/**
 * Tests for OAuth audit-log helpers.
 */
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
} from 'express'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { summarizeTokenRequest, tokenAuditLogger } from '../src/auth/audit-log'
import { tokenFingerprint } from '../src/auth/storage'

describe('summarizeTokenRequest', () => {
  it('extracts grant_type as a string when present', () => {
    const result = summarizeTokenRequest({ grant_type: 'refresh_token' })
    expect(result.grantType).toBe('refresh_token')
  })

  it('returns null grantType when missing or non-string', () => {
    expect(summarizeTokenRequest({}).grantType).toBeNull()
    expect(summarizeTokenRequest({ grant_type: 123 }).grantType).toBeNull()
  })

  it('reports client_id prefix without leaking the full value', () => {
    const clientId =
      '59ce70e133d06bf38184ea51805624d9a30e2f5431ad47151c8d899e93273df4'
    const result = summarizeTokenRequest({ client_id: clientId })
    expect(result.clientIdPrefix).toBe('59ce70e133d0')
    expect(result.hasClientId).toBe(true)
  })

  it('returns null clientIdPrefix when client_id is absent or non-string', () => {
    expect(summarizeTokenRequest({}).clientIdPrefix).toBeNull()
    expect(summarizeTokenRequest({}).hasClientId).toBe(false)
    expect(summarizeTokenRequest({ client_id: 7 }).clientIdPrefix).toBeNull()
    expect(summarizeTokenRequest({ client_id: 7 }).hasClientId).toBe(false)
  })

  it('detects presence of client_secret without echoing it', () => {
    const summary = summarizeTokenRequest({ client_secret: 'verysecret' })
    expect(summary.hasClientSecret).toBe(true)
    // Body fields that contain secrets must never appear in the summary
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('verysecret')
  })

  it('reports hasClientSecret=false when missing or empty', () => {
    expect(summarizeTokenRequest({}).hasClientSecret).toBe(false)
    expect(summarizeTokenRequest({ client_secret: '' }).hasClientSecret).toBe(
      false,
    )
    expect(summarizeTokenRequest({ client_secret: 5 }).hasClientSecret).toBe(
      false,
    )
  })

  it('reports refresh_token fingerprint and presence', () => {
    const result = summarizeTokenRequest({ refresh_token: 'r1' })
    expect(result.hasRefreshToken).toBe(true)
    expect(result.refreshTokenFingerprint).toBe(tokenFingerprint('r1'))
  })

  it('reports no refresh_token when absent or non-string', () => {
    expect(summarizeTokenRequest({}).hasRefreshToken).toBe(false)
    expect(summarizeTokenRequest({}).refreshTokenFingerprint).toBeNull()
    expect(summarizeTokenRequest({ refresh_token: 0 }).hasRefreshToken).toBe(
      false,
    )
    expect(
      summarizeTokenRequest({ refresh_token: 0 }).refreshTokenFingerprint,
    ).toBeNull()
  })

  it('reports code fingerprint and presence', () => {
    const result = summarizeTokenRequest({ code: 'c1' })
    expect(result.hasCode).toBe(true)
    expect(result.codeFingerprint).toBe(tokenFingerprint('c1'))
  })

  it('reports no code when absent or non-string', () => {
    expect(summarizeTokenRequest({}).hasCode).toBe(false)
    expect(summarizeTokenRequest({}).codeFingerprint).toBeNull()
    expect(summarizeTokenRequest({ code: false }).hasCode).toBe(false)
    expect(summarizeTokenRequest({ code: false }).codeFingerprint).toBeNull()
  })

  it('captures redirect_uri and resource for diagnosis', () => {
    const result = summarizeTokenRequest({
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      resource: 'https://mcp-server-u5atmmvqqq-uc.a.run.app/',
    })
    expect(result.redirectUri).toBe('https://claude.ai/api/mcp/auth_callback')
    expect(result.resource).toBe('https://mcp-server-u5atmmvqqq-uc.a.run.app/')
  })

  it('returns null redirectUri / resource when absent or non-string', () => {
    expect(summarizeTokenRequest({}).redirectUri).toBeNull()
    expect(summarizeTokenRequest({}).resource).toBeNull()
    expect(summarizeTokenRequest({ redirect_uri: 1 }).redirectUri).toBeNull()
    expect(summarizeTokenRequest({ resource: 1 }).resource).toBeNull()
  })

  it('returns an all-null summary for a non-object body', () => {
    const result = summarizeTokenRequest('not an object')
    expect(result).toEqual({
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
    })
  })

  it('returns an all-null summary for null', () => {
    const result = summarizeTokenRequest(null)
    expect(result.grantType).toBeNull()
    expect(result.hasClientId).toBe(false)
  })
})

describe('tokenAuditLogger middleware', () => {
  function buildRes(): {
    res: ExpressResponse
    finishListeners: (() => void)[]
    setStatus: (code: number) => void
  } {
    const finishListeners: (() => void)[] = []
    let statusCode = 200
    const res = {
      get statusCode() {
        return statusCode
      },
      set statusCode(code: number) {
        statusCode = code
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishListeners.push(cb)
        return res
      }),
    }
    return {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test mock
      res: res as unknown as ExpressResponse,
      finishListeners,
      setStatus: (code: number) => {
        statusCode = code
      },
    }
  }

  function spyOnLogger() {
    const logger = pino({ level: 'silent' })
    const records: { msg: string; payload: object }[] = []
    vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      const [first, second] = args
      if (typeof first === 'object' && first !== null) {
        records.push({
          msg: typeof second === 'string' ? second : '',

          payload: first,
        })
      }
    })
    return { logger, records }
  }

  it('logs the request summary on entry and the status code on finish', () => {
    const { logger, records } = spyOnLogger()
    const middleware = tokenAuditLogger(logger)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test mock
    const req = {
      method: 'POST',
      body: {
        grant_type: 'refresh_token',
        client_id: 'cid12345',
        client_secret: 's',
        refresh_token: 'r1',
      },
    } as ExpressRequest
    const { res, finishListeners, setStatus } = buildRes()
    const next: NextFunction = vi.fn<() => void>()

    middleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(records.length).toBe(1)
    expect(records[0]?.msg).toBe('token request received')

    setStatus(400)
    finishListeners.forEach((cb) => cb())

    expect(records.length).toBe(2)
    expect(records[1]?.msg).toBe('token response sent')
    expect(records[1]?.payload).toMatchObject({ status: 400 })
  })

  it('passes through unchanged when the body is not an object', () => {
    const { logger, records } = spyOnLogger()
    const middleware = tokenAuditLogger(logger)
    // Express may leave req.body undefined if no body parser ran. The audit
    // middleware should still call next() and emit an all-null summary.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test mock
    const req = { method: 'POST', body: undefined } as ExpressRequest
    const { res } = buildRes()
    const next: NextFunction = vi.fn<() => void>()

    middleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(records.some((r) => r.msg === 'token request received')).toBe(true)
  })
})
