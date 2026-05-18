/**
 * Tests for Firestore OAuth storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateToken, tokenFingerprint } from '../src/auth/storage'

// Mock Firestore
const mockGet = vi.fn<() => Promise<{ exists: boolean; data: () => unknown }>>()
const mockSet = vi.fn<(data: unknown) => Promise<void>>()
const mockDelete = vi.fn<() => Promise<void>>()
const mockRunTransaction =
  vi.fn<(fn: (tx: unknown) => Promise<boolean>) => Promise<boolean>>()

vi.mock('@google-cloud/firestore', () => ({
  Firestore: class MockFirestore {
    doc = () => ({
      get: mockGet,
      set: mockSet,
      delete: mockDelete,
    })
    runTransaction = mockRunTransaction
  },
}))

const { FirestoreOAuthStorage } = await import('../src/auth/storage')

describe('FirestoreOAuthStorage', () => {
  let storage: InstanceType<typeof FirestoreOAuthStorage>

  beforeEach(() => {
    vi.clearAllMocks()
    storage = new FirestoreOAuthStorage('test-project')
  })

  describe('clients', () => {
    it('returns undefined for non-existent client', async () => {
      mockGet.mockResolvedValue({ exists: false, data: () => undefined })
      const client = await storage.getClient('unknown')
      expect(client).toBeUndefined()
    })

    it('returns undefined when doc exists but data is null', async () => {
      mockGet.mockResolvedValue({ exists: true, data: () => null })
      const client = await storage.getClient('test')
      expect(client).toBeUndefined()
    })

    it('returns client data when it exists', async () => {
      const clientData = {
        client_id: 'test',
        client_secret: 'secret',
        client_id_issued_at: 123,
        redirect_uris: ['https://example.com/callback'],
      }
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({ client: clientData, expiresAt: Date.now() + 100000 }),
      })
      const client = await storage.getClient('test')
      expect(client?.client_id).toBe('test')
    })

    it('returns undefined for expired client', async () => {
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          client: { client_id: 'test' },
          expiresAt: Date.now() - 1000,
        }),
      })
      const client = await storage.getClient('test')
      expect(client).toBeUndefined()
    })

    it('saves client', async () => {
      mockSet.mockResolvedValue(undefined)
      await storage.saveClient({
        client_id: 'test',
        client_id_issued_at: 123,
        redirect_uris: [],
      })
      expect(mockSet).toHaveBeenCalledOnce()
    })
  })

  describe('pending authorizations', () => {
    it('returns undefined when pending auth doc has null data', async () => {
      mockGet.mockResolvedValue({ exists: true, data: () => null })
      const auth = await storage.getPendingAuth('code')
      expect(auth).toBeUndefined()
    })

    it('returns undefined for non-existent pending auth', async () => {
      mockGet.mockResolvedValue({ exists: false, data: () => undefined })
      const auth = await storage.getPendingAuth('code')
      expect(auth).toBeUndefined()
    })

    it('saves and retrieves pending auth', async () => {
      mockSet.mockResolvedValue(undefined)
      const pending = {
        clientId: 'client1',
        redirectUri: 'https://example.com/callback',
        codeChallenge: 'challenge',
        createdAt: Date.now(),
      }
      await storage.savePendingAuth('code', pending)
      expect(mockSet).toHaveBeenCalledOnce()
    })

    it('retrieves valid pending auth', async () => {
      const pending = {
        clientId: 'client1',
        redirectUri: 'https://example.com/callback',
        codeChallenge: 'challenge',
        createdAt: Date.now(),
      }
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          auth: pending,
          expiresAt: Date.now() + 100000,
        }),
      })
      const result = await storage.getPendingAuth('code')
      expect(result).toEqual(pending)
    })

    it('returns undefined for expired pending auth', async () => {
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          auth: { clientId: 'test' },
          expiresAt: Date.now() - 1000,
        }),
      })
      const auth = await storage.getPendingAuth('code')
      expect(auth).toBeUndefined()
    })

    it('deletes pending auth', async () => {
      mockDelete.mockResolvedValue(undefined)
      await storage.deletePendingAuth('code')
      expect(mockDelete).toHaveBeenCalledOnce()
    })
  })

  describe('installations', () => {
    it('returns undefined when installation doc has null data', async () => {
      mockGet.mockResolvedValue({ exists: true, data: () => null })
      const inst = await storage.getInstallation('token')
      expect(inst).toBeUndefined()
    })

    it('returns undefined for non-existent installation', async () => {
      mockGet.mockResolvedValue({ exists: false, data: () => undefined })
      const inst = await storage.getInstallation('token')
      expect(inst).toBeUndefined()
    })

    it('returns expired installations (expiry is checked by the provider, not storage)', async () => {
      const expired = {
        accessToken: 'token',
        refreshToken: 'refresh',
        clientId: 'client',
        userId: 'user',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: Math.floor(Date.now() / 1000) - 7200,
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      }
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({ installation: expired }),
      })
      const inst = await storage.getInstallation('token')
      // Storage returns the installation even if expired — refresh flow needs
      // access to expired installations to rotate tokens.
      expect(inst).toEqual(expired)
    })

    it('returns valid installation', async () => {
      const installation = {
        accessToken: 'token',
        refreshToken: 'refresh',
        clientId: 'client',
        userId: 'user',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({ installation }),
      })
      const result = await storage.getInstallation('token')
      expect(result).toEqual(installation)
    })

    it('saves installation', async () => {
      mockSet.mockResolvedValue(undefined)
      await storage.saveInstallation({
        accessToken: 'token',
        refreshToken: 'refresh',
        clientId: 'client',
        userId: 'user',
        userEmail: 'user@example.com',
        userDomain: 'example.com',
        issuedAt: 0,
        expiresAt: 9999999999,
      })
      expect(mockSet).toHaveBeenCalledOnce()
    })

    it('deletes installation', async () => {
      mockDelete.mockResolvedValue(undefined)
      await storage.deleteInstallation('token')
      expect(mockDelete).toHaveBeenCalledOnce()
    })
  })

  describe('refresh mappings', () => {
    it('returns undefined for unknown refresh token', async () => {
      mockGet.mockResolvedValue({ exists: false, data: () => undefined })
      const token = await storage.getAccessTokenForRefresh('refresh')
      expect(token).toBeUndefined()
    })

    it('returns undefined when refresh doc has null data', async () => {
      mockGet.mockResolvedValue({ exists: true, data: () => null })
      const token = await storage.getAccessTokenForRefresh('refresh')
      expect(token).toBeUndefined()
    })

    it('returns undefined when refresh doc has invalid data', async () => {
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({ notAccessToken: 123 }),
      })
      const token = await storage.getAccessTokenForRefresh('refresh')
      expect(token).toBeUndefined()
    })

    it('returns access token for valid refresh token', async () => {
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({ accessToken: 'access-token' }),
      })
      const token = await storage.getAccessTokenForRefresh('refresh')
      expect(token).toBe('access-token')
    })

    it('saves refresh mapping', async () => {
      mockSet.mockResolvedValue(undefined)
      await storage.saveRefreshMapping('refresh', 'access')
      expect(mockSet).toHaveBeenCalledOnce()
    })

    it('deletes refresh mapping', async () => {
      mockDelete.mockResolvedValue(undefined)
      await storage.deleteRefreshMapping('refresh')
      expect(mockDelete).toHaveBeenCalledOnce()
    })
  })

  describe('token exchange', () => {
    it('returns undefined when exchange doc has null data', async () => {
      mockGet.mockResolvedValue({ exists: true, data: () => null })
      const exchange = await storage.getTokenExchange('code')
      expect(exchange).toBeUndefined()
    })

    it('returns undefined for unknown code', async () => {
      mockGet.mockResolvedValue({ exists: false, data: () => undefined })
      const exchange = await storage.getTokenExchange('code')
      expect(exchange).toBeUndefined()
    })

    it('returns undefined for expired exchange', async () => {
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          accessToken: 'token',
          used: false,
          expiresAt: Date.now() - 1000,
        }),
      })
      const exchange = await storage.getTokenExchange('code')
      expect(exchange).toBeUndefined()
    })

    it('returns valid exchange', async () => {
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          accessToken: 'token',
          used: false,
          expiresAt: Date.now() + 100000,
        }),
      })
      const exchange = await storage.getTokenExchange('code')
      expect(exchange).toEqual({ accessToken: 'token', used: false })
    })

    it('saves token exchange', async () => {
      mockSet.mockResolvedValue(undefined)
      await storage.saveTokenExchange('code', 'token')
      expect(mockSet).toHaveBeenCalledOnce()
    })

    it('marks exchange as used via transaction', async () => {
      mockRunTransaction.mockImplementation(async (fn) => {
        const tx = {
          get: vi
            .fn<() => Promise<{ exists: boolean; data: () => unknown }>>()
            .mockResolvedValue({
              exists: true,
              data: () => ({ used: false }),
            }),
          update: vi.fn<(data: unknown) => void>(),
        }
        return fn(tx)
      })
      const result = await storage.markTokenExchangeUsed('code')
      expect(result).toBe(true)
    })

    it('returns false for non-existent exchange in transaction', async () => {
      mockRunTransaction.mockImplementation(async (fn) => {
        const tx = {
          get: vi
            .fn<() => Promise<{ exists: boolean; data: () => unknown }>>()
            .mockResolvedValue({
              exists: false,
              data: () => null,
            }),
          update: vi.fn<(data: unknown) => void>(),
        }
        return fn(tx)
      })
      const result = await storage.markTokenExchangeUsed('missing')
      expect(result).toBe(false)
    })

    it('returns false for already-used exchange', async () => {
      mockRunTransaction.mockImplementation(async (fn) => {
        const tx = {
          get: vi
            .fn<() => Promise<{ exists: boolean; data: () => unknown }>>()
            .mockResolvedValue({
              exists: true,
              data: () => ({ used: true }),
            }),
          update: vi.fn<(data: unknown) => void>(),
        }
        return fn(tx)
      })
      const result = await storage.markTokenExchangeUsed('code')
      expect(result).toBe(false)
    })
  })
})

describe('generateToken', () => {
  it('generates 64-character hex string', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateToken()))
    expect(tokens.size).toBe(10)
  })
})

describe('tokenFingerprint', () => {
  // The fingerprint must match the first 12 hex chars of SHA256(token),
  // which is the same prefix used as the Firestore document ID for the
  // collections under apps/mcp. This lets log entries be cross-referenced
  // with Firestore documents without exposing the full token.
  it('returns the first 12 hex chars of SHA256(token)', () => {
    // SHA256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(tokenFingerprint('hello')).toBe('2cf24dba5fb0')
  })

  it('returns 12-char hex prefix for any input', () => {
    const fp = tokenFingerprint('any-string')
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
  })

  it('is deterministic', () => {
    expect(tokenFingerprint('abc')).toBe(tokenFingerprint('abc'))
  })

  it('returns different prefixes for different tokens', () => {
    expect(tokenFingerprint('a')).not.toBe(tokenFingerprint('b'))
  })
})
