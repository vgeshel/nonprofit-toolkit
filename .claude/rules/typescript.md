# TypeScript Requirements

## All Logic Must Be in TypeScript

**Every piece of logic in this project must be written in TypeScript with 100% test coverage.**

This applies to:

- GitHub Actions workflows
- Build scripts
- Pre-commit hooks
- Any automation

### Forbidden Patterns

1. **No `actions/github-script`** - The `github-script` action embeds untestable JavaScript in YAML. Put workflow logic in a TypeScript script under `scripts/` with tests, and invoke it from the workflow.

2. **No shell scripts** - Do not create `.sh` files with logic. Write TypeScript scripts in `scripts/` instead. The only exception is thin wrapper scripts that simply invoke TypeScript.

3. **No inline bash logic** - Keep `run:` steps in workflows minimal. Complex logic belongs in TypeScript actions or scripts.

### Why TypeScript Everywhere?

- **Testability**: TypeScript code can achieve 100% test coverage
- **Type safety**: Catch errors at compile time with Zod validation
- **Consistency**: One language, one pattern across the codebase
- **Maintainability**: Easier to refactor and understand

`.husky/pre-commit` runs `scripts/check-github-script.ts`, which blocks introduction of `actions/github-script` in workflow files.

## Type Safety

TypeScript strict mode with **ABSOLUTELY NO `any` types EVER**.

### `as` Casting is Banned

Do not use `as` to cast types. Instead:

- Use proper types from SDKs and libraries
- Use type guards for runtime narrowing
- Use Zod `parse()` for runtime validation and type narrowing
- Use `satisfies` operator when you need to check a type without widening

**If you see `as` in code, you MUST:**

1. Flag it to the user immediately
2. Propose a fix using proper types, type guards, or Zod validation
3. Never silently accept or write code with `as` casts

**The ONLY exception**: Reading JSONB from database (e.g., `row.data as Record<string, unknown>`)

**Note**: `as const` is allowed—it's a const assertion that narrows types to literals, not a cast that bypasses type checking.
