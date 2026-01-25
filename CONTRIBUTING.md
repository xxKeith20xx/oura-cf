# Contributing

Thank you for considering contributing to this project! This document provides guidelines for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/oura-cf.git`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature-name`

## Development Setup

```bash
# Start local dev server
npx wrangler dev

# Run type checking
npx tsc --noEmit

# Run tests
npm test
```

## Code Style

- Use TypeScript with strict mode enabled
- Follow existing code patterns (tabs for indentation)
- Use descriptive variable names
- Add comments for complex logic
- Prefer explicit types over `any`

## Commit Messages

Use conventional commit format:

```
feat: add new feature
fix: resolve bug
docs: update documentation
chore: update dependencies
perf: improve performance
refactor: restructure code
test: add tests
```

## Pull Request Process

1. Update CHANGELOG.md with your changes (under `[Unreleased]` section)
2. Ensure code compiles without errors: `npx wrangler deploy --dry-run`
3. Test locally with `npx wrangler dev`
4. Create pull request with clear description
5. Link any related issues

## What to Contribute

- **Bug fixes** - Always welcome
- **Performance improvements** - Show benchmarks
- **Documentation** - Clarifications, examples, corrections
- **New features** - Open an issue first to discuss

## Code Review

- All contributions require review
- Maintain backward compatibility
- Keep changes focused and atomic
- Respond to feedback constructively

## Testing

While comprehensive tests are not yet implemented, consider adding tests for:

- Data transformation logic (`saveToD1` functions)
- OAuth token handling
- SQL validation (`isReadOnlySql`)
- Rate limiting logic

## Questions?

Open an issue for discussion before starting major work.
