/**
 * Test utilities for the Slack bot.
 */
import pino from 'pino'
import { z } from 'zod'

/**
 * Zod schema for parsing JSON response bodies in tests.
 */
const JsonResponseSchema = z.record(z.string(), z.unknown())

/**
 * Parse a Response body as a JSON object.
 * Uses Zod to validate instead of `as` casting.
 */
export async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json()
  return JsonResponseSchema.parse(raw)
}

/**
 * Create a silent pino Logger for testing.
 */
export function createTestLogger() {
  return pino({ level: 'silent' })
}
