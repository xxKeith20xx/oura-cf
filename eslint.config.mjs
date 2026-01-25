import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
	// Recommended base rules
	js.configs.recommended,
	...tseslint.configs.recommended,

	// Disable rules that conflict with Prettier
	prettier,

	// Custom configuration
	{
		languageOptions: {
			globals: {
				// Cloudflare Workers globals
				Request: 'readonly',
				Response: 'readonly',
				Headers: 'readonly',
				URL: 'readonly',
				crypto: 'readonly',
				fetch: 'readonly',
				console: 'readonly',
				ReadableStream: 'readonly',
				WritableStream: 'readonly',
			},
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// ===== Possible Errors =====
			'no-console': 'off', // console.log is fine in Workers for debugging

			// ===== Best Practices =====
			eqeqeq: ['error', 'always'], // Always use === instead of ==
			'no-var': 'error', // Use const/let instead of var
			'prefer-const': 'warn', // Use const when variable is never reassigned

			// ===== TypeScript Specific =====
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_', // Allow unused args starting with _
					varsIgnorePattern: '^_', // Allow unused vars starting with _
					caughtErrors: 'none', // Don't warn on unused catch variables
				},
			],
			'@typescript-eslint/no-explicit-any': 'warn', // Warn on 'any' types (we use it for external APIs)
			'@typescript-eslint/explicit-function-return-type': 'off', // Don't require return types (TypeScript infers)
			'@typescript-eslint/no-non-null-assertion': 'warn', // Warn on ! operator
		},
	},

	// Files to ignore
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'.wrangler/**',
			'*.config.mjs',
			'*.config.mts',
			'*.config.js',
			'*.config.ts',
			'migrations/**',
			'test/**',
			'worker-configuration.d.ts',
		],
	},
];
