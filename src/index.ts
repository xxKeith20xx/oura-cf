export interface Env {
	oura_db: D1Database;
	RATE_LIMITER: RateLimit;
	OURA_CACHE: KVNamespace;
	GRAFANA_SECRET: string;
	OURA_CLIENT_ID?: string;
	OURA_CLIENT_SECRET?: string;
	OURA_SCOPES?: string;
	OURA_PAT?: string;
}

type OuraQueryMode = 'none' | 'date' | 'datetime';

type OuraResource = {
	resource: string;
	path: string;
	queryMode: OuraQueryMode;
	paginated: boolean;
};

// Database row types
interface OuraOAuthStateRow {
	state: string;
	user_id: string;
	created_at: number;
}

interface OuraOAuthTokenRow {
	user_id: string;
	access_token: string;
	refresh_token: string | null;
	expires_at: number | null;
	scope: string | null;
	token_type: string | null;
}

// Oura API response types
interface OuraTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
}

interface OuraApiResponse<T> {
	data: T[];
	next_token?: string;
}

// In-memory cache for OAuth tokens (reset on cold start)
let tokenCache: { token: string; expiresAt: number } | null = null;

// Validation constants
const MAX_SQL_LENGTH = 10_000;
const MAX_BACKFILL_DAYS = 3650;
const OPENAPI_CACHE_TTL = 86400; // 24 hours
const RESPONSE_CACHE_TTL = 300; // 5 minutes (use 'private' cache for authenticated endpoints)

export default {
  // 1. Cron Trigger: Automated Daily Sync
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			Promise.all([
				syncData(env, 3, 0, null),
				updateTableStats(env), // Update stats cache
			])
		);
  },

  // 2. HTTP Fetch: API and Manual Backfill
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");
		const origin = request.headers.get('Origin');

		if (request.method === 'OPTIONS') {
			return withCors(
				new Response(null, {
					status: 204,
					headers: {
						'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
						'Access-Control-Allow-Headers': 'Authorization,Content-Type',
					},
				}),
				origin
			);
		}

	if (url.pathname === '/health') {
		// Rate limit: 1 request per minute per IP for health checks
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
		const rateLimitKey = `health:${clientIP}`;
		const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
		if (!success) {
			return withCors(
				Response.json(
					{ error: 'Rate limit exceeded. Max 1 request per 60 seconds.' },
					{ status: 429 }
				),
				origin
			);
		}

		// Minimal health check response (no sensitive metadata)
		return withCors(
			Response.json({
				status: 'ok',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			}),
			origin
		);
	}

	// Favicon - browsers automatically request this, don't require auth
	if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
		<text y="0.9em" font-size="90">💍</text>
	</svg>`;
		
		return withCors(
			new Response(svg, {
				headers: {
					'Content-Type': 'image/svg+xml',
					'Cache-Control': 'public, max-age=31536000',
				},
			}),
			origin
		);
	}

	if (url.pathname === '/oauth/callback') {
			// Rate limit: Prevent OAuth callback abuse (1 request per 10 seconds per IP)
			const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
			const rateLimitKey = `oauth:${clientIP}`;
			const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
			if (!success) {
				return withCors(
					Response.json(
						{ error: 'Rate limit exceeded. Please wait before retrying.' },
						{ status: 429 }
					),
					origin
				);
			}

			if (!env.oura_db || typeof (env.oura_db as any).prepare !== 'function') {
				return withCors(
					Response.json({ error: 'D1 binding missing or misconfigured (oura_db)' }, { status: 500 }),
					origin
				);
			}

			const err = url.searchParams.get('error');
			if (err) {
				return withCors(Response.json({ error: err }, { status: 400 }), origin);
			}
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			if (!code || !state) {
				return withCors(Response.json({ error: 'Missing code/state' }, { status: 400 }), origin);
			}

		const stateRow = await env.oura_db
			.prepare('SELECT user_id, created_at FROM oura_oauth_states WHERE state = ?')
			.bind(state)
			.first<OuraOAuthStateRow>();
		if (!stateRow) {
			return withCors(Response.json({ error: 'Invalid state' }, { status: 400 }), origin);
		}

		const createdAt = Number(stateRow.created_at);
		if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60_000) {
			await env.oura_db
				.prepare('DELETE FROM oura_oauth_states WHERE state = ?')
				.bind(state)
				.run();
			return withCors(Response.json({ error: 'State expired' }, { status: 400 }), origin);
		}

		await env.oura_db
			.prepare('DELETE FROM oura_oauth_states WHERE state = ?')
			.bind(state)
			.run();

		const callbackUrl = new URL(request.url);
		callbackUrl.search = '';
		const token = await exchangeAuthorizationCodeForToken(env, code, callbackUrl.toString());
		await upsertOauthToken(env, stateRow.user_id ?? 'default', token);
			return withCors(
				new Response('OK', {
					status: 200,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				}),
				origin
			);
		}

    if (auth !== `Bearer ${env.GRAFANA_SECRET}`) {
			return withCors(new Response('Unauthorized', { status: 401 }), origin);
    }

		// Rate limit authenticated endpoints to prevent abuse if token leaks
		// Allows 60 requests per minute per IP (1 per second sustained)
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
		const authRateLimitKey = `auth:${clientIP}`;
		const { success: authRateLimit } = await env.RATE_LIMITER.limit({ key: authRateLimitKey });
		
		if (!authRateLimit) {
			return withCors(
				Response.json(
					{ error: 'Rate limit exceeded. Maximum 60 requests per minute.' },
					{ status: 429 }
				),
				origin
			);
		}

		if (!env.oura_db || typeof (env.oura_db as any).prepare !== 'function') {
			return withCors(
				Response.json({ error: 'D1 binding missing or misconfigured (oura_db)' }, { status: 500 }),
				origin
			);
		}

		if (url.pathname === '/oauth/start') {
			const userId = 'default';
			const state = crypto.randomUUID();
			const createdAt = Date.now();
			await env.oura_db
				.prepare('INSERT INTO oura_oauth_states (state, user_id, created_at) VALUES (?, ?, ?)')
				.bind(state, userId, createdAt)
				.run();

			const callbackUrl = new URL(request.url);
			callbackUrl.pathname = '/oauth/callback';
			callbackUrl.search = '';

		const scopes = (
			env.OURA_SCOPES ??
			'email personal daily heartrate workout tag session spo2 stress heart_health ring_configuration'
		)
			.split(/\s+/)
			.filter(Boolean)
			.join(' ');

			if (!env.OURA_CLIENT_ID) {
				return withCors(
					Response.json({ error: 'Missing OURA_CLIENT_ID secret' }, { status: 500 }),
					origin
				);
			}

			const authUrl = new URL('https://cloud.ouraring.com/oauth/authorize');
			authUrl.searchParams.set('response_type', 'code');
			authUrl.searchParams.set('client_id', env.OURA_CLIENT_ID);
			authUrl.searchParams.set('redirect_uri', callbackUrl.toString());
			authUrl.searchParams.set('scope', scopes);
			authUrl.searchParams.set('state', state);

			return Response.redirect(authUrl.toString(), 302);
		}


    if (url.pathname === "/backfill") {
		// Rate limiting: prevent backfill spam (1 request per 60 seconds per IP)
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
		const rateLimitKey = `backfill:${clientIP}`;
		const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
		if (!success) {
			return withCors(
				Response.json(
					{ error: 'Rate limit exceeded. Please wait 60 seconds between backfill requests.' },
					{ status: 429 }
				),
				origin
			);
		}

		const daysParam = url.searchParams.get('days');
		const days = daysParam ? Number(daysParam) : 730;
		const offsetParam = url.searchParams.get('offset_days') ?? url.searchParams.get('offsetDays');
		const offsetRaw = offsetParam ? Number(offsetParam) : 0;
		const offsetDays = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, MAX_BACKFILL_DAYS) : 0;
		const maxTotalDays = Math.max(0, MAX_BACKFILL_DAYS - offsetDays);
		const totalDays = Number.isFinite(days) && days > 0 ? Math.min(days, maxTotalDays) : 730;
		if (totalDays <= 0) {
			return withCors(Response.json({ error: 'Backfill window out of range' }, { status: 400 }), origin);
		}
		const resourcesParam = url.searchParams.get('resources');
		const resourceFilter = parseResourceFilter(resourcesParam);
		
		// Choose sync strategy based on workload size to avoid waitUntil timeout
		// waitUntil has 30-second limit after response; large syncs may exceed this
		if (totalDays <= 1) {
			// Small sync: use waitUntil (fast response, completes in background)
			ctx.waitUntil(
				Promise.all([
					syncData(env, totalDays, offsetDays, resourceFilter),
					updateTableStats(env), // Also update stats
				])
			);
			return withCors(
				new Response('Backfill initiated in background.', { status: 202 }),
				origin
			);
		} else {
			// Large backfill: synchronous (client waits, but guaranteed completion)
			try {
				await syncData(env, totalDays, offsetDays, resourceFilter);
				await updateTableStats(env);
				return withCors(
					new Response(`Backfill completed: ${totalDays} days synced.`, { status: 200 }),
					origin
				);
			} catch (err) {
				return withCors(
					Response.json({
						error: 'Backfill failed',
						details: err instanceof Error ? err.message : String(err).slice(0, 500)
					}, { status: 500 }),
					origin
				);
			}
		}
    }

		if (url.pathname === '/api/daily_summaries') {
			const start = url.searchParams.get('start');
			const end = url.searchParams.get('end');
			const where: string[] = [];
			const args: unknown[] = [];

			if (start) {
				where.push('day >= ?');
				args.push(start);
			}
			if (end) {
				where.push('day <= ?');
				args.push(end);
			}

			const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
			try {
				const stmt = env.oura_db.prepare(
					`SELECT * FROM daily_summaries ${whereSql} ORDER BY day ASC`
				);
				const out = args.length ? await stmt.bind(...args).all() : await stmt.all();
				return withCors(
					new Response(JSON.stringify(out.results), {
						headers: {
							'Content-Type': 'application/json',
							// Use 'private' cache since endpoint requires authentication
							'Cache-Control': `private, max-age=${RESPONSE_CACHE_TTL}`,
						},
					}),
					origin
				);
			} catch (err) {
				return withCors(
					Response.json(
						{ error: 'D1 query failed', details: String(err).slice(0, 500) },
						{ status: 500 }
					),
					origin
				);
			}
		}

	if (url.pathname === '/api/sql' && request.method === 'POST') {
		const body = (await request.json().catch(() => null)) as
			| { sql?: unknown; params?: unknown }
			| null;

		const sql = typeof body?.sql === 'string' ? body.sql.trim() : '';
		const params = Array.isArray(body?.params) ? body.params : [];
		
		// Validation: SQL length limit
		if (sql.length > MAX_SQL_LENGTH) {
			return withCors(
				Response.json(
					{ error: `SQL too large (max ${MAX_SQL_LENGTH} characters)` },
					{ status: 400 }
				),
				origin
			);
		}

		// Validation: Read-only queries only
		if (!isReadOnlySql(sql)) {
			return withCors(new Response('Only read-only SQL is allowed', { status: 400 }), origin);
		}

		// Validation: Parameter count limit
		if (params.length > 100) {
			return withCors(
				Response.json({ error: 'Too many parameters (max 100)' }, { status: 400 }),
				origin
			);
		}

		try {
			const result = await env.oura_db.prepare(sql).bind(...params).all();
			
			// Detect stats/metadata queries (COUNT(*) across all tables)
			// These queries scan millions of rows but results change infrequently
			const isStatsQuery = /COUNT\(\*\).*FROM\s+heart_rate_samples/i.test(sql) &&
				/UNION\s+ALL/i.test(sql);
			
			// Use longer cache for stats queries (1 hour vs 5 minutes)
			const cacheTTL = isStatsQuery ? 3600 : RESPONSE_CACHE_TTL;
			
			return withCors(
				new Response(JSON.stringify({ results: result.results, meta: result.meta }), {
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': `private, max-age=${cacheTTL}`,
					},
				}),
				origin
			);
		} catch (err) {
			return withCors(
				Response.json(
					{ error: 'D1 query failed', details: String(err).slice(0, 500) },
					{ status: 500 }
				),
				origin
			);
		}
	}

	if (url.pathname === '/api/sql') {
		return withCors(new Response('Method Not Allowed', { status: 405 }), origin);
	}

	// Dedicated endpoint for table statistics (fast, approximate counts)
	if (url.pathname === '/api/stats') {
		try {
			// Use pre-computed stats table if available (most accurate)
			const { results: cachedStats } = await env.oura_db
				.prepare('SELECT resource, min_day, max_day, record_count, updated_at FROM table_stats ORDER BY resource')
				.all();
			
			if (cachedStats && cachedStats.length > 0) {
				return withCors(
					new Response(JSON.stringify(cachedStats), {
						headers: {
							'Content-Type': 'application/json',
							'Cache-Control': 'private, max-age=3600',
						},
					}),
					origin
				);
			}

			// Fallback: compute stats on-demand (slow but accurate)
			// This will only run if table_stats is empty (first time)
			console.warn('table_stats empty, computing on-demand (slow)', {
				timestamp: new Date().toISOString(),
			});
			
			const stats = await env.oura_db.prepare(`
				SELECT 'daily_summaries' AS resource, MIN(day) AS min_day, MAX(day) AS max_day, COUNT(*) AS record_count FROM daily_summaries
				UNION ALL
				SELECT 'sleep_episodes', MIN(day), MAX(day), COUNT(*) FROM sleep_episodes
				UNION ALL
				SELECT 'heart_rate_samples', MIN(substr(timestamp,1,10)), MAX(substr(timestamp,1,10)), COUNT(*) FROM heart_rate_samples
				UNION ALL
				SELECT 'activity_logs', MIN(substr(start_datetime,1,10)), MAX(substr(start_datetime,1,10)), COUNT(*) FROM activity_logs
			`).all();
			
			return withCors(
				new Response(JSON.stringify(stats.results), {
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'private, max-age=60', // Short cache since it's a fallback
					},
				}),
				origin
			);
		} catch (err) {
			return withCors(
				Response.json(
					{ error: 'Failed to fetch table stats', details: String(err).slice(0, 500) },
					{ status: 500 }
				),
				origin
			);
		}
	}

	// Serve all data to Grafana (root endpoint only)
	if (url.pathname === '/') {
		try {
			const { results } = await env.oura_db
				.prepare('SELECT * FROM daily_summaries ORDER BY day ASC')
				.all();
			return withCors(
				new Response(JSON.stringify(results), {
					headers: {
						'Content-Type': 'application/json',
						// Use 'private' cache since endpoint requires authentication
						'Cache-Control': `private, max-age=${RESPONSE_CACHE_TTL}`,
					},
				}),
				origin
			);
		} catch (err) {
			return withCors(
				Response.json(
					{ error: 'D1 query failed', details: String(err).slice(0, 500) },
					{ status: 500 }
				),
				origin
			);
		}
	}

	// No matching endpoint
	return withCors(new Response('Not Found', { status: 404 }), origin);
  }
};

async function syncData(
	env: Env,
	totalDays: number,
	offsetDays = 0,
	resourceFilter: Set<string> | null = null
) {
	const syncStartTime = Date.now();
	const resourcesAll = await loadOuraResourcesFromOpenApi(env);
	const resources = resourceFilter
		? resourcesAll.filter((r) => resourceFilter.has(r.resource))
		: resourcesAll;

	// Process all resources in parallel for faster syncs
	// Rate limit: 5000 req/5min (1000 req/min), we're using ~18 resources = well under limit
	const results = await Promise.allSettled(
		resources.map(async (r) => {
			try {
				if (r.queryMode === 'none') {
					await ingestResource(env, r, null);
					return { resource: r.resource, success: true, requests: 1 };
				}

				const chunkDays = getChunkDaysForResource(r);
				let requestCount = 0;

				// Process time windows sequentially per resource to avoid pagination issues
				for (let i = 0; i < totalDays; i += chunkDays) {
					const windowDays = Math.min(chunkDays, totalDays - i);
					const start = new Date(Date.now() - (offsetDays + i + windowDays) * 86400000)
						.toISOString()
						.split('T')[0];
					const end = new Date(Date.now() - (offsetDays + i) * 86400000)
						.toISOString()
						.split('T')[0];
					await ingestResource(env, r, { startDate: start, endDate: end });
					requestCount++;
				}

				return { resource: r.resource, success: true, requests: requestCount };
			} catch (err) {
				console.error('Resource sync failed', {
					resource: r.resource,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
					timestamp: new Date().toISOString(),
				});
				return { resource: r.resource, success: false, error: err };
			}
		})
	);

	// Log sync summary
	const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
	const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;
	const totalRequests = results
		.filter((r) => r.status === 'fulfilled')
		.reduce((sum, r) => sum + (r.value.requests || 0), 0);
	const duration = Date.now() - syncStartTime;

	console.log('Sync completed', {
		totalResources: resources.length,
		successful,
		failed,
		totalRequests,
		durationMs: duration,
		durationSec: (duration / 1000).toFixed(2),
		timestamp: new Date().toISOString(),
	});

	// Log failed resources for debugging
	const failedResources = results
		.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success))
		.map((r) => (r.status === 'fulfilled' ? r.value.resource : 'unknown'));
	
	if (failedResources.length > 0) {
		console.warn('Failed resources', {
			resources: failedResources,
			count: failedResources.length,
			timestamp: new Date().toISOString(),
		});
	}
}

function parseResourceFilter(raw: string | null): Set<string> | null {
	if (!raw) return null;
	const parts = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!parts.length) return null;
	return new Set(parts);
}

function getChunkDaysForResource(r: OuraResource): number {
	// Oura endpoint constraint: heartrate requires start/end datetime range <= 30 days.
	// Use 29 days to stay safely under the limit.
	if (r.resource === 'heartrate') return 29;
	return 90;
}

async function saveToD1(env: Env, endpoint: string, data: any[]) {
	// daily_readiness -> daily_summaries (readiness fields)
	if (endpoint === 'daily_readiness') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, readiness_score, readiness_activity_balance, readiness_body_temperature, readiness_hrv_balance, readiness_previous_day_activity, readiness_previous_night_sleep, readiness_recovery_index, readiness_resting_heart_rate, readiness_sleep_balance, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				readiness_score=excluded.readiness_score,
				readiness_activity_balance=excluded.readiness_activity_balance,
				readiness_body_temperature=excluded.readiness_body_temperature,
				readiness_hrv_balance=excluded.readiness_hrv_balance,
				readiness_previous_day_activity=excluded.readiness_previous_day_activity,
				readiness_previous_night_sleep=excluded.readiness_previous_night_sleep,
				readiness_recovery_index=excluded.readiness_recovery_index,
				readiness_resting_heart_rate=excluded.readiness_resting_heart_rate,
				readiness_sleep_balance=excluded.readiness_sleep_balance,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			const c = d?.contributors ?? {};
			stmts.push(stmt.bind(
				d.day,
				toInt(d.score),
				toInt(c.activity_balance),
				toInt(c.body_temperature),
				toInt(c.hrv_balance),
				toInt(c.previous_day_activity),
				toInt(c.previous_night),
				toInt(c.recovery_index),
				toInt(c.resting_heart_rate),
				toInt(c.sleep_balance)
			));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_sleep -> daily_summaries (sleep fields)
	if (endpoint === 'daily_sleep') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, sleep_score, sleep_deep_sleep, sleep_efficiency, sleep_latency, sleep_rem_sleep, sleep_restfulness, sleep_timing, sleep_total_sleep, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				sleep_score=excluded.sleep_score,
				sleep_deep_sleep=excluded.sleep_deep_sleep,
				sleep_efficiency=excluded.sleep_efficiency,
				sleep_latency=excluded.sleep_latency,
				sleep_rem_sleep=excluded.sleep_rem_sleep,
				sleep_restfulness=excluded.sleep_restfulness,
				sleep_timing=excluded.sleep_timing,
				sleep_total_sleep=excluded.sleep_total_sleep,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			const c = d?.contributors ?? {};
			stmts.push(stmt.bind(
				d.day,
				toInt(d.score),
				toInt(c.deep_sleep),
				toInt(c.efficiency),
				toInt(c.latency),
				toInt(c.rem_sleep),
				toInt(c.restfulness),
				toInt(c.timing),
				toInt(c.total_sleep)
			));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_activity -> daily_summaries (activity fields)
	if (endpoint === 'daily_activity') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, activity_score, activity_steps, activity_active_calories, activity_total_calories, activity_meet_daily_targets, activity_move_every_hour, activity_recovery_time, activity_stay_active, activity_training_frequency, activity_training_volume, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				activity_score=excluded.activity_score,
				activity_steps=excluded.activity_steps,
				activity_active_calories=excluded.activity_active_calories,
				activity_total_calories=excluded.activity_total_calories,
				activity_meet_daily_targets=excluded.activity_meet_daily_targets,
				activity_move_every_hour=excluded.activity_move_every_hour,
				activity_recovery_time=excluded.activity_recovery_time,
				activity_stay_active=excluded.activity_stay_active,
				activity_training_frequency=excluded.activity_training_frequency,
				activity_training_volume=excluded.activity_training_volume,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			const c = d?.contributors ?? {};
			stmts.push(stmt.bind(
				d.day,
				toInt(d.score),
				toInt(d.steps),
				toInt(d.active_calories),
				toInt(d.total_calories),
				toInt(c.meet_daily_targets),
				toInt(c.move_every_hour),
				toInt(c.recovery_time),
				toInt(c.stay_active),
				toInt(c.training_frequency),
				toInt(c.training_volume)
			));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_stress -> daily_summaries (stress_index)
	if (endpoint === 'daily_stress') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, stress_index, updated_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				stress_index=excluded.stress_index,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toInt(d.stress_high ?? d.day_summary)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_resilience -> daily_summaries (resilience fields)
	if (endpoint === 'daily_resilience') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, resilience_level, resilience_contributors_sleep, resilience_contributors_stress, updated_at)
			VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				resilience_level=excluded.resilience_level,
				resilience_contributors_sleep=excluded.resilience_contributors_sleep,
				resilience_contributors_stress=excluded.resilience_contributors_stress,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			const c = d?.contributors ?? {};
			stmts.push(stmt.bind(d.day, d.level ?? null, toInt(c.sleep_recovery), toInt(c.daytime_recovery)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_spo2 -> daily_summaries (spo2 fields)
	if (endpoint === 'daily_spo2') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, spo2_percentage, spo2_breathing_disturbance_index, updated_at)
			VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				spo2_percentage=excluded.spo2_percentage,
				spo2_breathing_disturbance_index=excluded.spo2_breathing_disturbance_index,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toReal(d.spo2_percentage?.average), toInt(d.breathing_disturbance_index)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_cardiovascular_age -> daily_summaries (cv_age_offset)
	if (endpoint === 'daily_cardiovascular_age') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, cv_age_offset, updated_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				cv_age_offset=excluded.cv_age_offset,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toInt(d.vascular_age)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// vo2_max -> daily_summaries (vo2_max)
	if (endpoint === 'vo2_max') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, vo2_max, updated_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				vo2_max=excluded.vo2_max,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toReal(d.vo2_max)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// sleep -> sleep_episodes
	if (endpoint === 'sleep') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO sleep_episodes (id, day, start_datetime, end_datetime, type, heart_rate_avg, heart_rate_lowest, hrv_avg, breath_avg, temperature_deviation, deep_duration, rem_duration, light_duration, awake_duration)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				day=excluded.day,
				start_datetime=excluded.start_datetime,
				end_datetime=excluded.end_datetime,
				type=excluded.type,
				heart_rate_avg=excluded.heart_rate_avg,
				heart_rate_lowest=excluded.heart_rate_lowest,
				hrv_avg=excluded.hrv_avg,
				breath_avg=excluded.breath_avg,
				temperature_deviation=excluded.temperature_deviation,
				deep_duration=excluded.deep_duration,
				rem_duration=excluded.rem_duration,
				light_duration=excluded.light_duration,
				awake_duration=excluded.awake_duration`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(
				d.id,
				d.day,
				d.bedtime_start ?? null,
				d.bedtime_end ?? null,
				d.type ?? null,
				toReal(d.average_heart_rate),
				toReal(d.lowest_heart_rate),
				toReal(d.average_hrv),
				toReal(d.average_breath),
				toReal(d.readiness?.temperature_deviation ?? d.temperature_deviation),
				toInt(d.deep_sleep_duration),
				toInt(d.rem_sleep_duration),
				toInt(d.light_sleep_duration),
				toInt(d.awake_time)
			));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// heartrate -> heart_rate_samples
	if (endpoint === 'heartrate') {
		const stmt = env.oura_db.prepare(
			'INSERT INTO heart_rate_samples (timestamp, bpm, source) VALUES (?, ?, ?) ' +
				'ON CONFLICT(timestamp) DO UPDATE SET bpm=excluded.bpm, source=excluded.source'
		);
		
		// Process in batches to reduce memory usage (heart rate can have 10k+ samples)
		const BATCH_SIZE = 500;
		for (let i = 0; i < data.length; i += BATCH_SIZE) {
			const batch = data.slice(i, i + BATCH_SIZE);
			const stmts = [];
			
			for (const d of batch) {
				const timestamp = typeof d?.timestamp === 'string' ? d.timestamp : null;
				if (!timestamp) continue;
				stmts.push(stmt.bind(timestamp, toInt(d.bpm), d.source ?? null));
			}
			
			if (stmts.length) {
				await env.oura_db.batch(stmts);
			}
		}
		return;
	}

	// workout -> activity_logs
	if (endpoint === 'workout') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO activity_logs (id, type, start_datetime, end_datetime, activity_label, intensity, calories, distance, hr_avg)
			VALUES (?, 'workout', ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				start_datetime=excluded.start_datetime,
				end_datetime=excluded.end_datetime,
				activity_label=excluded.activity_label,
				intensity=excluded.intensity,
				calories=excluded.calories,
				distance=excluded.distance,
				hr_avg=excluded.hr_avg`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(
				d.id,
				d.start_datetime ?? null,
				d.end_datetime ?? null,
				d.activity ?? d.sport ?? null,
				d.intensity ?? null,
				toReal(d.calories),
				toReal(d.distance),
				toReal(d.average_heart_rate)
			));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// session -> activity_logs (meditation/breathing sessions)
	if (endpoint === 'session') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO activity_logs (id, type, start_datetime, end_datetime, activity_label, hr_avg, mood)
			VALUES (?, 'session', ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				start_datetime=excluded.start_datetime,
				end_datetime=excluded.end_datetime,
				activity_label=excluded.activity_label,
				hr_avg=excluded.hr_avg,
				mood=excluded.mood`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(
				d.id,
				d.start_datetime ?? null,
				d.end_datetime ?? null,
				d.type ?? null,
				toReal(d.heart_rate?.average),
				d.mood ?? null
			));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// tag -> user_tags
	if (endpoint === 'tag') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO user_tags (id, day, tag_type, comment)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				day=excluded.day,
				tag_type=excluded.tag_type,
				comment=excluded.comment`
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.id, d.day ?? null, d.tag_type_code ?? d.tags?.[0] ?? null, d.comment ?? null));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}
}

function toInt(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
	if (typeof v === 'string') {
		const n = Number(v);
		if (Number.isFinite(n)) return Math.round(n);
	}
	return null;
}

function toReal(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string') {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function buildOuraUrl(endpoint: string, startDate: string, endDate: string): string {
	if (endpoint === 'heartrate') {
		const startDatetime = `${startDate}T00:00:00Z`;
		const endDatetime = `${endDate}T00:00:00Z`;
		return `https://api.ouraring.com/v2/usercollection/heartrate?start_datetime=${encodeURIComponent(startDatetime)}&end_datetime=${encodeURIComponent(endDatetime)}`;
	}
	return `https://api.ouraring.com/v2/usercollection/${endpoint}?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
}

async function ingestResource(
	env: Env,
	r: OuraResource,
	window: { startDate: string; endDate: string } | null
): Promise<void> {
	let nextToken: string | null = null;
	let page = 0;

	const accessToken = await getOuraAccessToken(env).catch((err) => {
		console.error('Failed to get Oura access token', {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			timestamp: new Date().toISOString(),
			resource: r.resource,
		});
		return null;
	});
	if (!accessToken) return;

	while (true) {
		const url = buildOuraUrlForResource(r, window, nextToken);
		const res = await fetchWithRetry(url, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.error('Oura fetch failed', {
				resource: r.resource,
				status: res.status,
				statusText: res.statusText,
				responseBody: text.slice(0, 500),
				timestamp: new Date().toISOString(),
				url: url,
			});
			return;
		}

		const json = await res.json().catch(() => null);
		if (!json || typeof json !== 'object') {
			console.error('Invalid JSON response from Oura', {
				resource: r.resource,
				timestamp: new Date().toISOString(),
				url: url,
			});
			return;
		}

		const apiResponse = json as OuraApiResponse<any>;
		const data = apiResponse.data;
		if (Array.isArray(data) && data.length) {
			await saveToD1(env, r.resource, data);
		}

		if (!r.paginated) return;
		nextToken = apiResponse.next_token ?? null;
		page += 1;
		if (!nextToken) return;
		if (page > 1000) {
			console.warn('Oura pagination safeguard triggered', {
				resource: r.resource,
				pageCount: page,
				timestamp: new Date().toISOString(),
				message: 'Exceeded maximum pagination limit of 1000 pages',
			});
			return;
		}
	}
}

function buildOuraUrlForResource(
	r: OuraResource,
	window: { startDate: string; endDate: string } | null,
	nextToken: string | null
): string {
	const base = `https://api.ouraring.com${r.path}`;
	const u = new URL(base);

	if (r.queryMode === 'date' && window) {
		u.searchParams.set('start_date', window.startDate);
		u.searchParams.set('end_date', window.endDate);
	}
	if (r.queryMode === 'datetime' && window) {
		u.searchParams.set('start_datetime', `${window.startDate}T00:00:00Z`);
		u.searchParams.set('end_datetime', `${window.endDate}T00:00:00Z`);
	}
	if (nextToken) {
		u.searchParams.set('next_token', nextToken);
	}
	return u.toString();
}

async function fetchWithRetry(
	input: RequestInfo | URL,
	init: RequestInit,
	maxRetries = 3
): Promise<Response> {
	let attempt = 0;
	while (true) {
		const res = await fetch(input, init);
		if (res.status !== 429 && res.status < 500) return res;
		attempt += 1;
		if (attempt > maxRetries) return res;
		const backoffMs = 250 * Math.pow(2, attempt);
		await new Promise((r) => setTimeout(r, backoffMs));
	}
}

async function loadOuraResourcesFromOpenApi(env: Env): Promise<OuraResource[]> {
	// Try KV cache first (24 hour TTL)
	try {
		const cached = await env.OURA_CACHE.get('openapi_resources', 'json');
		if (cached && Array.isArray(cached)) {
			return cached as OuraResource[];
		}
	} catch (err) {
		console.warn('Failed to read from KV cache', {
			error: err instanceof Error ? err.message : String(err),
			timestamp: new Date().toISOString(),
		});
	}

	// Fetch and parse OpenAPI spec
	const res = await fetch('https://cloud.ouraring.com/v2/static/json/openapi-1.27.json');
	if (!res.ok) {
		console.error('Failed to fetch Oura OpenAPI spec', {
			status: res.status,
			statusText: res.statusText,
			timestamp: new Date().toISOString(),
			message: 'Unable to load Oura API resource definitions',
		});
		return [];
	}
	const spec = (await res.json().catch(() => null)) as any;
	const paths = spec?.paths && typeof spec.paths === 'object' ? spec.paths : {};
	const out: OuraResource[] = [];
	const forceDateWindow = new Set(['sleep', 'sleep_time', 'workout']);

	for (const [path, methods] of Object.entries(paths)) {
		if (typeof path !== 'string') continue;
		if (!path.startsWith('/v2/usercollection/')) continue;
		if (path.startsWith('/v2/sandbox/')) continue;
		if (path.includes('{')) continue;
		if (!methods || typeof methods !== 'object') continue;
		const getDef = (methods as any).get;
		if (!getDef) continue;

		const resource = path.replace('/v2/usercollection/', '');
		if (!resource) continue;

		const params = Array.isArray(getDef.parameters) ? getDef.parameters : [];
		const paramNames = new Set(
			params
				.map((p: any) => (typeof p?.name === 'string' ? p.name : null))
				.filter(Boolean)
		);

		let queryMode: OuraQueryMode = 'none';
		if (paramNames.has('start_datetime') || paramNames.has('end_datetime')) {
			queryMode = 'datetime';
		} else if (paramNames.has('start_date') || paramNames.has('end_date')) {
			queryMode = 'date';
		}
		if (queryMode === 'none' && forceDateWindow.has(resource)) {
			queryMode = 'date';
		}

		const paginated = paramNames.has('next_token');
		out.push({ resource, path, queryMode, paginated });
	}

	out.sort((a, b) => a.resource.localeCompare(b.resource));
	
	// Cache in KV for 24 hours
	try {
		await env.OURA_CACHE.put('openapi_resources', JSON.stringify(out), {
			expirationTtl: OPENAPI_CACHE_TTL,
		});
	} catch (err) {
		console.warn('Failed to write to KV cache', {
			error: err instanceof Error ? err.message : String(err),
			timestamp: new Date().toISOString(),
		});
	}
	
	return out;
}

function isReadOnlySql(sql: string): boolean {
	if (!sql) return false;
	const normalized = stripLeadingSqlComments(sql).replace(/\s+/g, ' ').trim();
	if (!/^(select|with)\b/i.test(normalized)) return false;
	if (normalized.includes(';')) return false;
	if (/\boura_oauth_tokens\b/i.test(normalized)) return false;
	if (/\boura_oauth_states\b/i.test(normalized)) return false;
	return !/\b(insert|update|delete|drop|alter|create|replace|vacuum|pragma|attach|detach)\b/i.test(normalized);
}

async function exchangeAuthorizationCodeForToken(
	env: Env,
	code: string,
	redirectUri: string
): Promise<OuraTokenResponse> {
	if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) {
		throw new Error('Missing OURA_CLIENT_ID/OURA_CLIENT_SECRET');
	}

	const form = new URLSearchParams();
	form.set('grant_type', 'authorization_code');
	form.set('code', code);
	form.set('redirect_uri', redirectUri);

	const basic = btoa(`${env.OURA_CLIENT_ID}:${env.OURA_CLIENT_SECRET}`);
	const res = await fetch('https://api.ouraring.com/oauth/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basic}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: form.toString(),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 500)}`);
	}
	const json = await res.json().catch(() => null);
	if (!json || typeof json !== 'object') {
		throw new Error('Token exchange response invalid');
	}
	
	const tokenResponse = json as Partial<OuraTokenResponse>;
	if (!tokenResponse.access_token || typeof tokenResponse.access_token !== 'string') {
		throw new Error('Token exchange response missing access_token');
	}
	
	return tokenResponse as OuraTokenResponse;
}

async function refreshAccessToken(env: Env, refreshToken: string): Promise<OuraTokenResponse> {
	if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) {
		throw new Error('Missing OURA_CLIENT_ID/OURA_CLIENT_SECRET');
	}

	const form = new URLSearchParams();
	form.set('grant_type', 'refresh_token');
	form.set('refresh_token', refreshToken);

	const basic = btoa(`${env.OURA_CLIENT_ID}:${env.OURA_CLIENT_SECRET}`);
	const res = await fetch('https://api.ouraring.com/oauth/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basic}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: form.toString(),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 500)}`);
	}
	const json = await res.json().catch(() => null);
	if (!json || typeof json !== 'object') {
		throw new Error('Token refresh response invalid');
	}
	
	const tokenResponse = json as Partial<OuraTokenResponse>;
	if (!tokenResponse.access_token || typeof tokenResponse.access_token !== 'string') {
		throw new Error('Token refresh response missing access_token');
	}
	
	return tokenResponse as OuraTokenResponse;
}

async function upsertOauthToken(env: Env, userId: string, token: OuraTokenResponse): Promise<void> {
	const expiresAt =
		typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
			? Date.now() + Math.max(0, token.expires_in - 60) * 1000
			: null;

	await env.oura_db
		.prepare(
			'INSERT INTO oura_oauth_tokens (user_id, access_token, refresh_token, expires_at, scope, token_type) VALUES (?, ?, ?, ?, ?, ?) ' +
				'ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token, refresh_token=COALESCE(excluded.refresh_token, oura_oauth_tokens.refresh_token), expires_at=excluded.expires_at, scope=excluded.scope, token_type=excluded.token_type, updated_at=(strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'))'
		)
		.bind(
			userId,
			token.access_token,
			token.refresh_token ?? null,
			expiresAt,
			token.scope ?? null,
			token.token_type ?? null
		)
		.run();
}

async function getOuraAccessToken(env: Env): Promise<string> {
	// Check in-memory cache first (survives within same Worker instance)
	if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
		return tokenCache.token;
	}

	const userId = 'default';
	const row = await env.oura_db
		.prepare('SELECT access_token, refresh_token, expires_at FROM oura_oauth_tokens WHERE user_id = ?')
		.bind(userId)
		.first<OuraOAuthTokenRow>();

	if (!row) {
		// No token in database, fall back to PAT if available
		if (env.OURA_PAT) {
			// Cache PAT with a far future expiration (it doesn't expire)
			tokenCache = { token: env.OURA_PAT, expiresAt: Date.now() + 86400000 };
			return env.OURA_PAT;
		}
		throw new Error('No OAuth token found. Visit /oauth/start to authorize.');
	}

	const accessToken = row.access_token;
	const refreshToken = row.refresh_token;
	const expiresAt = row.expires_at;
	const hasValidAccess =
		accessToken && expiresAt !== null && Number.isFinite(expiresAt)
			? expiresAt > Date.now() + 60_000
			: !!accessToken;

	if (hasValidAccess && accessToken) {
		// Cache the valid token
		tokenCache = {
			token: accessToken,
			expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : Date.now() + 3600000,
		};
		return accessToken;
	}

	if (refreshToken) {
		const refreshed = await refreshAccessToken(env, refreshToken);
		await upsertOauthToken(env, userId, refreshed);
		// Cache the refreshed token
		const newExpiresAt =
			typeof refreshed.expires_in === 'number' && Number.isFinite(refreshed.expires_in)
				? Date.now() + Math.max(0, refreshed.expires_in - 60) * 1000
				: Date.now() + 3600000;
		tokenCache = { token: refreshed.access_token, expiresAt: newExpiresAt };
		return refreshed.access_token;
	}

	if (env.OURA_PAT) {
		tokenCache = { token: env.OURA_PAT, expiresAt: Date.now() + 86400000 };
		return env.OURA_PAT;
	}
	throw new Error('No OAuth refresh token found. Visit /oauth/start to authorize.');
}

function stripLeadingSqlComments(sql: string): string {
	let s = sql;
	while (true) {
		const trimmed = s.trimStart();
		if (trimmed.startsWith('--')) {
			const idx = trimmed.indexOf('\n');
			if (idx === -1) return '';
			s = trimmed.slice(idx + 1);
			continue;
		}
		if (trimmed.startsWith('/*')) {
			const idx = trimmed.indexOf('*/');
			if (idx === -1) return '';
			s = trimmed.slice(idx + 2);
			continue;
		}
		return trimmed;
	}
}

async function updateTableStats(env: Env): Promise<void> {
	try {
		// Compute stats for each table (this is expensive but runs once per sync)
		const stats = [
			{
				resource: 'daily_summaries',
				query: `SELECT 'daily_summaries' AS resource, MIN(day) AS min_day, MAX(day) AS max_day, COUNT(*) AS record_count FROM daily_summaries`,
			},
			{
				resource: 'sleep_episodes',
				query: `SELECT 'sleep_episodes' AS resource, MIN(day) AS min_day, MAX(day) AS max_day, COUNT(*) AS record_count FROM sleep_episodes`,
			},
			{
				resource: 'heart_rate_samples',
				query: `SELECT 'heart_rate_samples' AS resource, MIN(substr(timestamp,1,10)) AS min_day, MAX(substr(timestamp,1,10)) AS max_day, COUNT(*) AS record_count FROM heart_rate_samples`,
			},
			{
				resource: 'activity_logs',
				query: `SELECT 'activity_logs' AS resource, MIN(substr(start_datetime,1,10)) AS min_day, MAX(substr(start_datetime,1,10)) AS max_day, COUNT(*) AS record_count FROM activity_logs`,
			},
		];

		// Update stats for each table
		const updateStatements = [];
		for (const stat of stats) {
			const result = await env.oura_db.prepare(stat.query).first<{
				resource: string;
				min_day: string | null;
				max_day: string | null;
				record_count: number;
			}>();

			if (result) {
				const stmt = env.oura_db.prepare(
					`INSERT INTO table_stats (resource, min_day, max_day, record_count, updated_at)
					VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
					ON CONFLICT(resource) DO UPDATE SET
						min_day=excluded.min_day,
						max_day=excluded.max_day,
						record_count=excluded.record_count,
						updated_at=excluded.updated_at`
				);
				updateStatements.push(
					stmt.bind(result.resource, result.min_day, result.max_day, result.record_count)
				);
			}
		}

		if (updateStatements.length) {
			await env.oura_db.batch(updateStatements);
		}

		console.log('Table stats updated successfully', {
			timestamp: new Date().toISOString(),
			tables_updated: updateStatements.length,
		});
	} catch (err) {
		console.error('Failed to update table stats', {
			error: err instanceof Error ? err.message : String(err),
			timestamp: new Date().toISOString(),
		});
	}
}

function withCors(response: Response, origin: string | null): Response {
	const headers = new Headers(response.headers);
	
	// Whitelist allowed origins
	const allowedOrigins = [
		'https://oura.keith20.dev',
		'http://localhost:3000',
		'http://localhost:8787', // Wrangler dev server
	];
	
	// Validate origin and use first allowed origin as fallback
	const allowOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
	
	headers.set('Access-Control-Allow-Origin', allowOrigin);
	headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
	headers.set('Vary', 'Origin');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

