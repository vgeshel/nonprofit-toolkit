/**
 * Tests for PayPal connector.
 */
import type { ConnectorError } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { errAsync, okAsync } from 'neverthrow'
import type pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEarliestAllowedDate,
  PAYPAL_DEFAULT_PAGE_SIZE,
  PAYPAL_HISTORY_YEARS,
} from '../../src/paypal/client'
import { PayPalConnector, type IPayPalClient } from '../../src/paypal/connector'
import type { PayPalTransactionSearchResponse } from '../../src/paypal/schema'

/**
 * Create a mock pino logger for tests.
 * Uses type assertion because pino.Logger has many internal properties
 * that aren't relevant for testing logging behavior.
 */
function createMockLogger(): pino.Logger {
  const logger = {
    warn: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    debug: vi.fn<(...args: unknown[]) => void>(),
    trace: vi.fn<(...args: unknown[]) => void>(),
    fatal: vi.fn<(...args: unknown[]) => void>(),
    child: vi.fn<(...args: unknown[]) => pino.Logger>(),
    level: 'info',
    silent: vi.fn<(...args: unknown[]) => void>(),
    bindings: vi.fn<() => pino.Bindings>(() => ({})),
    flush: vi.fn<(...args: unknown[]) => void>(),
    isLevelEnabled: vi.fn<(level: string) => boolean>(() => true),
    msgPrefix: undefined,
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Test mock requires type assertion for pino.Logger
  const mockLogger = logger as unknown as pino.Logger
  logger.child.mockReturnValue(mockLogger)
  return mockLogger
}

describe('PayPalConnector', () => {
  const config = {
    clientId: 'test_client_id',
    secret: 'test_client_secret',
  }

  const runId = '550e8400-e29b-41d4-a716-446655440000'
  const from = DateTime.fromISO('2024-01-01T00:00:00Z', { zone: 'utc' })
  const to = DateTime.fromISO('2024-01-31T23:59:59Z', { zone: 'utc' })

  let mockClient: IPayPalClient
  let mockGetTransactions: ReturnType<
    typeof vi.fn<IPayPalClient['getTransactions']>
  >
  let connector: PayPalConnector

  beforeEach(() => {
    mockGetTransactions = vi.fn<IPayPalClient['getTransactions']>()
    mockClient = {
      getTransactions: mockGetTransactions,
      healthCheck: vi.fn<IPayPalClient['healthCheck']>(),
    }
    connector = new PayPalConnector({ config, client: mockClient })
  })

  describe('source', () => {
    it('returns "paypal"', () => {
      expect(connector.source).toBe('paypal')
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
        source: 'paypal',
        message: 'Invalid credentials',
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
    const createMockResponse = (
      transactions: PayPalTransactionSearchResponse['transaction_details'],
      page: number,
      totalPages: number,
    ): PayPalTransactionSearchResponse => ({
      transaction_details: transactions,
      page,
      total_pages: totalPages,
      total_items: transactions.length,
    })

    it('fetches a page of transactions', async () => {
      const mockResponse = createMockResponse(
        [
          {
            transaction_info: {
              transaction_id: 'TX1',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '100.00' },
              transaction_status: 'S',
              transaction_initiation_date: '2024-01-15T10:30:00Z',
            },
            payer_info: {
              email_address: 'donor@example.com',
              payer_name: { given_name: 'John', surname: 'Doe' },
            },
          },
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
        expect(result.value.events[0]?.external_id).toBe('TX1')
        expect(result.value.events[0]?.amount_cents).toBe(10000)
        expect(result.value.events[0]?.donor_email).toBe('donor@example.com')
        expect(result.value.hasMore).toBe(false)
        expect(result.value.nextCursor).toBeUndefined()
      }
    })

    it('indicates hasMore when more pages exist', async () => {
      const mockResponse = createMockResponse(
        [
          {
            transaction_info: {
              transaction_id: 'TX1',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '50.00' },
              transaction_status: 'S',
            },
          },
        ],
        1,
        3,
      )

      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const result = await connector.fetchPage({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.hasMore).toBe(true)
        expect(result.value.nextCursor).toBe('{"page":2}')
      }
    })

    it('uses cursor for pagination', async () => {
      const mockResponse = createMockResponse(
        [
          {
            transaction_info: {
              transaction_id: 'TX2',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '75.00' },
              transaction_status: 'S',
            },
          },
        ],
        2,
        3,
      )

      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const cursor = JSON.stringify({ page: 2 })
      const result = await connector.fetchPage({ from, to, runId }, cursor)

      expect(result.isOk()).toBe(true)
      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 2,
        pageSize: PAYPAL_DEFAULT_PAGE_SIZE,
      })
      if (result.isOk()) {
        expect(result.value.nextCursor).toBe('{"page":3}')
      }
    })

    it('handles invalid cursor gracefully', async () => {
      const mockResponse = createMockResponse([], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      await connector.fetchPage({ from, to, runId }, 'invalid-json')

      // Should use default page 1
      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 1,
        pageSize: PAYPAL_DEFAULT_PAGE_SIZE,
      })
    })

    it('handles malformed cursor object gracefully', async () => {
      const mockResponse = createMockResponse([], 1, 1)
      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      await connector.fetchPage(
        { from, to, runId },
        JSON.stringify({ wrong: 'data' }),
      )

      // Should use default page 1
      expect(mockClient.getTransactions).toHaveBeenCalledWith(from, to, {
        page: 1,
        pageSize: PAYPAL_DEFAULT_PAGE_SIZE,
      })
    })

    it('filters out outgoing payments and non-payment credits', async () => {
      const mockResponse = createMockResponse(
        [
          {
            transaction_info: {
              transaction_id: 'TX_IN',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '100.00' },
              transaction_status: 'S',
            },
          },
          {
            transaction_info: {
              transaction_id: 'TX_OUT',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '-50.00' },
              transaction_status: 'S',
            },
          },
          {
            transaction_info: {
              transaction_id: 'TX_FX',
              transaction_event_code: 'T0200',
              transaction_amount: { currency_code: 'USD', value: '54.12' },
              transaction_status: 'S',
            },
          },
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
        // Only the incoming payment is included; the T0200 conversion is not
        expect(result.value.events).toHaveLength(1)
        expect(result.value.events[0]?.external_id).toBe('TX_IN')
      }
    })

    it('propagates client errors', async () => {
      const error: ConnectorError = {
        type: 'rate_limit',
        source: 'paypal',
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

      const result = await connector.fetchPage({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toEqual([])
        expect(result.value.hasMore).toBe(false)
      }
    })

    it('handles missing total_pages', async () => {
      const mockResponse: PayPalTransactionSearchResponse = {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: 'TX1',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '100.00' },
              transaction_status: 'S',
            },
          },
        ],
      }

      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(mockResponse),
      )

      const result = await connector.fetchPage({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        // Should default to 1 total page, so no more pages
        expect(result.value.hasMore).toBe(false)
      }
    })
  })

  describe('fetchAll', () => {
    it('fetches all pages of transactions', async () => {
      // First page
      const page1Response: PayPalTransactionSearchResponse = {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: 'TX1',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '100.00' },
              transaction_status: 'S',
            },
          },
        ],
        page: 1,
        total_pages: 2,
        total_items: 2,
      }

      // Second page
      const page2Response: PayPalTransactionSearchResponse = {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: 'TX2',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '200.00' },
              transaction_status: 'S',
            },
          },
        ],
        page: 2,
        total_pages: 2,
        total_items: 2,
      }

      vi.mocked(mockClient.getTransactions)
        .mockReturnValueOnce(okAsync(page1Response))
        .mockReturnValueOnce(okAsync(page2Response))

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(2)
        expect(result.value[0]?.external_id).toBe('TX1')
        expect(result.value[1]?.external_id).toBe('TX2')
      }
    })

    it('stops on error', async () => {
      const page1Response: PayPalTransactionSearchResponse = {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: 'TX1',
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '100.00' },
              transaction_status: 'S',
            },
          },
        ],
        page: 1,
        total_pages: 2,
        total_items: 2,
      }

      const error: ConnectorError = {
        type: 'network',
        source: 'paypal',
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
      const emptyResponse: PayPalTransactionSearchResponse = {
        transaction_details: [],
        page: 1,
        total_pages: 1,
        total_items: 0,
      }

      vi.mocked(mockClient.getTransactions).mockReturnValue(
        okAsync(emptyResponse),
      )

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual([])
      }
    })

    it('handles many pages', async () => {
      const createPageResponse = (
        pageNum: number,
        totalPages: number,
      ): PayPalTransactionSearchResponse => ({
        transaction_details: [
          {
            transaction_info: {
              transaction_id: `TX${pageNum}`,
              transaction_event_code: 'T0013',
              transaction_amount: { currency_code: 'USD', value: '50.00' },
              transaction_status: 'S',
            },
          },
        ],
        page: pageNum,
        total_pages: totalPages,
        total_items: totalPages,
      })

      const totalPages = 5
      for (let i = 1; i <= totalPages; i++) {
        vi.mocked(mockClient.getTransactions).mockReturnValueOnce(
          okAsync(createPageResponse(i, totalPages)),
        )
      }

      const result = await connector.fetchAll({ from, to, runId })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(5)
        expect(result.value.map((e) => e.external_id)).toEqual([
          'TX1',
          'TX2',
          'TX3',
          'TX4',
          'TX5',
        ])
      }
    })

    describe('date adjustment for PayPal history limit', () => {
      it('adjusts start date when it exceeds 3-year limit', async () => {
        const emptyResponse: PayPalTransactionSearchResponse = {
          transaction_details: [],
          page: 1,
          total_pages: 1,
          total_items: 0,
        }
        vi.mocked(mockClient.getTransactions).mockReturnValue(
          okAsync(emptyResponse),
        )

        // Request date range starting 5 years ago
        const now = DateTime.utc()
        const oldFrom = now.minus({ years: 5 })
        const recentTo = now

        const result = await connector.fetchAll({
          from: oldFrom,
          to: recentTo,
          runId,
        })

        expect(result.isOk()).toBe(true)

        // The call should have been made with adjusted from date
        const earliest = getEarliestAllowedDate()

        // The from date should be adjusted to the earliest allowed
        expect(mockGetTransactions).toHaveBeenCalledTimes(1)
        const firstCallFrom = mockGetTransactions.mock.calls[0]?.[0]
        expect(firstCallFrom).toBeDefined()
        expect(firstCallFrom?.toMillis()).toBeCloseTo(earliest.toMillis(), -3)
      })

      it('returns empty array when entire date range exceeds limit', async () => {
        // Request date range that is entirely too old
        const now = DateTime.utc()
        const oldFrom = now.minus({ years: 5 })
        const oldTo = now.minus({ years: 4 })

        const result = await connector.fetchAll({
          from: oldFrom,
          to: oldTo,
          runId,
        })

        expect(result.isOk()).toBe(true)
        if (result.isOk()) {
          expect(result.value).toEqual([])
        }

        // The client should not have been called at all
        expect(mockClient.getTransactions).not.toHaveBeenCalled()
      })

      it('does not adjust dates when within limit', async () => {
        const emptyResponse: PayPalTransactionSearchResponse = {
          transaction_details: [],
          page: 1,
          total_pages: 1,
          total_items: 0,
        }
        vi.mocked(mockClient.getTransactions).mockReturnValue(
          okAsync(emptyResponse),
        )

        // Request date range within the limit
        const recentFrom = DateTime.utc().minus({ months: 6 })
        const recentTo = DateTime.utc()

        await connector.fetchAll({
          from: recentFrom,
          to: recentTo,
          runId,
        })

        // The call should have been made with original from date
        const firstCallFrom = mockGetTransactions.mock.calls[0]?.[0]

        expect(firstCallFrom?.toMillis()).toBe(recentFrom.toMillis())
      })

      it('logs warning when adjusting dates', async () => {
        const mockLogger = createMockLogger()

        const connectorWithLogger = new PayPalConnector({
          config,
          client: mockClient,
          logger: mockLogger,
        })

        const emptyResponse: PayPalTransactionSearchResponse = {
          transaction_details: [],
          page: 1,
          total_pages: 1,
          total_items: 0,
        }
        vi.mocked(mockClient.getTransactions).mockReturnValue(
          okAsync(emptyResponse),
        )

        const now = DateTime.utc()
        const oldFrom = now.minus({ years: 5 })
        const recentTo = now

        await connectorWithLogger.fetchAll({
          from: oldFrom,
          to: recentTo,
          runId,
        })

        // Should have logged a warning about adjusting dates
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining<Record<string, unknown>>({
            requestedFrom: expect.any(String),
            adjustedFrom: expect.any(String),
            limit: `${PAYPAL_HISTORY_YEARS} years`,
          }),
          expect.stringContaining('Adjusting start date'),
        )
      })

      it('logs warning when entire range is too old', async () => {
        const mockLogger = createMockLogger()

        const connectorWithLogger = new PayPalConnector({
          config,
          client: mockClient,
          logger: mockLogger,
        })

        const now = DateTime.utc()
        const oldFrom = now.minus({ years: 5 })
        const oldTo = now.minus({ years: 4 })

        await connectorWithLogger.fetchAll({
          from: oldFrom,
          to: oldTo,
          runId,
        })

        // Should have logged a warning about entire range being too old
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining<Record<string, unknown>>({
            from: expect.any(String),
            to: expect.any(String),
          }),
          expect.stringContaining('Returning empty results'),
        )
      })
    })
  })

  describe('constructor', () => {
    it('creates client from config when not provided', () => {
      // This just verifies it doesn't throw
      const connectorWithoutClient = new PayPalConnector({ config })
      expect(connectorWithoutClient.source).toBe('paypal')
    })

    it('uses provided client', () => {
      const customClient: IPayPalClient = {
        getTransactions: vi
          .fn<IPayPalClient['getTransactions']>()
          .mockReturnValue(
            okAsync({
              transaction_details: [],
              page: 1,
              total_pages: 1,
            }),
          ),
        healthCheck: vi.fn<IPayPalClient['healthCheck']>(),
      }

      const connectorWithClient = new PayPalConnector({
        config,
        client: customClient,
      })

      connectorWithClient.fetchPage({ from, to, runId })
      expect(customClient.getTransactions).toHaveBeenCalled()
    })
  })
})
