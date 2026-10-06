/**
 * Tests for Givebutter API client.
 */
import { DateTime } from 'luxon'
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  GIVEBUTTER_BASE_URL,
  GIVEBUTTER_DEFAULT_PAGE_SIZE,
  GivebutterClient,
} from '../../src/givebutter/client'
import type { GivebutterConfig } from '../../src/types'

describe('GivebutterClient', () => {
  const config: GivebutterConfig = {
    apiKey: 'test_api_key_123',
  }

  let client: GivebutterClient
  let fetchSpy: Mock<typeof fetch>

  beforeEach(() => {
    client = new GivebutterClient(config)
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('uses production URL by default', () => {
      const prodClient = new GivebutterClient({ apiKey: 'key' })
      expect(prodClient).toBeDefined()
    })

    it('uses custom baseUrl when provided', () => {
      const customClient = new GivebutterClient({
        apiKey: 'key',
        baseUrl: 'https://custom.givebutter.com',
      })
      expect(customClient).toBeDefined()
    })
  })

  describe('getTransactions', () => {
    const from = DateTime.fromISO('2024-01-01T00:00:00Z', { zone: 'utc' })
    const to = DateTime.fromISO('2024-01-31T23:59:59Z', { zone: 'utc' })

    const mockTransactionsResponse = {
      data: [
        {
          id: 1,
          number: 'TX-001',
          campaign_id: 100,
          campaign_code: 'SPRING',
          first_name: 'John',
          last_name: 'Doe',
          email: 'john@example.com',
          phone: null,
          address: null,
          status: 'succeeded',
          method: 'card',
          amount: 50.0,
          fee: 1.5,
          fee_covered: false,
          donated: 50.0,
          payout: 48.5,
          currency: 'USD',
          transacted_at: '2024-01-15T10:30:00Z',
          created_at: '2024-01-15T10:30:00Z',
        },
      ],
      links: {
        next: null,
      },
      meta: {
        current_page: 1,
        last_page: 1,
        per_page: 100,
        total: 1,
      },
    }

    it('fetches transactions successfully', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTransactionsResponse), { status: 200 }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.data).toHaveLength(1)
        // id is transformed to string by schema
        expect(result.value.data[0]?.id).toBe('1')
        expect(result.value.meta.total).toBe(1)
      }
    })

    it('includes authorization header', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTransactionsResponse), { status: 200 }),
      )

      await client.getTransactions(from, to)

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test_api_key_123',
            Accept: 'application/json',
          },
        }),
      )
    })

    it('includes date range in query params with Givebutter parameter names', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTransactionsResponse), { status: 200 }),
      )

      await client.getTransactions(from, to)

      const calledUrl = fetchSpy.mock.calls[0]?.[0]
      // Givebutter uses transactedAfter/transactedBefore for date filtering
      // transactedAfter is inclusive (on or after), transactedBefore is exclusive (before)
      // So to include transactions from Jan 31, we need transactedBefore=Feb 1
      expect(calledUrl).toContain('transactedAfter=2024-01-01')
      expect(calledUrl).toContain('transactedBefore=2024-02-01')
      expect(calledUrl).not.toContain('updated')
    })

    it('filters by updated date when dateField is "updated"', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTransactionsResponse), { status: 200 }),
      )

      await client.getTransactions(from, to, { dateField: 'updated' })

      const calledUrl = fetchSpy.mock.calls[0]?.[0]
      expect(calledUrl).toContain('updatedAfter=2024-01-01')
      expect(calledUrl).toContain('updatedBefore=2024-02-01')
      expect(calledUrl).not.toContain('transacted')
    })

    it('includes pagination params', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTransactionsResponse), { status: 200 }),
      )

      await client.getTransactions(from, to, { page: 2, perPage: 50 })

      const calledUrl = fetchSpy.mock.calls[0]?.[0]
      expect(calledUrl).toContain('page=2')
      expect(calledUrl).toContain('per_page=50')
    })

    it('uses default pagination values', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTransactionsResponse), { status: 200 }),
      )

      await client.getTransactions(from, to)

      const calledUrl = fetchSpy.mock.calls[0]?.[0]
      expect(calledUrl).toContain('page=1')
      expect(calledUrl).toContain(`per_page=${GIVEBUTTER_DEFAULT_PAGE_SIZE}`)
    })

    it('returns error on 401 unauthorized', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
        }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
        expect(result.error.statusCode).toBe(401)
      }
    })

    it('returns error on 403 forbidden', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
        expect(result.error.statusCode).toBe(403)
      }
    })

    it('returns error on 404 not found', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('api')
        expect(result.error.statusCode).toBe(404)
      }
    })

    it('returns error on rate limit', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
        }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('rate_limit')
        expect(result.error.statusCode).toBe(429)
        expect(result.error.retryable).toBe(true)
      }
    })

    it('returns error on server error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
        }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('api')
        expect(result.error.statusCode).toBe(500)
        expect(result.error.retryable).toBe(true)
      }
    })

    it('returns error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'))

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Network error')
      }
    })

    it('returns error on invalid JSON response', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }))

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
    })

    it('returns error on schema validation failure', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ invalid: 'response' }), { status: 200 }),
      )

      const result = await client.getTransactions(from, to)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.message).toContain('Invalid response')
      }
    })
  })

  describe('healthCheck', () => {
    it('returns ok when API is accessible', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [],
            links: { next: null },
            meta: {
              current_page: 1,
              last_page: 1,
              per_page: 1,
              total: 0,
            },
          }),
          { status: 200 },
        ),
      )

      const result = await client.healthCheck()

      expect(result.isOk()).toBe(true)
    })

    it('fetches with minimal data', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [],
            links: { next: null },
            meta: {
              current_page: 1,
              last_page: 1,
              per_page: 1,
              total: 0,
            },
          }),
          { status: 200 },
        ),
      )

      await client.healthCheck()

      const calledUrl = fetchSpy.mock.calls[0]?.[0]
      expect(calledUrl).toContain('page=1')
      expect(calledUrl).toContain('per_page=1')
    })

    it('returns error when credentials are invalid', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
        }),
      )

      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
      }
    })

    it('returns error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'))

      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
      }
    })
  })
})

describe('GIVEBUTTER_BASE_URL', () => {
  it('is the production Givebutter API URL', () => {
    expect(GIVEBUTTER_BASE_URL).toBe('https://api.givebutter.com/v1')
  })
})

describe('GIVEBUTTER_DEFAULT_PAGE_SIZE', () => {
  it('is a reasonable default', () => {
    expect(GIVEBUTTER_DEFAULT_PAGE_SIZE).toBeGreaterThan(0)
    expect(GIVEBUTTER_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(100)
  })
})
