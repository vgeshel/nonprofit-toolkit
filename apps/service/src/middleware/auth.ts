/**
 * Bearer token authentication middleware.
 */
import { timingSafeEqual } from 'node:crypto'

/**
 * Validate a Bearer token from the Authorization header.
 *
 * Uses timing-safe comparison to prevent side-channel attacks.
 * Returns true if the token matches the expected API key.
 */
export function validateBearerToken(
  authHeader: string | null,
  expectedKey: string,
): boolean {
  if (!authHeader) return false
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false
  const token = parts[1]
  if (token?.length !== expectedKey.length) return false
  return timingSafeEqual(Buffer.from(token), Buffer.from(expectedKey))
}
