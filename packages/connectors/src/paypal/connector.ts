/**
 * PayPal connector implementation.
 *
 * Implements the Connector interface for PayPal Transaction Search API.
 * Fetches transactions and transforms them to DonationEvents.
 */
import type {
  ConnectorError,
  DonationEvent,
  Source,
} from '@donations-etl/types'
import { type ResultAsync, okAsync } from 'neverthrow'
import type pino from 'pino'
import { z } from 'zod'
import type {
  Connector,
  FetchOptions,
  FetchResult,
  PayPalConfig,
} from '../types'
import {
  getEarliestAllowedDate,
  PAYPAL_DEFAULT_PAGE_SIZE,
  PAYPAL_HISTORY_YEARS,
  PayPalClient,
} from './client'
import { transformPayPalTransactions } from './transformer'

/**
 * Zod schema for cursor validation.
 */
const PaginationCursorSchema = z.object({
  page: z.number().int().min(1),
})

type PaginationCursor = z.infer<typeof PaginationCursorSchema>

const DEFAULT_CURSOR: PaginationCursor = { page: 1 }

/**
 * Parse a cursor string into pagination state.
 * Returns default cursor if parsing fails.
 */
function parseCursor(cursor?: string): PaginationCursor {
  if (!cursor) {
    return DEFAULT_CURSOR
  }

  try {
    const parsed: unknown = JSON.parse(cursor)
    const result = PaginationCursorSchema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
  } catch {
    // Invalid JSON, return default
  }

  return DEFAULT_CURSOR
}

/**
 * Interface for PayPal client to allow dependency injection in tests.
 */
export interface IPayPalClient {
  getTransactions(
    ...args: Parameters<PayPalClient['getTransactions']>
  ): ReturnType<PayPalClient['getTransactions']>
  healthCheck(): ReturnType<PayPalClient['healthCheck']>
}

/**
 * Options for PayPalConnector.
 */
export interface PayPalConnectorOptions {
  config: PayPalConfig
  client?: IPayPalClient // Optional for dependency injection in tests
  logger?: pino.Logger // Optional logger for warnings
}

/**
 * PayPal connector.
 *
 * Fetches transactions from PayPal Transaction Search API and transforms them
 * to canonical DonationEvent format. Only includes incoming payments (credits)
 * by default since those represent donations.
 */
export class PayPalConnector implements Connector {
  readonly source: Source = 'paypal'
  private readonly client: IPayPalClient
  private readonly logger?: pino.Logger

  constructor(options: PayPalConnectorOptions) {
    this.client = options.client ?? new PayPalClient(options.config)
    this.logger = options.logger
  }

  /**
   * Check if the PayPal API is accessible.
   */
  healthCheck(): ResultAsync<void, ConnectorError> {
    return this.client.healthCheck()
  }

  /**
   * Fetch a single page of donation events.
   *
   * Uses page-based pagination (PayPal's API pattern).
   */
  fetchPage(
    options: FetchOptions,
    cursor?: string,
  ): ResultAsync<FetchResult, ConnectorError> {
    const { from, to, runId } = options
    const paginationState = parseCursor(cursor)

    return this.client
      .getTransactions(from, to, {
        page: paginationState.page,
        pageSize: PAYPAL_DEFAULT_PAGE_SIZE,
      })
      .andThen((response) => {
        // Transform only incoming payments (credits) to donation events
        const events = transformPayPalTransactions(
          response.transaction_details,
          runId,
        )

        // Determine if there are more pages
        const currentPage = paginationState.page
        const totalPages = response.total_pages ?? 1
        const hasMore = currentPage < totalPages

        let nextCursor: string | undefined
        if (hasMore) {
          nextCursor = JSON.stringify({ page: currentPage + 1 })
        }

        return okAsync({ events, hasMore, nextCursor })
      })
  }

  /**
   * Fetch all donation events.
   *
   * Iterates through all pages, accumulating all donation events.
   * Automatically adjusts date range if it extends beyond PayPal's 3-year limit.
   */
  fetchAll(
    options: FetchOptions,
  ): ResultAsync<DonationEvent[], ConnectorError> {
    const earliest = getEarliestAllowedDate()
    let adjustedOptions = options

    // Check if requested date range extends beyond PayPal's limit
    if (options.from < earliest) {
      // If entire range is too old, return empty results
      if (earliest >= options.to) {
        this.logger?.warn(
          { from: options.from.toISO(), to: options.to.toISO() },
          `Entire date range is outside PayPal ${PAYPAL_HISTORY_YEARS}-year limit. Returning empty results.`,
        )
        return okAsync([])
      }

      // Adjust start date to earliest allowed
      this.logger?.warn(
        {
          requestedFrom: options.from.toISO(),
          adjustedFrom: earliest.toISO(),
          limit: `${PAYPAL_HISTORY_YEARS} years`,
        },
        `PayPal only allows searching transactions from the last ${PAYPAL_HISTORY_YEARS} years. Adjusting start date.`,
      )
      adjustedOptions = { ...options, from: earliest }
    }

    return this.fetchAllRecursive(adjustedOptions, undefined, [])
  }

  /**
   * Recursively fetch all pages.
   */
  private fetchAllRecursive(
    options: FetchOptions,
    cursor: string | undefined,
    accumulated: DonationEvent[],
  ): ResultAsync<DonationEvent[], ConnectorError> {
    return this.fetchPage(options, cursor).andThen((result) => {
      const allEvents = [...accumulated, ...result.events]

      if (!result.hasMore) {
        return okAsync(allEvents)
      }

      return this.fetchAllRecursive(options, result.nextCursor, allEvents)
    })
  }
}
