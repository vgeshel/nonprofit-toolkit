/**
 * Diagnostic logging for the OAuth `/token` endpoint.
 *
 * This module exists to diagnose intermittent refresh-token failures
 * that show up as `connector issue` in Claude.ai after ~24h of idle.
 * It produces a structured, log-safe summary of what the client sent
 * (no secrets) and the resulting response status, so we can correlate
 * with Firestore document state.
 */
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from 'express'
import type { Logger } from 'pino'
import { z } from 'zod'
import { tokenFingerprint } from './storage'

/**
 * Permissive schema for the parsed `/token` body: every field is
 * optional, every value is `unknown`, and any unknown extras pass
 * through. We don't *enforce* shape here (the SDK does that downstream)
 * — we just narrow `body` to a record-shaped type so we can inspect
 * each field without an `as` cast.
 */
const TokenBodySchema = z
  .object({
    grant_type: z.unknown().optional(),
    client_id: z.unknown().optional(),
    client_secret: z.unknown().optional(),
    refresh_token: z.unknown().optional(),
    code: z.unknown().optional(),
    redirect_uri: z.unknown().optional(),
    resource: z.unknown().optional(),
  })
  .passthrough()

/**
 * A redacted, structured view of the `/token` request body. Designed
 * so each field can be logged without exposing secrets or full tokens.
 */
export interface TokenRequestSummary {
  grantType: string | null
  clientIdPrefix: string | null
  hasClientId: boolean
  hasClientSecret: boolean
  hasRefreshToken: boolean
  refreshTokenFingerprint: string | null
  hasCode: boolean
  codeFingerprint: string | null
  redirectUri: string | null
  resource: string | null
}

/**
 * Build a log-safe summary from a (possibly untrusted) parsed body.
 *
 * All fields are checked with `typeof` rather than a Zod schema because
 * the body shape varies by grant_type and we want to log what the
 * client actually sent — including malformed input.
 */
/** Return the value if it's a string, otherwise null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function summarizeTokenRequest(body: unknown): TokenRequestSummary {
  const empty: TokenRequestSummary = {
    grantType: null,
    clientIdPrefix: null,
    hasClientId: false,
    hasClientSecret: false,
    hasRefreshToken: false,
    refreshTokenFingerprint: null,
    hasCode: false,
    codeFingerprint: null,
    redirectUri: null,
    resource: null,
  }

  const parsed = TokenBodySchema.safeParse(body)
  if (!parsed.success) return empty
  const obj = parsed.data

  const clientId = asString(obj.client_id)
  const refreshToken = asString(obj.refresh_token)
  const code = asString(obj.code)
  const clientSecret = asString(obj.client_secret)

  return {
    grantType: asString(obj.grant_type),
    clientIdPrefix: clientId ? clientId.slice(0, 12) : null,
    hasClientId: clientId !== null,
    hasClientSecret: clientSecret !== null && clientSecret.length > 0,
    hasRefreshToken: refreshToken !== null,
    refreshTokenFingerprint: refreshToken
      ? tokenFingerprint(refreshToken)
      : null,
    hasCode: code !== null,
    codeFingerprint: code ? tokenFingerprint(code) : null,
    redirectUri: asString(obj.redirect_uri),
    resource: asString(obj.resource),
  }
}

/**
 * Express middleware that logs every `/token` request's redacted
 * summary on entry and its final status code on `res.finish`. Mount
 * this *before* the MCP SDK's auth router so we capture requests
 * even when the SDK rejects them in middleware (e.g. invalid
 * `client_secret`).
 */
export function tokenAuditLogger(logger: Logger): RequestHandler {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const summary = summarizeTokenRequest(req.body)
    logger.info({ ...summary, method: req.method }, 'token request received')
    res.on('finish', () => {
      logger.info(
        {
          status: res.statusCode,
          grantType: summary.grantType,
          clientIdPrefix: summary.clientIdPrefix,
          refreshTokenFingerprint: summary.refreshTokenFingerprint,
          codeFingerprint: summary.codeFingerprint,
        },
        'token response sent',
      )
    })
    next()
  }
}
