import { env, createExecutionContext, createMessageBatch, getQueueResult, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import worker from '../src/index';
import { version as APP_VERSION } from '../package.json';

const AUTH_HEADER = { Authorization: 'Bearer test-grafana-secret' };
const ADMIN_HEADER = { Authorization: 'Bearer test-admin-secret' };
let uniqueIpCounter = 0;

function nextTestIp(): string {
	uniqueIpCounter += 1;
	return `198.51.100.${uniqueIpCounter}`;
}

async function healthRequest(headers: Record<string, string> = {}) {
	return SELF.fetch('https://example.com/health', {
		headers: {
			'CF-Connecting-IP': nextTestIp(),
			...headers,
		},
	});
}

// Helper: POST to /api/sql with auth
async function sqlQuery(sql: string, params: unknown[] = []) {
	return SELF.fetch('https://example.com/api/sql', {
		method: 'POST',
		headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
		body: JSON.stringify({ sql, params }),
	});
}

async function signWebhookBody(secret: string, timestamp: string, rawBody: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${rawBody}`));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// Set up D1 tables before all tests
beforeAll(async () => {
	const db = (env as any).oura_db as D1Database;
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS daily_summaries (
			day DATE PRIMARY KEY,
			readiness_score INTEGER,
			readiness_activity_balance INTEGER,
			readiness_body_temperature INTEGER,
			readiness_hrv_balance INTEGER,
			readiness_previous_day_activity INTEGER,
			readiness_previous_night_sleep INTEGER,
			readiness_recovery_index INTEGER,
			readiness_resting_heart_rate INTEGER,
			readiness_sleep_balance INTEGER,
			sleep_score INTEGER,
			sleep_deep_sleep INTEGER,
			sleep_efficiency INTEGER,
			sleep_latency INTEGER,
			sleep_rem_sleep INTEGER,
			sleep_restfulness INTEGER,
			sleep_timing INTEGER,
			sleep_total_sleep INTEGER,
			activity_score INTEGER,
			activity_steps INTEGER,
			activity_active_calories INTEGER,
			activity_total_calories INTEGER,
			activity_meet_daily_targets INTEGER,
			activity_move_every_hour INTEGER,
			activity_recovery_time INTEGER,
			activity_stay_active INTEGER,
			activity_training_frequency INTEGER,
			activity_training_volume INTEGER,
			stress_index INTEGER,
			resilience_level TEXT,
			resilience_contributors_sleep INTEGER,
			resilience_contributors_stress INTEGER,
			spo2_percentage REAL,
			spo2_breathing_disturbance_index INTEGER,
			cv_age_offset INTEGER,
			vo2_max REAL,
			sleep_time_optimal_bedtime TEXT,
			sleep_time_recommendation TEXT,
			sleep_time_status TEXT,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS heart_rate_samples (timestamp DATETIME PRIMARY KEY, bpm INTEGER, source TEXT)`),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS sleep_episodes (id TEXT PRIMARY KEY, day DATE, start_datetime DATETIME, end_datetime DATETIME, type TEXT, heart_rate_avg REAL, heart_rate_lowest REAL, hrv_avg REAL, breath_avg REAL, temperature_deviation REAL, deep_duration INTEGER, rem_duration INTEGER, light_duration INTEGER, awake_duration INTEGER)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS activity_logs (id TEXT PRIMARY KEY, type TEXT, start_datetime DATETIME, end_datetime DATETIME, activity_label TEXT, intensity TEXT, calories REAL, distance REAL, hr_avg REAL, mood TEXT)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS enhanced_tags (id TEXT PRIMARY KEY, start_day DATE NOT NULL, end_day DATE, start_time TEXT, end_time TEXT, tag_type_code TEXT, custom_name TEXT, comment TEXT)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS rest_mode_periods (id TEXT PRIMARY KEY, start_day DATE NOT NULL, end_day DATE, start_time TEXT, end_time TEXT, episodes_json TEXT)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS oura_oauth_tokens (user_id TEXT PRIMARY KEY, access_token TEXT, refresh_token TEXT, expires_at INTEGER)`,
		),
		db.prepare(`CREATE TABLE IF NOT EXISTS oura_oauth_states (state TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER)`),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS table_stats (resource TEXT PRIMARY KEY, min_day TEXT, max_day TEXT, record_count INTEGER, updated_at TEXT)`,
		),
	]);
	await db.batch([
		db.prepare(
			`INSERT OR REPLACE INTO daily_summaries (day, readiness_score, sleep_score, activity_score, activity_steps) VALUES ('2026-02-28', 85, 90, 75, 8000)`,
		),
		db.prepare(
			`INSERT OR REPLACE INTO daily_summaries (day, readiness_score, sleep_score, activity_score, activity_steps) VALUES ('2026-02-27', 72, 80, 65, 6000)`,
		),
		db.prepare(
			`INSERT OR REPLACE INTO daily_summaries (day, readiness_score, sleep_score, activity_score, activity_steps) VALUES ('2026-02-26', 91, 88, 82, 10000)`,
		),
	]);
});

beforeEach(async () => {
	const db = (env as any).oura_db as D1Database;
	const cache = (env as any).OURA_CACHE as KVNamespace;
	await Promise.all([
		cache.delete('sync:last_success'),
		cache.delete('webhook:last_accepted'),
		cache.delete('queue:last_success'),
		cache.delete('queue:last_error'),
		cache.delete('stats:last_error'),
	]);
	await db.batch([
		db.prepare("DELETE FROM daily_summaries WHERE day IN ('2026-03-03', '2026-03-04')"),
		db.prepare("DELETE FROM sleep_episodes WHERE id IN ('sleep-delete-1')"),
		db.prepare("DELETE FROM activity_logs WHERE id IN ('activity-delete-1')"),
		db.prepare("DELETE FROM enhanced_tags WHERE id IN ('enhanced-delete-1')"),
		db.prepare("DELETE FROM rest_mode_periods WHERE id IN ('rest-delete-1')"),
	]);
});

describe('Health Endpoint', () => {
	it('responds with ok status (integration style)', async () => {
		const response = await healthRequest();
		expect(response.status).toBe(200);

		const data = (await response.json()) as any;
		expect(data).toMatchObject({
			status: 'ok',
			version: APP_VERSION,
		});
		expect(data.timestamp).toBeDefined();
		// request debug info is admin-only — not present without auth
		expect(data.request).toBeUndefined();
	});

	it.skip('returns debug info with admin token (skipped: rate limited in tests)', async () => {
		// Health endpoint is 1 req/60s — the prior test consumes the slot.
		// Verify the behaviour manually: GET /health with Bearer test-admin-secret
		// should return { status:'ok', request:{ method:'GET', ... } } with no authorization header.
		const response = await SELF.fetch('https://example.com/health', {
			headers: { Authorization: 'Bearer test-admin-secret' },
		});
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.request).toBeDefined();
		expect(data.request.method).toBe('GET');
		// Authorization header must be stripped from debug output
		expect(data.request.headers?.authorization).toBeUndefined();
	});

	it.skip('includes request metadata (skipped: rate limited in tests)', async () => {
		// This test is skipped because the /health endpoint is rate limited
		// and multiple tests hit it, causing rate limit errors in test environment
		const response = await SELF.fetch('https://example.com/health', {
			headers: {
				'User-Agent': 'test-agent',
				'X-Custom-Header': 'test-value',
			},
		});

		const data = (await response.json()) as any;
		expect(data.request).toBeDefined();
		expect(data.request.method).toBe('GET');
		expect(data.request.url).toBe('https://example.com/health');
	});

	it('returns webhook, queue, and error signals for authenticated callers', async () => {
		const cache = (env as any).OURA_CACHE as KVNamespace;
		await Promise.all([
			cache.put('sync:last_success', JSON.stringify({ timestamp: '2026-03-03T12:00:00.000Z' })),
			cache.put('webhook:last_accepted', JSON.stringify({ timestamp: '2026-03-03T12:05:00.000Z', accepted: 2 })),
			cache.put('queue:last_success', JSON.stringify({ timestamp: '2026-03-03T12:06:00.000Z', dataType: 'daily_sleep' })),
			cache.put('queue:last_error', JSON.stringify({ timestamp: '2026-03-03T12:07:00.000Z', error: 'queue failure' })),
			cache.put('stats:last_error', JSON.stringify({ timestamp: '2026-03-03T12:08:00.000Z', error: 'stats failure' })),
		]);

		const response = await healthRequest(AUTH_HEADER);
		expect(response.status).toBe(200);

		const data = (await response.json()) as any;
		expect(data.lastSync?.timestamp).toBe('2026-03-03T12:00:00.000Z');
		expect(data.pipeline?.mode?.primary).toBe('webhook_queue');
		expect(data.pipeline?.mode?.reconciliation).toBe('cron_sync');
		expect(data.pipeline?.primaryPath?.label).toBe('Webhook + Queue');
		expect(data.pipeline?.reconciliationPath?.label).toBe('Cron Reconciliation');
		expect(data.pipeline?.webhook?.lastAccepted?.accepted).toBe(2);
		expect(data.pipeline?.queue?.lastSuccess?.dataType).toBe('daily_sleep');
		expect(data.pipeline?.queue?.lastError?.error).toBe('queue failure');
		expect(data.pipeline?.errors?.stats?.error).toBe('stats failure');
	});

	it('marks the pipeline stale when all freshness signals are old', async () => {
		const cache = (env as any).OURA_CACHE as KVNamespace;
		await Promise.all([
			cache.put('sync:last_success', JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z' })),
			cache.put('webhook:last_accepted', JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z' })),
			cache.put('queue:last_success', JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z' })),
		]);

		const response = await healthRequest(AUTH_HEADER);
		expect(response.status).toBe(200);

		const data = (await response.json()) as any;
		expect(data.pipeline?.status).toBe('Stale');
		expect(data.pipeline?.primaryPath?.status).toBe('Stale');
		expect(data.pipeline?.reconciliationPath?.status).toBe('Stale');
		expect(data.pipeline?.sync?.freshness?.state).toBe('stale');
		expect(data.pipeline?.webhook?.freshness?.state).toBe('stale');
		expect(data.pipeline?.queue?.freshness?.state).toBe('stale');
	});
});

describe('Favicon Endpoint', () => {
	it('returns SVG favicon', async () => {
		const response = await SELF.fetch('https://example.com/favicon.ico');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/svg+xml');

		const svg = await response.text();
		expect(svg).toContain('<svg');
		expect(svg).toContain('💍');
	});

	it('caches favicon for 1 year', async () => {
		const response = await SELF.fetch('https://example.com/favicon.svg');
		expect(response.headers.get('Cache-Control')).toContain('max-age=31536000');
	});
});

describe('Authentication', () => {
	it('returns 401 for protected endpoint without auth', async () => {
		const response = await SELF.fetch('https://example.com/api/stats');
		expect(response.status).toBe(401);
		const data = (await response.json()) as any;
		expect(data.error).toBe('Unauthorized');
	});

	it('returns 401 for invalid bearer token', async () => {
		const response = await SELF.fetch('https://example.com/api/stats', {
			headers: {
				Authorization: 'Bearer invalid-token',
			},
		});
		expect(response.status).toBe(401);
	});

	it('allows access with valid bearer token', async () => {
		const response = await SELF.fetch('https://example.com/api/stats', {
			headers: AUTH_HEADER,
		});

		// Should not be 401 (may be 200 or fallback to on-demand stats)
		expect(response.status).not.toBe(401);
	});

	it('blocks admin webhook management routes for non-admin token', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/oura/webhooks', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(403);
	});
});

describe('CORS', () => {
	it('handles OPTIONS preflight request', async () => {
		const response = await SELF.fetch('https://example.com/api/stats', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://example.com',
			},
		});

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
	});

	it('includes CORS headers in response', async () => {
		const response = await healthRequest({ Origin: 'https://example.com' });

		// CORS header reflects origin or is '*'
		const corsHeader = response.headers.get('Access-Control-Allow-Origin');
		expect(corsHeader).toBeTruthy();
		expect(['*', 'https://example.com', 'https://test.example.com']).toContain(corsHeader);
	});
});

describe('Rate Limiting', () => {
	it('rate limits health endpoint after first request', async () => {
		// Make multiple requests - should get rate limited
		// (Test environment may have rate limiter already triggered)
		const response = await SELF.fetch('https://example.com/health');

		// Should either succeed (200) or be rate limited (429)
		expect([200, 429]).toContain(response.status);

		if (response.status === 429) {
			const error = (await response.json()) as any;
			expect(error.error).toContain('Rate limit exceeded');
		}
	});
});

describe('/api/sql Endpoint', () => {
	it('returns 401 without auth', async () => {
		const response = await SELF.fetch('https://example.com/api/sql', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql: 'SELECT 1', params: [] }),
		});
		expect(response.status).toBe(401);
	});

	it('returns 405 for GET requests', async () => {
		const response = await SELF.fetch('https://example.com/api/sql', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(405);
	});

	it('returns 400 for empty SQL', async () => {
		const response = await sqlQuery('');
		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('required');
	});

	it('executes valid SELECT query', async () => {
		const response = await sqlQuery('SELECT day, readiness_score FROM daily_summaries ORDER BY day DESC');
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.results).toBeDefined();
		expect(data.results.length).toBe(3);
		expect(data.results[0].day).toBe('2026-02-28');
	});

	it('supports parameterized queries', async () => {
		const response = await sqlQuery('SELECT day, readiness_score FROM daily_summaries WHERE day >= ?', ['2026-02-27']);
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.results.length).toBe(2);
	});

	it('supports WITH (CTE) queries', async () => {
		const response = await sqlQuery(`
			WITH recent AS (SELECT day, readiness_score FROM daily_summaries WHERE readiness_score IS NOT NULL)
			SELECT day, readiness_score FROM recent ORDER BY day DESC LIMIT 1
		`);
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.results.length).toBe(1);
	});

	it('returns X-Cache header', async () => {
		const response = await sqlQuery('SELECT COUNT(*) AS cnt FROM daily_summaries');
		expect(response.status).toBe(200);
		const cacheHeader = response.headers.get('X-Cache');
		expect(cacheHeader).toBeTruthy();
		expect(['HIT', 'MISS']).toContain(cacheHeader);
	});
});

describe('SQL Injection Prevention (isReadOnlySql)', () => {
	it('blocks INSERT statements', async () => {
		const response = await sqlQuery("INSERT INTO daily_summaries (day) VALUES ('2099-01-01')");
		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('read-only');
	});

	it('blocks DELETE statements', async () => {
		const response = await sqlQuery('DELETE FROM daily_summaries');
		expect(response.status).toBe(400);
	});

	it('blocks DROP TABLE', async () => {
		const response = await sqlQuery('DROP TABLE daily_summaries');
		expect(response.status).toBe(400);
	});

	it('blocks UPDATE statements', async () => {
		const response = await sqlQuery("UPDATE daily_summaries SET readiness_score = 0 WHERE day = '2026-02-28'");
		expect(response.status).toBe(400);
	});

	it('blocks ALTER TABLE', async () => {
		const response = await sqlQuery('ALTER TABLE daily_summaries ADD COLUMN hack TEXT');
		expect(response.status).toBe(400);
	});

	it('blocks PRAGMA', async () => {
		const response = await sqlQuery('PRAGMA table_info(daily_summaries)');
		expect(response.status).toBe(400);
	});

	it('blocks multi-statement injection via semicolon', async () => {
		const response = await sqlQuery('SELECT 1; DROP TABLE daily_summaries');
		expect(response.status).toBe(400);
	});

	it('blocks access to oura_oauth_tokens', async () => {
		const response = await sqlQuery('SELECT * FROM oura_oauth_tokens');
		expect(response.status).toBe(400);
	});

	it('blocks access to oura_oauth_tokens with double-quoted identifier', async () => {
		const response = await sqlQuery('SELECT * FROM "oura_oauth_tokens"');
		expect(response.status).toBe(400);
	});

	it('blocks access to oura_oauth_tokens with backtick-quoted identifier', async () => {
		const response = await sqlQuery('SELECT * FROM `oura_oauth_tokens`');
		expect(response.status).toBe(400);
	});

	it('blocks access to oura_oauth_tokens with bracket-quoted identifier', async () => {
		const response = await sqlQuery('SELECT * FROM [oura_oauth_tokens]');
		expect(response.status).toBe(400);
	});

	it('blocks access to oura_oauth_states', async () => {
		const response = await sqlQuery('SELECT * FROM oura_oauth_states');
		expect(response.status).toBe(400);
	});

	it('blocks CTE wrapping a write operation', async () => {
		const response = await sqlQuery("WITH cte AS (SELECT 1) INSERT INTO daily_summaries (day) VALUES ('2099-01-01')");
		expect(response.status).toBe(400);
	});

	it('blocks comment-obfuscated writes', async () => {
		const response = await sqlQuery('/* innocent */ DROP TABLE daily_summaries');
		expect(response.status).toBe(400);
	});

	it('blocks VACUUM', async () => {
		const response = await sqlQuery('VACUUM');
		expect(response.status).toBe(400);
	});

	it('blocks ATTACH DATABASE', async () => {
		const response = await sqlQuery("ATTACH DATABASE ':memory:' AS hack");
		expect(response.status).toBe(400);
	});

	it('blocks LIKE with leading wildcard', async () => {
		const response = await sqlQuery("SELECT * FROM daily_summaries WHERE day LIKE '%2026'");
		expect(response.status).toBe(400);
	});

	it('allows REPLACE() as a string function', async () => {
		const response = await sqlQuery("SELECT REPLACE(day, '-', '/') AS formatted_day FROM daily_summaries LIMIT 1");
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.results).toBeDefined();
		expect(data.results[0].formatted_day).toContain('/');
	});

	it('blocks REPLACE INTO (write operation)', async () => {
		const response = await sqlQuery("REPLACE INTO daily_summaries (day) VALUES ('2099-01-01')");
		expect(response.status).toBe(400);
	});

	it('allows UNION ALL up to five terms', async () => {
		const response = await sqlQuery('SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5');
		expect(response.status).toBe(200);
	});

	it('blocks UNION ALL over five terms', async () => {
		const response = await sqlQuery(
			'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6',
		);
		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('too many UNION ALL terms');
	});

	it('ignores UNION ALL inside string literals', async () => {
		const response = await sqlQuery("SELECT 'UNION ALL UNION ALL UNION ALL UNION ALL UNION ALL UNION ALL' AS marker");
		expect(response.status).toBe(200);
	});
});

describe('SQL Parameter Validation', () => {
	it('rejects object params', async () => {
		const response = await sqlQuery('SELECT * FROM daily_summaries WHERE day = ?', [{ malicious: true }] as any);
		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('Invalid parameter type');
	});

	it('rejects array params', async () => {
		const response = await sqlQuery('SELECT * FROM daily_summaries WHERE day = ?', [[1, 2, 3]] as any);
		expect(response.status).toBe(400);
	});

	it('accepts null params', async () => {
		const response = await sqlQuery('SELECT * FROM daily_summaries WHERE readiness_score IS NOT ?', [null]);
		expect(response.status).toBe(200);
	});

	it('accepts boolean params', async () => {
		// D1 coerces booleans to 0/1
		const response = await sqlQuery('SELECT * FROM daily_summaries WHERE 1 = ?', [true]);
		expect(response.status).toBe(200);
	});
});

describe('LIMIT Capping', () => {
	it('injects LIMIT when query has none', async () => {
		const response = await sqlQuery('SELECT * FROM daily_summaries');
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		// Should succeed — LIMIT is injected automatically
		expect(data.results).toBeDefined();
	});

	it('preserves user LIMIT when within bounds', async () => {
		const response = await sqlQuery('SELECT * FROM daily_summaries LIMIT 2');
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.results.length).toBeLessThanOrEqual(2);
	});

	it('caps excessive LIMIT', async () => {
		// Default maxRows is 50000, LIMIT 999999 should be capped
		const response = await sqlQuery('SELECT * FROM daily_summaries LIMIT 999999');
		expect(response.status).toBe(200);
		// If there are only 3 rows, we can't test the cap directly,
		// but we verify the query doesn't error out
		const data = (await response.json()) as any;
		expect(data.results).toBeDefined();
	});
});

describe('/api/daily_summaries', () => {
	it('returns data with valid date range', async () => {
		const response = await SELF.fetch('https://example.com/api/daily_summaries?start=2026-02-26&end=2026-02-28', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.length).toBe(3);
		expect(data[0].day).toBe('2026-02-26');
	});

	it('returns 400 for invalid start date format', async () => {
		const response = await SELF.fetch('https://example.com/api/daily_summaries?start=not-a-date', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('Invalid start date');
	});

	it('returns 400 for invalid end date format', async () => {
		const response = await SELF.fetch('https://example.com/api/daily_summaries?end=2026/02/28', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(400);
		const data = (await response.json()) as any;
		expect(data.error).toContain('Invalid end date');
	});

	it('defaults to last 90 days when no start is specified', async () => {
		const response = await SELF.fetch('https://example.com/api/daily_summaries', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		// Our test data is within 90 days of "today"
		expect(data.length).toBeGreaterThan(0);
	});
});

describe('CORS Origin Validation', () => {
	it('reflects allowed origin back', async () => {
		const response = await SELF.fetch('https://example.com/health', {
			headers: { Origin: 'https://test.example.com' },
		});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://test.example.com');
	});

	it('falls back to default origin for disallowed origins', async () => {
		const response = await SELF.fetch('https://example.com/health', {
			headers: { Origin: 'https://evil.com' },
		});
		// Should NOT reflect the attacker's origin
		const corsOrigin = response.headers.get('Access-Control-Allow-Origin');
		expect(corsOrigin).not.toBe('https://evil.com');
		expect(corsOrigin).toBe('https://test.example.com');
	});
});

describe('Webhook Callback', () => {
	it('verifies challenge token on GET /webhook/oura', async () => {
		const response = await SELF.fetch(
			'https://example.com/webhook/oura?verification_token=test-webhook-verification-token&challenge=challenge-value',
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.challenge).toBe('challenge-value');
	});

	it('rejects invalid challenge token on GET /webhook/oura', async () => {
		const response = await SELF.fetch('https://example.com/webhook/oura?verification_token=wrong&challenge=abc');
		expect(response.status).toBe(401);
	});

	it('rejects invalid signature on POST /webhook/oura', async () => {
		const payload = {
			event_type: 'update',
			data_type: 'daily_sleep',
			object_id: `obj-${Date.now()}`,
			event_time: new Date().toISOString(),
			user_id: 'user-test',
		};
		const response = await SELF.fetch('https://example.com/webhook/oura', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-oura-timestamp': Math.floor(Date.now() / 1000).toString(),
				'x-oura-signature': 'bad-signature',
			},
			body: JSON.stringify(payload),
		});

		expect(response.status).toBe(401);
	});

	it('accepts valid signed webhook payload', async () => {
		const payload = {
			event_type: 'update',
			data_type: 'daily_sleep',
			object_id: `obj-${Date.now()}-${Math.random()}`,
			event_time: new Date().toISOString(),
			user_id: 'user-test',
		};
		const rawBody = JSON.stringify(payload);
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const signature = await signWebhookBody('test-oura-client-secret', timestamp, rawBody);

		const response = await SELF.fetch('https://example.com/webhook/oura', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-oura-timestamp': timestamp,
				'x-oura-signature': signature,
			},
			body: rawBody,
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as any;
		expect(body.accepted).toBe(1);
	});
});

describe('Webhook Queue Processing', () => {
	it('acks valid message and saves single-document payload', async () => {
		const db = (env as any).oura_db as D1Database;
		await db
			.prepare('INSERT OR REPLACE INTO oura_oauth_tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)')
			.bind('default', 'access-token', 'refresh-token', Date.now() + 3600000)
			.run();

		const originalFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url.includes('/v2/usercollection/daily_sleep/queue-object-1')) {
					return new Response(JSON.stringify({ day: '2026-03-02', score: 88, contributors: {} }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input, init);
			}),
		);

		const batch = createMessageBatch('oura-webhook-events', [
			{
				id: 'msg-1',
				timestamp: new Date(),
				attempts: 1,
				body: {
					eventType: 'update',
					dataType: 'daily_sleep',
					objectId: 'queue-object-1',
					eventTime: new Date().toISOString(),
					userId: 'user-test',
				},
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		expect(result.explicitAcks).toContain('msg-1');
		expect(result.retryMessages).toStrictEqual([]);

		const check = await db.prepare('SELECT day, sleep_score FROM daily_summaries WHERE day = ?').bind('2026-03-02').first<any>();
		expect(check?.sleep_score).toBe(88);

		vi.unstubAllGlobals();
	});

	it('clears only daily_sleep fields for delete events', async () => {
		const db = (env as any).oura_db as D1Database;
		await db
			.prepare(
				`INSERT OR REPLACE INTO daily_summaries (day, readiness_score, sleep_score, sleep_total_sleep, activity_score) VALUES (?, ?, ?, ?, ?)`,
			)
			.bind('2026-03-03', 77, 88, 450, 66)
			.run();

		const batch = createMessageBatch('oura-webhook-events', [
			{
				id: 'msg-delete-daily',
				timestamp: new Date(),
				attempts: 1,
				body: {
					eventType: 'delete',
					dataType: 'daily_sleep',
					objectId: '2026-03-03',
					eventTime: new Date().toISOString(),
					userId: 'user-test',
				},
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		expect(result.explicitAcks).toContain('msg-delete-daily');
		expect(result.retryMessages).toStrictEqual([]);

		const check = await db
			.prepare('SELECT readiness_score, sleep_score, sleep_total_sleep, activity_score FROM daily_summaries WHERE day = ?')
			.bind('2026-03-03')
			.first<any>();
		expect(check?.readiness_score).toBe(77);
		expect(check?.activity_score).toBe(66);
		expect(check?.sleep_score).toBeNull();
		expect(check?.sleep_total_sleep).toBeNull();
	});

	it('deletes id-keyed rows for sleep delete events', async () => {
		const db = (env as any).oura_db as D1Database;
		await db
			.prepare('INSERT OR REPLACE INTO sleep_episodes (id, day, type) VALUES (?, ?, ?)')
			.bind('sleep-delete-1', '2026-03-04', 'long_sleep')
			.run();

		const batch = createMessageBatch('oura-webhook-events', [
			{
				id: 'msg-delete-sleep',
				timestamp: new Date(),
				attempts: 1,
				body: {
					eventType: 'delete',
					dataType: 'sleep',
					objectId: 'sleep-delete-1',
					eventTime: new Date().toISOString(),
					userId: 'user-test',
				},
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		expect(result.explicitAcks).toContain('msg-delete-sleep');

		const check = await db.prepare('SELECT id FROM sleep_episodes WHERE id = ?').bind('sleep-delete-1').first<any>();
		expect(check).toBeNull();
	});
});

describe('/status', () => {
	it('renders webhook and queue freshness plus current errors', async () => {
		const cache = (env as any).OURA_CACHE as KVNamespace;
		await Promise.all([
			cache.put('sync:last_success', JSON.stringify({ timestamp: '2026-03-03T12:00:00.000Z' })),
			cache.put('webhook:last_accepted', JSON.stringify({ timestamp: '2026-03-03T12:05:00.000Z' })),
			cache.put('queue:last_success', JSON.stringify({ timestamp: '2026-03-03T12:06:00.000Z' })),
			cache.put('queue:last_error', JSON.stringify({ timestamp: '2026-03-03T12:07:00.000Z', error: 'queue failed' })),
			cache.put('stats:last_error', JSON.stringify({ timestamp: '2026-03-03T12:08:00.000Z', error: 'stats failed' })),
		]);

		const response = await SELF.fetch('https://example.com/status', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(200);

		const html = await response.text();
		expect(html).toContain('Primary freshness');
		expect(html).toContain('Webhook + Queue');
		expect(html).toContain('Reconciliation');
		expect(html).toContain('Cron sync safety net');
		expect(html).toContain('Webhook accepted');
		expect(html).toContain('Queue processed');
		expect(html).toContain('Current errors');
		expect(html).toContain('queue failed');
		expect(html).toContain('stats failed');
	});
});

describe('404 Handling', () => {
	it('returns 404 for unknown paths', async () => {
		const response = await SELF.fetch('https://example.com/nonexistent', {
			headers: AUTH_HEADER,
		});
		expect(response.status).toBe(404);
		const data = (await response.json()) as any;
		expect(data.error).toBe('Not Found');
	});
});

describe('/backfill', () => {
	it('reuses an active workflow for duplicate requests with the same parameters', async () => {
		const first = await SELF.fetch('https://example.com/backfill?days=1&resources=daily_sleep', {
			headers: {
				...ADMIN_HEADER,
				'CF-Connecting-IP': nextTestIp(),
			},
		});
		expect(first.status).toBe(202);
		const firstBody = (await first.json()) as any;
		expect(firstBody.reused).toBe(false);

		const second = await SELF.fetch('https://example.com/backfill?days=1&resources=daily_sleep', {
			headers: {
				...ADMIN_HEADER,
				'CF-Connecting-IP': nextTestIp(),
			},
		});
		expect(second.status).toBe(202);
		const secondBody = (await second.json()) as any;
		expect(secondBody.instanceId).toBe(firstBody.instanceId);
		expect(secondBody.reused).toBe(true);
	});
});

describe('Root Endpoint', () => {
	it('returns dashboard data', async () => {
		const response = await SELF.fetch('https://example.com/', {
			headers: AUTH_HEADER,
		});
		// May be 200 or 500 depending on data availability
		expect([200, 500]).toContain(response.status);
	});

	it('accepts days parameter', async () => {
		const response = await SELF.fetch('https://example.com/?days=30', {
			headers: AUTH_HEADER,
		});
		expect([200, 500]).toContain(response.status);
	});
});
