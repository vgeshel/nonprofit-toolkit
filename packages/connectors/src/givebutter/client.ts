/**
 * Givebutter API HTTP client.
 *
 * Handles API key authentication and transaction fetching.
 * Uses neverthrow Result types for explicit error handling.
 */
import { createConnectorError, type ConnectorError } from '@donations-etl/types'
import type { DateTime } from 'luxon'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import type { GivebutterConfig } from '../types'
import {
  GivebutterTransactionResponseSchema,
  type GivebutterTransactionResponse,
} from './schema'

export const GIVEBUTTER_BASE_URL = 'https://api.givebutter.com/v1'
export const GIVEBUTTER_DEFAULT_PAGE_SIZE = 100

/**
 * Which transaction timestamp the date range filters on.
 *
 * - transacted: when the donor made the payment (the event date)
 * - updated: when Givebutter last changed the record, e.g. when a pending ACH
 *   payment settled and became succeeded several days after it was transacted
 */
export type GivebutterDateField = 'transacted' | 'updated'

interface TransactionQueryOptions {
  page?: number
  perPage?: number
  dateField?: GivebutterDateField
}

/**
 * Determine the error type based on status code.
 */
function getErrorType(statusCode?: number): ConnectorError['type'] {
  if (statusCode === 401 || statusCode === 403) return 'auth'
  if (statusCode === 429) return 'rate_limit'
  if (statusCode !== undefined && statusCode >= 400) return 'api'
  return 'network'
}

/**
 * Create a ConnectorError for Givebutter API errors.
 */
function createGivebutterError(
  message: string,
  statusCode?: number,
  retryable?: boolean,
): ConnectorError {
  const type = getErrorType(statusCode)
  return createConnectorError(type, 'givebutter', message, {
    statusCode,
    retryable,
  })
}

/**
 * Determine if an HTTP status code indicates a retryable error.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Givebutter API client for fetching transactions.
 */
export class GivebutterClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: GivebutterConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? GIVEBUTTER_BASE_URL
  }

  /**
   * Make an authenticated GET request to the Givebutter API.
   */
  private request<T>(
    path: string,
    schema: { parse: (data: unknown) => T },
  ): ResultAsync<T, ConnectorError> {
    const url = `${this.baseUrl}${path}`

    return ResultAsync.fromPromise(
      fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      }),
      (error) =>
        createGivebutterError(
          /* istanbul ignore next -- @preserve non-Error thrown values are rare */
          error instanceof Error ? error.message : 'Network request failed',
        ),
    ).andThen((response) => {
      if (!response.ok) {
        return errAsync(
          createGivebutterError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
            isRetryableStatus(response.status),
          ),
        )
      }

      return ResultAsync.fromPromise(response.json(), (error) =>
        createGivebutterError(
          /* istanbul ignore next -- @preserve non-Error thrown values are rare */
          error instanceof Error
            ? error.message
            : 'Failed to parse response JSON',
        ),
      ).andThen((data) => {
        try {
          const parsed = schema.parse(data)
          return okAsync(parsed)
        } catch (error) {
          return errAsync(
            createGivebutterError(
              /* istanbul ignore next -- @preserve non-Error thrown values are rare */
              error instanceof Error
                ? `Invalid response: ${error.message}`
                : 'Invalid response format',
            ),
          )
        }
      })
    })
  }

  /**
   * Fetch transactions within a date range.
   *
   * Uses Givebutter's date filtering parameters for the chosen date field
   * (transactedAfter/transactedBefore or updatedAfter/updatedBefore):
   * - *After: on or after this date (inclusive)
   * - *Before: before this date (exclusive)
   *
   * @param from Start date for transactions (inclusive)
   * @param to End date for transactions (inclusive - we add 1 day for API's exclusive filter)
   * @param options Pagination options and the date field to filter on
   */
  getTransactions(
    from: DateTime,
    to: DateTime,
    options: TransactionQueryOptions = {},
  ): ResultAsync<GivebutterTransactionResponse, ConnectorError> {
    const page = options.page ?? 1
    const perPage = options.perPage ?? GIVEBUTTER_DEFAULT_PAGE_SIZE
    const dateField = options.dateField ?? 'transacted'

    // Build query parameters
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: perPage.toString(),
    })

    // We add 1 day to 'to' because the *Before filter is exclusive and we want
    // to include transactions from the 'to' date
    const startDate = from.toISODate()
    const endDate = to.plus({ days: 1 }).toISODate()

    /* istanbul ignore else -- @preserve valid DateTime always returns ISO date */
    if (startDate) {
      params.set(`${dateField}After`, startDate)
    }
    /* istanbul ignore else -- @preserve valid DateTime always returns ISO date */
    if (endDate) {
      params.set(`${dateField}Before`, endDate)
    }

    return this.request(
      `/transactions?${params.toString()}`,
      GivebutterTransactionResponseSchema,
    )
  }

  /**
   * Check if the API is accessible and credentials are valid.
   */
  healthCheck(): ResultAsync<void, ConnectorError> {
    // Fetch first page with minimal data to verify credentials
    const params = new URLSearchParams({
      page: '1',
      per_page: '1',
    })

    return this.request(
      `/transactions?${params.toString()}`,
      GivebutterTransactionResponseSchema,
    ).map(() => undefined)
  }
}
