/**
 * Connector interface and types.
 *
 * All data source connectors implement this interface to provide a consistent
 * way to fetch donation events from different sources.
 */
import type {
  ConnectorError,
  DonationEvent,
  Source,
} from '@donations-etl/types'
import type { DateTime } from 'luxon'
import type { ResultAsync } from 'neverthrow'

/**
 * Options for fetching donation events.
 */
export interface FetchOptions {
  /** Inclusive start of the date range (UTC) */
  from: DateTime
  /** Exclusive end of the date range (UTC) */
  to: DateTime
  /** UUID for this ETL run (assigned to all events) */
  runId: string
}

/**
 * Result of fetching a single page of donation events.
 */
export interface FetchResult {
  /** Donation events from this page */
  events: DonationEvent[]
  /** Cursor for the next page (undefined if no more pages) */
  nextCursor?: string
  /** Whether there are more pages to fetch */
  hasMore: boolean
}

/**
 * Connector interface that all data source adapters must implement.
 *
 * Design decisions:
 * - All methods return ResultAsync for explicit error handling
 * - fetchAll handles pagination internally for convenience
 * - fetchPage allows fine-grained control for testing/debugging
 * - healthCheck validates configuration before running ETL
 */
export interface Connector {
  /** The source identifier for this connector */
  readonly source: Source

  /**
   * Fetch all donation events in the date range.
   * Handles pagination internally.
   *
   * @param options Fetch options including date range and run ID
   * @returns All donation events in the range, or an error
   */
  fetchAll(options: FetchOptions): ResultAsync<DonationEvent[], ConnectorError>

  /**
   * Fetch a single page of donation events.
   * Useful for testing or when you need pagination control.
   *
   * @param options Fetch options including date range and run ID
   * @param cursor Pagination cursor from previous page (undefined for first page)
   * @returns Single page of events with pagination info
   */
  fetchPage(
    options: FetchOptions,
    cursor?: string,
  ): ResultAsync<FetchResult, ConnectorError>

  /**
   * Verify that the connector is configured correctly.
   * Checks API credentials and connectivity.
   *
   * @returns Ok if healthy, error if not
   */
  healthCheck(): ResultAsync<void, ConnectorError>
}

/**
 * Configuration for creating connectors.
 */
export interface MercuryConfig {
  apiKey: string
  baseUrl?: string
}

export interface PayPalConfig {
  clientId: string
  secret: string
  /** Use PayPal sandbox environment */
  sandbox?: boolean
  /** Override the base URL (takes precedence over sandbox) */
  baseUrl?: string
}

export interface GivebutterConfig {
  apiKey: string
  baseUrl?: string
}

export interface CheckDepositsConfig {
  spreadsheetId: string
  sheetName?: string
}

export interface FunraiseConfig {
  csvFilePath: string
}

export interface VenmoConfig {
  csvDirPath: string
}

export interface WiseConfig {
  apiToken: string
  profileId: number
  /** Optional: fetch from specific balance. If omitted, fetches from all balances. */
  balanceId?: number
  baseUrl?: string
}

export interface PatreonConfig {
  /** Patreon Creator's Access Token (OAuth 2.0 Bearer) */
  accessToken: string
  /** Patreon Campaign ID to fetch members from */
  campaignId: string
  baseUrl?: string
}

export interface ConnectorConfigs {
  mercury?: MercuryConfig
  paypal?: PayPalConfig
  givebutter?: GivebutterConfig
  checkDeposits?: CheckDepositsConfig
  funraise?: FunraiseConfig
  venmo?: VenmoConfig
  wise?: WiseConfig
  patreon?: PatreonConfig
}

/**
 * Factory function type for creating connectors.
 */
export interface ConnectorFactory<C extends Connector> {
  mercury: (config: MercuryConfig) => C
  paypal: (config: PayPalConfig) => C
  givebutter: (config: GivebutterConfig) => C
}
