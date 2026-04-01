import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					GRAFANA_SECRET: 'test-grafana-secret',
					ADMIN_SECRET: 'test-admin-secret',
				},
			},
		}),
	],
	define: {
		__APP_VERSION__: JSON.stringify('1.4.3'),
	},
	test: {},
});
