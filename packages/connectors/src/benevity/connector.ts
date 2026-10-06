/**
 * Benevity connector.
 *
 * Reads Benevity Donations Reports from a local directory, one CSV per
 * disbursement, and transforms them into canonical DonationEvents.
 *
 * Like the other export-backed connectors this ignores the fetch date range:
 * the directory holds whatever history has been downloaded, and the MERGE key
 * (`source`, `external_id`) makes re-ingesting the same reports idempotent.
 */
import {
  createConnectorError,
  type ConnectorError,
  type DonationEvent,
} from '@donations-etl/types'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import pino from 'pino'
import type {
  BenevityConfig,
  Connector,
  FetchOptions,
  FetchResult,
} from '../types'
import { BenevityClient, type IBenevityClient } from './client'
import { transformBenevityReport } from './transformer'

const logger = pino({ name: 'benevity-connector' })

export class BenevityConnector implements Connector {
  readonly source = 'benevity' as const
  private readonly client: IBenevityClient

  constructor(config: BenevityConfig, client?: IBenevityClient) {
    this.client = client ?? new BenevityClient(config.reportDirPath)
  }

  /**
   * Read every report in the directory and transform it.
   *
   * A report that fails its own reconciliation fails the whole fetch. These
   * reports state their totals, so a mismatch means the connector has
   * misunderstood the data — ingesting the rest would quietly load wrong
   * numbers into the consolidated tables.
   */
  fetchAll(
    options: FetchOptions,
  ): ResultAsync<DonationEvent[], ConnectorError> {
    logger.info({ source: this.source }, 'Reading Benevity reports')

    return this.client.readAllReports().andThen((reports) => {
      const events: DonationEvent[] = []

      for (const report of reports) {
        const transformed = transformBenevityReport(report, options.runId)
        if (transformed.isErr()) {
          return errAsync(
            createConnectorError(
              'validation',
              this.source,
              transformed.error.message,
            ),
          )
        }
        events.push(...transformed.value)
      }

      logger.info(
        { source: this.source, reports: reports.length, events: events.length },
        'Transformed Benevity reports',
      )
      return okAsync(events)
    })
  }

  /**
   * Reports are read in one pass, so a page is the whole set.
   */
  fetchPage(options: FetchOptions): ResultAsync<FetchResult, ConnectorError> {
    return this.fetchAll(options).map((events) => ({
      events,
      hasMore: false,
    }))
  }

  healthCheck(): ResultAsync<void, ConnectorError> {
    return this.client.healthCheck()
  }
}

/**
 * Create a Benevity connector from configuration.
 */
export function createBenevityConnector(
  config: BenevityConfig,
  client?: IBenevityClient,
): BenevityConnector {
  return new BenevityConnector(config, client)
}
