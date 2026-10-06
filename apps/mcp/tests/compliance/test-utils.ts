/**
 * Test-side helpers for compliance MCP test files.
 *
 * `extractFirstText` narrows the SDK's `ReadResourceResult` /
 * `CallToolResult` content union down to the `text` variant so tests
 * can assert against the parsed JSON without `as` casts. JSON parses
 * to `unknown`; tests then narrow with Zod or `expect(...)`-shape
 * matchers.
 */
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * Extract the first `text` content from a `ReadResourceResult`. Throws
 * if the result has no contents or if the first content is a blob
 * (which never happens for the compliance read surface).
 */
export function extractFirstResourceText(result: ReadResourceResult): string {
  const first = result.contents[0]
  if (first === undefined) {
    throw new Error('expected at least one resource content item')
  }
  if (!('text' in first) || typeof first.text !== 'string') {
    throw new Error('expected first content to be text')
  }
  return first.text
}

/**
 * Extract the first `text` content from a tool `CallToolResult`. Same
 * narrowing rationale as `extractFirstResourceText`.
 */
export function extractFirstToolText(result: CallToolResult): string {
  const first = result.content[0]
  if (first === undefined) {
    throw new Error('expected at least one tool content item')
  }
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected first content to be text')
  }
  return first.text
}

/**
 * Parse the first text content from a resource result as JSON and
 * validate it as an arbitrary object. The returned type is
 * `Record<string, unknown>` so tests narrow per-test.
 */
export function parseFirstResourceJson(
  result: ReadResourceResult,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(extractFirstResourceText(result))
  return z.record(z.string(), z.unknown()).parse(parsed)
}

/**
 * Parse the first text content from a tool result as JSON.
 */
export function parseFirstToolJson(
  result: CallToolResult,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(extractFirstToolText(result))
  return z.record(z.string(), z.unknown()).parse(parsed)
}
