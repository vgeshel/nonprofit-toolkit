/**
 * Tests for Patreon connector (implements Connector interface).
 */
import { createConnectorError } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { errAsync, okAsync } from 'neverthrow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PatreonConnector,
  type IPatreonClient,
} from '../../src/patreon/connector'
import type { PatreonMembersResponse } from '../../src/patreon/schema'
import type { FetchOptions, PatreonConfig } from '../../src/types'

const RUN_ID = '550e8400-e29b-41d4-a716-446655440000'

function createMockClient(): IPatreonClient {
  return {
    getMembers: vi.fn<IPatreonClient['getMembers']>(),
    healthCheck: vi.fn<IPatreonClient['healthCheck']>(),
  }
}

function buildResponse(
  cursor: string | null,
  events: { id: string; date: string; amount_cents: number }[],
): PatreonMembersResponse {
  return {
    data: [
      {
        type: 'member',
        id: 'mem_1',
        attributes: { full_name: 'Jane Doe', email: 'jane@example.com' },
        relationships: {
          pledge_history: {
            data: events.map((e) => ({ type: 'pledge-event', id: e.id })),
          },
        },
      },
    ],
    included: events.map((e) => ({
      type: 'pledge-event',
      id: e.id,
      attributes: {
        date: e.date,
        amount_cents: e.amount_cents,
        currency_code: 'USD',
        payment_status: 'Paid',
        type: 'subscription',
      },
    })),
    meta: { pagination: { cursors: { next: cursor } } },
  }
}

describe('PatreonConnector', () => {
  const config: PatreonConfig = {
    accessToken: 'tok',
    campaignId: 'cmp_1',
  }

  let connector: PatreonConnector
  let mockClient: IPatreonClient

  const fetchOptions: FetchOptions = {
    from: DateTime.fromISO('2024-03-01T00:00:00Z', { zone: 'utc' }),
    to: DateTime.fromISO('2024-04-01T00:00:00Z', { zone: 'utc' }),
    runId: RUN_ID,
  }

  beforeEach(() => {
    mockClient = createMockClient()
    connector = new PatreonConnector({ config, client: mockClient })
  })

  describe('source', () => {
    it('returns "patreon"', () => {
      expect(connector.source).toBe('patreon')
    })
  })

  describe('healthCheck', () => {
    it('delegates to the client', async () => {
      vi.mocked(mockClient.healthCheck).mockReturnValueOnce(okAsync(undefined))

      const result = await connector.healthCheck()

      expect(result.isOk()).toBe(true)
      expect(mockClient.healthCheck).toHaveBeenCalledTimes(1)
    })

    it('propagates errors from the client', async () => {
      const error = createConnectorError('auth', 'patreon', 'Invalid token', {
        statusCode: 401,
      })
      vi.mocked(mockClient.healthCheck).mockReturnValueOnce(errAsync(error))

      const result = await connector.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('auth')
      }
    })
  })

  describe('fetchPage', () => {
    it('fetches the first page when no cursor is provided', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync(
          buildResponse(null, [
            { id: 'evt_1', date: '2024-03-15T10:00:00Z', amount_cents: 500 },
          ]),
        ),
      )

      const result = await connector.fetchPage(fetchOptions)

      expect(mockClient.getMembers).toHaveBeenCalledWith(undefined)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(1)
        expect(result.value.events[0]?.external_id).toBe('evt_1')
        expect(result.value.events[0]?.amount_cents).toBe(500)
        expect(result.value.events[0]?.donor_name).toBe('Jane Doe')
        expect(result.value.hasMore).toBe(false)
        expect(result.value.nextCursor).toBeUndefined()
      }
    })

    it('passes the cursor through to the client', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync(buildResponse(null, [])),
      )

      await connector.fetchPage(fetchOptions, 'cursor_xyz')

      expect(mockClient.getMembers).toHaveBeenCalledWith('cursor_xyz')
    })

    it('returns hasMore=true and the next cursor when more pages exist', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync(
          buildResponse('cursor_next', [
            { id: 'evt_1', date: '2024-03-15T10:00:00Z', amount_cents: 500 },
          ]),
        ),
      )

      const result = await connector.fetchPage(fetchOptions)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.hasMore).toBe(true)
        expect(result.value.nextCursor).toBe('cursor_next')
      }
    })

    it('filters events outside the date range', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync(
          buildResponse(null, [
            { id: 'evt_in', date: '2024-03-15T10:00:00Z', amount_cents: 500 },
            {
              id: 'evt_out',
              date: '2024-02-15T10:00:00Z',
              amount_cents: 500,
            },
          ]),
        ),
      )

      const result = await connector.fetchPage(fetchOptions)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(1)
        expect(result.value.events[0]?.external_id).toBe('evt_in')
      }
    })

    it('propagates client errors', async () => {
      const error = createConnectorError(
        'rate_limit',
        'patreon',
        'rate limited',
        { statusCode: 429, retryable: true },
      )
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(errAsync(error))

      const result = await connector.fetchPage(fetchOptions)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.statusCode).toBe(429)
        expect(result.error.retryable).toBe(true)
      }
    })

    it('handles a response with no pagination meta', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync({ data: [] }),
      )

      const result = await connector.fetchPage(fetchOptions)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toEqual([])
        expect(result.value.hasMore).toBe(false)
        expect(result.value.nextCursor).toBeUndefined()
      }
    })
  })

  describe('fetchAll', () => {
    it('returns all events from a single page', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync(
          buildResponse(null, [
            { id: 'evt_1', date: '2024-03-10T10:00:00Z', amount_cents: 500 },
            { id: 'evt_2', date: '2024-03-20T10:00:00Z', amount_cents: 1000 },
          ]),
        ),
      )

      const result = await connector.fetchAll(fetchOptions)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(2)
      }
    })

    it('paginates through multiple pages', async () => {
      vi.mocked(mockClient.getMembers)
        .mockReturnValueOnce(
          okAsync(
            buildResponse('cursor_2', [
              { id: 'evt_1', date: '2024-03-05T00:00:00Z', amount_cents: 500 },
            ]),
          ),
        )
        .mockReturnValueOnce(
          okAsync(
            buildResponse('cursor_3', [
              { id: 'evt_2', date: '2024-03-15T00:00:00Z', amount_cents: 500 },
            ]),
          ),
        )
        .mockReturnValueOnce(
          okAsync(
            buildResponse(null, [
              { id: 'evt_3', date: '2024-03-25T00:00:00Z', amount_cents: 500 },
            ]),
          ),
        )

      const result = await connector.fetchAll(fetchOptions)

      expect(mockClient.getMembers).toHaveBeenCalledTimes(3)
      expect(mockClient.getMembers).toHaveBeenNthCalledWith(1, undefined)
      expect(mockClient.getMembers).toHaveBeenNthCalledWith(2, 'cursor_2')
      expect(mockClient.getMembers).toHaveBeenNthCalledWith(3, 'cursor_3')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(3)
        expect(result.value.map((e) => e.external_id)).toEqual([
          'evt_1',
          'evt_2',
          'evt_3',
        ])
      }
    })

    it('returns an error if any page fails', async () => {
      vi.mocked(mockClient.getMembers)
        .mockReturnValueOnce(
          okAsync(
            buildResponse('cursor_2', [
              { id: 'evt_1', date: '2024-03-05T00:00:00Z', amount_cents: 500 },
            ]),
          ),
        )
        .mockReturnValueOnce(
          errAsync(
            createConnectorError('api', 'patreon', 'server error', {
              statusCode: 500,
            }),
          ),
        )

      const result = await connector.fetchAll(fetchOptions)

      expect(result.isErr()).toBe(true)
    })

    it('returns an empty array when no events fall in range', async () => {
      vi.mocked(mockClient.getMembers).mockReturnValueOnce(
        okAsync(
          buildResponse(null, [
            { id: 'evt_old', date: '2023-01-01T00:00:00Z', amount_cents: 500 },
          ]),
        ),
      )

      const result = await connector.fetchAll(fetchOptions)

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual([])
      }
    })
  })
})
