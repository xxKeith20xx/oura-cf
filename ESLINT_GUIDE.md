# ESLint Guide for Oura-CF

## What is ESLint?

ESLint is a **linter** - a tool that analyzes your code for potential errors, bugs, stylistic issues, and suspicious patterns **before you run it**.

### Why Use ESLint?

| Benefit                | Example                                              |
| ---------------------- | ---------------------------------------------------- |
| **Catch bugs early**   | Unused variables, unreachable code                   |
| **Enforce code style** | Consistent indentation, quotes, semicolons           |
| **Best practices**     | Avoid `==` (use `===`), no `var` (use `const`/`let`) |
| **Team consistency**   | Everyone writes code the same way                    |
| **Learn as you code**  | ESLint explains WHY something is wrong               |

### Linter vs. Formatter vs. Type Checker

| Tool                          | Purpose                   | Example                       |
| ----------------------------- | ------------------------- | ----------------------------- |
| **ESLint** (Linter)           | Find bugs & enforce rules | "This variable is never used" |
| **Prettier** (Formatter)      | Format code consistently  | "Use tabs, not spaces"        |
| **TypeScript** (Type Checker) | Verify types are correct  | "Expected string, got number" |

**You already have**:

- ✅ Prettier (`.prettierrc` exists)
- ✅ TypeScript (`tsconfig.json` exists)
- ❌ ESLint (not set up yet)

## Setting Up ESLint

### Step 1: Install ESLint

```bash
# Install ESLint and TypeScript support
npm install --save-dev eslint @eslint/js typescript-eslint

# Optional: Prettier integration (prevents conflicts)
npm install --save-dev eslint-config-prettier
```

### Step 2: Create Configuration

Create `eslint.config.mjs` in your project root:

```javascript
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
	// Recommended base rules
	js.configs.recommended,
	...tseslint.configs.recommended,

	// Disable rules that conflict with Prettier
	prettier,

	// Your custom rules
	{
		languageOptions: {
			globals: {
				// Cloudflare Workers globals
				Request: 'readonly',
				Response: 'readonly',
				crypto: 'readonly',
				console: 'readonly',
			},
			parserOptions: {
				project: './tsconfig.json',
			},
		},
		rules: {
			// Possible errors
			'no-console': 'off', // Allow console.log in Workers
			'no-unused-vars': 'off', // Use TypeScript's version
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],

			// Best practices
			eqeqeq: ['error', 'always'], // Always use ===
			'no-var': 'error', // Use const/let instead
			'prefer-const': 'warn', // Use const when possible

			// TypeScript specific
			'@typescript-eslint/no-explicit-any': 'warn', // Warn on 'any' types
			'@typescript-eslint/explicit-function-return-type': 'off',
		},
	},

	// Ignore patterns
	{
		ignores: ['node_modules/**', 'dist/**', '.wrangler/**', '*.config.mjs', '*.config.js'],
	},
];
```

### Step 3: Add NPM Scripts

Add to `package.json`:

```json
{
	"scripts": {
		"lint": "eslint .",
		"lint:fix": "eslint . --fix",
		"format": "prettier --write .",
		"format:check": "prettier --check .",
		"test": "vitest"
	}
}
```

## Understanding ESLint Rules

### Rule Levels

| Level            | Meaning  | Behavior                    |
| ---------------- | -------- | --------------------------- |
| `"off"` or `0`   | Disabled | Rule won't run              |
| `"warn"` or `1`  | Warning  | Shows warning, doesn't fail |
| `"error"` or `2` | Error    | Shows error, fails build    |

### Common Rules Explained

```typescript
// ❌ BAD: Using var
var x = 5;
// ✅ GOOD: Use const/let
const x = 5;
// Rule: "no-var": "error"

// ❌ BAD: Loose equality
if (x == '5') {
}
// ✅ GOOD: Strict equality
if (x === 5) {
}
// Rule: "eqeqeq": ["error", "always"]

// ❌ BAD: Unused variable
const unused = getData();
// ✅ GOOD: Remove or use it
const data = getData();
console.log(data);
// Rule: "@typescript-eslint/no-unused-vars": "warn"

// ❌ BAD: Could be const
let x = 5; // Never reassigned
// ✅ GOOD: Use const
const x = 5;
// Rule: "prefer-const": "warn"

// ⚠️ WARNING: Using 'any'
function getData(): any {}
// ✅ BETTER: Specific type
function getData(): UserData {}
// Rule: "@typescript-eslint/no-explicit-any": "warn"
```

## Running ESLint

```bash
# Check for issues (doesn't fix)
npm run lint

# Fix automatically fixable issues
npm run lint:fix

# Check specific file
npx eslint src/index.ts

# Check with verbose output
npm run lint -- --debug

# Lint and format together
npm run lint:fix && npm run format
```

### Understanding Output

```bash
$ npm run lint

src/index.ts
  10:7   error    'unused' is assigned a value but never used    @typescript-eslint/no-unused-vars
  25:15  warning  Unexpected any. Specify a different type       @typescript-eslint/no-explicit-any
  40:3   error    Expected '===' and instead saw '=='             eqeqeq

✖ 3 problems (2 errors, 1 warning)
  2 errors and 0 warnings potentially fixable with the `--fix` option.
```

**Breaking it down:**

- `src/index.ts` - File with issues
- `10:7` - Line 10, column 7
- `error` - Severity level
- `'unused' is assigned...` - Problem description
- `@typescript-eslint/no-unused-vars` - Rule name

## ESLint + Prettier Integration

### The Problem

ESLint and Prettier can conflict:

- ESLint: "Use single quotes"
- Prettier: "Use double quotes"

### The Solution

Use `eslint-config-prettier` to disable ESLint rules that conflict with Prettier.

```bash
npm install --save-dev eslint-config-prettier
```

Then in `eslint.config.mjs`, add `prettier` last:

```javascript
export default [
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettier, // Must be last! Disables conflicting rules
];
```

### Workflow

```bash
# 1. Lint code (find logic errors)
npm run lint:fix

# 2. Format code (fix style)
npm run format

# 3. Run tests
npm test
```

## Common ESLint Configurations

### Option 1: Strict (Recommended for New Projects)

```javascript
{
  rules: {
    '@typescript-eslint/no-explicit-any': 'error', // No 'any' types
    '@typescript-eslint/no-unused-vars': 'error', // No unused vars
    'eqeqeq': ['error', 'always'], // Always ===
    'no-console': 'error', // No console.log in production
  }
}
```

### Option 2: Relaxed (Good for Existing Projects)

```javascript
{
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn', // Warn on 'any'
    '@typescript-eslint/no-unused-vars': 'warn', // Warn on unused
    'eqeqeq': ['warn', 'always'], // Warn on ==
    'no-console': 'off', // Allow console.log
  }
}
```

### Option 3: Cloudflare Workers Specific

```javascript
{
  languageOptions: {
    globals: {
      // Cloudflare globals
      Request: 'readonly',
      Response: 'readonly',
      Headers: 'readonly',
      URL: 'readonly',
      crypto: 'readonly',
      fetch: 'readonly',
    },
  },
  rules: {
    'no-console': 'off', // console.log is fine in Workers
    '@typescript-eslint/no-explicit-any': 'warn', // 'any' for request handlers
  }
}
```

## Integrating with CI/CD

Add to `.github/workflows/test.yml`:

```yaml
name: Test & Lint

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm install
      - run: npm run lint
      - run: npm run format:check
      - run: npm test
```

## VSCode Integration

Install the ESLint extension:

1. Open VSCode Extensions (Cmd+Shift+X)
2. Search for "ESLint" by Microsoft
3. Install

### Auto-fix on save

Add to `.vscode/settings.json`:

```json
{
	"editor.codeActionsOnSave": {
		"source.fixAll.eslint": true
	},
	"editor.formatOnSave": true,
	"editor.defaultFormatter": "esbenp.prettier-vscode",
	"[typescript]": {
		"editor.defaultFormatter": "esbenp.prettier-vscode"
	}
}
```

## Common Issues

### Issue 1: "Parsing error: Cannot find module 'tsconfig.json'"

**Fix**: Update `eslint.config.mjs`:

```javascript
parserOptions: {
  project: './tsconfig.json',
  tsconfigRootDir: import.meta.dirname,
}
```

### Issue 2: "Global 'Request' is not defined"

**Fix**: Add Cloudflare globals:

```javascript
languageOptions: {
  globals: {
    Request: 'readonly',
    Response: 'readonly',
  },
}
```

### Issue 3: ESLint conflicts with Prettier

**Fix**: Install and add `eslint-config-prettier`:

```bash
npm install --save-dev eslint-config-prettier
```

```javascript
import prettier from 'eslint-config-prettier';

export default [
	// ... other configs
	prettier, // Must be last
];
```

## Best Practices

1. **Start relaxed, get stricter**
   - Begin with warnings, convert to errors over time
2. **Fix incrementally**
   - Don't fix 1000 errors at once
   - Fix one rule at a time

3. **Ignore generated files**

   ```javascript
   {
   	ignores: ['dist/**', '.wrangler/**', 'node_modules/**'];
   }
   ```

4. **Document custom rules**

   ```javascript
   rules: {
     // We use 'any' for external API responses that lack types
     '@typescript-eslint/no-explicit-any': 'warn',
   }
   ```

5. **Run in CI**
   - Prevent bad code from merging
   - Add to GitHub Actions

## Next Steps

1. Install ESLint: `npm install --save-dev eslint @eslint/js typescript-eslint`
2. Create `eslint.config.mjs` with recommended config
3. Run: `npm run lint` to see issues
4. Fix issues: `npm run lint:fix`
5. Commit the config: `git add eslint.config.mjs`

## Resources

- [ESLint Documentation](https://eslint.org/docs/latest/)
- [TypeScript ESLint](https://typescript-eslint.io/)
- [ESLint Rules Reference](https://eslint.org/docs/latest/rules/)
- [Cloudflare Workers ESLint Config](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/eslint-config-typescript)

---

**Remember**: ESLint helps you write better code, but don't let it slow you down. Start with warnings and adjust rules to fit your workflow!
