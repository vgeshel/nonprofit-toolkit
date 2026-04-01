/**
 * BigQuery client wrapper.
 *
 * Provides type-safe operations for ETL runs, watermarks, and data loading.
 * Uses neverthrow Result types for explicit error handling.
 */
import type { DonationEvent } from '@donations-etl/types'
import { BigQuery } from '@google-cloud/bigquery'
import { Storage } from '@google-cloud/storage'
import { DateTime } from 'luxon'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import { z } from 'zod'
import {
  chunkEvents,
  eventsToNdjson,
  generateGcsPath,
  generateGcsPattern,
} from './ndjson'
import { generateReportSql } from './report-sql'
import {
  generateGetRunSql,
  generateGetWatermarkSql,
  generateInsertRunSql,
  generateMergeSql,
  generateUpdateRunSql,
  generateUpdateSourceCoverageSql,
  generateUpsertWatermarkSql,
} from './sql'
import { ensureLimit, validateReadOnlySql } from './sql-safety'
import {
  EtlRunSchema,
  ReportRowSchema,
  WatermarkSchema,
  parseReportRows,
  type BigQueryConfig,
  type EtlMetrics,
  type EtlMode,
  type EtlRun,
  type EtlStatus,
  type GCSConfig,
  type LoadResult,
  type MergeResult,
  type ReportData,
  type Watermark,
} from './types'

/**
 * Error types for BigQuery operations.
 */
export type BigQueryErrorType = 'query' | 'load' | 'storage' | 'validation'

export interface BigQueryError {
  type: BigQueryErrorType
  message: string
  cause?: unknown
}

/**
 * Create a BigQuery error.
 */
function createError(
  type: BigQueryErrorType,
  message: string,
  cause?: unknown,
): BigQueryError {
  return { type, message, cause }
}

/**
 * Default chunk size for NDJSON files.
 */
const DEFAULT_CHUNK_SIZE = 10000

const LoadJobMetadataSchema = z.object({
  status: z
    .object({
      errorResult: z.object({ message: z.string() }).optional(),
    })
    .optional(),
  statistics: z
    .object({
      load: z
        .object({
          outputRows: z.coerce.number().optional(),
          outputBytes: z.coerce.number().optional(),
        })
        .optional(),
    })
    .optional(),
})

const QueryJobMetadataSchema = z.object({
  status: z
    .object({
      errorResult: z.object({ message: z.string() }).optional(),
    })
    .optional(),
  statistics: z
    .object({
      query: z
        .object({
          dmlStats: z
            .object({
              insertedRowCount: z.coerce.number().optional(),
              updatedRowCount: z.coerce.number().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

/**
 * BigQuery client for ETL operations.
 */
export class BigQueryClient {
  private readonly bq: BigQuery
  private readonly storage: Storage
  private readonly config: BigQueryConfig
  private readonly gcsConfig: GCSConfig

  constructor(config: BigQueryConfig, gcsConfig: GCSConfig) {
    this.bq = new BigQuery({ projectId: config.projectId })
    this.storage = new Storage({ projectId: config.projectId })
    this.config = config
    this.gcsConfig = gcsConfig
  }

  /**
   * Insert a new ETL run record.
   */
  insertRun(
    runId: string,
    mode: EtlMode,
    from: DateTime,
    to: DateTime,
  ): ResultAsync<void, BigQueryError> {
    const sql = generateInsertRunSql(this.config)
    // Use a const to ensure TypeScript infers literal 'started' not just string
    const status: EtlStatus = 'started'
    const params = {
      run_id: runId,
      mode,
      status,
      started_at: DateTime.utc().toISO(),
      completed_at: null,
      from_ts: from.toISO(),
      to_ts: to.toISO(),
      metrics: null,
      error_message: null,
    }
    // BigQuery requires explicit types for null parameters
    const types = {
      completed_at: 'TIMESTAMP',
      metrics: 'JSON',
      error_message: 'STRING',
    }

    return ResultAsync.fromPromise(
      this.bq.query({ query: sql, params, types }),
      (error) => createError('query', 'Failed to insert run record', error),
    ).map(() => undefined)
  }

  /**
   * Update an ETL run record with completion status.
   */
  updateRun(
    runId: string,
    status: EtlStatus,
    metrics?: EtlMetrics,
    errorMessage?: string,
  ): ResultAsync<void, BigQueryError> {
    const sql = generateUpdateRunSql(this.config)
    const params = {
      run_id: runId,
      status,
      completed_at: DateTime.utc().toISO(),
      metrics: metrics ? JSON.stringify(metrics) : null,
      error_message: errorMessage ?? null,
    }
    // BigQuery requires explicit types for null parameters
    const types = {
      metrics: 'JSON',
      error_message: 'STRING',
    }

    return ResultAsync.fromPromise(
      this.bq.query({ query: sql, params, types }),
      (error) => createError('query', 'Failed to update run record', error),
    ).map(() => undefined)
  }

  /**
   * Get an ETL run by ID.
   */
  getRun(runId: string): ResultAsync<EtlRun | null, BigQueryError> {
    const sql = generateGetRunSql(this.config)
    const params = { run_id: runId }

    return ResultAsync.fromPromise(
      this.bq.query({ query: sql, params }),
      (error) => createError('query', 'Failed to get run record', error),
    ).map(([rows]) => {
      if (rows.length === 0) return null
      // Parse with Zod schema to validate and type the external data
      return EtlRunSchema.parse(rows[0])
    })
  }

  /**
   * Get the watermark for a source.
   */
  getWatermark(source: string): ResultAsync<Watermark | null, BigQueryError> {
    const sql = generateGetWatermarkSql(this.config)
    const params = { source }

    return ResultAsync.fromPromise(
      this.bq.query({ query: sql, params }),
      (error) => createError('query', 'Failed to get watermark', error),
    ).map(([rows]) => {
      if (rows.length === 0) return null
      // Parse with Zod schema to validate and type the external data
      return WatermarkSchema.parse(rows[0])
    })
  }

  /**
   * Upsert a watermark for a source.
   */
  updateWatermark(
    source: string,
    lastSuccessToTs: DateTime,
  ): ResultAsync<void, BigQueryError> {
    const sql = generateUpsertWatermarkSql(this.config)
    const params = {
      source,
      last_success_to_ts: lastSuccessToTs.toISO(),
      updated_at: DateTime.utc().toISO(),
    }

    return ResultAsync.fromPromise(
      this.bq.query({ query: sql, params }),
      (error) => createError('query', 'Failed to update watermark', error),
    ).map(() => undefined)
  }

  /**
   * Write events to GCS as NDJSON files.
   *
   * Splits events into chunks and writes each chunk as a separate file.
   */
  writeEventsToGcs(
    events: DonationEvent[],
    runId: string,
    source: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
    chunkPrefix?: string,
  ): ResultAsync<string[], BigQueryError> {
    if (events.length === 0) {
      return okAsync([])
    }

    const chunks = chunkEvents(events, chunkSize)
    const bucket = this.storage.bucket(this.gcsConfig.bucket)
    const prefix = this.gcsConfig.prefix ?? ''

    const writePromises = chunks.map(async (chunk, index) => {
      const basePath = generateGcsPath(runId, source, index, chunkPrefix)
      const path = prefix ? `${prefix}/${basePath}` : basePath
      const content = eventsToNdjson(chunk)

      const file = bucket.file(path)
      await file.save(content, { contentType: 'application/json' })

      return path
    })

    return ResultAsync.fromPromise(Promise.all(writePromises), (error) => {
      // Extract error details since Error objects don't serialize to JSON
      /* istanbul ignore next -- @preserve error.cause is rare */
      const errorMessage =
        error instanceof Error
          ? `${error.message}${error.cause ? ` (cause: ${JSON.stringify(error.cause)})` : ''}`
          : String(error)
      return createError(
        'storage',
        `Failed to write events to GCS: ${errorMessage}`,
        error,
      )
    })
  }

  /**
   * Load NDJSON files from GCS into staging table.
   */
  loadFromGcs(
    runId: string,
    source: string,
  ): ResultAsync<LoadResult, BigQueryError> {
    const sourceUri = generateGcsPattern(this.gcsConfig.bucket, runId, source)
    const prefix = this.gcsConfig.prefix ?? ''
    const fullUri = prefix
      ? sourceUri.replace(`/runs/`, `/${prefix}/runs/`)
      : sourceUri

    // Use createJob with sourceUris for GCS-to-BigQuery loads.
    // table.load() is for local files; it creates a ReadStream and fails with GCS URIs.
    return ResultAsync.fromPromise(
      this.bq.createJob({
        configuration: {
          load: {
            destinationTable: {
              projectId: this.config.projectId,
              datasetId: this.config.datasetRaw,
              tableId: 'stg_events',
            },
            sourceFormat: 'NEWLINE_DELIMITED_JSON',
            sourceUris: [fullUri],
            writeDisposition: 'WRITE_APPEND',
            schema: {
              fields: [
                { name: 'run_id', type: 'STRING', mode: 'REQUIRED' },
                { name: 'source', type: 'STRING', mode: 'REQUIRED' },
                { name: 'external_id', type: 'STRING', mode: 'REQUIRED' },
                { name: 'event_ts', type: 'TIMESTAMP', mode: 'REQUIRED' },
                { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
                { name: 'ingested_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
                { name: 'amount_cents', type: 'INT64', mode: 'REQUIRED' },
                { name: 'fee_cents', type: 'INT64', mode: 'REQUIRED' },
                { name: 'net_amount_cents', type: 'INT64', mode: 'REQUIRED' },
                { name: 'currency', type: 'STRING', mode: 'REQUIRED' },
                { name: 'donor_name', type: 'STRING' },
                { name: 'payer_name', type: 'STRING' },
                { name: 'donor_email', type: 'STRING' },
                { name: 'donor_phone', type: 'STRING' },
                { name: 'donor_address', type: 'JSON' },
                { name: 'status', type: 'STRING', mode: 'REQUIRED' },
                { name: 'payment_method', type: 'STRING' },
                { name: 'description', type: 'STRING' },
                { name: 'attribution', type: 'STRING' },
                { name: 'attribution_human', type: 'STRING' },
                { name: 'source_metadata', type: 'JSON', mode: 'REQUIRED' },
              ],
            },
          },
        },
      }),
      (error) => createError('load', 'Failed to create load job', error),
    )
      .andThen(([job]) =>
        // Wait for job to complete
        ResultAsync.fromPromise(job.promise(), () =>
          createError('load', 'Job failed to complete'),
        ).andThen(() =>
          // Get final metadata after job completes
          ResultAsync.fromPromise(job.getMetadata(), (error) =>
            createError('load', 'Failed to get job status', error),
          ),
        ),
      )
      .andThen(([raw]) => {
        const metadata = LoadJobMetadataSchema.parse(raw)

        if (metadata.status?.errorResult) {
          return errAsync(
            createError(
              'load',
              `Load job failed: ${metadata.status.errorResult.message}`,
            ),
          )
        }

        const stats = metadata.statistics?.load
        return okAsync({
          rowsLoaded: stats?.outputRows ?? 0,
          bytesProcessed: stats?.outputBytes ?? 0,
        })
      })
  }

  /**
   * Execute MERGE from staging to canonical table.
   *
   * Uses createJob() instead of query() to get DML statistics.
   * The query() method doesn't return job metadata with statistics,
   * but createJob() + getMetadata() does.
   */
  merge(runId: string): ResultAsync<MergeResult, BigQueryError> {
    const sql = generateMergeSql(this.config)

    return ResultAsync.fromPromise(
      this.bq.createJob({
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
            parameterMode: 'NAMED',
            queryParameters: [
              {
                name: 'run_id',
                parameterType: { type: 'STRING' },
                parameterValue: { value: runId },
              },
            ],
          },
        },
      }),
      (error) => createError('query', 'Failed to create merge job', error),
    )
      .andThen(([job]) =>
        // Wait for job to complete
        ResultAsync.fromPromise(job.promise(), () =>
          createError('query', 'Merge job failed to complete'),
        ).andThen(() =>
          // Get final metadata after job completes
          ResultAsync.fromPromise(job.getMetadata(), (error) =>
            createError('query', 'Failed to get merge job status', error),
          ),
        ),
      )
      .andThen(([raw]) => {
        const metadata = QueryJobMetadataSchema.parse(raw)

        if (metadata.status?.errorResult) {
          return errAsync(
            createError(
              'query',
              `Merge job failed: ${metadata.status.errorResult.message}`,
            ),
          )
        }

        const stats = metadata.statistics?.query?.dmlStats
        return okAsync({
          rowsInserted: stats?.insertedRowCount ?? 0,
          rowsUpdated: stats?.updatedRowCount ?? 0,
        })
      })
  }

  /**
   * Update source coverage dates after a merge.
   *
   * Computes MIN(event_ts) per non-mercury source and upserts into
   * source_coverage. This keeps the disbursement deduplication filter
   * current as new sources are added or backfills extend coverage.
   */
  updateSourceCoverage(): ResultAsync<void, BigQueryError> {
    const sql = generateUpdateSourceCoverageSql(this.config)

    return ResultAsync.fromPromise(this.bq.query({ query: sql }), (error) =>
      createError('query', 'Failed to update source coverage', error),
    ).map(() => undefined)
  }

  /**
   * Query donation report aggregations for a date range.
   *
   * Returns totals, breakdown by source, campaign, and amount range.
   * Filters to succeeded USD donations only.
   */
  queryReport(
    fromTs: string,
    toTs: string,
  ): ResultAsync<ReportData, BigQueryError> {
    const sql = generateReportSql(this.config)
    const params = { from_ts: fromTs, to_ts: toTs }

    return ResultAsync.fromPromise(
      this.bq.query({ query: sql, params }),
      (error) => createError('query', 'Failed to query report data', error),
    ).map(([rows]) => {
      const validated = z.array(ReportRowSchema).parse(rows)
      return parseReportRows(validated)
    })
  }

  /**
   * Execute a read-only SQL query with safety guardrails.
   *
   * - Rejects non-SELECT statements (DDL/DML)
   * - Appends LIMIT if not present
   * - Caps bytes billed to prevent runaway costs
   */
  executeReadOnlyQuery(
    sql: string,
    maxBytes: number = 100 * 1024 * 1024, // 100MB default
  ): ResultAsync<Record<string, unknown>[], BigQueryError> {
    const validationError = validateReadOnlySql(sql)
    if (validationError) {
      return errAsync(createError('query', validationError))
    }

    const limitedSql = ensureLimit(sql)

    return ResultAsync.fromPromise(
      this.bq.query({
        query: limitedSql,
        maximumBytesBilled: String(maxBytes),
      }),
      (error) => createError('query', 'Query execution failed', error),
    ).map(([rows]) => z.array(z.record(z.string(), z.unknown())).parse(rows))
  }

  /**
   * Health check - verify we can query BigQuery.
   */
  healthCheck(): ResultAsync<void, BigQueryError> {
    return ResultAsync.fromPromise(
      this.bq.query({ query: 'SELECT 1' }),
      (error) => createError('query', 'BigQuery health check failed', error),
    ).map(() => undefined)
  }
}
