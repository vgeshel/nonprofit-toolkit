---
name: code-reuse
description: Use before implementing any new function, utility, or helper — to check whether the codebase, its dependencies, or the standard library already solves it. Covers where this repo keeps shared code, how to search for it, and how to refactor existing callers onto a new helper. Triggers on "write a helper for", "add a utility", "implement X from scratch", "is there already something that does this", or noticing duplicated logic.
---

# Code Reuse

Code reuse reduces bugs, improves maintainability, and ensures consistency. Always prefer using existing, tested code over writing new implementations.

## 1. Search Before You Implement

**Before writing any new function or logic, search for existing implementations:**

- Grep for similar patterns in the codebase
- Check the shared packages under `packages/` — `packages/types/` holds shared
  types and Result helpers, and each domain package (`bq`, `connectors`,
  `letter`, `compliance`) owns its own utilities
- Search dependencies in `package.json` for a library solution
- Look in the Node.js/Bun standard library for a built-in
- Review related files for similar functionality

## 2. Break Code into Small, Pure Functions

Small, pure functions are easier to test, more reusable, simpler to understand,
and — because they are named — discoverable by the next person who greps.

Extract named helpers instead of inlining multi-step logic in a caller.

## 3. Use Clear, Descriptive Names

Function names should clearly describe what they do, making them easy to find when searching:

- **Good**: `formatDuration`, `parseGitHubUrl`, `validateIssueNumber`, `truncateString`
- **Bad**: `format`, `parse`, `validate`, `truncate`

More specific names prevent accidental misuse and help others find your functions.

## 4. Leverage Standard Libraries

Don't reinvent the wheel. Prefer `node:fs/promises` (file operations),
`node:path` (path manipulation), `node:crypto` (hashing), and array methods over
hand-rolled equivalents.

## 5. Check Dependencies

Before implementing generic functionality, check whether it is already a
dependency:

- **Logging**: `pino`
- **Date/time**: `luxon`
- **Validation**: `zod`
- **Error handling**: `neverthrow`
- **CLI parsing**: `commander`
- **BigQuery / Firestore / Secret Manager / Storage**: the `@google-cloud/*` clients

Check `package.json` and fetch the library's current documentation before
implementing something generic.

## 6. Refactor When You Create Reusable Code

When you create a new reusable function:

1. Implement the new, general-purpose function
2. Search the codebase for similar patterns
3. Refactor found instances to use the new function
4. Update tests to verify the refactoring

This keeps the codebase DRY and prevents future duplication.

## Workflow Summary

1. **Search** the codebase for similar code
2. **Check `packages/`** for an existing shared utility
3. **Check dependencies** in `package.json`
4. **Check the standard library**
5. **Implement** a small, pure, well-named function if nothing exists
6. **Refactor** similar code onto it
7. **Test** it — see `.claude/rules/testing.md`
