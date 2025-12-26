export interface Env {
	oura_db: D1Database;
  OURA_PAT: string;
  GRAFANA_SECRET: string;
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
    ctx.waitUntil(syncData(env, 3));
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

    if (auth !== `Bearer ${env.GRAFANA_SECRET}`) {
			return withCors(new Response('Unauthorized', { status: 401 }), origin);
    }

    if (url.pathname === "/backfill") {
			ctx.waitUntil(syncData(env, 730)); // Request 2 years
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
			const stmt = env.oura_db.prepare(
				`SELECT * FROM daily_summaries ${whereSql} ORDER BY day ASC`
			);
			const out = args.length ? await stmt.bind(...args).all() : await stmt.all();
			return withCors(Response.json(out.results), origin);
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

			const result = await env.oura_db.prepare(sql).bind(...params).all();
			return withCors(
				Response.json({ results: result.results, meta: result.meta }),
				origin
			);
		}

		if (url.pathname === '/api/sql') {
			return withCors(new Response('Method Not Allowed', { status: 405 }), origin);
		}

    // Serve data to Grafana
		const { results } = await env.oura_db
			.prepare('SELECT * FROM daily_summaries ORDER BY day ASC')
			.all();
		return withCors(Response.json(results), origin);
  }
};

async function syncData(env: Env, totalDays: number) {
	const resources = await loadOuraResourcesFromOpenApi();
	const chunkDays = 90;

	for (const r of resources) {
		if (r.queryMode === 'none') {
			await ingestResource(env, r, null);
			continue;
		}

		for (let i = 0; i < totalDays; i += chunkDays) {
			const start = new Date(Date.now() - (i + chunkDays) * 86400000)
				.toISOString()
				.split('T')[0];
			const end = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
			await ingestResource(env, r, { startDate: start, endDate: end });
		}
	}
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

	while (true) {
		const url = buildOuraUrlForResource(r, window, nextToken);
		const res = await fetchWithRetry(url, {
			headers: { Authorization: `Bearer ${env.OURA_PAT}` },
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
				await saveRawDocuments(env, r.resource, data);
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

	for (const [path, methods] of Object.entries(paths)) {
		if (typeof path !== 'string') continue;
		if (!path.startsWith('/v2/usercollection/')) continue;
		if (path.startsWith('/v2/sandbox/')) continue;
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
	return !/\b(insert|update|delete|drop|alter|create|replace|vacuum|pragma|attach|detach)\b/i.test(normalized);
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
		const documentId = String(d?.id ?? d?.day ?? crypto.randomUUID());
		const day = typeof d?.day === 'string' ? d.day : null;
		const startAt = typeof d?.start_datetime === 'string' ? d.start_datetime : typeof d?.start_time === 'string' ? d.start_time : null;
		const endAt = typeof d?.end_datetime === 'string' ? d.end_datetime : typeof d?.end_time === 'string' ? d.end_time : null;
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

