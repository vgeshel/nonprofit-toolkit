/**
 * Tests for Givebutter connector.
 */
import type { ConnectorError } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { errAsync, okAsync } from 'neverthrow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIVEBUTTER_DEFAULT_PAGE_SIZE } from '../../src/givebutter/client'
import {
  GivebutterConnector,
  type IGivebutterClient,
} from '../../src/givebutter/connector'
import type { GivebutterTransactionResponse } from '../../src/givebutter/schema'

describe('GivebutterConnector', () => {
  const config = {
    apiKey: 'test_api_key',
  }

  const runId = '550e8400-e29b-41d4-a716-446655440000'
  const from = DateTime.fromISO('2024-01-01T00:00:00Z', { zone: 'utc' })
  const to = DateTime.fromISO('2024-01-31T23:59:59Z', { zone: 'utc' })

  let mockClient: IGivebutterClient
  let connector: GivebutterConnector

  const createTransaction = (
    id: number,
    status: 'succeeded' | 'authorized' | 'failed' | 'cancelled' = 'succeeded',
  ) => ({
    // id is transformed to string by schema
    id: String(id),
    number: `TX-${id}`,
    campaign_id: 100,
    campaign_code: 'SPRING',
    first_name: 'Donor',
    last_name: `${id}`,
    email: `donor${id}@example.com`,
    phone: null,
    address: null,
    status,
    method: 'card',
    amount: id * 10,
    fee: 0.5,
    fee_covered: true,
    donated: id * 10,
    payout: id * 10 - 0.5,
    currency: 'USD',
    is_recurring: false,
    plan_id: null,
    transacted_at: '2024-01-15T10:30:00Z',
    created_at: '2024-01-15T10:30:00Z',
  })

  const createMockResponse = (
    transactions: GivebutterTransactionResponse['data'],
    currentPage: number,
    lastPage: number,
  ): GivebutterTransactionResponse => ({
    data: transactions,
    links: {
      next:
        currentPage < lastPage
          ? `https://api.givebutter.com/v1/transactions?page=${currentPage + 1}`
          : null,
    },
    meta: {
      current_page: currentPage,
      last_page: lastPage,
      per_page: GIVEBUTTER_DEFAULT_PAGE_SIZE,
      total: transactions.length * lastPage,
    },
  })

  beforeEach(() => {
    mockClient = {
      getTransactions: vi.fn<IGivebutterClient['getTransactions']>(),
      healthCheck: vi.fn<IGivebutterClient['healthCheck']>(),
    }
    connector = new GivebutterConnector({ config, client: mockClient })
  })

  describe('source', () => {
    it('returns "givebutter"', () => {
      expect(connector.source).toBe('givebutter')
    })
  })

  describe('healthCheck', () => {
    it('delegates to client healthCheck', async () => {
      vi.mocked(mockClient.healthCheck).mockReturnValue(okAsync(undefined))

      const result = await connector.healthCheck()

      expect(result.isOk()).toBe(true)
      expect(mockClient.healthCheck).toHaveBeenCalled()
    })

    it('propagates client errors', async () => {
      const error: ConnectorError = {
        type: 'auth',
        source: 'givebutter',
        message: 'Invalid API key',
        retryable: false,
      }
      vi.mocked(mockClient.healthCheck).mockReturnValue(errAsync(error))

      const result = await connector.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
      }
    })
  })

  describe('fetchPage', () => {
    it('fetches a page of transactions by transacted date first', async () => {
      const mockResponse = createMockResponse([createTransaction(1)], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const result = await connector.fetchPage({ from, to, runId })

      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 1,
        perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
        dateField: 'transacted',
      })
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(1)
        expect(result.value.events[0]?.external_id).toBe('1')
        // createTransaction(1) has amount: 1 * 10 = $10 = 1000 cents
        expect(result.value.events[0]?.amount_cents).toBe(1000)
        // After the last transacted page, the updated-date pass follows
        expect(result.value.hasMore).toBe(true)
        expect(result.value.nextCursor).toBe('{"dateField":"updated","page":1}')
      }
    })

    it('indicates hasMore when more transacted pages exist', async () => {
      const mockResponse = createMockResponse([createTransaction(1)], 1, 3)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const result = await connector.fetchPage({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.hasMore).toBe(true)
        expect(result.value.nextCursor).toBe(
          '{"dateField":"transacted","page":2}',
        )
      }
    })

    it('uses cursor for pagination', async () => {
      const mockResponse = createMockResponse([createTransaction(2)], 2, 3)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const cursor = JSON.stringify({ dateField: 'transacted', page: 2 })
      const result = await connector.fetchPage({ from, to, runId }, cursor)

      expect(result.isOk()).toBe(true)
      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 2,
        perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
        dateField: 'transacted',
      })
      if (result.isOk()) {
        expect(result.value.nextCursor).toBe(
          '{"dateField":"transacted","page":3}',
        )
      }
    })

    it('fetches by updated date when the cursor is in the updated pass', async () => {
      const mockResponse = createMockResponse([createTransaction(5)], 2, 3)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const cursor = JSON.stringify({ dateField: 'updated', page: 2 })
      const result = await connector.fetchPage({ from, to, runId }, cursor)

      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 2,
        perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
        dateField: 'updated',
      })
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events.map((e) => e.external_id)).toEqual(['5'])
        expect(result.value.hasMore).toBe(true)
        expect(result.value.nextCursor).toBe('{"dateField":"updated","page":3}')
      }
    })

    it('finishes after the last page of the updated pass', async () => {
      const mockResponse = createMockResponse([createTransaction(5)], 3, 3)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const cursor = JSON.stringify({ dateField: 'updated', page: 3 })
      const result = await connector.fetchPage({ from, to, runId }, cursor)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.hasMore).toBe(false)
        expect(result.value.nextCursor).toBeUndefined()
      }
    })

    it('handles invalid cursor gracefully', async () => {
      const mockResponse = createMockResponse([], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      await connector.fetchPage({ from, to, runId }, 'invalid-json')

      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 1,
        perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
        dateField: 'transacted',
      })
    })

    it('handles malformed cursor object gracefully', async () => {
      const mockResponse = createMockResponse([], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      await connector.fetchPage(
        { from, to, runId },
        JSON.stringify({ dateField: 'created', page: 2 }),
      )

      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 1,
        perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
        dateField: 'transacted',
      })
    })

    it('filters out non-succeeded transactions', async () => {
      const mockResponse = createMockResponse(
        [
          createTransaction(1, 'succeeded'),
          createTransaction(2, 'authorized'),
          createTransaction(3, 'failed'),
          createTransaction(4, 'cancelled'),
        ],
        1,
        1,
      )
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const result = await connector.fetchPage({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(1)
        expect(result.value.events[0]?.external_id).toBe('1')
      }
    })

    it('propagates client errors', async () => {
      const error: ConnectorError = {
        type: 'rate_limit',
        source: 'givebutter',
        message: 'Too many requests',
        retryable: true,
      }
      vi.mocked(mockClient.getTransactions).mockReturnValue(errAsync(error))

      const result = await connector.fetchPage({ from, to, runId })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('rate_limit')
        expect(result.error.retryable).toBe(true)
      }
    })

    it('handles empty transaction list', async () => {
      const mockResponse = createMockResponse([], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const result = await connector.fetchPage(
        { from, to, runId },
        JSON.stringify({ dateField: 'updated', page: 1 }),
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toEqual([])
        expect(result.value.hasMore).toBe(false)
      }
    })
  })

  describe('fetchAll', () => {
    it('fetches all transacted pages, then all updated pages', async () => {
      vi.mocked(mockClient.getTransactions)
        .mockReturnValueOnce(
          okAsync(createMockResponse([createTransaction(1)], 1, 2)),
        )
        .mockReturnValueOnce(
          okAsync(createMockResponse([createTransaction(2)], 2, 2)),
        )
        .mockReturnValueOnce(
          okAsync(createMockResponse([createTransaction(3)], 1, 1)),
        )

      const result = await connector.fetchAll({ from, to, runId })

      expect(vi.mocked(mockClient.getTransactions).mock.calls).toEqual([
        [
          from,
          to,
          {
            page: 1,
            perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
            dateField: 'transacted',
          },
        ],
        [
          from,
          to,
          {
            page: 2,
            perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
            dateField: 'transacted',
          },
        ],
        [
          from,
          to,
          {
            page: 1,
            perPage: GIVEBUTTER_DEFAULT_PAGE_SIZE,
            dateField: 'updated',
          },
        ],
      ])
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.map((e) => e.external_id)).toEqual(['1', '2', '3'])
      }
    })

    it('includes a transaction that settled in the window after being transacted before it', async () => {
      // An ACH charge transacted 2023-12-28 was still pending when the window
      // covering that date was fetched, so it was filtered out there. It
      // settled in January, which moved its updated_at into this window.
      const settledAch = {
        ...createTransaction(7),
        method: 'ach',
        transacted_at: '2023-12-28T21:33:49Z',
        created_at: '2023-12-28T21:33:48Z',
      }
      vi.mocked(mockClient.getTransactions)
        .mockReturnValueOnce(
          okAsync(createMockResponse([createTransaction(1)], 1, 1)),
        )
        .mockReturnValueOnce(okAsync(createMockResponse([settledAch], 1, 1)))

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.map((e) => e.external_id)).toEqual(['1', '7'])
        expect(result.value[1]?.event_ts).toBe('2023-12-28T21:33:49Z')
        expect(result.value[1]?.status).toBe('succeeded')
      }
    })

    it('returns each transaction once when both passes include it', async () => {
      vi.mocked(mockClient.getTransactions)
        .mockReturnValueOnce(
          okAsync(
            createMockResponse(
              [createTransaction(1), createTransaction(2)],
              1,
              1,
            ),
          ),
        )
        .mockReturnValueOnce(
          okAsync(
            createMockResponse(
              [createTransaction(2), createTransaction(3)],
              1,
              1,
            ),
          ),
        )

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.map((e) => e.external_id)).toEqual(['1', '2', '3'])
      }
    })

    it('stops on error', async () => {
      const page1Response = createMockResponse([createTransaction(1)], 1, 2)
      const error: ConnectorError = {
        type: 'network',
        source: 'givebutter',
        message: 'Connection lost',
        retryable: true,
      }

      vi.mocked(mockClient.getTransactions)
        .mockReturnValueOnce(okAsync(page1Response))
        .mockReturnValueOnce(errAsync(error))

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
      }
    })

    it('returns empty array when no transactions', async () => {
      const emptyResponse = createMockResponse([], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(emptyResponse),
      )

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual([])
      }
      expect(mockClient.getTransactions).toHaveBeenCalledTimes(2)
    })

    it('handles many pages', async () => {
      const totalPages = 5
      for (let i = 1; i <= totalPages; i++) {
        const response = createMockResponse(
          [createTransaction(i)],
          i,
          totalPages,
        )
        vi.mocked(mockClient.getTransactions).mockReturnValueOnce(
          okAsync(response),
        )
      }
      vi.mocked(mockClient.getTransactions).mockReturnValueOnce(
        okAsync(createMockResponse([], 1, 1)),
      )

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.map((e) => e.external_id)).toEqual([
          '1',
          '2',
          '3',
          '4',
          '5',
        ])
      }
    })
  })

  describe('constructor', () => {
    it('creates client from config when not provided', () => {
      const connectorWithoutClient = new GivebutterConnector({ config })
      expect(connectorWithoutClient.source).toBe('givebutter')
    })

    it('uses provided client', () => {
      const customClient: IGivebutterClient = {
        getTransactions: vi
          .fn<IGivebutterClient['getTransactions']>()
          .mockReturnValue(okAsync(createMockResponse([], 1, 1))),
        healthCheck: vi.fn<IGivebutterClient['healthCheck']>(),
      }

      const connectorWithClient = new GivebutterConnector({
        config,
        client: customClient,
      })

      connectorWithClient.fetchPage({ from, to, runId })
      expect(customClient.getTransactions).toHaveBeenCalled()
    })
  })
})
