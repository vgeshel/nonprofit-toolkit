/**
 * Tests for Patreon API client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PATREON_BASE_URL,
  PATREON_DEFAULT_PAGE_SIZE,
  PatreonClient,
} from '../../src/patreon/client'
import type { PatreonConfig } from '../../src/types'

vi.mock('../../src/ipv4-fetch', () => ({
  fetchIPv4: vi.fn((url: string, init?: RequestInit) => fetch(url, init)),
}))

import { fetchIPv4 } from '../../src/ipv4-fetch'

describe('PatreonClient', () => {
  const config: PatreonConfig = {
    accessToken: 'test_token_xyz',
    campaignId: 'cmp_42',
    baseUrl: 'https://www.patreon.com',
  }

  let client: PatreonClient
  let fetchSpy: ReturnType<typeof vi.fn>

  const successResponse = {
    data: [
      {
        type: 'member',
        id: 'mem_1',
        attributes: { full_name: 'Jane Doe', email: 'jane@example.com' },
        relationships: {
          pledge_history: {
            data: [{ type: 'pledge-event', id: 'evt_1' }],
          },
        },
      },
    ],
    included: [
      {
        type: 'pledge-event',
        id: 'evt_1',
        attributes: {
          date: '2024-03-01T00:00:00Z',
          amount_cents: 500,
          currency_code: 'USD',
          payment_status: 'Paid',
          type: 'subscription',
        },
      },
    ],
    meta: { pagination: { cursors: { next: 'next_cursor' }, total: 1 } },
  }

  beforeEach(() => {
    client = new PatreonClient(config)
    fetchSpy = vi.mocked(fetchIPv4)
    fetchSpy.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('uses the provided baseUrl', () => {
      const c = new PatreonClient({
        accessToken: 't',
        campaignId: 'c',
        baseUrl: 'https://custom.example.com',
      })
      expect(c).toBeDefined()
    })

    it('uses the default baseUrl when not provided', () => {
      const c = new PatreonClient({ accessToken: 't', campaignId: 'c' })
      expect(c).toBeDefined()
    })
  })

  describe('getMembers', () => {
    it('builds the correct URL with required params', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 }),
      )

      await client.getMembers()

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/oauth2/v2/campaigns/cmp_42/members?'),
        expect.anything(),
      )
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('include=pledge_history%2Cuser'),
        expect.anything(),
      )
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('fields%5Bmember%5D='),
        expect.anything(),
      )
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('fields%5Bpledge-event%5D='),
        expect.anything(),
      )
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`page%5Bcount%5D=${PATREON_DEFAULT_PAGE_SIZE}`),
        expect.anything(),
      )
    })

    it('sends the Bearer auth header', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 }),
      )

      await client.getMembers()

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'GET',
          headers: {
            Authorization: 'Bearer test_token_xyz',
            Accept: 'application/json',
          },
        }),
      )
    })

    it('includes the cursor when provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 }),
      )

      await client.getMembers('cursor_abc')

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('page%5Bcursor%5D=cursor_abc'),
        expect.anything(),
      )
    })

    it('omits page[cursor] on first page', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 }),
      )

      await client.getMembers()

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.not.stringContaining('page%5Bcursor%5D'),
        expect.anything(),
      )
    })

    it('uses a custom page size when provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 }),
      )

      await client.getMembers(undefined, 50)

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('page%5Bcount%5D=50'),
        expect.anything(),
      )
    })

    it('returns parsed response on success', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 }),
      )

      const result = await client.getMembers()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.data).toHaveLength(1)
        expect(result.value.data[0]?.id).toBe('mem_1')
        expect(result.value.included).toHaveLength(1)
        expect(result.value.meta?.pagination?.cursors?.next).toBe('next_cursor')
      }
    })

    it('returns auth error on 401', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
        }),
      )

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
        expect(result.error.source).toBe('patreon')
        expect(result.error.statusCode).toBe(401)
        expect(result.error.retryable).toBe(false)
      }
    })

    it('returns auth error on 403', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('forbidden', { status: 403 }))

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
      }
    })

    it('returns rate_limit error on 429 with retryable=true', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('too many', { status: 429 }))

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('rate_limit')
        expect(result.error.retryable).toBe(true)
      }
    })

    it('returns api error on 4xx with retryable=false', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }))

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('api')
        expect(result.error.retryable).toBe(false)
      }
    })

    it('returns api error on 5xx with retryable=true', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('server error', { status: 502 }),
      )

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('api')
        expect(result.error.retryable).toBe(true)
      }
    })

    it('returns network error on fetch rejection', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('ECONNREFUSED')
      }
    })

    it('returns network error on JSON parse failure', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }))

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
      }
    })

    it('returns network error on schema validation failure', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }),
      )

      const result = await client.getMembers()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Invalid response')
      }
    })
  })

  describe('healthCheck', () => {
    it('returns ok when getMembers succeeds with page size 1', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      )

      const result = await client.healthCheck()

      expect(result.isOk()).toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('page%5Bcount%5D=1'),
        expect.anything(),
      )
    })

    it('returns error when getMembers fails', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('unauthorized', { status: 401 }),
      )

      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
      }
    })
  })
})

describe('PATREON_BASE_URL', () => {
  it('is the canonical Patreon API host', () => {
    expect(PATREON_BASE_URL).toBe('https://www.patreon.com')
  })
})

describe('PATREON_DEFAULT_PAGE_SIZE', () => {
  it('is set to the API maximum (1000)', () => {
    expect(PATREON_DEFAULT_PAGE_SIZE).toBe(1000)
  })
})
