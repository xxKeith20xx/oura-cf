export interface Env {
	oura_db: D1Database;
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

export default {
  // 1. Cron Trigger: Automated Daily Sync
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(syncData(env, 3, 0, null));
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
			return withCors(Response.json({ ok: true }), origin);
		}

		if (url.pathname === '/oauth/callback') {
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
				.first();
			if (!stateRow) {
				return withCors(Response.json({ error: 'Invalid state' }, { status: 400 }), origin);
			}

			const createdAt = Number((stateRow as any).created_at);
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
			await upsertOauthToken(env, (stateRow as any).user_id ?? 'default', token);
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
				.split(/[\s+]+/)
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
			const daysParam = url.searchParams.get('days');
			const days = daysParam ? Number(daysParam) : 730;
			const offsetParam = url.searchParams.get('offset_days') ?? url.searchParams.get('offsetDays');
			const offsetRaw = offsetParam ? Number(offsetParam) : 0;
			const offsetDays = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 3650) : 0;
			const maxTotalDays = Math.max(0, 3650 - offsetDays);
			const totalDays = Number.isFinite(days) && days > 0 ? Math.min(days, maxTotalDays) : 730;
			if (totalDays <= 0) {
				return withCors(Response.json({ error: 'Backfill window out of range' }, { status: 400 }), origin);
			}
			const resourcesParam = url.searchParams.get('resources');
			const resourceFilter = parseResourceFilter(resourcesParam);
			ctx.waitUntil(syncData(env, totalDays, offsetDays, resourceFilter));
			return withCors(new Response('Backfill initiated.', { status: 202 }), origin);
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
				return withCors(Response.json(out.results), origin);
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
			if (sql.length > 50_000) {
				return withCors(new Response('SQL too large', { status: 400 }), origin);
			}

			if (!isReadOnlySql(sql)) {
				return withCors(new Response('Only read-only SQL is allowed', { status: 400 }), origin);
			}

			try {
				const result = await env.oura_db.prepare(sql).bind(...params).all();
				return withCors(
					Response.json({ results: result.results, meta: result.meta }),
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

    // Serve data to Grafana
		try {
			const { results } = await env.oura_db
				.prepare('SELECT * FROM daily_summaries ORDER BY day ASC')
				.all();
			return withCors(Response.json(results), origin);
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
};

async function syncData(
	env: Env,
	totalDays: number,
	offsetDays = 0,
	resourceFilter: Set<string> | null = null
) {
	const resourcesAll = await loadOuraResourcesFromOpenApi();
	const resources = resourceFilter
		? resourcesAll.filter((r) => resourceFilter.has(r.resource))
		: resourcesAll;

	for (const r of resources) {
		if (r.queryMode === 'none') {
			await ingestResource(env, r, null);
			continue;
		}

		const chunkDays = getChunkDaysForResource(r);

		for (let i = 0; i < totalDays; i += chunkDays) {
			const start = new Date(Date.now() - (offsetDays + i + chunkDays) * 86400000)
				.toISOString()
				.split('T')[0];
			const end = new Date(Date.now() - (offsetDays + i) * 86400000)
				.toISOString()
				.split('T')[0];
			await ingestResource(env, r, { startDate: start, endDate: end });
		}
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
  // Mapping logic to insert/upsert data into D1 tables
  // Example for readiness
  if (endpoint === 'daily_readiness') {
		const stmt = env.oura_db.prepare(
			"INSERT INTO daily_summaries (day, readiness_score) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET readiness_score=excluded.readiness_score"
		);
		await env.oura_db.batch(data.map((d) => stmt.bind(d.day, d.score)));
  }

	if (endpoint === 'heartrate') {
		const stmt = env.oura_db.prepare(
			'INSERT INTO heart_rate_samples (timestamp, bpm, source) VALUES (?, ?, ?) ' +
				'ON CONFLICT(timestamp) DO UPDATE SET bpm=excluded.bpm, source=excluded.source'
		);
		const stmts = data
			.map((d) => {
				const timestamp = typeof d?.timestamp === 'string' ? d.timestamp : null;
				if (!timestamp) return null;
				const bpm = typeof d?.bpm === 'number' ? d.bpm : Number(d?.bpm);
				const bpmVal = Number.isFinite(bpm) ? bpm : null;
				const source = typeof d?.source === 'string' ? d.source : null;
				return stmt.bind(timestamp, bpmVal, source);
			})
			.filter(Boolean) as any[];

		if (stmts.length) {
			await env.oura_db.batch(stmts);
		}
	}
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
		console.log('Failed to get Oura access token', String(err).slice(0, 500));
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
			console.log('Oura fetch failed', r.resource, res.status, text.slice(0, 500));
			return;
		}

		const json = (await res.json().catch(() => null)) as any;
		const data = json?.data;
		if (Array.isArray(data)) {
			if (data.length) {
				if (r.resource !== 'heartrate') {
					await saveRawDocuments(env, r.resource, data);
				}
				await saveToD1(env, r.resource, data);
			}
		} else if (json && typeof json === 'object') {
			await saveRawSingleton(env, r.resource, json);
		}

		if (!r.paginated) return;
		nextToken = typeof json?.next_token === 'string' ? json.next_token : null;
		page += 1;
		if (!nextToken) return;
		if (page > 1000) {
			console.log('Oura pagination safeguard triggered', r.resource);
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

async function loadOuraResourcesFromOpenApi(): Promise<OuraResource[]> {
	const res = await fetch('https://cloud.ouraring.com/v2/static/json/openapi-1.27.json');
	if (!res.ok) {
		console.log('Failed to fetch Oura OpenAPI spec', res.status);
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

type OuraTokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
};

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
	const json = (await res.json().catch(() => null)) as any;
	if (!json?.access_token || typeof json.access_token !== 'string') {
		throw new Error('Token exchange response missing access_token');
	}
	return json as OuraTokenResponse;
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
	const json = (await res.json().catch(() => null)) as any;
	if (!json?.access_token || typeof json.access_token !== 'string') {
		throw new Error('Token refresh response missing access_token');
	}
	return json as OuraTokenResponse;
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
	const userId = 'default';
	const row = await env.oura_db
		.prepare('SELECT access_token, refresh_token, expires_at FROM oura_oauth_tokens WHERE user_id = ?')
		.bind(userId)
		.first();

	const accessToken = typeof (row as any)?.access_token === 'string' ? (row as any).access_token : null;
	const refreshToken = typeof (row as any)?.refresh_token === 'string' ? (row as any).refresh_token : null;
	const expiresAt = Number((row as any)?.expires_at);
	const hasValidAccess =
		accessToken && Number.isFinite(expiresAt) ? expiresAt > Date.now() + 60_000 : !!accessToken;

	if (hasValidAccess && accessToken) return accessToken;
	if (refreshToken) {
		const refreshed = await refreshAccessToken(env, refreshToken);
		await upsertOauthToken(env, userId, refreshed);
		return refreshed.access_token;
	}

	if (env.OURA_PAT) return env.OURA_PAT;
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

function withCors(response: Response, origin: string | null): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', origin ?? '*');
	headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
	headers.set('Vary', 'Origin');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function saveRawDocuments(env: Env, resource: string, documents: any[]) {
	const fetchedAt = new Date().toISOString();
	const baseStmt = env.oura_db.prepare(
		'INSERT INTO oura_raw_documents (user_id, resource, document_id, payload_json, day, start_at, end_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
			'ON CONFLICT(user_id, resource, document_id) DO UPDATE SET payload_json=excluded.payload_json, day=excluded.day, start_at=excluded.start_at, end_at=excluded.end_at, fetched_at=excluded.fetched_at'
	);

	const userId = 'default';
	const stmts = documents.map((d) => {
		const { day, startAt, endAt } = extractDayStartEnd(d);
		const documentId = String(d?.id ?? startAt ?? day ?? crypto.randomUUID());
		return baseStmt.bind(userId, resource, documentId, JSON.stringify(d), day, startAt, endAt, fetchedAt);
	});

	if (stmts.length) {
		await env.oura_db.batch(stmts);
	}
}

async function saveRawSingleton(env: Env, resource: string, payload: unknown) {
	const userId = 'default';
	const fetchedAt = new Date().toISOString();
	const stmt = env.oura_db.prepare(
		'INSERT INTO oura_raw_documents (user_id, resource, document_id, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?) ' +
			'ON CONFLICT(user_id, resource, document_id) DO UPDATE SET payload_json=excluded.payload_json, fetched_at=excluded.fetched_at'
	);
	await stmt.bind(userId, resource, resource, JSON.stringify(payload), fetchedAt).run();
}

function pickString(v: unknown): string | null {
	return typeof v === 'string' && v.length ? v : null;
}

function extractDayStartEnd(d: any): { day: string | null; startAt: string | null; endAt: string | null } {
	const startAt =
		pickString(d?.start_datetime) ||
		pickString(d?.start_time) ||
		pickString(d?.bedtime_start) ||
		pickString(d?.bedtime_start_datetime) ||
		pickString(d?.timestamp) ||
		pickString(d?.start) ||
		null;

	const endAt =
		pickString(d?.end_datetime) ||
		pickString(d?.end_time) ||
		pickString(d?.bedtime_end) ||
		pickString(d?.bedtime_end_datetime) ||
		pickString(d?.end) ||
		null;

	const day =
		pickString(d?.day) ||
		(typeof startAt === 'string' && startAt.length >= 10 ? startAt.slice(0, 10) : null) ||
		(typeof endAt === 'string' && endAt.length >= 10 ? endAt.slice(0, 10) : null);

	return { day, startAt, endAt };
}
