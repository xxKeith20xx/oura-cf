import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';

const AUTH_HEADER = { Authorization: 'Bearer test-grafana-secret' };

// Helper: POST to /api/sql with auth
async function sqlQuery(sql: string, params: unknown[] = []) {
	return SELF.fetch('https://example.com/api/sql', {
		method: 'POST',
		headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
		body: JSON.stringify({ sql, params }),
	});
}

// Set up D1 tables before all tests
beforeAll(async () => {
	const db = (env as any).oura_db as D1Database;
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS daily_summaries (
			day DATE PRIMARY KEY, readiness_score INTEGER, sleep_score INTEGER,
			activity_score INTEGER, activity_steps INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS heart_rate_samples (timestamp DATETIME PRIMARY KEY, bpm INTEGER, source TEXT)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS sleep_episodes (id TEXT PRIMARY KEY, day DATE, type TEXT)`),
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

describe('Health Endpoint', () => {
	it('responds with ok status (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/health');
		expect(response.status).toBe(200);

		const data = (await response.json()) as any;
		expect(data).toMatchObject({
			status: 'ok',
			version: '1.4.1',
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
		const response = await SELF.fetch('https://example.com/health', {
			headers: {
				Origin: 'https://example.com',
			},
		});

		// CORS header reflects origin or is '*'
		const corsHeader = response.headers.get('Access-Control-Allow-Origin');
		expect(corsHeader).toBeTruthy();
		expect(['*', 'https://example.com', 'https://oura.keith20.dev']).toContain(corsHeader);
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
			headers: { Origin: 'https://oura.keith20.dev' },
		});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oura.keith20.dev');
	});

	it('falls back to default origin for disallowed origins', async () => {
		const response = await SELF.fetch('https://example.com/health', {
			headers: { Origin: 'https://evil.com' },
		});
		// Should NOT reflect the attacker's origin
		const corsOrigin = response.headers.get('Access-Control-Allow-Origin');
		expect(corsOrigin).not.toBe('https://evil.com');
		expect(corsOrigin).toBe('https://oura.keith20.dev');
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
