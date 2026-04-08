/**
 * Patreon connector implementation.
 *
 * Patreon V2's API does not support server-side date filtering on
 * pledges. To get donation events in a date range we have to walk all
 * members of the campaign (paginated by cursor), accumulate their
 * pledge events, and filter client-side. The transformer applies the
 * date-range filter using the `from`/`to` window from FetchOptions.
 */
import type {
  ConnectorError,
  DonationEvent,
  Source,
} from '@donations-etl/types'
import { type ResultAsync, okAsync } from 'neverthrow'
import type {
  Connector,
  FetchOptions,
  FetchResult,
  PatreonConfig,
} from '../types'
import { PatreonClient } from './client'
import { transformPatreonMembersResponse } from './transformer'

/**
 * Interface for Patreon client to allow dependency injection in tests.
 */
export interface IPatreonClient {
  getMembers(
    ...args: Parameters<PatreonClient['getMembers']>
  ): ReturnType<PatreonClient['getMembers']>
  healthCheck(): ReturnType<PatreonClient['healthCheck']>
}

/**
 * Options for PatreonConnector.
 */
export interface PatreonConnectorOptions {
  config: PatreonConfig
  client?: IPatreonClient
}

/**
 * Patreon connector.
 */
export class PatreonConnector implements Connector {
  readonly source: Source = 'patreon'
  private readonly client: IPatreonClient

  constructor(options: PatreonConnectorOptions) {
    /* istanbul ignore next -- @preserve tests always provide mock client */
    this.client = options.client ?? new PatreonClient(options.config)
  }

  /**
   * Verify that the Patreon API is reachable.
   */
  healthCheck(): ResultAsync<void, ConnectorError> {
    return this.client.healthCheck()
  }

  /**
   * Fetch a single page of donation events.
   *
   * The Patreon next-page cursor is used directly as our connector
   * cursor (no JSON wrapping needed since it's already a string).
   */
  fetchPage(
    options: FetchOptions,
    cursor?: string,
  ): ResultAsync<FetchResult, ConnectorError> {
    const { from, to, runId } = options

    return this.client.getMembers(cursor).map((response) => {
      const events = transformPatreonMembersResponse(response, runId, from, to)
      const nextCursor = response.meta?.pagination?.cursors?.next ?? undefined
      const hasMore = Boolean(nextCursor)
      return { events, hasMore, nextCursor: nextCursor ?? undefined }
    })
  }

  /**
   * Fetch all donation events in the date range.
   */
  fetchAll(
    options: FetchOptions,
  ): ResultAsync<DonationEvent[], ConnectorError> {
    return this.fetchAllRecursive(options, undefined, [])
  }

  /**
   * Recursively fetch all pages and accumulate events.
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
