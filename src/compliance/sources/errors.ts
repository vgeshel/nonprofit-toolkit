/**
 * Error type for compliance discovery sources.
 *
 * Discriminated by `type` so callers can pattern-match. All sources that fail
 * return `err(SourceError)` rather than throwing — this makes failure paths
 * visible to coverage tools and is a project-wide rule (see
 * `.claude/rules/error-handling.md`).
 */

/**
 * Failure modes that any compliance source may emit.
 *
 * - `network`     — connection failed, DNS error, abort
 * - `http`        — non-2xx response, with the actual status
 * - `rate_limit`  — explicit 429, optionally with retry-after seconds
 * - `validation`  — caller-side input did not validate (bad EIN format, etc.)
 * - `parse`       — upstream returned data that did not match the source's
 *                   declared schema (the explicit "site changed" failure mode)
 * - `not_found`   — upstream succeeded but the entity was absent
 * - `tos`         — refusal due to a terms-of-service / authentication policy
 *                   (raised by the runner before contacting upstream)
 * - `internal`    — programmer error inside the source body (unreachable path
 *                   reached, etc.) — surfaced rather than silently swallowed
 */
export type SourceError =
  | { type: 'network'; message: string }
  | { type: 'http'; status: number; message: string }
  | { type: 'rate_limit'; message: string; retryAfterSeconds?: number }
  | { type: 'validation'; message: string }
  | { type: 'parse'; message: string }
  | { type: 'not_found'; message: string }
  | { type: 'tos'; message: string }
  | { type: 'internal'; message: string }

/**
 * Format a `SourceError` for human-readable logging.
 */
export function formatSourceError(error: SourceError): string {
  switch (error.type) {
    case 'http':
      return `[http ${String(error.status)}] ${error.message}`
    case 'rate_limit':
      return error.retryAfterSeconds === undefined
        ? `[rate_limit] ${error.message}`
        : `[rate_limit retry-after=${String(error.retryAfterSeconds)}s] ${error.message}`
    case 'network':
    case 'validation':
    case 'parse':
    case 'not_found':
    case 'tos':
    case 'internal':
      return `[${error.type}] ${error.message}`
  }
}
