export interface Env {
  DB: D1Database;
  OURA_PAT: string;
  GRAFANA_SECRET: string;
}

export default {
  // 1. Cron Trigger: Automated Daily Sync
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncData(env, 3));
  },

  // 2. HTTP Fetch: API and Manual Backfill
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");

    if (auth !== `Bearer ${env.GRAFANA_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/backfill") {
      await syncData(env, 730); // Request 2 years
      return new Response("Backfill initiated.");
    }

    // Serve data to Grafana
    const { results } = await env.DB.prepare("SELECT * FROM daily_metrics ORDER BY day ASC").all();
    return Response.json(results);
  }
};

async function syncData(env: Env, totalDays: number) {
  const ENDPOINTS = ['daily_readiness', 'daily_sleep', 'daily_activity', 'daily_stress', 'heart_rate'];
  const CHUNK = 90; // Oura limit

  for (let i = 0; i < totalDays; i += CHUNK) {
    const start = new Date(Date.now() - (i + CHUNK) * 86400000).toISOString().split('T')[0];
    const end = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];

    for (const ep of ENDPOINTS) {
      const res = await fetch(`https://api.ouraring.com/v2/usercollection/${ep}?start_date=${start}&end_date=${end}`, {
        headers: { "Authorization": `Bearer ${env.OURA_PAT}` }
      });
      const { data } = await res.json() as any;
      if (data) await saveToD1(env, ep, data);
    }
  }
}

async function saveToD1(env: Env, endpoint: string, data: any[]) {
  // Mapping logic to insert/upsert data into D1 tables
  // Example for readiness
  if (endpoint === 'daily_readiness') {
     const stmt = env.DB.prepare("INSERT INTO daily_metrics (day, readiness_score) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET readiness_score=excluded.readiness_score");
     await env.DB.batch(data.map(d => stmt.bind(d.day, d.score)));
  }
}

