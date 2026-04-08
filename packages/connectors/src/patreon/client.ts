/**
 * Patreon API V2 HTTP client.
 *
 * Authenticates with a Creator's Access Token (OAuth 2.0 Bearer) and
 * fetches members of a campaign with their `pledge_history` and `user`
 * relationships included. Uses cursor-based pagination.
 *
 * Reference: https://docs.patreon.com/?javascript#apiv2
 */
import type { ConnectorError } from '@donations-etl/types'
import { createConnectorError } from '@donations-etl/types'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import { fetchIPv4 } from '../ipv4-fetch'
import type { PatreonConfig } from '../types'
import {
  PatreonMembersResponseSchema,
  type PatreonMembersResponse,
} from './schema'

export const PATREON_BASE_URL = 'https://www.patreon.com'
export const PATREON_DEFAULT_PAGE_SIZE = 1000

/**
 * Member fields requested from the API. Limiting fields keeps payloads
 * small and is required by Patreon's sparse fieldsets convention.
 */
const MEMBER_FIELDS = [
  'full_name',
  'email',
  'patron_status',
  'last_charge_date',
  'last_charge_status',
  'lifetime_support_cents',
  'currently_entitled_amount_cents',
].join(',')

/**
 * Pledge event fields requested from the API.
 *
 * Patreon's resource type for pledge events is `pledge-event` (hyphen),
 * which must be passed in `fields[pledge-event]=...`.
 *
 * `pledge_payment_status` is requested in addition to `payment_status`
 * because state-change events use it instead. `tier_id` / `tier_title`
 * are stored on the donation event's source_metadata.
 */
const PLEDGE_EVENT_FIELDS = [
  'date',
  'amount_cents',
  'currency_code',
  'payment_status',
  'pledge_payment_status',
  'type',
  'tier_id',
  'tier_title',
].join(',')

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
 * Create a ConnectorError for Patreon API errors.
 */
function createPatreonError(
  message: string,
  statusCode?: number,
  retryable?: boolean,
): ConnectorError {
  const type = getErrorType(statusCode)
  return createConnectorError(type, 'patreon', message, {
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
 * Patreon API V2 client.
 */
export class PatreonClient {
  private readonly accessToken: string
  private readonly campaignId: string
  private readonly baseUrl: string

  constructor(config: PatreonConfig) {
    this.accessToken = config.accessToken
    this.campaignId = config.campaignId
    this.baseUrl = config.baseUrl ?? PATREON_BASE_URL
  }

  /**
   * Build headers for API requests.
   */
  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    }
  }

  /**
   * Build the members URL with includes, fields, and pagination params.
   */
  private buildMembersUrl(cursor?: string, pageSize?: number): string {
    const params = new URLSearchParams()
    params.set('include', 'pledge_history,user')
    params.set('fields[member]', MEMBER_FIELDS)
    params.set('fields[pledge-event]', PLEDGE_EVENT_FIELDS)
    params.set('page[count]', String(pageSize ?? PATREON_DEFAULT_PAGE_SIZE))
    if (cursor) {
      params.set('page[cursor]', cursor)
    }
    return `${this.baseUrl}/api/oauth2/v2/campaigns/${this.campaignId}/members?${params.toString()}`
  }

  /**
   * Fetch a single page of campaign members with their pledge_history.
   *
   * @param cursor Optional pagination cursor from a previous page
   * @param pageSize Optional override of page size
   */
  getMembers(
    cursor?: string,
    pageSize?: number,
  ): ResultAsync<PatreonMembersResponse, ConnectorError> {
    const url = this.buildMembersUrl(cursor, pageSize)

    return ResultAsync.fromPromise(
      fetchIPv4(url, { method: 'GET', headers: this.getHeaders() }),
      (error) =>
        createPatreonError(
          /* istanbul ignore next -- @preserve non-Error thrown values are rare */
          error instanceof Error ? error.message : 'Network request failed',
        ),
    ).andThen((response) => {
      if (!response.ok) {
        return errAsync(
          createPatreonError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
            isRetryableStatus(response.status),
          ),
        )
      }

      return ResultAsync.fromPromise(response.json(), (error) =>
        createPatreonError(
          /* istanbul ignore next -- @preserve non-Error thrown values are rare */
          error instanceof Error
            ? error.message
            : 'Failed to parse response JSON',
        ),
      ).andThen((data) => {
        const result = PatreonMembersResponseSchema.safeParse(data)
        if (!result.success) {
          return errAsync(
            createPatreonError(`Invalid response: ${result.error.message}`),
          )
        }
        return okAsync(result.data)
      })
    })
  }

  /**
   * Verify that the API is reachable and credentials are valid.
   */
  healthCheck(): ResultAsync<void, ConnectorError> {
    return this.getMembers(undefined, 1).map(() => undefined)
  }
}
