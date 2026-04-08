/**
 * Tests for the ETL Orchestrator.
 */
import type {
  BigQueryError,
  EtlMetrics,
  EtlMode,
  EtlStatus,
  LoadResult,
  MergeResult,
  Watermark,
} from '@donations-etl/bq'
import type { FetchOptions } from '@donations-etl/connectors'
import type { ConnectorError, DonationEvent } from '@donations-etl/types'
import type { DateTime } from 'luxon'
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config'

type InsertRunFn = (
  runId: string,
  mode: EtlMode,
  from: DateTime,
  to: DateTime,
) => ResultAsync<void, BigQueryError>
type UpdateRunFn = (
  runId: string,
  status: EtlStatus,
  metrics?: EtlMetrics,
  errorMessage?: string,
) => ResultAsync<void, BigQueryError>
type GetWatermarkFn = (
  source: string,
) => ResultAsync<Watermark | null, BigQueryError>
type UpdateWatermarkFn = (
  source: string,
  lastSuccessToTs: DateTime,
) => ResultAsync<void, BigQueryError>
type WriteEventsToGcsFn = (
  events: DonationEvent[],
  runId: string,
  source: string,
  chunkSize?: number,
  chunkPrefix?: string,
) => ResultAsync<string[], BigQueryError>
type LoadFromGcsFn = (
  runId: string,
  source: string,
) => ResultAsync<LoadResult, BigQueryError>
type MergeFn = (runId: string) => ResultAsync<MergeResult, BigQueryError>
type HealthCheckFn = () => ResultAsync<void, BigQueryError>
type FetchAllFn = (
  options: FetchOptions,
) => ResultAsync<DonationEvent[], ConnectorError>

// Create mock instances that we can access
const mockBqClient = {
  insertRun: vi.fn<InsertRunFn>(),
  updateRun: vi.fn<UpdateRunFn>(),
  getWatermark: vi.fn<GetWatermarkFn>(),
  updateWatermark: vi.fn<UpdateWatermarkFn>(),
  writeEventsToGcs: vi.fn<WriteEventsToGcsFn>(),
  loadFromGcs: vi.fn<LoadFromGcsFn>(),
  merge: vi.fn<MergeFn>(),
  updateSourceCoverage: vi.fn<() => ResultAsync<void, BigQueryError>>(),
  healthCheck: vi.fn<HealthCheckFn>(),
}

const mockMercuryConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockPayPalConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockGivebutterConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockCheckDepositsConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockFunraiseConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockVenmoConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockWiseConnector = { fetchAll: vi.fn<FetchAllFn>() }
const mockPatreonConnector = { fetchAll: vi.fn<FetchAllFn>() }

// Mock dependencies with class-based implementations
vi.mock('@donations-etl/connectors', () => ({
  MercuryConnector: class MockMercuryConnector {
    fetchAll = mockMercuryConnector.fetchAll
  },
  PayPalConnector: class MockPayPalConnector {
    fetchAll = mockPayPalConnector.fetchAll
  },
  GivebutterConnector: class MockGivebutterConnector {
    fetchAll = mockGivebutterConnector.fetchAll
  },
  CheckDepositsConnector: class MockCheckDepositsConnector {
    fetchAll = mockCheckDepositsConnector.fetchAll
  },
  FunraiseConnector: class MockFunraiseConnector {
    fetchAll = mockFunraiseConnector.fetchAll
  },
  VenmoConnector: class MockVenmoConnector {
    fetchAll = mockVenmoConnector.fetchAll
  },
  WiseConnector: class MockWiseConnector {
    fetchAll = mockWiseConnector.fetchAll
  },
  PatreonConnector: class MockPatreonConnector {
    fetchAll = mockPatreonConnector.fetchAll
  },
}))

vi.mock('@donations-etl/bq', () => ({
  BigQueryClient: class MockBigQueryClient {
    insertRun = mockBqClient.insertRun
    updateRun = mockBqClient.updateRun
    getWatermark = mockBqClient.getWatermark
    updateWatermark = mockBqClient.updateWatermark
    writeEventsToGcs = mockBqClient.writeEventsToGcs
    loadFromGcs = mockBqClient.loadFromGcs
    merge = mockBqClient.merge
    updateSourceCoverage = mockBqClient.updateSourceCoverage
    healthCheck = mockBqClient.healthCheck
  },
}))

// Import after mocks are set up
import { Orchestrator } from '../src/orchestrator'

describe('Orchestrator', () => {
  let config: Config
  let logger: pino.Logger

  beforeEach(() => {
    vi.clearAllMocks()

    config = {
      PROJECT_ID: 'test-project',
      BUCKET: 'test-bucket',
      DATASET_RAW: 'donations_raw',
      DATASET_CANON: 'donations',
      LOOKBACK_HOURS: 48,
      LOG_LEVEL: 'info',
      MERCURY_API_KEY: 'mercury-key',
      PAYPAL_CLIENT_ID: 'paypal-client',
      PAYPAL_SECRET: 'paypal-secret',
      CHECK_DEPOSITS_SHEET_NAME: 'checks',
    }

    // Create a real pino logger that writes to a no-op destination
    logger = pino({ level: 'silent' })

    // Setup default mock responses
    mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
    mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
    mockBqClient.getWatermark.mockReturnValue(okAsync(null))
    mockBqClient.updateWatermark.mockReturnValue(okAsync(undefined))
    mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
    mockBqClient.loadFromGcs.mockReturnValue(
      okAsync({ rowsLoaded: 100, bytesProcessed: 5000 }),
    )
    mockBqClient.merge.mockReturnValue(
      okAsync({ rowsInserted: 10, rowsUpdated: 5 }),
    )
    mockBqClient.updateSourceCoverage.mockReturnValue(okAsync(undefined))
    mockBqClient.healthCheck.mockReturnValue(okAsync(undefined))

    mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
    mockPayPalConnector.fetchAll.mockReturnValue(okAsync([]))
    mockGivebutterConnector.fetchAll.mockReturnValue(okAsync([]))
  })

  describe('constructor', () => {
    it('initializes with mercury connector when API key is present', () => {
      const orchestrator = new Orchestrator(config, logger)
      expect(orchestrator).toBeDefined()
    })

    it('initializes with paypal connector when client ID and secret are present', () => {
      const orchestrator = new Orchestrator(config, logger)
      expect(orchestrator).toBeDefined()
    })

    it('initializes without givebutter connector when API key is missing', () => {
      const orchestrator = new Orchestrator(config, logger)
      expect(orchestrator).toBeDefined()
    })

    it('initializes with givebutter connector when API key is present', () => {
      const configWithGivebutter = {
        ...config,
        GIVEBUTTER_API_KEY: 'givebutter-key',
      }
      const orchestrator = new Orchestrator(configWithGivebutter, logger)
      expect(orchestrator).toBeDefined()
    })

    it('initializes with check_deposits connector when spreadsheet ID is present', () => {
      const configWithCheckDeposits = {
        ...config,
        CHECK_DEPOSITS_SPREADSHEET_ID: 'test-spreadsheet-id-123',
      }
      const orchestrator = new Orchestrator(configWithCheckDeposits, logger)
      expect(orchestrator).toBeDefined()
    })

    it('initializes with wise connector when token and profile ID are present', () => {
      const configWithWise = {
        ...config,
        WISE_TOKEN: 'wise-token',
        WISE_PROFILE_ID: 12345,
      }
      const orchestrator = new Orchestrator(configWithWise, logger)
      expect(orchestrator).toBeDefined()
    })

    it('initializes with patreon connector when access token and campaign ID are present', () => {
      const configWithPatreon = {
        ...config,
        PATREON_ACCESS_TOKEN: 'patreon-token',
        PATREON_CAMPAIGN_ID: 'cmp_42',
      }
      const orchestrator = new Orchestrator(configWithPatreon, logger)
      expect(orchestrator).toBeDefined()
    })
  })

  describe('healthCheck', () => {
    it('returns ok when BigQuery health check passes', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.healthCheck()

      expect(result.isOk()).toBe(true)
    })

    it('returns error when BigQuery health check fails', async () => {
      mockBqClient.healthCheck.mockReturnValue(
        errAsync({ type: 'query', message: 'Connection failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.healthCheck()

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })
  })

  describe('runDaily', () => {
    it('returns error when no sources are enabled', async () => {
      const configNoSources: Config = {
        ...config,
        MERCURY_API_KEY: undefined,
        PAYPAL_CLIENT_ID: undefined,
        PAYPAL_SECRET: undefined,
      }

      const orchestrator = new Orchestrator(configNoSources, logger)

      const result = await orchestrator.runDaily()

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('config')
      expect(result._unsafeUnwrapErr().message).toContain('No sources enabled')
    })

    it('runs daily ETL successfully with empty events', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily()

      expect(result.isOk()).toBe(true)
      expect(result._unsafeUnwrap().status).toBe('succeeded')
      expect(result._unsafeUnwrap().mode).toBe('daily')
      // Should skip load and merge when no sources have data
      expect(mockBqClient.loadFromGcs).not.toHaveBeenCalled()
      expect(mockBqClient.merge).not.toHaveBeenCalled()
    })

    it('runs daily ETL for specific sources', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isOk()).toBe(true)
      expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
    })

    it('processes events and writes to GCS', async () => {
      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'txn-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 10000,
          fee_cents: 0,
          net_amount_cents: 10000,
          currency: 'USD',
          donor_name: 'John Doe',
          payer_name: null,
          donor_email: 'john@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Test donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000001',
        },
      ]

      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isOk()).toBe(true)
      expect(mockBqClient.writeEventsToGcs).toHaveBeenCalled()
      expect(mockBqClient.merge).toHaveBeenCalled()
    })

    it('updates watermarks after successful run', async () => {
      const orchestrator = new Orchestrator(config, logger)

      await orchestrator.runDaily({ sources: ['mercury'] })

      expect(mockBqClient.updateWatermark).toHaveBeenCalled()
    })

    it('returns error when insertRun fails', async () => {
      mockBqClient.insertRun.mockReturnValue(
        errAsync({ type: 'query', message: 'Insert failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns error when updateRun fails during error handling', async () => {
      const connectorError: ConnectorError = {
        type: 'api',
        source: 'mercury',
        message: 'API failed',
        retryable: false,
      }
      mockMercuryConnector.fetchAll.mockReturnValue(errAsync(connectorError))
      // updateRun fails during error handling
      mockBqClient.updateRun.mockReturnValue(
        errAsync({ type: 'query', message: 'Update failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      // Should return the original connector error, not the updateRun error
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('connector')
    })

    it('returns error when getWatermark fails', async () => {
      mockBqClient.getWatermark.mockReturnValue(
        errAsync({ type: 'query', message: 'Watermark query failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns error when writeEventsToGcs fails', async () => {
      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'gcs-fail-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 10000,
          fee_cents: 0,
          net_amount_cents: 10000,
          currency: 'USD',
          donor_name: 'Test Donor',
          payer_name: null,
          donor_email: 'test@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Test donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000001',
        },
      ]
      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))
      mockBqClient.writeEventsToGcs.mockReturnValue(
        errAsync({ type: 'storage', message: 'GCS write failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns error when merge fails', async () => {
      mockMercuryConnector.fetchAll.mockReturnValue(
        okAsync([
          {
            source: 'mercury',
            external_id: 'txn-123',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 10000,
            fee_cents: 0,
            net_amount_cents: 10000,
            currency: 'USD',
            donor_name: 'John Doe',
            payer_name: null,
            donor_email: 'john@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Test donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: '00000000-0000-0000-0000-000000000001',
          },
        ]),
      )
      mockBqClient.merge.mockReturnValue(
        errAsync({ type: 'query', message: 'Merge failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('updates source coverage after merge', async () => {
      mockMercuryConnector.fetchAll.mockReturnValue(
        okAsync([
          {
            source: 'mercury',
            external_id: 'txn-123',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 10000,
            fee_cents: 0,
            net_amount_cents: 10000,
            currency: 'USD',
            donor_name: 'John Doe',
            payer_name: null,
            donor_email: 'john@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Test donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: '00000000-0000-0000-0000-000000000001',
          },
        ]),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isOk()).toBe(true)
      expect(mockBqClient.updateSourceCoverage).toHaveBeenCalled()
    })

    it('returns error when source coverage update fails', async () => {
      mockMercuryConnector.fetchAll.mockReturnValue(
        okAsync([
          {
            source: 'mercury',
            external_id: 'txn-123',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 10000,
            fee_cents: 0,
            net_amount_cents: 10000,
            currency: 'USD',
            donor_name: 'John Doe',
            payer_name: null,
            donor_email: 'john@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Test donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: '00000000-0000-0000-0000-000000000001',
          },
        ]),
      )
      mockBqClient.updateSourceCoverage.mockReturnValue(
        errAsync({ type: 'query', message: 'Coverage update failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns error when updateWatermark fails', async () => {
      mockBqClient.updateWatermark.mockReturnValue(
        errAsync({ type: 'query', message: 'Watermark update failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns error when connector fails', async () => {
      const connectorError: ConnectorError = {
        type: 'api',
        source: 'mercury',
        message: 'API rate limited',
        retryable: true,
      }
      mockMercuryConnector.fetchAll.mockReturnValue(errAsync(connectorError))

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('connector')
    })

    it('updates run record with error on failure', async () => {
      const connectorError: ConnectorError = {
        type: 'api',
        source: 'mercury',
        message: 'API failed',
        retryable: false,
      }
      mockMercuryConnector.fetchAll.mockReturnValue(errAsync(connectorError))

      const orchestrator = new Orchestrator(config, logger)

      await orchestrator.runDaily({ sources: ['mercury'] })

      expect(mockBqClient.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        undefined,
        expect.stringContaining('mercury'),
      )
    })

    it('uses watermark for fetch window calculation', async () => {
      const watermark = {
        source: 'mercury',
        last_success_to_ts: '2024-01-10T00:00:00Z',
        updated_at: '2024-01-10T01:00:00Z',
      }
      mockBqClient.getWatermark.mockReturnValue(okAsync(watermark))

      const orchestrator = new Orchestrator(config, logger)

      await orchestrator.runDaily({ sources: ['mercury'] })

      expect(mockMercuryConnector.fetchAll).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          from: expect.any(Object), // DateTime
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          to: expect.any(Object), // DateTime
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          runId: expect.any(String),
        }),
      )
    })

    it('loads data from GCS into staging before merge', async () => {
      // This test exposes a bug: loadFromGcs must be called to load
      // NDJSON files from GCS into the staging table before merge runs.
      // Without this step, data is written to GCS but never loaded into BigQuery.
      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'load-test-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 10000,
          fee_cents: 0,
          net_amount_cents: 10000,
          currency: 'USD',
          donor_name: 'Load Test Donor',
          payer_name: null,
          donor_email: 'load@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Test donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000001',
        },
      ]

      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isOk()).toBe(true)
      // Critical: loadFromGcs must be called to load data into staging table
      expect(mockBqClient.loadFromGcs).toHaveBeenCalled()
      // loadFromGcs should be called for each source with events
      expect(mockBqClient.loadFromGcs).toHaveBeenCalledWith(
        expect.any(String), // runId
        'mercury',
      )
    })

    it('returns error when loadFromGcs fails', async () => {
      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'load-fail-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 10000,
          fee_cents: 0,
          net_amount_cents: 10000,
          currency: 'USD',
          donor_name: 'Test Donor',
          payer_name: null,
          donor_email: 'test@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Test donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000001',
        },
      ]

      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))
      mockBqClient.loadFromGcs.mockReturnValue(
        errAsync({ type: 'load', message: 'GCS load failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runDaily({ sources: ['mercury'] })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('bigquery')
        expect(result.error.message).toContain('Load failed for mercury')
      }
    })

    describe('partial pipeline execution', () => {
      it('skips merge when skipMerge is true', async () => {
        const events: DonationEvent[] = [
          {
            source: 'mercury',
            external_id: 'skip-merge-123',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 10000,
            fee_cents: 0,
            net_amount_cents: 10000,
            currency: 'USD',
            donor_name: 'Skip Merge Donor',
            payer_name: null,
            donor_email: 'skip@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Test donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: '00000000-0000-0000-0000-000000000001',
          },
        ]

        mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runDaily({
          sources: ['mercury'],
          skipMerge: true,
        })

        expect(result.isOk()).toBe(true)
        // Should still extract and load to staging
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockBqClient.writeEventsToGcs).toHaveBeenCalled()
        expect(mockBqClient.loadFromGcs).toHaveBeenCalled()
        // But should NOT merge
        expect(mockBqClient.merge).not.toHaveBeenCalled()
        // Should still update watermarks
        expect(mockBqClient.updateWatermark).toHaveBeenCalled()
      })

      it('skips load when skipMerge is true and no sources have data', async () => {
        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runDaily({
          sources: ['mercury'],
          skipMerge: true,
        })

        expect(result.isOk()).toBe(true)
        expect(mockBqClient.loadFromGcs).not.toHaveBeenCalled()
        expect(mockBqClient.merge).not.toHaveBeenCalled()
      })

      it('skips extraction when mergeOnly is true', async () => {
        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runDaily({
          mergeOnly: true,
        })

        expect(result.isOk()).toBe(true)
        // Should NOT extract from any source
        expect(mockMercuryConnector.fetchAll).not.toHaveBeenCalled()
        expect(mockPayPalConnector.fetchAll).not.toHaveBeenCalled()
        expect(mockGivebutterConnector.fetchAll).not.toHaveBeenCalled()
        // Should NOT write to GCS
        expect(mockBqClient.writeEventsToGcs).not.toHaveBeenCalled()
        // Should NOT load from GCS
        expect(mockBqClient.loadFromGcs).not.toHaveBeenCalled()
        // Should only run merge
        expect(mockBqClient.merge).toHaveBeenCalled()
        // Should NOT update watermarks (no extraction happened)
        expect(mockBqClient.updateWatermark).not.toHaveBeenCalled()
      })

      it('returns error when merge fails in mergeOnly mode', async () => {
        mockBqClient.merge.mockReturnValue(
          errAsync({ type: 'query', message: 'Merge failed' }),
        )

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runDaily({
          mergeOnly: true,
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('bigquery')
      })
    })

    describe('Funraise CSV support', () => {
      it('adds Funraise connector when funraiseCsv is provided', async () => {
        // Reset mocks
        mockFunraiseConnector.fetchAll.mockReset()
        mockBqClient.getWatermark.mockReset()

        // Setup mock responses
        mockBqClient.getWatermark.mockReturnValue(okAsync(null))
        mockFunraiseConnector.fetchAll.mockReturnValue(okAsync([]))

        // Config without any sources initially
        const configNoSources: Config = {
          ...config,
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configNoSources, logger)

        const result = await orchestrator.runDaily({
          funraiseCsv: '/path/to/funraise.csv',
        })

        expect(result.isOk()).toBe(true)
        // Funraise connector should have been called
        expect(mockFunraiseConnector.fetchAll).toHaveBeenCalled()
      })

      it('auto-adds funraise to sources when funraiseCsv is provided', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockFunraiseConnector.fetchAll.mockReset()
        mockBqClient.getWatermark.mockReset()
        mockBqClient.updateWatermark.mockReset()

        // Setup mock responses
        mockBqClient.getWatermark.mockReturnValue(okAsync(null))
        mockBqClient.updateWatermark.mockReturnValue(okAsync(undefined))
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
        mockFunraiseConnector.fetchAll.mockReturnValue(okAsync([]))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runDaily({
          sources: ['mercury'], // Only mercury specified
          funraiseCsv: '/path/to/funraise.csv', // But funraise CSV provided
        })

        expect(result.isOk()).toBe(true)
        // Both Mercury and Funraise should have been called
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockFunraiseConnector.fetchAll).toHaveBeenCalled()
      })
    })

    describe('Venmo CSV support', () => {
      it('adds Venmo connector when venmoDir is provided', async () => {
        // Reset mocks
        mockVenmoConnector.fetchAll.mockReset()
        mockBqClient.getWatermark.mockReset()

        // Setup mock responses
        mockBqClient.getWatermark.mockReturnValue(okAsync(null))
        mockVenmoConnector.fetchAll.mockReturnValue(okAsync([]))

        // Config without any sources initially
        const configNoSources: Config = {
          ...config,
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configNoSources, logger)

        const result = await orchestrator.runDaily({
          venmoDir: '/path/to/venmo',
        })

        expect(result.isOk()).toBe(true)
        // Venmo connector should have been called
        expect(mockVenmoConnector.fetchAll).toHaveBeenCalled()
      })

      it('auto-adds venmo to sources when venmoDir is provided', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockVenmoConnector.fetchAll.mockReset()
        mockBqClient.getWatermark.mockReset()
        mockBqClient.updateWatermark.mockReset()

        // Setup mock responses
        mockBqClient.getWatermark.mockReturnValue(okAsync(null))
        mockBqClient.updateWatermark.mockReturnValue(okAsync(undefined))
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
        mockVenmoConnector.fetchAll.mockReturnValue(okAsync([]))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runDaily({
          sources: ['mercury'], // Only mercury specified
          venmoDir: '/path/to/venmo', // But venmo dir provided
        })

        expect(result.isOk()).toBe(true)
        // Both Mercury and Venmo should have been called
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockVenmoConnector.fetchAll).toHaveBeenCalled()
      })
    })
  })

  describe('runBackfill', () => {
    it('returns error when no sources are enabled', async () => {
      const configNoSources: Config = {
        ...config,
        MERCURY_API_KEY: undefined,
        PAYPAL_CLIENT_ID: undefined,
        PAYPAL_SECRET: undefined,
      }

      const orchestrator = new Orchestrator(configNoSources, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-01-31',
        chunk: 'month',
      })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('config')
    })

    it('returns error when from and to dates are missing', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('config')
      expect(result._unsafeUnwrapErr().message).toContain(
        'Backfill requires --from and --to dates',
      )
    })

    it('generates chunks and processes them', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-03-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isOk()).toBe(true)
      const runs = result._unsafeUnwrap()
      // New architecture: single run for entire backfill, chunking happens internally
      expect(runs.length).toBe(1)
    })

    it('generates daily chunks', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-01-03',
        chunk: 'day',
        sources: ['mercury'],
      })

      expect(result.isOk()).toBe(true)
      const runs = result._unsafeUnwrap()
      // New architecture: single run for entire backfill, chunking happens internally
      expect(runs.length).toBe(1)
    })

    it('generates weekly chunks', async () => {
      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-01-22',
        chunk: 'week',
        sources: ['mercury'],
      })

      expect(result.isOk()).toBe(true)
      const runs = result._unsafeUnwrap()
      // New architecture: single run for entire backfill, chunking happens internally
      expect(runs.length).toBe(1)
    })

    it('creates run record for each chunk', async () => {
      const orchestrator = new Orchestrator(config, logger)

      await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(mockBqClient.insertRun).toHaveBeenCalledWith(
        expect.any(String),
        'backfill',
        expect.any(Object),
        expect.any(Object),
      )
    })

    it('does not update watermarks during backfill', async () => {
      const orchestrator = new Orchestrator(config, logger)

      await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(mockBqClient.updateWatermark).not.toHaveBeenCalled()
    })

    it('continues processing other sources after one source fails', async () => {
      const connectorError: ConnectorError = {
        type: 'api',
        source: 'mercury',
        message: 'API failed',
        retryable: false,
      }
      // Mercury fails on first chunk
      mockMercuryConnector.fetchAll.mockReturnValueOnce(
        errAsync(connectorError),
      )

      const orchestrator = new Orchestrator(config, logger)

      // With new architecture, a single source failure causes the backfill to fail
      // but other sources are still processed concurrently
      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      // Single source failing causes the backfill to fail
      expect(result.isErr()).toBe(true)
    })

    it('processes events and writes to GCS during backfill', async () => {
      // Reset mocks to clear any mockReturnValueOnce from previous tests
      mockMercuryConnector.fetchAll.mockReset()
      mockBqClient.writeEventsToGcs.mockReset()
      mockBqClient.loadFromGcs.mockReset()
      mockBqClient.merge.mockReset()
      mockBqClient.insertRun.mockReset()
      mockBqClient.updateRun.mockReset()

      // Setup mock responses
      mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
      mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
      mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
      mockBqClient.loadFromGcs.mockReturnValue(
        okAsync({ rowsLoaded: 100, bytesProcessed: 5000 }),
      )
      mockBqClient.merge.mockReturnValue(
        okAsync({ rowsInserted: 10, rowsUpdated: 5 }),
      )

      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'backfill-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 5000,
          fee_cents: 0,
          net_amount_cents: 5000,
          currency: 'USD',
          donor_name: 'Backfill Donor',
          payer_name: null,
          donor_email: 'backfill@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Backfill donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000002',
        },
      ]

      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isOk()).toBe(true)
      expect(mockBqClient.writeEventsToGcs).toHaveBeenCalled()
      expect(mockBqClient.merge).toHaveBeenCalled()
    })

    it('loads data from GCS into staging before merge during backfill', async () => {
      // This test exposes the same bug as the daily test: loadFromGcs must
      // be called to load NDJSON files from GCS into staging before merge.
      mockMercuryConnector.fetchAll.mockReset()
      mockBqClient.writeEventsToGcs.mockReset()
      mockBqClient.loadFromGcs.mockReset()
      mockBqClient.merge.mockReset()
      mockBqClient.insertRun.mockReset()
      mockBqClient.updateRun.mockReset()

      mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
      mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
      mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
      mockBqClient.loadFromGcs.mockReturnValue(
        okAsync({ rowsLoaded: 100, bytesProcessed: 5000 }),
      )
      mockBqClient.merge.mockReturnValue(
        okAsync({ rowsInserted: 10, rowsUpdated: 5 }),
      )

      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'backfill-load-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 5000,
          fee_cents: 0,
          net_amount_cents: 5000,
          currency: 'USD',
          donor_name: 'Backfill Load Donor',
          payer_name: null,
          donor_email: 'backfill-load@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Backfill load donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000002',
        },
      ]

      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isOk()).toBe(true)
      // Critical: loadFromGcs must be called to load data into staging table
      expect(mockBqClient.loadFromGcs).toHaveBeenCalled()
      expect(mockBqClient.loadFromGcs).toHaveBeenCalledWith(
        expect.any(String), // runId
        'mercury',
      )
    })

    it('handles BigQuery write failure during backfill', async () => {
      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'fail-123',
          event_ts: '2024-01-15T10:00:00Z',
          created_at: '2024-01-15T10:00:00Z',
          ingested_at: '2024-01-15T10:05:00Z',
          amount_cents: 5000,
          fee_cents: 0,
          net_amount_cents: 5000,
          currency: 'USD',
          donor_name: 'Test Donor',
          payer_name: null,
          donor_email: 'test@example.com',
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: 'Test donation',
          attribution: null,
          attribution_human: null,
          source_metadata: {},
          run_id: '00000000-0000-0000-0000-000000000003',
        },
      ]

      mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))
      mockBqClient.writeEventsToGcs.mockReturnValue(
        errAsync({ type: 'query', message: 'GCS write failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns error when insertRun fails during backfill', async () => {
      mockBqClient.insertRun.mockReturnValue(
        errAsync({ type: 'query', message: 'Insert failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    it('returns original error when updateRun fails during backfill error handling', async () => {
      const connectorError: ConnectorError = {
        type: 'api',
        source: 'mercury',
        message: 'API failed during backfill',
        retryable: false,
      }
      mockMercuryConnector.fetchAll.mockReturnValue(errAsync(connectorError))
      // updateRun fails during error handling
      mockBqClient.updateRun.mockReturnValue(
        errAsync({ type: 'query', message: 'Update failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      // Should return the original connector error, not the updateRun error
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('connector')
    })

    it('returns error when updateRun (finalize) fails during successful backfill', async () => {
      mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
      // updateRun fails during finalization (not error handling)
      mockBqClient.updateRun.mockReturnValue(
        errAsync({ type: 'query', message: 'Finalize failed' }),
      )

      const orchestrator = new Orchestrator(config, logger)

      const result = await orchestrator.runBackfill({
        from: '2024-01-01',
        to: '2024-02-01',
        chunk: 'month',
        sources: ['mercury'],
      })

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().type).toBe('bigquery')
    })

    describe('partial pipeline execution', () => {
      it('skips merge when skipMerge is true', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 100, bytesProcessed: 5000 }),
        )

        const events: DonationEvent[] = [
          {
            source: 'mercury',
            external_id: 'backfill-skip-merge-123',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 5000,
            fee_cents: 0,
            net_amount_cents: 5000,
            currency: 'USD',
            donor_name: 'Backfill Skip Merge Donor',
            payer_name: null,
            donor_email: 'backfill-skip@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Backfill skip merge donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: '00000000-0000-0000-0000-000000000002',
          },
        ]

        mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['mercury'],
          skipMerge: true,
        })

        expect(result.isOk()).toBe(true)
        // Should still extract and load to staging
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockBqClient.writeEventsToGcs).toHaveBeenCalled()
        expect(mockBqClient.loadFromGcs).toHaveBeenCalled()
        // But should NOT merge
        expect(mockBqClient.merge).not.toHaveBeenCalled()
      })

      it('skips extraction when mergeOnly is true', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 10, rowsUpdated: 5 }),
        )

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          mergeOnly: true,
          chunk: 'month',
        })

        expect(result.isOk()).toBe(true)
        // Should NOT extract from any source
        expect(mockMercuryConnector.fetchAll).not.toHaveBeenCalled()
        // Should NOT write to GCS
        expect(mockBqClient.writeEventsToGcs).not.toHaveBeenCalled()
        // Should NOT load from GCS
        expect(mockBqClient.loadFromGcs).not.toHaveBeenCalled()
        // Should only run merge
        expect(mockBqClient.merge).toHaveBeenCalled()
      })

      it('returns error when merge fails in mergeOnly mode', async () => {
        // Reset mocks
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.merge.mockReturnValue(
          errAsync({ type: 'query', message: 'Merge failed in backfill' }),
        )

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          mergeOnly: true,
          chunk: 'month',
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('bigquery')
      })

      it('returns error when insertRun fails in mergeOnly mode', async () => {
        // Reset mocks
        mockBqClient.insertRun.mockReset()

        // Setup mock - insertRun fails
        mockBqClient.insertRun.mockReturnValue(
          errAsync({ type: 'query', message: 'Insert failed in merge-only' }),
        )

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          mergeOnly: true,
          chunk: 'month',
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('bigquery')
        expect(result._unsafeUnwrapErr().message).toContain(
          'Insert failed in merge-only',
        )
      })

      it('returns original error when updateRun fails during mergeOnly error handling', async () => {
        // Reset mocks
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        // Merge fails
        mockBqClient.merge.mockReturnValue(
          errAsync({ type: 'query', message: 'Merge failed during backfill' }),
        )
        // updateRun also fails during error handling
        mockBqClient.updateRun.mockReturnValue(
          errAsync({ type: 'query', message: 'Update failed' }),
        )

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          mergeOnly: true,
          chunk: 'month',
        })

        // Should return the original merge error, not the updateRun error
        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('bigquery')
        expect(result._unsafeUnwrapErr().message).toContain('Merge failed')
      })
    })

    describe('Givebutter chunking', () => {
      it('fetches Givebutter events using chunking with API date filtering', async () => {
        // Reset mocks
        mockGivebutterConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 2, bytesProcessed: 1000 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 2, rowsUpdated: 0 }),
        )

        // Givebutter API now filters by date via transactedAfter/transactedBefore
        // The connector returns only events within the requested range
        const eventsInRange: DonationEvent[] = [
          {
            source: 'givebutter',
            external_id: 'gb-in-range-1',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 2000,
            fee_cents: 0,
            net_amount_cents: 2000,
            currency: 'USD',
            donor_name: 'In Range Donor',
            payer_name: null,
            donor_email: 'inrange@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'card',
            description: 'In range donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
          {
            source: 'givebutter',
            external_id: 'gb-in-range-2',
            event_ts: '2024-01-20T10:00:00Z',
            created_at: '2024-01-20T10:00:00Z',
            ingested_at: '2024-01-20T10:05:00Z',
            amount_cents: 3000,
            fee_cents: 0,
            net_amount_cents: 3000,
            currency: 'USD',
            donor_name: 'In Range Donor 2',
            payer_name: null,
            donor_email: 'inrange2@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'card',
            description: 'In range donation 2',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]

        mockGivebutterConnector.fetchAll.mockReturnValue(okAsync(eventsInRange))

        const configWithGivebutter = {
          ...config,
          GIVEBUTTER_API_KEY: 'givebutter-key',
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configWithGivebutter, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['givebutter'],
        })

        expect(result.isOk()).toBe(true)
        // Should write the 2 events returned by the API
        // writeEventsToGcs is called with: events, runId, source, chunkSize, chunkPrefix
        expect(mockBqClient.writeEventsToGcs).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ external_id: 'gb-in-range-1' }),
            expect.objectContaining({ external_id: 'gb-in-range-2' }),
          ]),
          expect.any(String),
          'givebutter',
          undefined, // chunkSize (default)
          '0', // chunkPrefix (chunk index)
        )
        expect(mockBqClient.writeEventsToGcs).toHaveBeenCalledTimes(1)
        const writeCallArgs = mockBqClient.writeEventsToGcs.mock.calls[0]
        expect(Array.isArray(writeCallArgs?.[0])).toBe(true)
        expect(writeCallArgs?.[0]).toHaveLength(2)
      })

      it('returns empty result when no Givebutter events in date range', async () => {
        // Reset mocks
        mockGivebutterConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        // API returns empty when no events in date range
        mockGivebutterConnector.fetchAll.mockReturnValue(okAsync([]))

        const configWithGivebutter = {
          ...config,
          GIVEBUTTER_API_KEY: 'givebutter-key',
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configWithGivebutter, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['givebutter'],
        })

        expect(result.isOk()).toBe(true)
        // Should NOT write anything (no events in range)
        expect(mockBqClient.writeEventsToGcs).not.toHaveBeenCalled()
      })

      it('returns error when Givebutter connector fails', async () => {
        // Reset mocks
        mockGivebutterConnector.fetchAll.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        const connectorError: ConnectorError = {
          type: 'api',
          source: 'givebutter',
          message: 'Givebutter API rate limited',
          retryable: true,
        }
        mockGivebutterConnector.fetchAll.mockReturnValue(
          errAsync(connectorError),
        )

        const configWithGivebutter = {
          ...config,
          GIVEBUTTER_API_KEY: 'givebutter-key',
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configWithGivebutter, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['givebutter'],
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('connector')
        expect(result._unsafeUnwrapErr().message).toContain('givebutter')
      })

      it('returns error when Givebutter GCS write fails', async () => {
        // Reset mocks
        mockGivebutterConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        // Givebutter returns events in range
        const events: DonationEvent[] = [
          {
            source: 'givebutter',
            external_id: 'gb-gcs-fail-1',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 1000,
            fee_cents: 0,
            net_amount_cents: 1000,
            currency: 'USD',
            donor_name: 'GCS Fail Donor',
            payer_name: null,
            donor_email: 'gcsfail@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'card',
            description: 'GCS fail donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]
        mockGivebutterConnector.fetchAll.mockReturnValue(okAsync(events))

        // GCS write fails
        mockBqClient.writeEventsToGcs.mockReturnValue(
          errAsync({
            type: 'storage',
            message: 'GCS write failed for Givebutter',
          }),
        )

        const configWithGivebutter = {
          ...config,
          GIVEBUTTER_API_KEY: 'givebutter-key',
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configWithGivebutter, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['givebutter'],
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('bigquery')
      })

      it('returns 0 count when Givebutter connector is not configured', async () => {
        // Reset mocks
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        // Config without Givebutter
        const configWithoutGivebutter = {
          ...config,
          GIVEBUTTER_API_KEY: undefined,
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configWithoutGivebutter, logger)

        // Try to run backfill with givebutter - should fail as no sources enabled
        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['givebutter'],
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().message).toContain(
          'No sources enabled',
        )
      })
    })

    describe('source chunking strategies', () => {
      it('processes Mercury source with chunking', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 1, bytesProcessed: 500 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 2, rowsUpdated: 0 }),
        )

        const events: DonationEvent[] = [
          {
            source: 'mercury',
            external_id: 'merc-1',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 1000,
            fee_cents: 0,
            net_amount_cents: 1000,
            currency: 'USD',
            donor_name: 'Mercury Donor',
            payer_name: null,
            donor_email: 'merc@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Mercury donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]

        // Return events for each chunk call
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-01-03', // 2-day range = 2 chunks with 'day'
          chunk: 'day',
          sources: ['mercury'],
        })

        expect(result.isOk()).toBe(true)
        // Should be called once per chunk (2 days = 2 chunks)
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalledTimes(2)
      })

      it('processes PayPal source with chunking', async () => {
        // Reset mocks
        mockPayPalConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 1, bytesProcessed: 500 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 1, rowsUpdated: 0 }),
        )

        const events: DonationEvent[] = [
          {
            source: 'paypal',
            external_id: 'pp-1',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 2000,
            fee_cents: 50,
            net_amount_cents: 1950,
            currency: 'USD',
            donor_name: 'PayPal Donor',
            payer_name: null,
            donor_email: 'paypal@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'paypal',
            description: 'PayPal donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]

        mockPayPalConnector.fetchAll.mockReturnValue(okAsync(events))

        // Config with only PayPal
        const configPayPalOnly = {
          ...config,
          MERCURY_API_KEY: undefined,
        }

        const orchestrator = new Orchestrator(configPayPalOnly, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['paypal'],
        })

        expect(result.isOk()).toBe(true)
        expect(mockPayPalConnector.fetchAll).toHaveBeenCalled()
      })

      it('handles empty chunks during chunked fetching', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        // All chunks return empty
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-01-03',
          chunk: 'day',
          sources: ['mercury'],
        })

        expect(result.isOk()).toBe(true)
        // Should be called for each chunk
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalledTimes(2)
        // But no data should be written
        expect(mockBqClient.writeEventsToGcs).not.toHaveBeenCalled()
      })

      it('returns error when chunked fetch fails', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        const connectorError: ConnectorError = {
          type: 'api',
          source: 'mercury',
          message: 'Mercury API failed on chunk',
          retryable: false,
        }
        mockMercuryConnector.fetchAll.mockReturnValue(errAsync(connectorError))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-01-03',
          chunk: 'day',
          sources: ['mercury'],
        })

        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('connector')
      })

      it('clamps final chunk to end date when range does not align with chunk boundary', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 1, bytesProcessed: 500 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 1, rowsUpdated: 0 }),
        )

        const events: DonationEvent[] = [
          {
            source: 'mercury',
            external_id: 'merc-clamp-1',
            event_ts: '2024-01-10T10:00:00Z',
            created_at: '2024-01-10T10:00:00Z',
            ingested_at: '2024-01-10T10:05:00Z',
            amount_cents: 1000,
            fee_cents: 0,
            net_amount_cents: 1000,
            currency: 'USD',
            donor_name: 'Clamp Test Donor',
            payer_name: null,
            donor_email: 'clamp@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Clamp test donation',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]

        mockMercuryConnector.fetchAll.mockReturnValue(okAsync(events))

        const orchestrator = new Orchestrator(config, logger)

        // Use a date range where the end date doesn't align with chunk boundary
        // Jan 1 to Jan 15 with 'month' chunk would normally create Jan 1 -> Feb 1,
        // but it should be clamped to Jan 1 -> Jan 15
        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-01-15', // Mid-month end date
          chunk: 'month', // Monthly chunks would overshoot
          sources: ['mercury'],
        })

        expect(result.isOk()).toBe(true)
        // Should only be called once (single clamped chunk)
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalledTimes(1)
      })
    })

    describe('Funraise CSV support', () => {
      it('adds Funraise connector when funraiseCsv is provided', async () => {
        // Reset mocks
        mockFunraiseConnector.fetchAll.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockFunraiseConnector.fetchAll.mockReturnValue(okAsync([]))

        // Config without any sources initially
        const configNoSources: Config = {
          ...config,
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configNoSources, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          funraiseCsv: '/path/to/funraise.csv',
        })

        expect(result.isOk()).toBe(true)
        // Funraise connector should have been called
        expect(mockFunraiseConnector.fetchAll).toHaveBeenCalled()
      })

      it('auto-adds funraise to sources when funraiseCsv is provided', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockFunraiseConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 1, bytesProcessed: 500 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 1, rowsUpdated: 0 }),
        )
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
        mockFunraiseConnector.fetchAll.mockReturnValue(okAsync([]))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['mercury'], // Only mercury specified
          funraiseCsv: '/path/to/funraise.csv', // But funraise CSV provided
        })

        expect(result.isOk()).toBe(true)
        // Both Mercury and Funraise should have been called
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockFunraiseConnector.fetchAll).toHaveBeenCalled()
      })
    })

    describe('Venmo CSV support', () => {
      it('adds Venmo connector when venmoDir is provided', async () => {
        // Reset mocks
        mockVenmoConnector.fetchAll.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockVenmoConnector.fetchAll.mockReturnValue(okAsync([]))

        // Config without any sources initially
        const configNoSources: Config = {
          ...config,
          MERCURY_API_KEY: undefined,
          PAYPAL_CLIENT_ID: undefined,
          PAYPAL_SECRET: undefined,
        }

        const orchestrator = new Orchestrator(configNoSources, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          venmoDir: '/path/to/venmo',
        })

        expect(result.isOk()).toBe(true)
        // Venmo connector should have been called
        expect(mockVenmoConnector.fetchAll).toHaveBeenCalled()
      })

      it('auto-adds venmo to sources when venmoDir is provided', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockVenmoConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 1, bytesProcessed: 500 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 1, rowsUpdated: 0 }),
        )
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
        mockVenmoConnector.fetchAll.mockReturnValue(okAsync([]))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['mercury'], // Only mercury specified
          venmoDir: '/path/to/venmo', // But venmo dir provided
        })

        expect(result.isOk()).toBe(true)
        // Both Mercury and Venmo should have been called
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockVenmoConnector.fetchAll).toHaveBeenCalled()
      })
    })

    describe('concurrent source processing', () => {
      it('processes multiple sources concurrently', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockPayPalConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))
        mockBqClient.writeEventsToGcs.mockReturnValue(okAsync(['path1.ndjson']))
        mockBqClient.loadFromGcs.mockReturnValue(
          okAsync({ rowsLoaded: 1, bytesProcessed: 500 }),
        )
        mockBqClient.merge.mockReturnValue(
          okAsync({ rowsInserted: 2, rowsUpdated: 0 }),
        )

        const mercuryEvents: DonationEvent[] = [
          {
            source: 'mercury',
            external_id: 'merc-concurrent-1',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 1000,
            fee_cents: 0,
            net_amount_cents: 1000,
            currency: 'USD',
            donor_name: 'Mercury Concurrent',
            payer_name: null,
            donor_email: 'merc@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'ach',
            description: 'Mercury concurrent',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]

        const paypalEvents: DonationEvent[] = [
          {
            source: 'paypal',
            external_id: 'pp-concurrent-1',
            event_ts: '2024-01-15T10:00:00Z',
            created_at: '2024-01-15T10:00:00Z',
            ingested_at: '2024-01-15T10:05:00Z',
            amount_cents: 2000,
            fee_cents: 50,
            net_amount_cents: 1950,
            currency: 'USD',
            donor_name: 'PayPal Concurrent',
            payer_name: null,
            donor_email: 'paypal@example.com',
            donor_phone: null,
            donor_address: null,
            status: 'succeeded',
            payment_method: 'paypal',
            description: 'PayPal concurrent',
            attribution: null,
            attribution_human: null,
            source_metadata: {},
            run_id: 'test-run',
          },
        ]

        mockMercuryConnector.fetchAll.mockReturnValue(okAsync(mercuryEvents))
        mockPayPalConnector.fetchAll.mockReturnValue(okAsync(paypalEvents))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['mercury', 'paypal'],
        })

        expect(result.isOk()).toBe(true)
        // Both sources should have been called
        expect(mockMercuryConnector.fetchAll).toHaveBeenCalled()
        expect(mockPayPalConnector.fetchAll).toHaveBeenCalled()
        // Data from both should be loaded
        expect(mockBqClient.loadFromGcs).toHaveBeenCalledTimes(2)
      })

      it('fails if any source fails during concurrent processing', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockPayPalConnector.fetchAll.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        // Mercury succeeds
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))

        // PayPal fails
        const connectorError: ConnectorError = {
          type: 'api',
          source: 'paypal',
          message: 'PayPal API failed',
          retryable: false,
        }
        mockPayPalConnector.fetchAll.mockReturnValue(errAsync(connectorError))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['mercury', 'paypal'],
        })

        // Should fail because PayPal failed
        expect(result.isErr()).toBe(true)
        expect(result._unsafeUnwrapErr().type).toBe('connector')
      })

      it('skips load/merge when no sources have data', async () => {
        // Reset mocks
        mockMercuryConnector.fetchAll.mockReset()
        mockPayPalConnector.fetchAll.mockReset()
        mockBqClient.writeEventsToGcs.mockReset()
        mockBqClient.loadFromGcs.mockReset()
        mockBqClient.merge.mockReset()
        mockBqClient.insertRun.mockReset()
        mockBqClient.updateRun.mockReset()

        // Setup mock responses
        mockBqClient.insertRun.mockReturnValue(okAsync(undefined))
        mockBqClient.updateRun.mockReturnValue(okAsync(undefined))

        // Both sources return empty
        mockMercuryConnector.fetchAll.mockReturnValue(okAsync([]))
        mockPayPalConnector.fetchAll.mockReturnValue(okAsync([]))

        const orchestrator = new Orchestrator(config, logger)

        const result = await orchestrator.runBackfill({
          from: '2024-01-01',
          to: '2024-02-01',
          chunk: 'month',
          sources: ['mercury', 'paypal'],
        })

        expect(result.isOk()).toBe(true)
        // No data written
        expect(mockBqClient.writeEventsToGcs).not.toHaveBeenCalled()
        // No load or merge
        expect(mockBqClient.loadFromGcs).not.toHaveBeenCalled()
        expect(mockBqClient.merge).not.toHaveBeenCalled()
      })
    })
  })
})
