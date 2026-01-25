# Testing Guide for Oura-CF

## What is Testing?

Testing is writing code that automatically verifies your application works correctly.

### Why Test?

- ✅ **Catch bugs early** - Find issues before users do
- ✅ **Confidence** - Refactor code without fear
- ✅ **Documentation** - Tests show how code should work
- ✅ **Regression prevention** - Ensure old bugs don't return

## Your Testing Stack

| Package                             | Version | Purpose                                 |
| ----------------------------------- | ------- | --------------------------------------- |
| **Vitest**                          | 3.2.4   | Fast, modern test framework (like Jest) |
| **@cloudflare/vitest-pool-workers** | 0.12.6  | Test Workers with D1, KV, etc.          |
| **TypeScript**                      | 5.9.3   | Type-safe tests                         |

## Test Types

### 1. Unit Tests

Test individual functions in isolation.

```typescript
// Example: Test a pure function
function add(a: number, b: number) {
	return a + b;
}

// Test
it('adds two numbers', () => {
	expect(add(2, 3)).toBe(5);
});
```

### 2. Integration Tests

Test how multiple parts work together.

```typescript
// Example: Test an API endpoint
it('returns user data from database', async () => {
	const response = await fetch('/api/user/123');
	const data = await response.json();
	expect(data.name).toBe('John');
});
```

### 3. End-to-End (E2E) Tests

Test the entire application flow (we won't cover these now).

## Your Test Structure

```
test/
├── index.spec.ts       # Your test file
├── tsconfig.json       # TypeScript config for tests
└── env.d.ts           # Environment type definitions
```

### Test File Naming Conventions

| Pattern          | Example            | When to Use                    |
| ---------------- | ------------------ | ------------------------------ |
| `*.test.ts`      | `api.test.ts`      | Jest/Vitest standard           |
| `*.spec.ts`      | `api.spec.ts`      | BDD style (your current style) |
| `__tests__/*.ts` | `__tests__/api.ts` | Jest convention                |

**You're using**: `*.spec.ts` (perfectly fine!)

## Vitest Basics

### Writing a Test

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature Name', () => {
	it('does something specific', () => {
		// Arrange: Set up test data
		const input = 'hello';

		// Act: Run the code
		const result = input.toUpperCase();

		// Assert: Check the result
		expect(result).toBe('HELLO');
	});
});
```

### Common Matchers

```typescript
// Equality
expect(value).toBe(5); // Exact match (===)
expect(value).toEqual({ a: 1 }); // Deep equality
expect(value).toMatchObject({ a: 1 }); // Partial match

// Truthiness
expect(value).toBeTruthy(); // Truthy value
expect(value).toBeFalsy(); // Falsy value
expect(value).toBeNull(); // Exactly null
expect(value).toBeUndefined(); // Exactly undefined

// Numbers
expect(value).toBeGreaterThan(3);
expect(value).toBeLessThan(5);
expect(value).toBeCloseTo(3.14, 2); // Floating point

// Strings
expect(string).toContain('hello');
expect(string).toMatch(/hello/i); // Regex

// Arrays
expect(array).toContain('item');
expect(array).toHaveLength(3);

// Async
await expect(promise).resolves.toBe(5);
await expect(promise).rejects.toThrow();
```

## Testing Cloudflare Workers

### Method 1: Unit Style (More Control)

```typescript
import { env, createExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

it('tests endpoint', async () => {
	// Create a request
	const request = new Request('http://example.com/api/data');

	// Create execution context
	const ctx = createExecutionContext();

	// Call your worker
	const response = await worker.fetch(request, env, ctx);

	// Wait for background tasks
	await waitOnExecutionContext(ctx);

	// Assert
	expect(response.status).toBe(200);
});
```

### Method 2: Integration Style (Simpler)

```typescript
import { SELF } from 'cloudflare:test';

it('tests endpoint', async () => {
	// Call the worker like a real request
	const response = await SELF.fetch('https://example.com/api/data');

	expect(response.status).toBe(200);
});
```

**Use Integration Style for:**

- Testing full request/response flow
- Testing with real bindings (D1, KV)
- Quick endpoint tests

**Use Unit Style for:**

- Testing with custom contexts
- Mocking dependencies
- Testing background tasks (`ctx.waitUntil`)

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (re-runs on file changes)
npm test -- --watch

# Run specific test file
npm test test/index.spec.ts

# Run tests matching pattern
npm test -- --grep "health endpoint"

# Show coverage
npm test -- --coverage

# Run tests once and exit (useful for CI)
npm test -- --run
```

## Best Practices

### 1. Test Structure: AAA Pattern

```typescript
it('calculates total price', () => {
	// Arrange: Set up test data
	const items = [{ price: 10 }, { price: 20 }];

	// Act: Execute the code
	const total = calculateTotal(items);

	// Assert: Verify the result
	expect(total).toBe(30);
});
```

### 2. Descriptive Test Names

```typescript
// ❌ Bad
it('works', () => { ... });

// ✅ Good
it('returns 404 when user not found', () => { ... });
```

### 3. Test One Thing

```typescript
// ❌ Bad: Testing multiple things
it('user API works', () => {
	expect(getUser()).toBeDefined();
	expect(createUser()).toBe(true);
	expect(deleteUser()).toBe(true);
});

// ✅ Good: Separate tests
it('gets existing user', () => {
	expect(getUser(1)).toBeDefined();
});

it('creates new user', () => {
	expect(createUser({ name: 'John' })).toBe(true);
});
```

### 4. Use beforeEach/afterEach for Setup

```typescript
describe('User API', () => {
	let userId: number;

	beforeEach(async () => {
		// Runs before each test
		userId = await createTestUser();
	});

	afterEach(async () => {
		// Runs after each test
		await deleteTestUser(userId);
	});

	it('gets user by id', () => {
		expect(getUser(userId)).toBeDefined();
	});
});
```

## Common Pitfalls

### 1. Forgetting to `await`

```typescript
// ❌ Bad: Promise not awaited
it('fetches data', () => {
	const result = fetchData(); // Returns Promise!
	expect(result).toBe('data'); // Will fail
});

// ✅ Good
it('fetches data', async () => {
	const result = await fetchData();
	expect(result).toBe('data');
});
```

### 2. Tests Depending on Each Other

```typescript
// ❌ Bad: Test 2 depends on Test 1
let userId;

it('creates user', async () => {
	userId = await createUser();
});

it('gets user', async () => {
	expect(getUser(userId)).toBeDefined(); // Fails if test 1 skipped
});

// ✅ Good: Independent tests
it('creates user', async () => {
	const userId = await createUser();
	expect(userId).toBeDefined();
});

it('gets user', async () => {
	const userId = await createUser(); // Create own data
	expect(getUser(userId)).toBeDefined();
});
```

### 3. Not Cleaning Up Resources

```typescript
// ❌ Bad: Leaves test data in database
it('creates user', async () => {
	await createUser({ name: 'Test' });
	// Database now has test user forever
});

// ✅ Good: Clean up
it('creates user', async () => {
	const userId = await createUser({ name: 'Test' });

	try {
		expect(userId).toBeDefined();
	} finally {
		await deleteUser(userId); // Always clean up
	}
});
```

## Next Steps

1. Fix the existing failing tests (see updated `test/index.spec.ts`)
2. Add tests for critical endpoints:
   - `/api/sql` (SQL validation)
   - `/backfill` (date range validation)
   - OAuth flow
3. Set up test coverage reporting
4. Add tests to CI/CD (run on every push)

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Cloudflare Workers Testing](https://developers.cloudflare.com/workers/testing/)
- [Vitest Pool Workers](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples)

---

**Remember**: Tests are code too! Keep them simple, readable, and maintainable.
