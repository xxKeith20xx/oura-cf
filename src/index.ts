import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

// Build-time constant injected via wrangler.jsonc `define` (mirrors package.json version)
declare const __APP_VERSION__: string;

export interface Env {
	oura_db: D1Database;
	RATE_LIMITER: RateLimit;
	AUTH_RATE_LIMITER: RateLimit;
	UNAUTH_RATE_LIMITER: RateLimit; // New: Rate limiter for unauthenticated requests
	OURA_CACHE: KVNamespace;
	OURA_ANALYTICS?: AnalyticsEngineDataset; // Analytics Engine for query/auth metrics
	GRAFANA_SECRET: string;
	ADMIN_SECRET?: string; // Separate secret for manual admin operations (backfill, etc.)
	OURA_CLIENT_ID?: string;
	OURA_CLIENT_SECRET?: string;
	OURA_SCOPES?: string;
	OURA_PAT?: string;
	BACKFILL_WORKFLOW: Workflow; // Workflows binding for durable backfill orchestration
	ALLOWED_ORIGINS?: string; // Comma-separated CORS origins (default: https://oura.keith20.dev)
	MAX_QUERY_ROWS?: string; // Maximum rows to return from SQL queries (default: 50000)
	QUERY_TIMEOUT_MS?: string; // Query timeout in milliseconds (default: 7000)
	LOG_SQL_PREVIEW?: string; // Set to 'false' to disable SQL preview in logs/analytics
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

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null;
}

function toJsonRecord(value: unknown): JsonRecord {
	return isJsonRecord(value) ? value : {};
}

async function pseudonymizeForLogs(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `h:${hex.slice(0, 12)}`;
}

function getSqlPreview(sql: string, enabled: boolean): string {
	if (!enabled) return '[disabled]';
	const compact = sql.replace(/\s+/g, ' ').trim();
	const redacted = compact
		.replace(/'(?:''|[^'])*'/g, "'?'")
		.replace(/"(?:""|[^"])*"/g, '"?"')
		.replace(/\b\d{4,}\b/g, '?');
	return redacted.slice(0, 120);
}

// In-memory cache for OAuth tokens (reset on cold start)
let tokenCache: { token: string; expiresAt: number } | null = null;

// Security: Constant-time token comparison to prevent timing attacks
async function constantTimeCompare(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	// Hash both to fixed-length buffers so timingSafeEqual always compares equal-length inputs,
	// avoiding length-based timing leaks when a and b have different lengths.
	const [aHash, bHash] = await Promise.all([crypto.subtle.digest('SHA-256', aBytes), crypto.subtle.digest('SHA-256', bBytes)]);

	return crypto.subtle.timingSafeEqual(aHash, bHash);
}

// Security: Generate composite rate limit key to prevent collision behind proxies
// Uses IP + token prefix hash to differentiate users behind same proxy
async function getRateLimitKey(clientIP: string, authHeader: string | null, type: 'auth' | 'unauth' | 'health'): Promise<string> {
	const baseKey = `${type}:${clientIP}`;

	if (type === 'auth' && authHeader) {
		// Hash first 16 chars of token to differentiate users behind same IP
		const tokenPrefix = authHeader.slice(7, 23); // After "Bearer "
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenPrefix));
		const hashArray = Array.from(new Uint8Array(hash));
		const hashHex = hashArray
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, 8);
		return `${baseKey}:${hashHex}`;
	}

	return baseKey;
}

// Cache: Generate a short hash key for SQL query + params to use as KV cache key
async function hashSqlQuery(sql: string, params: unknown[]): Promise<string> {
	const data = JSON.stringify({ sql, params });
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 16);
}

// Cache: Flush all sql: prefixed KV entries after a data sync so dashboards see fresh data
async function flushSqlCache(kv: KVNamespace): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const list = await kv.list({ prefix: 'sql:', limit: 1000, cursor });
		await Promise.all(list.keys.map((k) => kv.delete(k.name)));
		deleted += list.keys.length;
		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
	return deleted;
}

// Security: Validate Bearer token and return which role it belongs to (null = invalid)
async function getBearerRole(authHeader: string | null, env: Env): Promise<'grafana' | 'admin' | null> {
	if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
	const token = authHeader.substring(7);
	if (env.ADMIN_SECRET && (await constantTimeCompare(token, env.ADMIN_SECRET))) return 'admin';
	if (await constantTimeCompare(token, env.GRAFANA_SECRET)) return 'grafana';
	return null;
}

// Security: Validate Bearer token against multiple secrets (supports rotation)
async function validateBearerToken(authHeader: string | null, env: Env): Promise<boolean> {
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return false;
	}

	const token = authHeader.substring(7); // Remove "Bearer " prefix

	// Check all configured secrets (Grafana service token + admin token)
	const secrets = [env.GRAFANA_SECRET, env.ADMIN_SECRET].filter((s): s is string => typeof s === 'string' && s.length > 0);

	for (const secret of secrets) {
		if (await constantTimeCompare(token, secret)) {
			return true;
		}
	}

	return false;
}

// Security: Log authentication attempt and write to Analytics Engine
async function logAuthAttempt(success: boolean, request: Request, env: Env, details?: string): Promise<void> {
	const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
	const ipHash = await pseudonymizeForLogs(clientIP);
	const userAgent = request.headers.get('User-Agent') || 'unknown';
	const cfData = request.cf as IncomingRequestCfProperties | undefined;

	console.log(
		JSON.stringify({
			type: 'auth_attempt',
			success,
			ipHash,
			country: cfData?.country || 'unknown',
			userAgent: userAgent.slice(0, 200),
			url: new URL(request.url).pathname,
			details: details || undefined,
		}),
	);

	if (env.OURA_ANALYTICS) {
		env.OURA_ANALYTICS.writeDataPoint({
			indexes: ['auth'],
			doubles: [success ? 1 : 0],
			blobs: [ipHash, (cfData?.country as string) || 'unknown', new URL(request.url).pathname, details || ''],
		});
	}
}

// Security: Log SQL query execution and write to Analytics Engine
async function logSqlQuery(
	request: Request,
	sql: string,
	params: unknown[],
	executionTimeMs: number,
	rowCount: number,
	env: Env,
	error?: string,
): Promise<void> {
	const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
	const ipHash = await pseudonymizeForLogs(clientIP);
	const sqlPreview = getSqlPreview(sql, (env.LOG_SQL_PREVIEW ?? 'true').toLowerCase() !== 'false');

	console.log(
		JSON.stringify({
			type: 'sql_query',
			ipHash,
			sqlPreview,
			sqlLength: sql.length,
			paramCount: params.length,
			executionTimeMs,
			rowCount,
			error: error || undefined,
		}),
	);

	// Write to Analytics Engine (non-blocking, fire-and-forget)
	if (env.OURA_ANALYTICS) {
		env.OURA_ANALYTICS.writeDataPoint({
			indexes: ['sql_query'],
			doubles: [executionTimeMs, rowCount, sql.length, error ? 1 : 0],
			blobs: [sqlPreview, ipHash, rowCount === -1 ? 'cache_hit' : 'cache_miss', error || ''],
		});
	}
}

// Validation constants
const MAX_SQL_LENGTH = 10_000;
const MAX_BACKFILL_DAYS = 3650;
const OPENAPI_CACHE_TTL = 86400; // 24 hours
const OURA_DOCS_URL = 'https://cloud.ouraring.com/v2/docs';
const OURA_OPENAPI_FALLBACK_URL = 'https://cloud.ouraring.com/v2/static/json/openapi-1.28.json';
const RESPONSE_CACHE_TTL = 300; // 5 minutes (use 'private' cache for authenticated endpoints)
const SQL_KV_CACHE_TTL = 21600; // 6 hours KV cache for SQL query results (data changes ~2-3x/day via cron)
const STATS_KV_CACHE_TTL = 21600; // 6 hours KV cache for stats/metadata queries
const DEFAULT_MAX_QUERY_ROWS = 50_000; // Default max rows for SQL queries
const DEFAULT_QUERY_TIMEOUT_MS = 7_000; // Default query timeout (7 seconds)
const MIN_QUERY_TIMEOUT_MS = 1_000; // Clamp to avoid invalid low/negative values
const MAX_QUERY_TIMEOUT_MS = 15_000; // Clamp to avoid excessively long-running queries
const MAX_PARAMS = 100; // Maximum SQL parameters
const MAX_BODY_SIZE = 1_048_576; // 1MB max request body size
const SYNC_SCHEDULE_DISPLAY = 'Every 2 hours (0 */2 * * * UTC)';
const SYNC_RESOURCE_CONCURRENCY = 4; // Parallel resources per sync run
const DEFAULT_CORS_ORIGINS = ['https://oura.keith20.dev', 'http://localhost:3000', 'http://localhost:8787'];

// Derive CORS origins from env each request — no mutable module-level state.
function getCorsOrigins(env: Pick<Env, 'ALLOWED_ORIGINS'>): string[] {
	return env.ALLOWED_ORIGINS
		? env.ALLOWED_ORIGINS.split(',')
				.map((o) => o.trim())
				.filter(Boolean)
		: DEFAULT_CORS_ORIGINS;
}

// Circuit breaker state (in-memory, resets on Worker restart)
const circuitBreakerState = {
	failures: 0,
	lastFailureTime: 0,
	state: 'closed' as 'closed' | 'open' | 'half-open',
};

const CIRCUIT_BREAKER_THRESHOLD = 5; // Open after 5 failures
const CIRCUIT_BREAKER_TIMEOUT = 300000; // 5 minutes before trying again

// Circuit breaker wrapper for Oura API calls
async function withCircuitBreaker<T>(fn: () => Promise<T>, operationName: string): Promise<T> {
	const now = Date.now();

	// If circuit is open, check if we should try half-open
	if (circuitBreakerState.state === 'open') {
		if (now - circuitBreakerState.lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
			console.log('Circuit breaker entering half-open state', { operation: operationName });
			circuitBreakerState.state = 'half-open';
		} else {
			throw new Error(`Circuit breaker is OPEN for ${operationName}. Try again later.`);
		}
	}

	try {
		const result = await fn();

		// Success: reset circuit if it was half-open
		if (circuitBreakerState.state === 'half-open') {
			console.log('Circuit breaker closed after successful call', { operation: operationName });
			circuitBreakerState.state = 'closed';
			circuitBreakerState.failures = 0;
		}

		return result;
	} catch (err) {
		circuitBreakerState.failures++;
		circuitBreakerState.lastFailureTime = now;

		if (circuitBreakerState.failures >= CIRCUIT_BREAKER_THRESHOLD) {
			console.error('Circuit breaker opened due to repeated failures', {
				operation: operationName,
				failures: circuitBreakerState.failures,
			});
			circuitBreakerState.state = 'open';
		}

		throw err;
	}
}

// Retry utility with exponential backoff for cron jobs
async function retryWithBackoff<T>(fn: () => Promise<T>, options: { maxRetries: number; baseDelay: number; maxDelay: number }): Promise<T> {
	const { maxRetries, baseDelay, maxDelay } = options;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));

			if (attempt === maxRetries) {
				console.error('Cron sync failed after max retries', {
					attempts: attempt + 1,
					error: lastError.message,
				});
				throw lastError;
			}

			const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
			console.warn('Cron sync attempt failed, retrying', {
				attempt: attempt + 1,
				maxRetries: maxRetries + 1,
				delayMs: delay,
				error: lastError.message,
			});

			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	if (items.length === 0) return [];

	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let nextIndex = 0;

	const run = async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				const value = await worker(items[index], index);
				results[index] = { status: 'fulfilled', value };
			} catch (reason) {
				results[index] = { status: 'rejected', reason };
			}
		}
	};

	await Promise.all(Array.from({ length: limit }, () => run()));
	return results;
}

export default {
	// 1. Cron Trigger: Automated Daily Sync
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			retryWithBackoff(
				async () => {
					const syncStart = Date.now();
					await syncData(env, 3, 0, null);
					await updateTableStats(env);
					// Record successful sync metadata for /health and /status endpoints
					if (env.OURA_CACHE) {
						try {
							await env.OURA_CACHE.put(
								'sync:last_success',
								JSON.stringify({
									timestamp: new Date().toISOString(),
									trigger: controller.cron,
									durationMs: Date.now() - syncStart,
								}),
								{ expirationTtl: 86400 * 7 }, // Keep for 7 days
							);
						} catch {
							// Non-fatal
						}
					}
				},
				{ maxRetries: 3, baseDelay: 5000, maxDelay: 60000 },
			).then(async () => {
				// Flush cached query results so dashboards see fresh data immediately.
				// Isolated from retry: a KV failure here should not re-trigger data sync.
				if (env.OURA_CACHE) {
					try {
						const flushed = await flushSqlCache(env.OURA_CACHE);
						console.log('SQL cache flushed after cron sync', { entriesFlushed: flushed });
					} catch (err) {
						console.warn('Cache flush failed after cron sync (non-fatal)', {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}),
		);
		// Clean up expired OAuth states (abandoned flows)
		ctx.waitUntil(
			env.oura_db
				.prepare('DELETE FROM oura_oauth_states WHERE created_at < ?')
				.bind(Date.now() - 24 * 60 * 60_000) // older than 24 hours
				.run()
				.catch((err) => console.warn('OAuth state cleanup failed (non-fatal)', { error: String(err) })),
		);
	},

	// 2. HTTP Fetch: API and Manual Backfill
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const corsOrigins = getCorsOrigins(env);
		const url = new URL(request.url);
		const auth = request.headers.get('Authorization');
		const origin = request.headers.get('Origin');
		// Request-scoped helper so all withCors calls use the same origins without global state
		const cors = (response: Response) => withCors(response, origin, corsOrigins);

		if (request.method === 'OPTIONS') {
			return cors(
				new Response(null, {
					status: 204,
					headers: {
						'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
						'Access-Control-Allow-Headers': 'Authorization,Content-Type',
					},
				}),
			);
		}

		// Security: Check request body size for POST/PUT requests
		if (request.method === 'POST' || request.method === 'PUT') {
			const contentLength = request.headers.get('Content-Length');
			if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
				return cors(Response.json({ error: 'Request body too large (max 1MB)' }, { status: 413 }));
			}
		}

		if (url.pathname === '/health') {
			// Rate limit: 1 request per minute per IP for health checks
			const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
			const rateLimitKey = await getRateLimitKey(clientIP, null, 'health');
			const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
			if (!success) {
				return cors(Response.json({ error: 'Rate limit exceeded. Max 1 request per 60 seconds.' }, { status: 429 }));
			}

			const healthAuth = request.headers.get('Authorization');
			const healthRole = await getBearerRole(healthAuth, env);

			// Base response (public)
			const healthResponse: Record<string, unknown> = {
				status: 'ok',
				timestamp: new Date().toISOString(),
				version: __APP_VERSION__,
			};

			// Last sync status (available to all authenticated callers)
			if (healthRole !== null && env.OURA_CACHE) {
				try {
					const lastSync = (await env.OURA_CACHE.get('sync:last_success', 'json')) as Record<string, unknown> | null;
					healthResponse.lastSync = lastSync ?? null;
				} catch {
					// Non-fatal — don't block health response
				}
			}

			// Full debug info (admin only) — includes request headers, CF properties, etc.
			if (healthRole === 'admin') {
				const headers: Record<string, string> = {};
				request.headers.forEach((value, key) => {
					// Strip sensitive headers even for admin (they don't need to round-trip auth tokens)
					if (!['authorization', 'cookie'].includes(key.toLowerCase())) {
						headers[key] = value;
					}
				});
				healthResponse.request = {
					headers,
					method: request.method,
					url: request.url,
					cf: request.cf,
				};
			}

			return cors(Response.json(healthResponse));
		}

		// Favicon - browsers automatically request this, don't require auth
		if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
		<text y="0.9em" font-size="90">💍</text>
	</svg>`;

			return cors(
				new Response(svg, {
					headers: {
						'Content-Type': 'image/svg+xml',
						'Cache-Control': 'public, max-age=31536000',
					},
				}),
			);
		}

		if (url.pathname === '/oauth/callback') {
			// Rate limit: Prevent OAuth callback abuse (apply unauthenticated rate limit)
			const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
			const rateLimitKey = await getRateLimitKey(clientIP, null, 'unauth');
			const { success } = await env.UNAUTH_RATE_LIMITER.limit({ key: rateLimitKey });
			if (!success) {
				return cors(Response.json({ error: 'Rate limit exceeded. Please wait before retrying.' }, { status: 429 }));
			}

			if (!env.oura_db) {
				return cors(Response.json({ error: 'D1 binding missing or misconfigured (oura_db)' }, { status: 500 }));
			}

			const err = url.searchParams.get('error');
			if (err) {
				// Validate error parameter length to prevent log injection
				const sanitizedError = err.slice(0, 200);
				return cors(Response.json({ error: sanitizedError }, { status: 400 }));
			}
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');

			// Validation: Check parameter lengths and formats
			if (!code || !state) {
				return cors(Response.json({ error: 'Missing code/state' }, { status: 400 }));
			}

			// Validation: OAuth authorization codes are typically 40-50 chars
			if (code.length < 10 || code.length > 100) {
				return cors(Response.json({ error: 'Invalid code format' }, { status: 400 }));
			}

			// Validation: State should be a UUID (36 chars) or similar
			if (state.length < 10 || state.length > 100) {
				return cors(Response.json({ error: 'Invalid state format' }, { status: 400 }));
			}

			const stateRow = await env.oura_db
				.prepare('SELECT user_id, created_at FROM oura_oauth_states WHERE state = ?')
				.bind(state)
				.first<OuraOAuthStateRow>();
			if (!stateRow) {
				return cors(Response.json({ error: 'Invalid state' }, { status: 400 }));
			}

			const createdAt = Number(stateRow.created_at);
			if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60_000) {
				await env.oura_db.prepare('DELETE FROM oura_oauth_states WHERE state = ?').bind(state).run();
				return cors(Response.json({ error: 'State expired' }, { status: 400 }));
			}

			await env.oura_db.prepare('DELETE FROM oura_oauth_states WHERE state = ?').bind(state).run();

			const callbackUrl = new URL(request.url);
			callbackUrl.search = '';
			const token = await exchangeAuthorizationCodeForToken(env, code, callbackUrl.toString());
			await upsertOauthToken(env, stateRow.user_id ?? 'default', token);
			return cors(Response.json({ message: 'OK' }, { status: 200 }));
		}

		// Security: Validate authentication using constant-time comparison
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
		const isAuthenticated = await validateBearerToken(auth, env);

		if (!isAuthenticated) {
			// Rate limit ONLY unauthenticated/failed auth requests (prevents brute-force)
			// Limit: 10 requests per minute per IP for failed auth attempts
			const unauthRateLimitKey = await getRateLimitKey(clientIP, null, 'unauth');
			const { success: unauthRateLimit } = await env.UNAUTH_RATE_LIMITER.limit({ key: unauthRateLimitKey });

			if (!unauthRateLimit) {
				await logAuthAttempt(false, request, env, 'Rate limit exceeded (unauthenticated)');
				return cors(Response.json({ error: 'Rate limit exceeded. Please wait before retrying.' }, { status: 429 }));
			}

			await logAuthAttempt(false, request, env, 'Invalid or missing token');
			return cors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
		}

		// Authentication successful - log it
		await logAuthAttempt(true, request, env);

		// Rate limit authenticated endpoints to prevent abuse if token leaks
		// Allows 3000 requests per minute per IP + token combination (50 per second sustained)
		const authRateLimitKey = await getRateLimitKey(clientIP, auth, 'auth');
		const { success: authRateLimit } = await env.AUTH_RATE_LIMITER.limit({ key: authRateLimitKey });

		if (!authRateLimit) {
			return cors(Response.json({ error: 'Rate limit exceeded. Maximum 3000 requests per minute.' }, { status: 429 }));
		}

		if (!env.oura_db) {
			return cors(Response.json({ error: 'D1 binding missing or misconfigured (oura_db)' }, { status: 500 }));
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

			const scopes = (env.OURA_SCOPES ?? 'email personal daily heartrate workout tag session spo2 stress heart_health ring_configuration')
				.split(/\s+/)
				.filter(Boolean)
				.join(' ');

			if (!env.OURA_CLIENT_ID) {
				return cors(Response.json({ error: 'Missing OURA_CLIENT_ID secret' }, { status: 500 }));
			}

			const authUrl = new URL('https://cloud.ouraring.com/oauth/authorize');
			authUrl.searchParams.set('response_type', 'code');
			authUrl.searchParams.set('client_id', env.OURA_CLIENT_ID);
			authUrl.searchParams.set('redirect_uri', callbackUrl.toString());
			authUrl.searchParams.set('scope', scopes);
			authUrl.searchParams.set('state', state);

			return Response.redirect(authUrl.toString(), 302);
		}

		if (url.pathname === '/backfill') {
			// Rate limit backfill: 1 request per 60 seconds per IP.
			// Backfill is expensive (fans out to all Oura API endpoints + D1 writes),
			// so this prevents accidental repeated triggers.
			const rateLimitKey = await getRateLimitKey(clientIP, auth, 'health');
			const { success: backfillRateOk } = await env.RATE_LIMITER.limit({ key: `backfill:${rateLimitKey}` });
			if (!backfillRateOk) {
				return cors(Response.json({ error: 'Rate limit exceeded. Please wait 60 seconds between backfill requests.' }, { status: 429 }));
			}

			const daysParam = url.searchParams.get('days');
			const days = daysParam ? Number(daysParam) : 730;
			const offsetParam = url.searchParams.get('offset_days') ?? url.searchParams.get('offsetDays');
			const offsetRaw = offsetParam ? Number(offsetParam) : 0;
			const offsetDays = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, MAX_BACKFILL_DAYS) : 0;
			const maxTotalDays = Math.max(0, MAX_BACKFILL_DAYS - offsetDays);
			const totalDays = Number.isFinite(days) && days > 0 ? Math.min(days, maxTotalDays) : 730;
			if (totalDays <= 0) {
				return cors(Response.json({ error: 'Backfill window out of range' }, { status: 400 }));
			}
			const resourcesParam = url.searchParams.get('resources');
			const resourceFilter = parseResourceFilter(resourcesParam);

			// Dispatch to Cloudflare Workflow for durable, retryable execution.
			// The Workflow runs each resource as an isolated step with its own retry budget,
			// eliminating CPU/subrequest limit concerns for large backfills.
			try {
				const params: BackfillParams = {
					totalDays,
					offsetDays,
					resources: resourceFilter ? [...resourceFilter] : undefined,
				};

				// Use a deterministic ID so duplicate requests within the rate limit window
				// are idempotent (Workflow.create throws if the ID already exists)
				const instanceId = `backfill-${totalDays}d-offset${offsetDays}-${Date.now()}`;

				const instance = await env.BACKFILL_WORKFLOW.create({
					id: instanceId,
					params,
				});

				console.log('Backfill workflow dispatched', {
					instanceId: instance.id,
					totalDays,
					offsetDays,
					resourceFilter: resourceFilter ? [...resourceFilter] : 'all',
				});

				return cors(
					Response.json(
						{
							message: 'Backfill workflow started.',
							instanceId: instance.id,
							statusUrl: `/backfill/status?id=${encodeURIComponent(instance.id)}`,
							totalDays,
							offsetDays,
						},
						{ status: 202 },
					),
				);
			} catch (err) {
				console.error('Failed to dispatch backfill workflow', {
					error: err instanceof Error ? err.message : String(err),
				});
				return cors(
					Response.json(
						{
							error: 'Failed to start backfill workflow',
							details: err instanceof Error ? err.message : String(err).slice(0, 500),
						},
						{ status: 500 },
					),
				);
			}
		}

		if (url.pathname === '/backfill/status') {
			const instanceId = url.searchParams.get('id');
			if (!instanceId) {
				return cors(Response.json({ error: 'Missing required parameter: id' }, { status: 400 }));
			}

			try {
				const instance = await env.BACKFILL_WORKFLOW.get(instanceId);
				const status = await instance.status();

				return cors(
					Response.json({
						instanceId,
						status: status.status,
						error: status.error || undefined,
						output: status.output || undefined,
					}),
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Workflow.get throws if the instance doesn't exist
				const isNotFound = message.includes('not found') || message.includes('does not exist');
				return cors(
					Response.json(
						{
							error: isNotFound ? 'Workflow instance not found' : 'Failed to fetch workflow status',
							details: message.slice(0, 500),
						},
						{ status: isNotFound ? 404 : 500 },
					),
				);
			}
		}

		if (url.pathname === '/api/daily_summaries') {
			const start = url.searchParams.get('start');
			const end = url.searchParams.get('end');
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

			if (start && !dateRegex.test(start)) {
				return cors(Response.json({ error: 'Invalid start date format (expected YYYY-MM-DD)' }, { status: 400 }));
			}
			if (end && !dateRegex.test(end)) {
				return cors(Response.json({ error: 'Invalid end date format (expected YYYY-MM-DD)' }, { status: 400 }));
			}

			const where: string[] = [];
			const args: unknown[] = [];

			if (start) {
				where.push('day >= ?');
				args.push(start);
			} else {
				// Default to last 90 days to avoid full table scans when no start date is specified
				const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().substring(0, 10);
				where.push('day >= ?');
				args.push(cutoff);
			}
			if (end) {
				where.push('day <= ?');
				args.push(end);
			}

			const whereSql = `WHERE ${where.join(' AND ')}`;
			try {
				const stmt = env.oura_db.prepare(`SELECT * FROM daily_summaries ${whereSql} ORDER BY day ASC`);
				const out = args.length ? await stmt.bind(...args).all() : await stmt.all();
				return cors(
					new Response(JSON.stringify(out.results), {
						headers: {
							'Content-Type': 'application/json',
							// Use 'private' cache since endpoint requires authentication
							'Cache-Control': `private, max-age=${RESPONSE_CACHE_TTL}`,
						},
					}),
				);
			} catch (err) {
				return cors(Response.json({ error: 'D1 query failed', details: String(err).slice(0, 500) }, { status: 500 }));
			}
		}

		if (url.pathname === '/api/sql' && request.method === 'POST') {
			const queryStartTime = Date.now();
			let sql = '';
			let params: unknown[] = [];

			try {
				const body = (await request.json().catch(() => null)) as { sql?: unknown; params?: unknown } | null;

				sql = typeof body?.sql === 'string' ? body.sql.trim() : '';
				params = Array.isArray(body?.params) ? body.params : [];

				// Validation: SQL length limit
				if (sql.length === 0) {
					return cors(Response.json({ error: 'SQL query is required' }, { status: 400 }));
				}

				if (sql.length > MAX_SQL_LENGTH) {
					return cors(Response.json({ error: `SQL too large (max ${MAX_SQL_LENGTH} characters)` }, { status: 400 }));
				}

				// Validation: Read-only queries only
				if (!isReadOnlySql(sql)) {
					await logSqlQuery(request, sql, params, Date.now() - queryStartTime, 0, env, 'Query blocked: not read-only');
					return cors(Response.json({ error: 'Only read-only SQL queries are allowed' }, { status: 400 }));
				}

				// Validation: Parameter count limit
				if (params.length > MAX_PARAMS) {
					return cors(Response.json({ error: `Too many parameters (max ${MAX_PARAMS})` }, { status: 400 }));
				}

				// Validation: Each param must be a bindable primitive (string, number, boolean, null)
				for (let i = 0; i < params.length; i++) {
					const p = params[i];
					if (p !== null && typeof p !== 'string' && typeof p !== 'number' && typeof p !== 'boolean') {
						return cors(
							Response.json({ error: `Invalid parameter type at index ${i}: expected string, number, boolean, or null` }, { status: 400 }),
						);
					}
				}

				// Security: Analyze query complexity
				const complexity = analyzeQueryComplexity(sql);
				if (complexity.score > 100) {
					console.warn('High complexity query', {
						complexity: complexity.score,
						warnings: complexity.warnings,
						sqlPreview: sql.slice(0, 100),
					});
				}

				// Cache: Check KV for cached result before hitting D1
				// Detect stats/metadata queries (COUNT(*) across all tables) for longer cache TTL
				const isStatsQuery = /COUNT\(\*\).*FROM\s+heart_rate_samples/i.test(sql) && /UNION\s+ALL/i.test(sql);
				const kvCacheTtl = isStatsQuery ? STATS_KV_CACHE_TTL : SQL_KV_CACHE_TTL;
				const cacheKey = `sql:${await hashSqlQuery(sql, params)}`;

				if (env.OURA_CACHE) {
					const cached = await env.OURA_CACHE.get(cacheKey);
					if (cached) {
						const executionTime = Date.now() - queryStartTime;
						await logSqlQuery(request, sql, params, executionTime, -1, env); // -1 = cache hit
						return cors(
							new Response(cached, {
								headers: {
									'Content-Type': 'application/json',
									'Cache-Control': `private, max-age=${kvCacheTtl}`,
									'X-Content-Type-Options': 'nosniff',
									'X-Frame-Options': 'DENY',
									'X-Query-Time-Ms': executionTime.toString(),
									'X-Cache': 'HIT',
								},
							}),
						);
					}
				}

				// Get configuration with defaults
				const parsedMaxRows = env.MAX_QUERY_ROWS ? parseInt(env.MAX_QUERY_ROWS, 10) : NaN;
				const maxRows = Number.isFinite(parsedMaxRows) ? parsedMaxRows : DEFAULT_MAX_QUERY_ROWS;
				const parsedTimeout = env.QUERY_TIMEOUT_MS ? parseInt(env.QUERY_TIMEOUT_MS, 10) : NaN;
				const timeoutCandidate = Number.isFinite(parsedTimeout) ? parsedTimeout : DEFAULT_QUERY_TIMEOUT_MS;
				const timeoutMs = Math.max(MIN_QUERY_TIMEOUT_MS, Math.min(timeoutCandidate, MAX_QUERY_TIMEOUT_MS));

				// Inject or cap LIMIT to prevent D1 from reading unlimited rows.
				// This avoids reading rows that would just be rejected by the post-query row-count check.
				const sqlTrimmed = sql.replace(/;\s*$/, '').trim();

				// Strip trailing SQL comments before LIMIT detection to prevent bypass via:
				//   "SELECT * FROM foo LIMIT 999999 -- comment" (would hide LIMIT from regex)
				let sqlForLimitCheck = sqlTrimmed.replace(/--[^\n]*$/, '').trim();
				sqlForLimitCheck = sqlForLimitCheck.replace(/\/\*[\s\S]*?\*\/\s*$/, '').trim();

				const limitMatch = sqlForLimitCheck.match(/\bLIMIT\s+(\d+)(\s*(?:OFFSET\s+\d+\s*)?)$/i);
				let effectiveSql: string;
				if (limitMatch) {
					const userLimit = parseInt(limitMatch[1], 10);
					if (userLimit > maxRows) {
						// Cap the outermost LIMIT to maxRows+1 so the post-query check still triggers correctly.
						// Use the match index to replace only the matched LIMIT at the end, not one in a subquery.
						const matchStart = limitMatch.index ?? sqlForLimitCheck.length;
						const offsetSuffix = limitMatch[2] || '';
						effectiveSql = sqlForLimitCheck.substring(0, matchStart) + `LIMIT ${maxRows + 1}` + offsetSuffix;
					} else {
						effectiveSql = sqlTrimmed;
					}
				} else {
					effectiveSql = `${sqlTrimmed} LIMIT ${maxRows + 1}`;
				}

				// Execute query with timeout
				const queryPromise = env.oura_db
					.prepare(effectiveSql)
					.bind(...params)
					.all();

				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error('Query timeout exceeded')), timeoutMs);
				});

				const result = await Promise.race([queryPromise, timeoutPromise]);

				const executionTime = Date.now() - queryStartTime;
				const rowCount = result.results?.length || 0;

				// Security: Enforce row limit
				if (rowCount > maxRows) {
					await logSqlQuery(request, sql, params, executionTime, rowCount, env, `Too many rows returned: ${rowCount}`);
					return cors(
						Response.json(
							{
								error: 'Query returned too many rows',
								hint: `Maximum ${maxRows} rows allowed. Please add a LIMIT clause or use more specific filters.`,
							},
							{ status: 400 },
						),
					);
				}

				// Log successful query
				await logSqlQuery(request, sql, params, executionTime, rowCount, env);

				// Use longer HTTP cache for stats queries (1 hour vs 5 minutes)
				const httpCacheTTL = isStatsQuery ? 3600 : RESPONSE_CACHE_TTL;

				const responseBody = JSON.stringify({ results: result.results, meta: result.meta });

				// Cache: Store result in KV for subsequent requests (non-blocking)
				if (env.OURA_CACHE) {
					ctx.waitUntil(env.OURA_CACHE.put(cacheKey, responseBody, { expirationTtl: kvCacheTtl }));
				}

				return cors(
					new Response(responseBody, {
						headers: {
							'Content-Type': 'application/json',
							'Cache-Control': `private, max-age=${httpCacheTTL}`,
							'X-Content-Type-Options': 'nosniff',
							'X-Frame-Options': 'DENY',
							'X-Query-Time-Ms': executionTime.toString(),
							'X-Row-Count': rowCount.toString(),
							'X-Cache': 'MISS',
						},
					}),
				);
			} catch (err) {
				const executionTime = Date.now() - queryStartTime;
				const errorMessage = err instanceof Error ? err.message : String(err);

				// Log failed query
				await logSqlQuery(request, sql, params, executionTime, 0, env, errorMessage);

				// Security: Don't leak detailed database errors to clients
				if (errorMessage.includes('timeout')) {
					return cors(
						Response.json(
							{
								error: 'Query timeout',
								hint: 'Your query took too long to execute. Try simplifying it or adding more specific filters.',
							},
							{ status: 408 },
						),
					);
				}

				// Generic error message (don't expose internal details)
				return cors(
					Response.json(
						{
							error: 'Query execution failed',
							hint: 'Please check your SQL syntax and try again.',
						},
						{ status: 500 },
					),
				);
			}
		}

		if (url.pathname === '/api/sql') {
			return cors(Response.json({ error: 'Method Not Allowed' }, { status: 405 }));
		}

		// Dedicated endpoint for table statistics (fast, approximate counts)
		if (url.pathname === '/api/stats') {
			try {
				// Use pre-computed stats table if available (most accurate)
				const { results: cachedStats } = await env.oura_db
					.prepare('SELECT resource, min_day, max_day, record_count, updated_at FROM table_stats ORDER BY resource')
					.all();

				if (cachedStats && cachedStats.length > 0) {
					return cors(
						new Response(JSON.stringify(cachedStats), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': 'private, max-age=3600',
							},
						}),
					);
				}

				// Fallback: compute stats on-demand (slow but accurate)
				// This will only run if table_stats is empty (first time)
				console.warn('table_stats empty, computing on-demand (slow)');

				const stats = await env.oura_db
					.prepare(
						`
				SELECT 'daily_summaries' AS resource, MIN(day) AS min_day, MAX(day) AS max_day, COUNT(*) AS record_count FROM daily_summaries
				UNION ALL
				SELECT 'sleep_episodes', MIN(day), MAX(day), COUNT(*) FROM sleep_episodes
				UNION ALL
				SELECT 'heart_rate_samples', MIN(timestamp), MAX(timestamp), COUNT(*) FROM heart_rate_samples
				UNION ALL
				SELECT 'activity_logs', MIN(start_datetime), MAX(start_datetime), COUNT(*) FROM activity_logs
				UNION ALL
				SELECT 'enhanced_tags', MIN(start_day), MAX(start_day), COUNT(*) FROM enhanced_tags
				UNION ALL
				SELECT 'rest_mode_periods', MIN(start_day), MAX(start_day), COUNT(*) FROM rest_mode_periods
			`,
					)
					.all();

				// Truncate datetime values to date-only (YYYY-MM-DD) for tables that store full timestamps
				const truncatedResults = (
					stats.results as Array<{ resource: string; min_day: string | null; max_day: string | null; record_count: number }>
				).map((row) => ({
					...row,
					min_day: row.min_day?.substring(0, 10) ?? null,
					max_day: row.max_day?.substring(0, 10) ?? null,
				}));

				return cors(
					new Response(JSON.stringify(truncatedResults), {
						headers: {
							'Content-Type': 'application/json',
							'Cache-Control': 'private, max-age=60', // Short cache since it's a fallback
						},
					}),
				);
			} catch (err) {
				return cors(Response.json({ error: 'Failed to fetch table stats', details: String(err).slice(0, 500) }, { status: 500 }));
			}
		}

		// Serve recent daily summaries (root endpoint)
		// Note: Grafana dashboard uses /api/sql exclusively; this endpoint is a convenience fallback.
		// Default to last 90 days to avoid full table scans. Use ?days=N to override (max 3650).
		if (url.pathname === '/') {
			try {
				const daysParam = url.searchParams.get('days');
				const days = Math.min(Math.max(parseInt(daysParam || '90', 10) || 90, 1), 3650);
				// Compute the cutoff date in JS to avoid any string interpolation in SQL
				const cutoff = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
				const { results } = await env.oura_db.prepare('SELECT * FROM daily_summaries WHERE day >= ? ORDER BY day ASC').bind(cutoff).all();
				return cors(
					new Response(JSON.stringify(results), {
						headers: {
							'Content-Type': 'application/json',
							// Use 'private' cache since endpoint requires authentication
							'Cache-Control': `private, max-age=${RESPONSE_CACHE_TTL}`,
						},
					}),
				);
			} catch (err) {
				return cors(Response.json({ error: 'D1 query failed', details: String(err).slice(0, 500) }, { status: 500 }));
			}
		}

		// Status page — requires auth (same as all endpoints below the auth gate)
		if (url.pathname === '/status') {
			try {
				const [lastSync, statsResult] = await Promise.all([
					env.OURA_CACHE
						? (env.OURA_CACHE.get('sync:last_success', 'json') as Promise<Record<string, unknown> | null>)
						: Promise.resolve(null),
					env.oura_db.prepare('SELECT resource, record_count, max_day, updated_at FROM table_stats ORDER BY resource').all(),
				]);

				const stats = statsResult.results as Array<{
					resource: string;
					record_count: number;
					max_day: string | null;
					updated_at: string | null;
				}>;
				const isHealthy = lastSync !== null;
				const lastSyncTime = lastSync?.timestamp as string | undefined;
				const lastSyncAgo = lastSyncTime ? Math.round((Date.now() - new Date(lastSyncTime).getTime()) / 60000) : null;

				const tableRows = stats.length
					? stats
							.map(
								(r) =>
									`\t\t\t<tr><td>${r.resource}</td><td>${r.record_count?.toLocaleString() ?? '—'}</td><td>${r.max_day ?? '—'}</td></tr>`,
							)
							.join('\n')
					: '\t\t\t<tr><td colspan="3"><em>No stats available — run a sync first</em></td></tr>';

				const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Oura Data Pipeline — Status</title>
	<style>
		body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #222; }
		h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
		.badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.85rem; font-weight: 600; }
		.ok { background: #d1fae5; color: #065f46; }
		.unknown { background: #fef3c7; color: #92400e; }
		table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
		th, td { padding: 0.45rem 0.6rem; border: 1px solid #e5e7eb; text-align: left; }
		th { background: #f9fafb; font-weight: 600; }
		.meta { color: #6b7280; font-size: 0.8rem; margin-top: 1.5rem; }
	</style>
</head>
<body>
	<h1>💍 Oura Data Pipeline</h1>
	<p>
		Status: <span class="badge ${isHealthy ? 'ok' : 'unknown'}">${isHealthy ? 'Operational' : 'Unknown'}</span>
		${lastSyncTime ? `&nbsp;&nbsp;Last sync: ${lastSyncAgo !== null ? `${lastSyncAgo}m ago` : lastSyncTime}` : '&nbsp;&nbsp;No sync recorded yet'}
	</p>
	<table>
		<thead><tr><th>Table</th><th>Records</th><th>Latest Day</th></tr></thead>
		<tbody>
${tableRows}
		</tbody>
	</table>
	<p class="meta">v${__APP_VERSION__} &nbsp;·&nbsp; Sync: ${SYNC_SCHEDULE_DISPLAY} &nbsp;·&nbsp; <a href="/health">health</a></p>
</body>
</html>`;

				return new Response(html, {
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': 'public, max-age=300',
					},
				});
			} catch (err) {
				return new Response('Status page error', { status: 500 });
			}
		}

		// No matching endpoint
		return cors(Response.json({ error: 'Not Found' }, { status: 404 }));
	},
};

async function syncData(env: Env, totalDays: number, offsetDays = 0, resourceFilter: Set<string> | null = null) {
	const syncStartTime = Date.now();
	const resourcesAll = await loadOuraResourcesFromOpenApi(env);
	const resources = resourceFilter ? resourcesAll.filter((r) => resourceFilter.has(r.resource)) : resourcesAll;

	// Process resources with bounded concurrency to avoid API/database bursts.
	const results = await mapWithConcurrency(resources, SYNC_RESOURCE_CONCURRENCY, async (r) => {
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
				const start = new Date(Date.now() - (offsetDays + i + windowDays) * 86400000).toISOString().split('T')[0];
				const end = new Date(Date.now() - (offsetDays + i) * 86400000).toISOString().split('T')[0];
				await ingestResource(env, r, { startDate: start, endDate: end });
				requestCount++;
			}

			return { resource: r.resource, success: true, requests: requestCount };
		} catch (err) {
			console.error('Resource sync failed', {
				resource: r.resource,
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
			return { resource: r.resource, success: false, error: err };
		}
	});

	// Log sync summary
	const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
	const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;
	const totalRequests = results.filter((r) => r.status === 'fulfilled').reduce((sum, r) => sum + (r.value.requests || 0), 0);
	const duration = Date.now() - syncStartTime;

	console.log('Sync completed', {
		totalResources: resources.length,
		successful,
		failed,
		totalRequests,
		durationMs: duration,
		durationSec: (duration / 1000).toFixed(2),
	});

	// Log failed resources for debugging
	const failedResources = results
		.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success))
		.map((r) => (r.status === 'fulfilled' ? r.value.resource : 'unknown'));

	if (failedResources.length > 0) {
		console.warn('Failed resources', {
			resources: failedResources,
			count: failedResources.length,
		});
	}

	// Throw if majority of resources failed so retryWithBackoff can actually retry
	if (resources.length > 0 && failed > resources.length / 2) {
		throw new Error(`Sync failed: ${failed}/${resources.length} resources failed (${failedResources.join(', ')})`);
	}
}

function parseResourceFilter(raw: string | null): Set<string> | null {
	if (!raw) return null;

	// Validation: Limit resources parameter length to prevent abuse
	if (raw.length > 500) {
		console.warn('Resource filter too long, truncating', { length: raw.length });
		raw = raw.slice(0, 500);
	}

	const parts = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	// Validation: Limit number of resources to prevent excessive filtering
	if (parts.length > 20) {
		console.warn('Too many resources specified, limiting to 20', { count: parts.length });
		parts.length = 20;
	}

	// Validation: Only allow alphanumeric and underscore in resource names
	const validParts = parts.filter((p) => /^[a-zA-Z0-9_]+$/.test(p));
	if (validParts.length !== parts.length) {
		console.warn('Invalid resource names filtered out', {
			original: parts.length,
			valid: validParts.length,
		});
	}

	if (!validParts.length) return null;
	return new Set(validParts);
}

function getChunkDaysForResource(r: OuraResource): number {
	// Oura endpoint constraint: heartrate requires start/end datetime range <= 30 days.
	// Use 29 days to stay safely under the limit.
	if (r.resource === 'heartrate') return 29;
	return 90;
}

// Normalize Oura resource names to handle renames/case changes across API versions.
// e.g., 'vO2_max' (1.28) -> 'vo2_max' (what saveToD1 expects)
const RESOURCE_ALIASES: Record<string, string> = {
	vO2_max: 'vo2_max',
};

async function saveToD1(env: Env, endpoint: string, data: JsonRecord[]) {
	// Normalize endpoint name to handle API version renames
	const normalizedEndpoint = RESOURCE_ALIASES[endpoint] ?? endpoint;
	const KNOWN_ENDPOINTS = new Set([
		'daily_readiness',
		'daily_sleep',
		'daily_activity',
		'daily_stress',
		'daily_resilience',
		'daily_spo2',
		'daily_cardiovascular_age',
		'vo2_max',
		'sleep',
		'heartrate',
		'workout',
		'session',
		'enhanced_tag',
		'rest_mode_period',
		'sleep_time',
	]);

	// daily_readiness -> daily_summaries (readiness fields)
	if (normalizedEndpoint === 'daily_readiness') {
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
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			const c = toJsonRecord(d.contributors);
			stmts.push(
				stmt.bind(
					d.day,
					toInt(d.score),
					toInt(c.activity_balance),
					toInt(c.body_temperature),
					toInt(c.hrv_balance),
					toInt(c.previous_day_activity),
					toInt(c.previous_night),
					toInt(c.recovery_index),
					toInt(c.resting_heart_rate),
					toInt(c.sleep_balance),
				),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_sleep -> daily_summaries (sleep fields)
	if (normalizedEndpoint === 'daily_sleep') {
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
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			const c = toJsonRecord(d.contributors);
			stmts.push(
				stmt.bind(
					d.day,
					toInt(d.score),
					toInt(c.deep_sleep),
					toInt(c.efficiency),
					toInt(c.latency),
					toInt(c.rem_sleep),
					toInt(c.restfulness),
					toInt(c.timing),
					toInt(c.total_sleep),
				),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_activity -> daily_summaries (activity fields)
	if (normalizedEndpoint === 'daily_activity') {
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
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			const c = toJsonRecord(d.contributors);
			stmts.push(
				stmt.bind(
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
					toInt(c.training_volume),
				),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_stress -> daily_summaries (stress_index)
	if (normalizedEndpoint === 'daily_stress') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, stress_index, updated_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				stress_index=excluded.stress_index,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toInt(d.stress_high ?? d.day_summary)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_resilience -> daily_summaries (resilience fields)
	if (normalizedEndpoint === 'daily_resilience') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, resilience_level, resilience_contributors_sleep, resilience_contributors_stress, updated_at)
			VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				resilience_level=excluded.resilience_level,
				resilience_contributors_sleep=excluded.resilience_contributors_sleep,
				resilience_contributors_stress=excluded.resilience_contributors_stress,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			const c = toJsonRecord(d.contributors);
			stmts.push(stmt.bind(d.day, d.level ?? null, toInt(c.sleep_recovery), toInt(c.daytime_recovery)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_spo2 -> daily_summaries (spo2 fields)
	if (normalizedEndpoint === 'daily_spo2') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, spo2_percentage, spo2_breathing_disturbance_index, updated_at)
			VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				spo2_percentage=excluded.spo2_percentage,
				spo2_breathing_disturbance_index=excluded.spo2_breathing_disturbance_index,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			const spo2 = toJsonRecord(d.spo2_percentage);
			stmts.push(stmt.bind(d.day, toReal(spo2.average), toInt(d.breathing_disturbance_index)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// daily_cardiovascular_age -> daily_summaries (cv_age_offset)
	if (normalizedEndpoint === 'daily_cardiovascular_age') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, cv_age_offset, updated_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				cv_age_offset=excluded.cv_age_offset,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toInt(d.vascular_age)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// vo2_max -> daily_summaries (vo2_max)
	// Note: Oura API renamed this from 'vo2_max' to 'vO2_max' in spec 1.28
	// RESOURCE_ALIASES normalizes it back to 'vo2_max'
	if (normalizedEndpoint === 'vo2_max') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, vo2_max, updated_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				vo2_max=excluded.vo2_max,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(stmt.bind(d.day, toReal(d.vo2_max)));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// sleep -> sleep_episodes
	if (normalizedEndpoint === 'sleep') {
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
				awake_duration=excluded.awake_duration`,
		);
		const stmts = [];
		for (const d of data) {
			const readiness = toJsonRecord(d.readiness);
			stmts.push(
				stmt.bind(
					d.id,
					d.day,
					d.bedtime_start ?? null,
					d.bedtime_end ?? null,
					d.type ?? null,
					toReal(d.average_heart_rate),
					toReal(d.lowest_heart_rate),
					toReal(d.average_hrv),
					toReal(d.average_breath),
					toReal(readiness.temperature_deviation ?? d.temperature_deviation),
					toInt(d.deep_sleep_duration),
					toInt(d.rem_sleep_duration),
					toInt(d.light_sleep_duration),
					toInt(d.awake_time),
				),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// heartrate -> heart_rate_samples
	if (normalizedEndpoint === 'heartrate') {
		const stmt = env.oura_db.prepare(
			'INSERT INTO heart_rate_samples (timestamp, bpm, source) VALUES (?, ?, ?) ' +
				'ON CONFLICT(timestamp) DO UPDATE SET bpm=excluded.bpm, source=excluded.source',
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
	if (normalizedEndpoint === 'workout') {
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
				hr_avg=excluded.hr_avg`,
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(
				stmt.bind(
					d.id,
					d.start_datetime ?? null,
					d.end_datetime ?? null,
					d.activity ?? d.sport ?? null,
					d.intensity ?? null,
					toReal(d.calories),
					toReal(d.distance),
					toReal(d.average_heart_rate),
				),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// session -> activity_logs (meditation/breathing sessions)
	if (normalizedEndpoint === 'session') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO activity_logs (id, type, start_datetime, end_datetime, activity_label, hr_avg, mood)
			VALUES (?, 'session', ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				start_datetime=excluded.start_datetime,
				end_datetime=excluded.end_datetime,
				activity_label=excluded.activity_label,
				hr_avg=excluded.hr_avg,
				mood=excluded.mood`,
		);
		const stmts = [];
		for (const d of data) {
			const heartRate = toJsonRecord(d.heart_rate);
			stmts.push(
				stmt.bind(d.id, d.start_datetime ?? null, d.end_datetime ?? null, d.type ?? null, toReal(heartRate.average), d.mood ?? null),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// enhanced_tag -> enhanced_tags (richer tag model with duration + custom names)
	if (normalizedEndpoint === 'enhanced_tag') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO enhanced_tags (id, start_day, end_day, start_time, end_time, tag_type_code, custom_name, comment)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				start_day=excluded.start_day,
				end_day=excluded.end_day,
				start_time=excluded.start_time,
				end_time=excluded.end_time,
				tag_type_code=excluded.tag_type_code,
				custom_name=excluded.custom_name,
				comment=excluded.comment`,
		);
		const stmts = [];
		for (const d of data) {
			stmts.push(
				stmt.bind(
					d.id,
					d.start_day ?? null,
					d.end_day ?? null,
					d.start_time ?? null,
					d.end_time ?? null,
					d.tag_type_code ?? null,
					d.custom_name ?? null,
					d.comment ?? null,
				),
			);
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// rest_mode_period -> rest_mode_periods
	if (normalizedEndpoint === 'rest_mode_period') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO rest_mode_periods (id, start_day, end_day, start_time, end_time, episodes_json)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				start_day=excluded.start_day,
				end_day=excluded.end_day,
				start_time=excluded.start_time,
				end_time=excluded.end_time,
				episodes_json=excluded.episodes_json`,
		);
		const stmts = [];
		for (const d of data) {
			const episodesJson = Array.isArray(d.episodes) ? JSON.stringify(d.episodes) : null;
			stmts.push(stmt.bind(d.id, d.start_day ?? null, d.end_day ?? null, d.start_time ?? null, d.end_time ?? null, episodesJson));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// sleep_time -> daily_summaries (sleep timing recommendation columns)
	if (normalizedEndpoint === 'sleep_time') {
		const stmt = env.oura_db.prepare(
			`INSERT INTO daily_summaries (day, sleep_time_optimal_bedtime, sleep_time_recommendation, sleep_time_status, updated_at)
			VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			ON CONFLICT(day) DO UPDATE SET
				sleep_time_optimal_bedtime=excluded.sleep_time_optimal_bedtime,
				sleep_time_recommendation=excluded.sleep_time_recommendation,
				sleep_time_status=excluded.sleep_time_status,
				updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
		);
		const stmts = [];
		for (const d of data) {
			// optimal_bedtime can be an object with start/end fields or a string
			const bedtime =
				typeof d.optimal_bedtime === 'object' && d.optimal_bedtime !== null
					? JSON.stringify(d.optimal_bedtime)
					: (d.optimal_bedtime ?? null);
			stmts.push(stmt.bind(d.day, bedtime, d.recommendation ?? null, d.status ?? null));
		}
		if (stmts.length) await env.oura_db.batch(stmts);
	}

	// Warn if a new Oura API endpoint was discovered but has no D1 handler
	if (!KNOWN_ENDPOINTS.has(normalizedEndpoint)) {
		console.warn('saveToD1: unhandled endpoint, data discarded', {
			endpoint: normalizedEndpoint,
			originalEndpoint: endpoint,
			recordCount: data.length,
		});
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

async function ingestResource(env: Env, r: OuraResource, window: { startDate: string; endDate: string } | null): Promise<void> {
	let nextToken: string | null = null;
	let page = 0;

	const accessToken = await getOuraAccessToken(env).catch((err) => {
		console.error('Failed to get Oura access token', {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			resource: r.resource,
		});
		// Re-throw so syncData sees this as a failed resource instead of silent success
		throw new Error(`Token acquisition failed for ${r.resource}: ${err instanceof Error ? err.message : String(err)}`);
	});

	while (true) {
		const url = buildOuraUrlForResource(r, window, nextToken);
		const res = await withCircuitBreaker(
			() =>
				fetchWithRetry(url, {
					headers: { Authorization: `Bearer ${accessToken}` },
				}),
			`Oura API - ${r.resource}`,
		);

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.error('Oura fetch failed', {
				resource: r.resource,
				status: res.status,
				statusText: res.statusText,
				responseBody: text.slice(0, 500),
				url: url,
			});
			throw new Error(`Oura API ${res.status} for ${r.resource}: ${res.statusText}`);
		}

		const json = await res.json().catch(() => null);
		if (!json || typeof json !== 'object') {
			console.error('Invalid JSON response from Oura', {
				resource: r.resource,
				url: url,
			});
			throw new Error(`Invalid JSON response from Oura for ${r.resource}`);
		}

		const apiResponse = json as OuraApiResponse<Record<string, unknown>>;
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
				message: 'Exceeded maximum pagination limit of 1000 pages',
			});
			return;
		}
	}
}

function buildOuraUrlForResource(r: OuraResource, window: { startDate: string; endDate: string } | null, nextToken: string | null): string {
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

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit, maxRetries = 3): Promise<Response> {
	let attempt = 0;
	while (true) {
		const res = await fetch(input, init);
		if (res.status !== 429 && res.status < 500) return res;
		attempt += 1;
		if (attempt > maxRetries) return res;
		// Respect Retry-After from API (seconds integer); fall back to exponential backoff
		const retryAfter = res.headers.get('Retry-After');
		const backoffMs =
			retryAfter && /^\d+$/.test(retryAfter.trim()) ? Math.min(parseInt(retryAfter.trim(), 10) * 1000, 60_000) : 250 * Math.pow(2, attempt);
		await new Promise((r) => setTimeout(r, backoffMs));
	}
}

// Discover the current OpenAPI spec URL from the Oura docs page.
// Falls back to OURA_OPENAPI_FALLBACK_URL if discovery fails.
async function discoverOpenApiSpecUrl(): Promise<string> {
	try {
		const res = await fetch(OURA_DOCS_URL);
		if (!res.ok) {
			console.warn('Oura docs page returned non-200, using fallback spec URL', {
				status: res.status,
			});
			return OURA_OPENAPI_FALLBACK_URL;
		}
		const html = await res.text();
		// Parse spec-url from: <redoc spec-url="/v2/static/json/openapi-X.YZ.json">
		const match = html.match(/spec-url=["']([^"']+)["']/);
		if (match?.[1]) {
			const specPath = match[1];
			const specUrl = specPath.startsWith('http') ? specPath : `https://cloud.ouraring.com${specPath}`;
			console.log('Discovered OpenAPI spec URL from docs page', { specUrl });
			return specUrl;
		}
		console.warn('Could not parse spec-url from Oura docs page, using fallback');
		return OURA_OPENAPI_FALLBACK_URL;
	} catch (err) {
		console.warn('Failed to fetch Oura docs page for spec discovery, using fallback', {
			error: err instanceof Error ? err.message : String(err),
		});
		return OURA_OPENAPI_FALLBACK_URL;
	}
}

async function loadOuraResourcesFromOpenApi(env: Env): Promise<OuraResource[]> {
	type OpenApiOperation = { parameters?: unknown };
	type OpenApiPaths = Record<string, JsonRecord>;

	// Try KV cache first (24 hour TTL)
	try {
		const cached = await env.OURA_CACHE.get('openapi_resources', 'json');
		if (cached && Array.isArray(cached)) {
			return cached as OuraResource[];
		}
	} catch (err) {
		console.warn('Failed to read from KV cache', {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Dynamically discover the current spec URL (resilient to version bumps)
	const specUrl = await discoverOpenApiSpecUrl();

	const res = await fetch(specUrl);
	if (!res.ok) {
		console.error('Failed to fetch Oura OpenAPI spec', {
			specUrl,
			status: res.status,
			statusText: res.statusText,
			message: 'Unable to load Oura API resource definitions. The spec URL may have changed.',
		});
		throw new Error(`Failed to fetch Oura OpenAPI spec: ${res.status} ${res.statusText} from ${specUrl}`);
	}
	const spec = (await res.json().catch(() => null)) as unknown;
	const specObj = toJsonRecord(spec);
	const paths = isJsonRecord(specObj.paths) ? (specObj.paths as OpenApiPaths) : {};
	const out: OuraResource[] = [];
	const forceDateWindow = new Set(['sleep', 'sleep_time', 'workout']);

	for (const [path, methods] of Object.entries(paths)) {
		if (typeof path !== 'string') continue;
		if (!path.startsWith('/v2/usercollection/')) continue;
		if (path.startsWith('/v2/sandbox/')) continue;
		if (path.includes('{')) continue;
		if (!isJsonRecord(methods)) continue;
		const getDef = methods.get as OpenApiOperation | undefined;
		if (!getDef) continue;

		const resource = path.replace('/v2/usercollection/', '');
		if (!resource) continue;

		const params = Array.isArray(getDef.parameters) ? getDef.parameters : [];
		const paramNames = new Set(
			params
				.map((p) => {
					const param = toJsonRecord(p);
					return typeof param.name === 'string' ? param.name : null;
				})
				.filter((name): name is string => typeof name === 'string'),
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

	console.log('Loaded Oura API resources from OpenAPI spec', {
		specUrl,
		resourceCount: out.length,
		resources: out.map((r) => r.resource),
	});

	// Cache in KV for 24 hours
	try {
		await env.OURA_CACHE.put('openapi_resources', JSON.stringify(out), {
			expirationTtl: OPENAPI_CACHE_TTL,
		});
	} catch (err) {
		console.warn('Failed to write to KV cache', {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return out;
}

function isReadOnlySql(sql: string): boolean {
	if (!sql) return false;
	const normalized = stripLeadingSqlComments(sql).replace(/\s+/g, ' ').trim().toLowerCase();

	// Must start with SELECT or WITH (CTE)
	if (!/^(select|with)\b/.test(normalized)) return false;

	// No multiple statements
	if (normalized.includes(';')) return false;

	// Block access to sensitive tables using safe static regex patterns
	// Use word boundaries to prevent substring matches while avoiding dynamic regex
	const blockedTablePatterns = [/\boura_oauth_tokens\b/i, /\boura_oauth_states\b/i];
	for (const pattern of blockedTablePatterns) {
		if (pattern.test(normalized)) {
			return false;
		}
	}

	// Block any write operations using safe static patterns
	const writeOpPatterns = [
		/\binsert\b/,
		/\bupdate\b/,
		/\bdelete\b/,
		/\bdrop\b/,
		/\balter\b/,
		/\bcreate\b/,
		/\breplace\s+into\b/, // Only block REPLACE INTO (write op), not REPLACE() string function
		/\bvacuum\b/,
		/\bpragma\b/,
		/\battach\b/,
		/\bdetach\b/,
	];
	for (const pattern of writeOpPatterns) {
		if (pattern.test(normalized)) {
			return false;
		}
	}

	// Check for potentially dangerous patterns
	// Block LIKE with leading wildcard (can be expensive)
	if (/like\s+['"]%/.test(normalized)) {
		console.warn('SQL query blocked: LIKE with leading wildcard', { sqlPreview: sql.slice(0, 100) });
		return false;
	}

	return true;
}

// Security: Analyze query complexity (simple heuristic)
function analyzeQueryComplexity(sql: string): { score: number; warnings: string[] } {
	const normalized = sql.toLowerCase();
	let score = 0;
	const warnings: string[] = [];

	// Count joins (each adds complexity)
	const joinCount = (normalized.match(/\bjoin\b/g) || []).length;
	score += joinCount * 10;
	if (joinCount > 5) warnings.push(`High join count: ${joinCount}`);

	// Count subqueries
	const subqueryCount = (normalized.match(/\(select\b/g) || []).length;
	score += subqueryCount * 15;
	if (subqueryCount > 3) warnings.push(`High subquery count: ${subqueryCount}`);

	// Count unions
	const unionCount = (normalized.match(/\bunion\b/g) || []).length;
	score += unionCount * 5;

	// LIKE operations can be expensive
	const likeCount = (normalized.match(/\blike\b/g) || []).length;
	score += likeCount * 5;

	// GROUP BY can be expensive on large datasets
	if (normalized.includes('group by')) {
		score += 20;
	}

	return { score, warnings };
}

async function exchangeAuthorizationCodeForToken(env: Env, code: string, redirectUri: string): Promise<OuraTokenResponse> {
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
				"ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token, refresh_token=COALESCE(excluded.refresh_token, oura_oauth_tokens.refresh_token), expires_at=excluded.expires_at, scope=excluded.scope, token_type=excluded.token_type, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
		)
		.bind(userId, token.access_token, token.refresh_token ?? null, expiresAt, token.scope ?? null, token.token_type ?? null)
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
	const hasValidAccess = accessToken && expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt > Date.now() + 60_000 : !!accessToken;

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

/**
 * Refresh table_stats with COUNT/MIN/MAX from each table.
 * This is expensive (full-table scans on heart_rate_samples, etc.), so by
 * default we gate it behind a KV cooldown. Pass `force: true` from backfill
 * or explicit refresh paths to bypass the cooldown.
 */
const STATS_COOLDOWN_MS = 6 * 3600_000; // 6 hours
const STATS_COOLDOWN_KEY = 'stats:last_updated';

async function updateTableStats(env: Env, { force = false }: { force?: boolean } = {}): Promise<void> {
	try {
		// Gate: skip the expensive refresh if we updated recently (unless forced)
		if (!force && env.OURA_CACHE) {
			const lastUpdated = await env.OURA_CACHE.get(STATS_COOLDOWN_KEY);
			if (lastUpdated && Date.now() - Number(lastUpdated) < STATS_COOLDOWN_MS) {
				console.log('Skipping table stats refresh (cooldown active)', {
					lastUpdated: new Date(Number(lastUpdated)).toISOString(),
					cooldownMs: STATS_COOLDOWN_MS,
				});
				return;
			}
		}

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
				// Use bare MIN/MAX on PK column for O(1) index lookup instead of substr() which forces full table scan
				query: `SELECT 'heart_rate_samples' AS resource, MIN(timestamp) AS min_day, MAX(timestamp) AS max_day, COUNT(*) AS record_count FROM heart_rate_samples`,
			},
			{
				resource: 'activity_logs',
				// Use bare MIN/MAX on indexed column for O(1) index lookup instead of substr() which forces full table scan
				query: `SELECT 'activity_logs' AS resource, MIN(start_datetime) AS min_day, MAX(start_datetime) AS max_day, COUNT(*) AS record_count FROM activity_logs`,
			},
			{
				resource: 'enhanced_tags',
				query: `SELECT 'enhanced_tags' AS resource, MIN(start_day) AS min_day, MAX(start_day) AS max_day, COUNT(*) AS record_count FROM enhanced_tags`,
			},
			{
				resource: 'rest_mode_periods',
				query: `SELECT 'rest_mode_periods' AS resource, MIN(start_day) AS min_day, MAX(start_day) AS max_day, COUNT(*) AS record_count FROM rest_mode_periods`,
			},
		];

		// Run all stat queries in parallel (they are independent reads)
		const settled = await Promise.allSettled(
			stats.map((stat) =>
				env.oura_db.prepare(stat.query).first<{
					resource: string;
					min_day: string | null;
					max_day: string | null;
					record_count: number;
				}>(),
			),
		);

		const updateStatements = [];
		for (let i = 0; i < settled.length; i++) {
			const entry = settled[i];
			if (entry.status === 'rejected') {
				console.warn('Stat query failed', {
					resource: stats[i].resource,
					error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
				});
				continue;
			}
			const result = entry.value;
			if (result) {
				// Truncate datetime values to date-only (YYYY-MM-DD) for tables that store full timestamps
				// This is needed because we removed substr() from the SQL for MIN/MAX index optimization
				const minDay = result.min_day?.substring(0, 10) ?? null;
				const maxDay = result.max_day?.substring(0, 10) ?? null;

				const stmt = env.oura_db.prepare(
					`INSERT INTO table_stats (resource, min_day, max_day, record_count, updated_at)
				VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				ON CONFLICT(resource) DO UPDATE SET
					min_day=excluded.min_day,
					max_day=excluded.max_day,
					record_count=excluded.record_count,
					updated_at=excluded.updated_at`,
				);
				updateStatements.push(stmt.bind(result.resource, minDay, maxDay, result.record_count));
			}
		}

		if (updateStatements.length) {
			await env.oura_db.batch(updateStatements);
		}

		// Record the update timestamp so future cron ticks can skip the refresh
		if (env.OURA_CACHE) {
			try {
				await env.OURA_CACHE.put(STATS_COOLDOWN_KEY, String(Date.now()), {
					expirationTtl: STATS_COOLDOWN_MS / 1000,
				});
			} catch {
				// Non-fatal — worst case we recompute stats next tick
			}
		}

		console.log('Table stats updated successfully', {
			tables_updated: updateStatements.length,
		});
	} catch (err) {
		console.error('Failed to update table stats', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ─── Backfill Workflow ───────────────────────────────────────────────────────
// Durable, retryable backfill orchestration via Cloudflare Workflows.
// Each resource sync runs as an isolated step with its own retry budget,
// so a transient Oura API failure for one resource doesn't block the rest.

type BackfillParams = {
	totalDays: number;
	offsetDays: number;
	resources?: string[]; // Optional subset of resources to sync
};

type BackfillResourceResult = {
	resource: string;
	success: boolean;
	requests: number;
	error?: string;
};

export class BackfillWorkflow extends WorkflowEntrypoint<Env, BackfillParams> {
	override async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep) {
		const { totalDays, offsetDays, resources: resourceNames } = event.payload;

		// Step 1: Discover available resources from Oura OpenAPI spec
		const allResources = await step.do(
			'discover-resources',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const loaded = await loadOuraResourcesFromOpenApi(this.env);
				// Return plain objects (must be serializable)
				return loaded.map((r) => ({
					resource: r.resource,
					path: r.path,
					queryMode: r.queryMode,
					paginated: r.paginated,
				}));
			},
		);

		// Filter to requested resources if specified
		const resourceFilter = resourceNames ? new Set(resourceNames) : null;
		const resources = resourceFilter ? allResources.filter((r) => resourceFilter.has(r.resource)) : allResources;

		console.log('Backfill workflow started', {
			instanceId: event.instanceId,
			totalDays,
			offsetDays,
			resourceCount: resources.length,
			filtered: !!resourceFilter,
		});

		// Step 2: Sync each resource as its own durable step
		// Each step is independently retryable — if heartrate fails, sleep still completes
		const results: BackfillResourceResult[] = [];

		for (const r of resources) {
			const result = await step.do(
				`sync:${r.resource}`,
				{
					retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
					// Generous timeout: large resources (heartrate) with many chunks can take minutes
					timeout: '5 minutes',
				},
				async () => {
					try {
						if (r.queryMode === 'none') {
							await ingestResource(this.env, r, null);
							return { resource: r.resource, success: true, requests: 1 } satisfies BackfillResourceResult;
						}

						const chunkDays = getChunkDaysForResource(r);
						let requestCount = 0;

						for (let i = 0; i < totalDays; i += chunkDays) {
							const windowDays = Math.min(chunkDays, totalDays - i);
							const start = new Date(Date.now() - (offsetDays + i + windowDays) * 86400000).toISOString().split('T')[0];
							const end = new Date(Date.now() - (offsetDays + i) * 86400000).toISOString().split('T')[0];
							await ingestResource(this.env, r, { startDate: start, endDate: end });
							requestCount++;
						}

						return { resource: r.resource, success: true, requests: requestCount } satisfies BackfillResourceResult;
					} catch (err) {
						console.error('Workflow resource sync failed', {
							resource: r.resource,
							error: err instanceof Error ? err.message : String(err),
						});
						// Re-throw so the step retry mechanism kicks in
						throw err;
					}
				},
			);

			results.push(result);
		}

		// Step 3: Update table stats after all resources are synced
		// Force refresh since backfill always writes meaningful new data
		await step.do('update-stats', { retries: { limit: 2, delay: '5 seconds', backoff: 'constant' }, timeout: '30 seconds' }, async () => {
			await updateTableStats(this.env, { force: true });
		});

		// Step 4: Flush SQL KV cache so dashboards see fresh data
		await step.do('flush-cache', { retries: { limit: 2, delay: '2 seconds', backoff: 'constant' }, timeout: '15 seconds' }, async () => {
			if (this.env.OURA_CACHE) {
				const flushed = await flushSqlCache(this.env.OURA_CACHE);
				console.log('Backfill workflow flushed SQL cache', { entriesFlushed: flushed });
			}
		});

		// Return summary for status polling
		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;
		const totalRequests = results.reduce((sum, r) => sum + r.requests, 0);

		console.log('Backfill workflow completed', {
			instanceId: event.instanceId,
			successful,
			failed,
			totalRequests,
		});

		return {
			totalDays,
			offsetDays,
			resources: results.length,
			successful,
			failed,
			totalRequests,
			results,
		};
	}
}

function withCors(response: Response, origin: string | null, allowedOrigins: string[] = DEFAULT_CORS_ORIGINS): Response {
	const headers = new Headers(response.headers);

	const allowOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

	// CORS headers
	headers.set('Access-Control-Allow-Origin', allowOrigin);
	headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
	headers.set('Vary', 'Origin');

	// Security headers
	if (!headers.has('X-Content-Type-Options')) {
		headers.set('X-Content-Type-Options', 'nosniff');
	}
	if (!headers.has('X-Frame-Options')) {
		headers.set('X-Frame-Options', 'DENY');
	}
	headers.set('X-XSS-Protection', '1; mode=block');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('Content-Security-Policy', "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';");

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
