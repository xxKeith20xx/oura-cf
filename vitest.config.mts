import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	define: {
		__APP_VERSION__: JSON.stringify('1.4.0'),
	},
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						GRAFANA_SECRET: 'test-grafana-secret',
						ADMIN_SECRET: 'test-admin-secret',
					},
				},
			},
		},
	},
});
