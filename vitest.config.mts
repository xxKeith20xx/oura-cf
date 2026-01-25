import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: {
					configPath: './wrangler.jsonc',
				},
				miniflare: {
					// Use local mode in CI (no Cloudflare authentication required)
					compatibilityDate: '2025-01-23',
					compatibilityFlags: ['nodejs_compat_v2'],
				},
			},
		},
	},
});
