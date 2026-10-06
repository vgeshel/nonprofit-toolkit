---
name: error-handling
description: Use when writing or reviewing code that can fail — API calls, file I/O, external commands, parsing — or when deciding between throwing and returning a Result. Covers the neverthrow Result pattern used throughout this codebase, the shared error types in packages/types/src/result.ts, chaining with andThen/map, and where to unwrap. Triggers on "error handling", "Result type", "neverthrow", "should this throw", "how do I handle this failure".
---

# Error Handling with Result Types

We use the `neverthrow` library for explicit error handling. This makes error paths visible to code coverage tools and forces us to handle all failure modes.

Shared Result helpers and error types live in `packages/types/src/result.ts`.

## Why Result Types?

With thrown exceptions, error paths are invisible to coverage tools:

```typescript
// BAD: Coverage sees no branch - error path is invisible
async function getUser(id: string): Promise<User> {
  const response = await fetch(`/users/${id}`)
  if (!response.ok) throw new Error('User not found') // ← Invisible to coverage
  return response.json()
}

// GOOD: Coverage sees the branch - forces us to test the error path
async function getUser(id: string): ResultAsync<User, ApiError> {
  const response = await fetch(`/users/${id}`)
  if (!response.ok) return err({ type: 'api', message: 'User not found' }) // ← Branch!
  return ok(await response.json())
}
```

## Error Types

Errors use discriminated union types so the `type` field narrows the payload:

```typescript
type ValidationError = { type: 'validation'; field?: string; message: string }
type ApiError = { type: 'api'; status?: number; message: string }
type FileSystemError = {
  type: 'filesystem'
  code?: string
  path?: string
  message: string
}
```

Check `packages/types/src/result.ts` for the types this codebase actually
defines before adding a new one — reuse beats inventing a parallel error shape.

## Patterns

### Wrap external APIs at boundaries

```typescript
export function fetchDonations(
  client: Client,
  since: DateTime,
): ResultAsync<Donation[], ApiError> {
  return ResultAsync.fromPromise(
    client.listTransactions({ since: since.toISO() }),
    toApiError,
  ).map((response) => response.data)
}
```

### Chain operations with `.andThen()` and `.map()`

```typescript
return fetchDonations(client, since)
  .andThen((donations) => validateDonations(donations)) // Returns Result
  .map((valid) => normalizeDonations(valid)) // Returns plain value
```

### Unwrap at entry points

```typescript
async function run(): Promise<void> {
  const result = await runPipeline({...})

  if (result.isErr()) {
    logger.error({ error: result.error }, 'Pipeline failed')
    process.exitCode = 1
    return
  }

  logger.info({ count: result.value.length }, 'Pipeline complete')
}
```

## Rules

1. **No `throw` in production code** - Use `err()` or `errAsync()` instead
2. **Entry points unwrap Results** - top-level `main`/CLI entry points use `try/catch` for genuinely unexpected errors
3. **Always handle errors** - The `neverthrow/must-use-result` ESLint rule enforces this
4. **Test all error paths** - With Result types, coverage tools see error branches
