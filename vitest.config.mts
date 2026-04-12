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
					OURA_CLIENT_ID: 'test-oura-client-id',
					OURA_CLIENT_SECRET: 'test-oura-client-secret',
					OURA_WEBHOOK_VERIFICATION_TOKEN: 'test-webhook-verification-token',
					OURA_WEBHOOK_CALLBACK_URL: 'https://example.com/webhook/oura',
					ALLOWED_ORIGINS: 'https://test.example.com',
				},
			},
		}),
	],
	define: {
		__APP_VERSION__: JSON.stringify('2.1.0'),
	},
	test: {},
});
