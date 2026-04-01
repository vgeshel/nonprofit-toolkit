/**
 * Tests for BigQuery client.
 *
 * These tests verify the behavior of the client methods by mocking
 * the underlying BigQuery and GCS client implementations.
 */
import type { DonationEvent } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BigQueryConfig, EtlMetrics, GCSConfig } from '../src/types'

// Create mock instances that we can control
const mockQuery = vi.fn<(opts: unknown) => Promise<[unknown[], unknown]>>()
const mockDataset = vi.fn<(id: string) => { table: typeof mockTable }>()
const mockTable = vi.fn<(id: string) => { load: typeof mockLoad }>()
const mockLoad = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const mockBucket = vi.fn<(name: string) => { file: typeof mockFile }>()
const mockFile = vi.fn<(path: string) => { save: typeof mockSave }>()
const mockSave =
  vi.fn<(content: string, options: { contentType: string }) => Promise<void>>()
const mockCreateJob =
  vi.fn<
    (
      config: unknown,
    ) => Promise<
      [{ promise: typeof mockPromise; getMetadata: typeof mockGetMetadata }]
    >
  >()
const mockGetMetadata = vi.fn<() => Promise<[unknown]>>()
const mockPromise = vi.fn<() => Promise<void>>()

// Mock the modules before importing the client
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class MockBigQuery {
    query = mockQuery
    dataset = mockDataset
    createJob = mockCreateJob
  },
}))

vi.mock('@google-cloud/storage', () => ({
  Storage: class MockStorage {
    bucket = mockBucket
  },
}))

// Import after mocking
import { BigQueryClient } from '../src/client'

describe('BigQueryClient', () => {
  const bqConfig: BigQueryConfig = {
    projectId: 'test-project',
    datasetRaw: 'donations_raw',
    datasetCanon: 'donations',
  }

  const gcsConfig: GCSConfig = {
    bucket: 'test-bucket',
    prefix: 'etl',
  }

  let client: BigQueryClient

  beforeEach(() => {
    vi.clearAllMocks()

    // Setup default mock chain
    mockDataset.mockReturnValue({
      table: mockTable,
    })
    mockTable.mockReturnValue({
      load: mockLoad,
    })
    mockBucket.mockReturnValue({
      file: mockFile,
    })
    mockFile.mockReturnValue({
      save: mockSave,
    })

    client = new BigQueryClient(bqConfig, gcsConfig)
  })

  describe('insertRun', () => {
    it('inserts a run record with correct parameters', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const runId = '550e8400-e29b-41d4-a716-446655440000'
      const from = DateTime.fromISO('2024-01-14T00:00:00Z')
      const to = DateTime.fromISO('2024-01-15T00:00:00Z')

      const result = await client.insertRun(runId, 'daily', from, to)

      expect(result.isOk()).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        query: expect.stringContaining('INSERT INTO'),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({
          run_id: runId,
          mode: 'daily',
          status: 'started',
        }),
        types: {
          completed_at: 'TIMESTAMP',
          metrics: 'JSON',
          error_message: 'STRING',
        },
      })
    })

    it('returns error on query failure', async () => {
      mockQuery.mockRejectedValue(new Error('Connection failed'))

      const result = await client.insertRun(
        '550e8400-e29b-41d4-a716-446655440000',
        'daily',
        DateTime.utc(),
        DateTime.utc(),
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to insert run record')
      }
    })
  })

  describe('updateRun', () => {
    it('updates a run record with metrics', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const metrics: EtlMetrics = {
        sources: { mercury: { count: 100, bytesWritten: 50000 } },
        totalCount: 100,
      }

      const result = await client.updateRun(
        '550e8400-e29b-41d4-a716-446655440000',
        'succeeded',
        metrics,
      )

      expect(result.isOk()).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        query: expect.stringContaining('UPDATE'),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({
          run_id: '550e8400-e29b-41d4-a716-446655440000',
          status: 'succeeded',
          metrics: JSON.stringify(metrics),
        }),
        types: {
          metrics: 'JSON',
          error_message: 'STRING',
        },
      })
    })

    it('updates a run record with error message', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const result = await client.updateRun(
        '550e8400-e29b-41d4-a716-446655440000',
        'failed',
        undefined,
        'Connection timeout',
      )

      expect(result.isOk()).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        query: expect.stringContaining('UPDATE'),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({
          status: 'failed',
          error_message: 'Connection timeout',
          metrics: null,
        }),
        types: {
          metrics: 'JSON',
          error_message: 'STRING',
        },
      })
    })

    it('returns error on update failure', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'))

      const result = await client.updateRun(
        '550e8400-e29b-41d4-a716-446655440000',
        'succeeded',
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to update run record')
      }
    })
  })

  describe('getRun', () => {
    it('returns run record when found', async () => {
      const runRecord = {
        run_id: '550e8400-e29b-41d4-a716-446655440000',
        mode: 'daily',
        status: 'succeeded',
        started_at: '2024-01-15T00:00:00Z',
        completed_at: '2024-01-15T00:05:00Z',
        from_ts: '2024-01-14T00:00:00Z',
        to_ts: '2024-01-15T00:00:00Z',
        metrics: { sources: {}, totalCount: 0 },
        error_message: null,
      }

      mockQuery.mockResolvedValue([[runRecord], {}])

      const result = await client.getRun('550e8400-e29b-41d4-a716-446655440000')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual(runRecord)
      }
    })

    it('returns null when run not found', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const result = await client.getRun('550e8400-e29b-41d4-a716-446655440000')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBeNull()
      }
    })

    it('returns error on query failure', async () => {
      mockQuery.mockRejectedValue(new Error('Query failed'))

      const result = await client.getRun('550e8400-e29b-41d4-a716-446655440000')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to get run record')
      }
    })
  })

  describe('getWatermark', () => {
    it('returns watermark when found', async () => {
      const watermark = {
        source: 'mercury',
        last_success_to_ts: '2024-01-15T00:00:00Z',
        updated_at: '2024-01-15T01:00:00Z',
      }

      mockQuery.mockResolvedValue([[watermark], {}])

      const result = await client.getWatermark('mercury')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual(watermark)
      }
    })

    it('returns null when watermark not found', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const result = await client.getWatermark('unknown')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBeNull()
      }
    })

    it('returns error on query failure', async () => {
      mockQuery.mockRejectedValue(new Error('Query failed'))

      const result = await client.getWatermark('mercury')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to get watermark')
      }
    })
  })

  describe('updateWatermark', () => {
    it('upserts watermark correctly', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const lastSuccessToTs = DateTime.fromISO('2024-01-15T00:00:00Z')
      const result = await client.updateWatermark('mercury', lastSuccessToTs)

      expect(result.isOk()).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        query: expect.stringContaining('MERGE'),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({
          source: 'mercury',
          last_success_to_ts: lastSuccessToTs.toISO(),
        }),
      })
    })

    it('returns error on update failure', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'))

      const lastSuccessToTs = DateTime.fromISO('2024-01-15T00:00:00Z')
      const result = await client.updateWatermark('mercury', lastSuccessToTs)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to update watermark')
      }
    })
  })

  describe('writeEventsToGcs', () => {
    it('returns empty array for empty events', async () => {
      const result = await client.writeEventsToGcs([], 'run-123', 'mercury')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual([])
      }
    })

    it('writes events to GCS', async () => {
      mockSave.mockResolvedValue(undefined)

      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'TX1',
          event_ts: '2024-01-15T10:30:00Z',
          created_at: '2024-01-15T10:30:00Z',
          ingested_at: '2024-01-15T10:35:00Z',
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
          description: null,
          attribution: null,
          attribution_human: null,
          run_id: 'run-123',
          source_metadata: {},
        },
      ]

      const result = await client.writeEventsToGcs(events, 'run-123', 'mercury')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(1)
        expect(result.value[0]).toContain('runs/run-123/source=mercury/')
      }
      expect(mockSave).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ contentType: 'application/json' }),
      )
    })

    it('chunks events correctly', async () => {
      mockSave.mockResolvedValue(undefined)

      // Create 25 events
      const events: DonationEvent[] = Array.from({ length: 25 }, (_, i) => ({
        source: 'mercury',
        external_id: `TX${i}`,
        event_ts: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        ingested_at: '2024-01-15T10:35:00Z',
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
        description: null,
        attribution: null,
        attribution_human: null,
        run_id: 'run-123',
        source_metadata: {},
      }))

      // Use chunk size of 10
      const result = await client.writeEventsToGcs(
        events,
        'run-123',
        'mercury',
        10,
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        // 25 events / 10 per chunk = 3 chunks
        expect(result.value).toHaveLength(3)
      }
    })

    it('returns error on storage failure', async () => {
      mockSave.mockRejectedValue(new Error('Storage unavailable'))

      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'TX1',
          event_ts: '2024-01-15T10:30:00Z',
          created_at: '2024-01-15T10:30:00Z',
          ingested_at: '2024-01-15T10:35:00Z',
          amount_cents: 10000,
          fee_cents: 0,
          net_amount_cents: 10000,
          currency: 'USD',
          donor_name: null,
          payer_name: null,
          donor_email: null,
          donor_phone: null,
          donor_address: null,
          status: 'succeeded',
          payment_method: 'ach',
          description: null,
          attribution: null,
          attribution_human: null,
          run_id: 'run-123',
          source_metadata: {},
        },
      ]

      const result = await client.writeEventsToGcs(events, 'run-123', 'mercury')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('storage')
        // Error message now includes the underlying error details
        expect(result.error.message).toContain('Failed to write events to GCS')
        expect(result.error.message).toContain('Storage unavailable')
      }
    })
  })

  describe('loadFromGcs', () => {
    it('loads data from GCS into staging table', async () => {
      const jobMetadata = {
        status: { state: 'DONE' },
        statistics: {
          load: {
            outputRows: '100',
            outputBytes: '50000',
          },
        },
      }

      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.loadFromGcs('run-123', 'mercury')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.rowsLoaded).toBe(100)
        expect(result.value.bytesProcessed).toBe(50000)
      }

      // Verify createJob was called with correct config
      expect(mockCreateJob).toHaveBeenCalledWith({
        configuration: {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          load: expect.objectContaining({
            destinationTable: {
              projectId: 'test-project',
              datasetId: 'donations_raw',
              tableId: 'stg_events',
            },
            sourceFormat: 'NEWLINE_DELIMITED_JSON',
            sourceUris: [
              'gs://test-bucket/etl/runs/run-123/source=mercury/*.ndjson',
            ],
          }),
        },
      })
    })

    it('returns error on load failure', async () => {
      mockCreateJob.mockRejectedValue(new Error('Load failed'))

      const result = await client.loadFromGcs('run-123', 'mercury')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('load')
        expect(result.error.message).toBe('Failed to create load job')
      }
    })

    it('handles missing statistics', async () => {
      const jobMetadata = { status: { state: 'DONE' } }
      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.loadFromGcs('run-123', 'mercury')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.rowsLoaded).toBe(0)
        expect(result.value.bytesProcessed).toBe(0)
      }
    })

    it('returns error when job has error result', async () => {
      const jobMetadata = {
        status: {
          state: 'DONE',
          errorResult: { message: 'Schema mismatch' },
        },
      }
      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.loadFromGcs('run-123', 'mercury')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('load')
        expect(result.error.message).toBe('Load job failed: Schema mismatch')
      }
    })

    it('returns error when getMetadata fails', async () => {
      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockRejectedValue(new Error('Metadata fetch failed'))
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.loadFromGcs('run-123', 'mercury')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('load')
        expect(result.error.message).toBe('Failed to get job status')
      }
    })

    it('waits for job completion before getting metadata', async () => {
      const jobMetadata = {
        status: { state: 'DONE' },
        statistics: {
          load: { outputRows: '100', outputBytes: '50000' },
        },
      }

      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      await client.loadFromGcs('run-123', 'mercury')

      // Verify promise() is called to wait for job completion
      expect(mockPromise).toHaveBeenCalled()
    })

    it('returns error when job.promise() rejects', async () => {
      mockPromise.mockRejectedValue(new Error('Job execution failed'))
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.loadFromGcs('run-123', 'mercury')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('load')
        expect(result.error.message).toBe('Job failed to complete')
      }
    })
  })

  describe('merge', () => {
    it('executes merge and returns DML stats', async () => {
      const jobMetadata = {
        status: { state: 'DONE' },
        statistics: {
          query: {
            dmlStats: {
              insertedRowCount: '50',
              updatedRowCount: '25',
            },
          },
        },
      }

      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.merge('run-123')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.rowsInserted).toBe(50)
        expect(result.value.rowsUpdated).toBe(25)
      }

      // Verify createJob was called with correct query config
      expect(mockCreateJob).toHaveBeenCalledWith({
        configuration: {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          query: expect.objectContaining({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            query: expect.stringContaining('MERGE'),
            useLegacySql: false,
            parameterMode: 'NAMED',
            queryParameters: [
              {
                name: 'run_id',
                parameterType: { type: 'STRING' },
                parameterValue: { value: 'run-123' },
              },
            ],
          }),
        },
      })
    })

    it('returns zero counts when no DML stats', async () => {
      const jobMetadata = { status: { state: 'DONE' } }

      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.merge('run-123')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.rowsInserted).toBe(0)
        expect(result.value.rowsUpdated).toBe(0)
      }
    })

    it('returns error on job creation failure', async () => {
      mockCreateJob.mockRejectedValue(new Error('Merge failed'))

      const result = await client.merge('run-123')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to create merge job')
      }
    })

    it('returns error when job has error result', async () => {
      const jobMetadata = {
        status: {
          state: 'DONE',
          errorResult: { message: 'Query syntax error' },
        },
      }

      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.merge('run-123')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe(
          'Merge job failed: Query syntax error',
        )
      }
    })

    it('returns error when job.promise() rejects', async () => {
      mockPromise.mockRejectedValue(new Error('Job execution failed'))
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.merge('run-123')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Merge job failed to complete')
      }
    })

    it('returns error when getMetadata fails', async () => {
      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockRejectedValue(new Error('Metadata fetch failed'))
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await client.merge('run-123')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('Failed to get merge job status')
      }
    })
  })

  describe('healthCheck', () => {
    it('succeeds when BigQuery is healthy', async () => {
      mockQuery.mockResolvedValue([[], {}])

      const result = await client.healthCheck()

      expect(result.isOk()).toBe(true)
    })

    it('fails when BigQuery is unhealthy', async () => {
      mockQuery.mockRejectedValue(new Error('Service unavailable'))

      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toBe('BigQuery health check failed')
      }
    })
  })

  describe('without prefix', () => {
    let clientNoPrefix: BigQueryClient

    beforeEach(() => {
      const gcsConfigNoPrefix: GCSConfig = { bucket: 'test-bucket' }
      clientNoPrefix = new BigQueryClient(bqConfig, gcsConfigNoPrefix)
    })

    it('writes events to GCS root path when no prefix', async () => {
      mockSave.mockResolvedValue(undefined)

      const events: DonationEvent[] = [
        {
          source: 'mercury',
          external_id: 'TX1',
          event_ts: '2024-01-15T10:30:00Z',
          created_at: '2024-01-15T10:30:00Z',
          ingested_at: '2024-01-15T10:35:00Z',
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
          description: null,
          attribution: null,
          attribution_human: null,
          run_id: 'run-123',
          source_metadata: {},
        },
      ]

      const result = await clientNoPrefix.writeEventsToGcs(
        events,
        'run-123',
        'mercury',
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(1)
        // Without prefix, path should start with runs/
        expect(result.value[0]).toMatch(/^runs\/run-123\/source=mercury\//)
      }
    })

    it('loads from GCS root path when no prefix', async () => {
      const jobMetadata = {
        status: { state: 'DONE' },
        statistics: {
          load: {
            outputRows: '100',
            outputBytes: '5000',
          },
        },
      }

      mockPromise.mockResolvedValue(undefined)
      mockGetMetadata.mockResolvedValue([jobMetadata])
      mockCreateJob.mockResolvedValue([
        { promise: mockPromise, getMetadata: mockGetMetadata },
      ])

      const result = await clientNoPrefix.loadFromGcs('run-123', 'mercury')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.rowsLoaded).toBe(100)
      }

      // Verify the source URI doesn't have prefix
      expect(mockCreateJob).toHaveBeenCalledWith({
        configuration: {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          load: expect.objectContaining({
            sourceUris: [
              'gs://test-bucket/runs/run-123/source=mercury/*.ndjson',
            ],
          }),
        },
      })
    })
  })

  describe('queryReport', () => {
    it('returns structured report data', async () => {
      mockQuery.mockResolvedValue([
        [
          {
            section: 'total',
            label: 'total',
            total_cents: '1500000',
            count: '42',
            non_usd_excluded: '3',
          },
          {
            section: 'by_source',
            label: 'mercury',
            total_cents: '500000',
            count: '10',
            non_usd_excluded: '0',
          },
          {
            section: 'by_source',
            label: 'paypal',
            total_cents: '1000000',
            count: '32',
            non_usd_excluded: '0',
          },
          {
            section: 'by_campaign',
            label: 'Spring Drive',
            total_cents: '800000',
            count: '25',
            non_usd_excluded: '0',
          },
          {
            section: 'by_amount_range',
            label: '$0 - $100',
            total_cents: '150000',
            count: '25',
            non_usd_excluded: '0',
          },
        ],
        null,
      ])

      const result = await client.queryReport('2026-03-01', '2026-03-31')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.total.totalCents).toBe(1500000)
        expect(result.value.total.count).toBe(42)
        expect(result.value.total.nonUsdExcluded).toBe(3)
        expect(result.value.bySource).toHaveLength(2)
        expect(result.value.bySource[0]?.label).toBe('mercury')
        expect(result.value.byCampaign).toHaveLength(1)
        expect(result.value.byCampaign[0]?.label).toBe('Spring Drive')
        expect(result.value.byAmountRange).toHaveLength(1)
      }
    })

    it('passes date parameters to query', async () => {
      mockQuery.mockResolvedValue([
        [
          {
            section: 'total',
            label: 'total',
            total_cents: '0',
            count: '0',
            non_usd_excluded: '0',
          },
        ],
        null,
      ])

      await client.queryReport('2026-01-01', '2026-01-31')

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { from_ts: '2026-01-01', to_ts: '2026-01-31' },
        }),
      )
    })

    it('returns error when query fails', async () => {
      mockQuery.mockRejectedValue(new Error('BQ error'))

      const result = await client.queryReport('2026-01-01', '2026-01-31')

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toContain('Failed to query report data')
      }
    })

    it('handles empty result set', async () => {
      mockQuery.mockResolvedValue([[], null])

      const result = await client.queryReport('2026-01-01', '2026-01-31')

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.total.totalCents).toBe(0)
        expect(result.value.total.count).toBe(0)
        expect(result.value.bySource).toEqual([])
      }
    })
  })

  describe('executeReadOnlyQuery', () => {
    it('executes a valid SELECT query', async () => {
      mockQuery.mockResolvedValue([[{ source: 'mercury', total: 5000 }], null])

      const result = await client.executeReadOnlyQuery(
        'SELECT source, SUM(amount_cents) as total FROM donations.events GROUP BY source',
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual([{ source: 'mercury', total: 5000 }])
      }
    })

    it('sets maximumBytesBilled on the query', async () => {
      mockQuery.mockResolvedValue([[], null])

      await client.executeReadOnlyQuery('SELECT 1', 50 * 1024 * 1024)

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          maximumBytesBilled: String(50 * 1024 * 1024),
        }),
      )
    })

    it('appends LIMIT when not present', async () => {
      mockQuery.mockResolvedValue([[], null])

      await client.executeReadOnlyQuery('SELECT * FROM donations.events')

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          query: expect.stringContaining('LIMIT 100'),
        }),
      )
    })

    it('preserves existing LIMIT', async () => {
      mockQuery.mockResolvedValue([[], null])

      await client.executeReadOnlyQuery(
        'SELECT * FROM donations.events LIMIT 10',
      )

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          query: expect.stringContaining('LIMIT 10'),
        }),
      )
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          query: expect.not.stringContaining('LIMIT 100'),
        }),
      )
    })

    it('rejects non-SELECT statements', async () => {
      const result = await client.executeReadOnlyQuery(
        'DROP TABLE donations.events',
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toContain('must start with SELECT')
      }
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('rejects SQL injection attempts', async () => {
      const result = await client.executeReadOnlyQuery(
        'SELECT 1; DROP TABLE donations.events',
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.message).toContain(
          'Multi-statement queries are not allowed',
        )
      }
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('returns error when query execution fails', async () => {
      mockQuery.mockRejectedValue(new Error('BigQuery error'))

      const result = await client.executeReadOnlyQuery(
        'SELECT * FROM donations.events',
      )

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
      }
    })
  })

  describe('updateSourceCoverage', () => {
    it('executes source coverage update query', async () => {
      mockQuery.mockResolvedValue([[], null])

      const result = await client.updateSourceCoverage()

      expect(result.isOk()).toBe(true)
      expect(mockQuery).toHaveBeenCalled()
    })

    it('returns error when query fails', async () => {
      mockQuery.mockRejectedValue(new Error('Coverage update failed'))

      const result = await client.updateSourceCoverage()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('query')
        expect(result.error.message).toContain('source coverage')
      }
    })
  })
})
