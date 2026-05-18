/**
 * Tests for the Google OAuth proxy provider.
 */
import type { Response as ExpressResponse } from 'express'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleOAuthProvider } from '../src/auth/provider'
import type { OAuthStorage } from '../src/auth/storage'
import { tokenFingerprint } from '../src/auth/storage'

const mockLogger = pino({ level: 'silent' })

/**
 * Build a silent pino logger plus spies on every level method. Each spy
 * captures (firstArg, msg) calls so tests can assert on structured log
 * payloads emitted by the provider.
 */
function buildCapturingLogger() {
  const logger = pino({ level: 'silent' })
  const records: { level: string; msg: string; payload: object }[] = []
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      const [first, second] = args
      if (typeof first === 'object' && first !== null) {
        records.push({
          level,
          msg: typeof second === 'string' ? second : '',

          payload: first,
        })
      } else if (typeof first === 'string') {
        records.push({ level, msg: first, payload: {} })
      }
    })
  }
  return { logger, records }
}

function createMockStorage(): OAuthStorage {
  return {
    getClient: vi.fn<() => Promise<undefined>>(),
    saveClient: vi.fn<() => Promise<void>>(),
    getPendingAuth: vi.fn<() => Promise<undefined>>(),
    savePendingAuth: vi.fn<() => Promise<void>>(),
    deletePendingAuth: vi.fn<() => Promise<void>>(),
    getInstallation: vi.fn<() => Promise<undefined>>(),
    saveInstallation: vi.fn<() => Promise<void>>(),
    deleteInstallation: vi.fn<() => Promise<void>>(),
    getAccessTokenForRefresh: vi.fn<() => Promise<undefined>>(),
    saveRefreshMapping: vi.fn<() => Promise<void>>(),
    deleteRefreshMapping: vi.fn<() => Promise<void>>(),
    getTokenExchange: vi.fn<() => Promise<undefined>>(),
    saveTokenExchange: vi.fn<() => Promise<void>>(),
    markTokenExchangeUsed: vi.fn<() => Promise<boolean>>(),
  }
}

const providerConfig = {
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-secret',
  allowedDomain: 'example.com',
  baseUrl: 'https://mcp.example.com',
}

describe('GoogleOAuthProvider', () => {
  let storage: ReturnType<typeof createMockStorage>
  let provider: GoogleOAuthProvider

  beforeEach(() => {
    vi.clearAllMocks()
    storage = createMockStorage()
    provider = new GoogleOAuthProvider({
      ...providerConfig,
      storage,
      logger: mockLogger,
    })
  })

  describe('clientsStore', () => {
    it('delegates getClient to storage', async () => {
      const clientData = {
        client_id: 'test',
        client_id_issued_at: 123,
        redirect_uris: [],
      }
      vi.mocked(storage.getClient).mockResolvedValue(clientData)

      const result = await provider.clientsStore.getClient('test')
      expect(result).toEqual(clientData)
      expect(storage.getClient).toHaveBeenCalledWith('test')
    })

    it('rethrows errors from storage.getClient', async () => {
      vi.mocked(storage.getClient).mockRejectedValue(
        new Error('Firestore unavailable'),
      )

      await expect(provider.clientsStore.getClient('test')).rejects.toThrow(
        'Firestore unavailable',
      )
    })

    it('rethrows errors from storage.saveClient', async () => {
      vi.mocked(storage.saveClient).mockRejectedValue(
        new Error('Permission denied'),
      )

      const store = provider.clientsStore
      if (!store.registerClient)
        throw new Error('registerClient not implemented')

      await expect(
        store.registerClient({
          redirect_uris: ['https://example.com/callback'],
        }),
      ).rejects.toThrow('Permission denied')
    })

    it('registers client with generated ID', async () => {
      vi.mocked(storage.saveClient).mockResolvedValue(undefined)

      const store = provider.clientsStore
      if (!store.registerClient)
        throw new Error('registerClient not implemented')
      const result = await store.registerClient({
        redirect_uris: ['https://example.com/callback'],
      })

      expect(result.client_id).toBeTruthy()
      expect(result.client_id_issued_at).toBeGreaterThan(0)
      expect(result.redirect_uris).toEqual(['https://example.com/callback'])
      expect(storage.saveClient).toHaveBeenCalledOnce()
    })
  })

  describe('authorize', () => {
    it('saves pending auth and redirects to Google', async () => {
      vi.mocked(storage.savePendingAuth).mockResolvedValue(undefined)

      let redirectUrl = ''
      const mockRes = {
        redirect: (url: string) => {
          redirectUrl = url
        },
      }

      await provider.authorize(
        { client_id: 'client1', client_id_issued_at: 0, redirect_uris: [] },
        {
          state: 'test-state',
          codeChallenge: 'challenge123',
          redirectUri: 'https://client.example.com/callback',
        },
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test mock
        mockRes as ExpressResponse,
      )

      expect(storage.savePendingAuth).toHaveBeenCalledOnce()
      expect(redirectUrl).toContain('accounts.google.com')
      expect(redirectUrl).toContain('client_id=test-client-id')
      expect(redirectUrl).toContain('hd=example.com')
      expect(redirectUrl).toContain('scope=openid+email+profile')
      expect(redirectUrl).toContain(
        'redirect_uri=https%3A%2F%2Fmcp.example.com%2Foauth%2Fgoogle%2Fcallback',
      )
    })
  })

  describe('challengeForAuthorizationCode', () => {
    it('returns the stored code challenge', async () => {
      vi.mocked(storage.getPendingAuth).mockResolvedValue({
        clientId: 'client1',
        redirectUri: 'https://example.com/callback',
        codeChallenge: 'stored-challenge',
        createdAt: Date.now(),
      })

      const challenge = await provider.challengeForAuthorizationCode(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        'auth-code',
      )
      expect(challenge).toBe('stored-challenge')
    })

    it('throws for unknown authorization code', async () => {
      vi.mocked(storage.getPendingAuth).mockResolvedValue(undefined)

      await expect(
        provider.challengeForAuthorizationCode(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'unknown',
        ),
      ).rejects.toThrow('Unknown authorization code')
    })
  })

  describe('exchangeAuthorizationCode', () => {
    it('returns tokens for valid code', async () => {
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.markTokenExchangeUsed).mockResolvedValue(true)
      vi.mocked(storage.getTokenExchange).mockResolvedValue({
        accessToken: 'access-token',
        used: true,
      })
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        clientId: 'client1',
        userId: 'user1',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: now,
        expiresAt: now + 3600,
      })

      const tokens = await provider.exchangeAuthorizationCode(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        'auth-code',
      )

      expect(tokens.access_token).toBe('access-token')
      expect(tokens.refresh_token).toBe('refresh-token')
      expect(tokens.token_type).toBe('bearer')
    })

    it('throws when token exchange not found', async () => {
      vi.mocked(storage.markTokenExchangeUsed).mockResolvedValue(true)
      vi.mocked(storage.getTokenExchange).mockResolvedValue(undefined)

      await expect(
        provider.exchangeAuthorizationCode(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'auth-code',
        ),
      ).rejects.toThrow('Token exchange not found')
    })

    it('throws when installation not found for exchange', async () => {
      vi.mocked(storage.markTokenExchangeUsed).mockResolvedValue(true)
      vi.mocked(storage.getTokenExchange).mockResolvedValue({
        accessToken: 'access',
        used: true,
      })
      vi.mocked(storage.getInstallation).mockResolvedValue(undefined)

      await expect(
        provider.exchangeAuthorizationCode(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'auth-code',
        ),
      ).rejects.toThrow('Installation not found')
    })

    it('throws for already-used code', async () => {
      vi.mocked(storage.markTokenExchangeUsed).mockResolvedValue(false)

      await expect(
        provider.exchangeAuthorizationCode(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'used-code',
        ),
      ).rejects.toThrow('already used')
    })
  })

  describe('verifyAccessToken', () => {
    it('returns auth info for valid token', async () => {
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'valid-token',
        refreshToken: 'refresh',
        clientId: 'client1',
        userId: 'user1',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: now,
        expiresAt: now + 3600,
      })

      const authInfo = await provider.verifyAccessToken('valid-token')
      expect(authInfo.token).toBe('valid-token')
      expect(authInfo.clientId).toBe('client1')
      expect(authInfo.extra?.email).toBe('user@example.com')
    })

    it('throws for invalid token', async () => {
      vi.mocked(storage.getInstallation).mockResolvedValue(undefined)

      await expect(provider.verifyAccessToken('invalid')).rejects.toThrow(
        'Invalid or expired',
      )
    })

    it('throws for expired token', async () => {
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'expired-token',
        refreshToken: 'refresh',
        clientId: 'client1',
        userId: 'user1',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: now - 7200,
        expiresAt: now - 100,
      })

      await expect(provider.verifyAccessToken('expired-token')).rejects.toThrow(
        'Invalid or expired',
      )
    })
  })

  describe('diagnostic logging', () => {
    it('logs each step of a successful refresh-token exchange', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue(
        'old-access',
      )
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        clientId: 'client1',
        userId: 'user1',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: now - 7200,
        expiresAt: now - 100,
      })

      await providerWithLog.exchangeRefreshToken(
        { client_id: 'client1', client_id_issued_at: 0, redirect_uris: [] },
        'old-refresh',
      )

      const messages = records.map((r) => r.msg)
      expect(messages).toContain('exchangeRefreshToken: start')
      expect(messages).toContain('exchangeRefreshToken: refresh mapping found')
      expect(messages).toContain('exchangeRefreshToken: installation found')
      expect(messages).toContain('exchangeRefreshToken: success')
      const start = records.find((r) => r.msg === 'exchangeRefreshToken: start')
      expect(start?.payload).toMatchObject({
        refreshTokenFingerprint: tokenFingerprint('old-refresh'),
        clientId: 'client1',
      })
    })

    it('logs a warning when refresh-mapping lookup fails', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue(undefined)

      await expect(
        providerWithLog.exchangeRefreshToken(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'unknown-refresh',
        ),
      ).rejects.toThrow('Invalid refresh token')

      const warning = records.find(
        (r) => r.msg === 'exchangeRefreshToken: refresh mapping not found',
      )
      expect(warning).toBeDefined()
      expect(warning?.payload).toMatchObject({
        refreshTokenFingerprint: tokenFingerprint('unknown-refresh'),
      })
    })

    it('logs a warning when installation for refresh is missing', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue('orphan')
      vi.mocked(storage.getInstallation).mockResolvedValue(undefined)

      await expect(
        providerWithLog.exchangeRefreshToken(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'refresh-tok',
        ),
      ).rejects.toThrow('Installation not found')

      const warning = records.find(
        (r) => r.msg === 'exchangeRefreshToken: installation not found',
      )
      expect(warning).toBeDefined()
      expect(warning?.payload).toMatchObject({
        refreshTokenFingerprint: tokenFingerprint('refresh-tok'),
      })
    })

    it('logs a warning when verifyAccessToken cannot find the installation', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      vi.mocked(storage.getInstallation).mockResolvedValue(undefined)

      await expect(
        providerWithLog.verifyAccessToken('missing-tok'),
      ).rejects.toThrow('Invalid or expired')

      const warning = records.find(
        (r) => r.msg === 'verifyAccessToken: installation not found',
      )
      expect(warning).toBeDefined()
      expect(warning?.payload).toMatchObject({
        tokenFingerprint: tokenFingerprint('missing-tok'),
      })
    })

    it('logs a warning when verifyAccessToken finds an expired token', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'r',
        clientId: 'c1',
        userId: 'u1',
        userEmail: 'u@example.com',
        userDomain: 'example.com',
        issuedAt: now - 7200,
        expiresAt: now - 100,
      })

      await expect(providerWithLog.verifyAccessToken('tok')).rejects.toThrow(
        'Invalid or expired',
      )

      const warning = records.find(
        (r) => r.msg === 'verifyAccessToken: token expired',
      )
      expect(warning).toBeDefined()
      expect(warning?.payload).toMatchObject({
        tokenFingerprint: tokenFingerprint('tok'),
      })
    })

    it('logs success for a valid verifyAccessToken', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'r',
        clientId: 'c1',
        userId: 'u1',
        userEmail: 'u@example.com',
        userDomain: 'example.com',
        issuedAt: now,
        expiresAt: now + 3600,
      })

      await providerWithLog.verifyAccessToken('tok')

      const ok = records.find((r) => r.msg === 'verifyAccessToken: ok')
      expect(ok).toBeDefined()
    })

    it('logs each step of exchangeAuthorizationCode', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.markTokenExchangeUsed).mockResolvedValue(true)
      vi.mocked(storage.getTokenExchange).mockResolvedValue({
        accessToken: 'access',
        used: true,
      })
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        clientId: 'c1',
        userId: 'u1',
        userEmail: 'u@example.com',
        userDomain: 'example.com',
        issuedAt: now,
        expiresAt: now + 3600,
      })

      await providerWithLog.exchangeAuthorizationCode(
        { client_id: 'c1', client_id_issued_at: 0, redirect_uris: [] },
        'auth-code',
      )

      const messages = records.map((r) => r.msg)
      expect(messages).toContain('exchangeAuthorizationCode: start')
      expect(messages).toContain('exchangeAuthorizationCode: success')
    })

    it('logs a warning when exchangeAuthorizationCode encounters a replayed code', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      vi.mocked(storage.markTokenExchangeUsed).mockResolvedValue(false)

      await expect(
        providerWithLog.exchangeAuthorizationCode(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'reused',
        ),
      ).rejects.toThrow('already used')

      const warn = records.find(
        (r) => r.msg === 'exchangeAuthorizationCode: code replayed',
      )
      expect(warn).toBeDefined()
    })

    it('logs when revokeToken is called', async () => {
      const { logger, records } = buildCapturingLogger()
      const providerWithLog = new GoogleOAuthProvider({
        ...providerConfig,
        storage,
        logger,
      })
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue('acc')
      vi.mocked(storage.deleteInstallation).mockResolvedValue(undefined)
      vi.mocked(storage.deleteRefreshMapping).mockResolvedValue(undefined)

      await providerWithLog.revokeToken(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        { token: 'r', token_type_hint: 'refresh_token' },
      )

      const log = records.find((r) => r.msg === 'revokeToken')
      expect(log).toBeDefined()
      expect(log?.payload).toMatchObject({ tokenTypeHint: 'refresh_token' })
    })
  })

  describe('exchangeRefreshToken', () => {
    it('generates new tokens and cleans up old ones', async () => {
      const now = Math.floor(Date.now() / 1000)
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue(
        'old-access',
      )
      // Old installation is already expired — refresh should still work.
      // This is the whole point of refresh tokens.
      vi.mocked(storage.getInstallation).mockResolvedValue({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        clientId: 'client1',
        userId: 'user1',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: now - 7200,
        expiresAt: now - 100,
      })
      vi.mocked(storage.saveInstallation).mockResolvedValue(undefined)
      vi.mocked(storage.saveRefreshMapping).mockResolvedValue(undefined)
      vi.mocked(storage.deleteInstallation).mockResolvedValue(undefined)
      vi.mocked(storage.deleteRefreshMapping).mockResolvedValue(undefined)

      const tokens = await provider.exchangeRefreshToken(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        'old-refresh',
      )

      expect(tokens.access_token).toBeTruthy()
      expect(tokens.access_token).not.toBe('old-access')
      expect(tokens.refresh_token).toBeTruthy()
      expect(tokens.refresh_token).not.toBe('old-refresh')
      expect(storage.deleteInstallation).toHaveBeenCalledWith('old-access')
      expect(storage.deleteRefreshMapping).toHaveBeenCalledWith('old-refresh')
    })

    it('throws when old installation not found', async () => {
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue(
        'old-access',
      )
      vi.mocked(storage.getInstallation).mockResolvedValue(undefined)

      await expect(
        provider.exchangeRefreshToken(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'old-refresh',
        ),
      ).rejects.toThrow('Installation not found')
    })

    it('throws for invalid refresh token', async () => {
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue(undefined)

      await expect(
        provider.exchangeRefreshToken(
          { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
          'invalid',
        ),
      ).rejects.toThrow('Invalid refresh token')
    })
  })

  describe('revokeToken', () => {
    it('revokes refresh token and installation', async () => {
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue('access')
      vi.mocked(storage.deleteInstallation).mockResolvedValue(undefined)
      vi.mocked(storage.deleteRefreshMapping).mockResolvedValue(undefined)

      await provider.revokeToken(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        { token: 'refresh', token_type_hint: 'refresh_token' },
      )

      expect(storage.deleteInstallation).toHaveBeenCalledWith('access')
      expect(storage.deleteRefreshMapping).toHaveBeenCalledWith('refresh')
    })

    it('handles refresh token with no associated access token', async () => {
      vi.mocked(storage.getAccessTokenForRefresh).mockResolvedValue(undefined)
      vi.mocked(storage.deleteRefreshMapping).mockResolvedValue(undefined)

      await provider.revokeToken(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        { token: 'orphaned-refresh', token_type_hint: 'refresh_token' },
      )

      expect(storage.deleteInstallation).not.toHaveBeenCalled()
      expect(storage.deleteRefreshMapping).toHaveBeenCalledWith(
        'orphaned-refresh',
      )
    })

    it('revokes access token directly', async () => {
      vi.mocked(storage.deleteInstallation).mockResolvedValue(undefined)

      await provider.revokeToken(
        { client_id: 'c', client_id_issued_at: 0, redirect_uris: [] },
        { token: 'access', token_type_hint: 'access_token' },
      )

      expect(storage.deleteInstallation).toHaveBeenCalledWith('access')
    })
  })

  describe('handleGoogleCallback', () => {
    it('rejects wrong domain', async () => {
      // Mock fetch for Google token exchange
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: 'user1',
          email: 'user@wrong.com',
          hd: 'wrong.com',
        }),
      ).toString('base64url')
      const mockIdToken = `header.${idTokenPayload}.signature`

      vi.stubGlobal(
        'fetch',
        vi.fn<() => Promise<Response>>().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'google-access',
              id_token: mockIdToken,
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      )

      await expect(
        provider.handleGoogleCallback('google-code', 'mcp-auth-code'),
      ).rejects.toThrow('Access restricted to @example.com')

      vi.unstubAllGlobals()
    })

    it('creates installation for valid domain', async () => {
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: 'user1',
          email: 'user@example.com',
          hd: 'example.com',
          name: 'Test User',
        }),
      ).toString('base64url')
      const mockIdToken = `header.${idTokenPayload}.signature`

      vi.stubGlobal(
        'fetch',
        vi.fn<() => Promise<Response>>().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'google-access',
              id_token: mockIdToken,
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      )

      vi.mocked(storage.getPendingAuth).mockResolvedValue({
        clientId: 'client1',
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: 'challenge',
        state: 'client-state',
        createdAt: Date.now(),
      })
      vi.mocked(storage.saveInstallation).mockResolvedValue(undefined)
      vi.mocked(storage.saveRefreshMapping).mockResolvedValue(undefined)
      vi.mocked(storage.saveTokenExchange).mockResolvedValue(undefined)
      vi.mocked(storage.deletePendingAuth).mockResolvedValue(undefined)

      const { redirectUrl } = await provider.handleGoogleCallback(
        'google-code',
        'mcp-auth-code',
      )

      expect(redirectUrl).toContain('https://client.example.com/callback')
      expect(redirectUrl).toContain('code=mcp-auth-code')
      expect(redirectUrl).toContain('state=client-state')
      expect(storage.saveInstallation).toHaveBeenCalledOnce()
      expect(storage.saveRefreshMapping).toHaveBeenCalledOnce()
      expect(storage.saveTokenExchange).toHaveBeenCalledOnce()
      // Pending auth is intentionally NOT deleted — SDK's /token handler
      // calls challengeForAuthorizationCode after this, which needs it.
      expect(storage.deletePendingAuth).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('throws for malformed Google ID token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<() => Promise<Response>>().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'google-access',
              id_token: 'no-dots',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      )

      await expect(
        provider.handleGoogleCallback('google-code', 'mcp-code'),
      ).rejects.toThrow('Invalid Google ID token format')

      vi.unstubAllGlobals()
    })

    it('throws when Google token exchange fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<() => Promise<Response>>()
          .mockResolvedValue(new Response('Bad Request', { status: 400 })),
      )

      await expect(
        provider.handleGoogleCallback('bad-code', 'mcp-code'),
      ).rejects.toThrow('Google token exchange failed')

      vi.unstubAllGlobals()
    })

    it('omits state from redirect when not provided', async () => {
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: 'user1',
          email: 'user@example.com',
          hd: 'example.com',
        }),
      ).toString('base64url')
      const mockIdToken = `header.${idTokenPayload}.signature`

      vi.stubGlobal(
        'fetch',
        vi.fn<() => Promise<Response>>().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'google-access',
              id_token: mockIdToken,
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      )

      vi.mocked(storage.getPendingAuth).mockResolvedValue({
        clientId: 'client1',
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: 'challenge',
        createdAt: Date.now(),
        // No state
      })
      vi.mocked(storage.saveInstallation).mockResolvedValue(undefined)
      vi.mocked(storage.saveRefreshMapping).mockResolvedValue(undefined)
      vi.mocked(storage.saveTokenExchange).mockResolvedValue(undefined)
      vi.mocked(storage.deletePendingAuth).mockResolvedValue(undefined)

      const { redirectUrl } = await provider.handleGoogleCallback(
        'google-code',
        'mcp-auth-code',
      )

      expect(redirectUrl).not.toContain('state=')

      vi.unstubAllGlobals()
    })

    it('throws when pending auth has expired', async () => {
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: 'user1',
          email: 'user@example.com',
          hd: 'example.com',
        }),
      ).toString('base64url')
      const mockIdToken = `header.${idTokenPayload}.signature`

      vi.stubGlobal(
        'fetch',
        vi.fn<() => Promise<Response>>().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: 'google-access',
              id_token: mockIdToken,
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      )

      vi.mocked(storage.getPendingAuth).mockResolvedValue(undefined)

      await expect(
        provider.handleGoogleCallback('google-code', 'mcp-auth-code'),
      ).rejects.toThrow('Authorization session expired')

      vi.unstubAllGlobals()
    })
  })
})
