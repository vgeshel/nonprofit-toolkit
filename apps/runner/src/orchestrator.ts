/**
 * ETL Orchestrator.
 *
 * Coordinates the ETL pipeline:
 * 1. Fetch events from connectors
 * 2. Write to GCS as NDJSON
 * 3. Load into BigQuery staging
 * 4. Merge into canonical table
 * 5. Update watermarks and run status
 */
import {
  BigQueryClient,
  type EtlMetrics,
  type SourceMetrics,
} from '@donations-etl/bq'
import {
  CheckDepositsConnector,
  FunraiseConnector,
  GivebutterConnector,
  MercuryConnector,
  PayPalConnector,
  VenmoConnector,
  WiseConnector,
  type Connector,
} from '@donations-etl/connectors'
import type { ConnectorError, Source } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import type { Config } from './config'
import type { Logger } from './logger'

/**
 * Orchestrator error types.
 */
export type OrchestratorErrorType =
  | 'config'
  | 'connector'
  | 'bigquery'
  | 'internal'

export interface OrchestratorError {
  type: OrchestratorErrorType
  message: string
  cause?: unknown
}

/**
 * Create an orchestrator error.
 */
function createError(
  type: OrchestratorErrorType,
  message: string,
  cause?: unknown,
): OrchestratorError {
  return { type, message, cause }
}

/**
 * Daily run options.
 */
export interface DailyOptions {
  sources?: Source[]
  /** Skip merge to final table, only load to staging */
  skipMerge?: boolean
  /** Skip extraction, only run merge from staging to final */
  mergeOnly?: boolean
  /** Path to Funraise CSV export file */
  funraiseCsv?: string
  /** Path to directory containing Venmo CSV exports */
  venmoDir?: string
}

/**
 * Backfill options.
 */
export interface BackfillOptions {
  from?: string // YYYY-MM-DD, optional with mergeOnly
  to?: string // YYYY-MM-DD, optional with mergeOnly
  chunk: 'day' | 'week' | 'month'
  sources?: Source[]
  /** Skip merge to final table, only load to staging */
  skipMerge?: boolean
  /** Skip extraction, only run merge from staging to final */
  mergeOnly?: boolean
  /** Path to Funraise CSV export file */
  funraiseCsv?: string
  /** Path to directory containing Venmo CSV exports */
  venmoDir?: string
}

/**
 * Run result.
 */
export interface RunResult {
  runId: string
  mode: 'daily' | 'backfill'
  status: 'succeeded' | 'failed'
  metrics?: EtlMetrics
  error?: string
}

/**
 * ETL Orchestrator.
 */
export class Orchestrator {
  private readonly bq: BigQueryClient
  private readonly connectors: Map<Source, Connector>
  private readonly config: Config
  private readonly logger: Logger

  constructor(config: Config, logger: Logger) {
    this.config = config
    this.logger = logger

    // Initialize BigQuery client
    this.bq = new BigQueryClient(
      {
        projectId: config.PROJECT_ID,
        datasetRaw: config.DATASET_RAW,
        datasetCanon: config.DATASET_CANON,
      },
      {
        bucket: config.BUCKET,
      },
    )

    // Initialize connectors based on configuration
    this.connectors = new Map()

    if (config.MERCURY_API_KEY) {
      this.connectors.set(
        'mercury',
        new MercuryConnector({ config: { apiKey: config.MERCURY_API_KEY } }),
      )
    }

    if (config.PAYPAL_CLIENT_ID && config.PAYPAL_SECRET) {
      this.connectors.set(
        'paypal',
        new PayPalConnector({
          config: {
            clientId: config.PAYPAL_CLIENT_ID,
            secret: config.PAYPAL_SECRET,
          },
          logger: this.logger.child({ connector: 'paypal' }),
        }),
      )
    }

    if (config.GIVEBUTTER_API_KEY) {
      this.connectors.set(
        'givebutter',
        new GivebutterConnector({
          config: { apiKey: config.GIVEBUTTER_API_KEY },
        }),
      )
    }

    if (config.CHECK_DEPOSITS_SPREADSHEET_ID) {
      this.connectors.set(
        'check_deposits',
        new CheckDepositsConnector({
          config: {
            spreadsheetId: config.CHECK_DEPOSITS_SPREADSHEET_ID,
            sheetName: config.CHECK_DEPOSITS_SHEET_NAME,
          },
        }),
      )
    }

    if (config.WISE_TOKEN && config.WISE_PROFILE_ID) {
      this.connectors.set(
        'wise',
        new WiseConnector({
          config: {
            apiToken: config.WISE_TOKEN,
            profileId: config.WISE_PROFILE_ID,
          },
        }),
      )
    }
  }

  /**
   * Run daily ETL.
   */
  runDaily(
    options: DailyOptions = {},
  ): ResultAsync<RunResult, OrchestratorError> {
    const runId = uuidv4()
    const now = DateTime.utc()
    const lookbackHours = this.config.LOOKBACK_HOURS
    const { skipMerge, mergeOnly, funraiseCsv, venmoDir } = options

    // Add Funraise connector if CSV path is provided
    if (funraiseCsv) {
      this.connectors.set(
        'funraise',
        new FunraiseConnector({ config: { csvFilePath: funraiseCsv } }),
      )
    }

    // Add Venmo connector if directory path is provided
    if (venmoDir) {
      this.connectors.set('venmo', new VenmoConnector({ csvDirPath: venmoDir }))
    }

    this.logger.info(
      { runId, mode: 'daily', skipMerge, mergeOnly, funraiseCsv, venmoDir },
      'Starting daily ETL run',
    )

    // Determine which sources to process
    // If funraiseCsv is provided but funraise is not in sources, auto-add it
    // If venmoDir is provided but venmo is not in sources, auto-add it
    let sources = options.sources ?? Array.from(this.connectors.keys())
    if (funraiseCsv && !sources.includes('funraise')) {
      sources = [...sources, 'funraise']
    }
    if (venmoDir && !sources.includes('venmo')) {
      sources = [...sources, 'venmo']
    }
    const enabledSources = sources.filter((s) => this.connectors.has(s))

    // For mergeOnly, we don't need sources (just run merge)
    if (enabledSources.length === 0 && !mergeOnly) {
      return errAsync(createError('config', 'No sources enabled'))
    }

    // Create the run record
    return this.bq
      .insertRun(runId, 'daily', now.minus({ hours: lookbackHours }), now)
      .mapErr((e) => createError('bigquery', e.message, e))
      .andThen(() =>
        this.processSourcesDaily(
          runId,
          enabledSources,
          lookbackHours,
          skipMerge,
          mergeOnly,
        ),
      )
      .andThen((metrics) =>
        this.finalizeRun(runId, 'daily', 'succeeded', metrics),
      )
      .orElse((error) => {
        // On failure, update the run record with error
        return this.bq
          .updateRun(runId, 'failed', undefined, error.message)
          .mapErr(() => error) // Keep original error
          .andThen(() => errAsync(error))
      })
  }

  /**
   * Run backfill ETL.
   *
   * Runs each source concurrently with its own fetching strategy:
   * - Mercury: Supports date filtering, uses chunking
   * - PayPal: Has 3-year limit, uses chunking within limit
   * - Givebutter: No API date filtering, fetches all and filters client-side
   * - Funraise: CSV file, no date filtering (reads entire file)
   */
  runBackfill(
    options: BackfillOptions,
  ): ResultAsync<RunResult[], OrchestratorError> {
    const { skipMerge, mergeOnly, funraiseCsv, venmoDir } = options

    // Add Funraise connector if CSV path is provided
    if (funraiseCsv) {
      this.connectors.set(
        'funraise',
        new FunraiseConnector({ config: { csvFilePath: funraiseCsv } }),
      )
    }

    // Add Venmo connector if directory path is provided
    if (venmoDir) {
      this.connectors.set('venmo', new VenmoConnector({ csvDirPath: venmoDir }))
    }

    // If mergeOnly, run a single merge without extracting data
    if (mergeOnly) {
      return this.runMergeOnly()
    }

    // For regular backfill, from and to are required (validated by Zod schema)
    const from = options.from ?? ''
    const to = options.to ?? ''

    if (from === '' || to === '') {
      return errAsync(
        createError('config', 'Backfill requires --from and --to dates'),
      )
    }

    // Determine which sources to process
    // If funraiseCsv is provided but funraise is not in sources, auto-add it
    // If venmoDir is provided but venmo is not in sources, auto-add it
    let sources = options.sources ?? Array.from(this.connectors.keys())
    if (funraiseCsv && !sources.includes('funraise')) {
      sources = [...sources, 'funraise']
    }
    if (venmoDir && !sources.includes('venmo')) {
      sources = [...sources, 'venmo']
    }
    const enabledSources = sources.filter((s) => this.connectors.has(s))

    if (enabledSources.length === 0) {
      return errAsync(createError('config', 'No sources enabled'))
    }

    const fromDate = DateTime.fromISO(from, { zone: 'utc' })
    const toDate = DateTime.fromISO(to, { zone: 'utc' })

    this.logger.info(
      {
        from,
        to,
        sources: enabledSources,
        skipMerge,
      },
      'Starting backfill (sources run concurrently)',
    )

    // Run each source concurrently with its own strategy
    return this.processSourcesConcurrently(
      enabledSources,
      fromDate,
      toDate,
      options.chunk,
      skipMerge,
    )
  }

  /**
   * Run merge-only mode: just merge staging data to final table.
   */
  private runMergeOnly(): ResultAsync<RunResult[], OrchestratorError> {
    const runId = uuidv4()
    const now = DateTime.utc()

    this.logger.info({ runId }, 'Running merge-only mode')

    return this.bq
      .insertRun(runId, 'backfill', now, now) // Use current time for both from/to
      .mapErr((e) => createError('bigquery', e.message, e))
      .andThen(() => this.mergeToFinal(runId))
      .andThen(() =>
        this.finalizeRun(runId, 'backfill', 'succeeded', {
          sources: {},
          totalCount: 0,
          totalDurationMs: 0,
        }),
      )
      .map((result) => [result])
      .orElse((error) => {
        return this.bq
          .updateRun(runId, 'failed', undefined, error.message)
          .mapErr(() => error)
          .andThen(() => errAsync(error))
      })
  }

  /**
   * Health check - verify all connectors and BigQuery are accessible.
   */
  healthCheck(): ResultAsync<void, OrchestratorError> {
    return this.bq
      .healthCheck()
      .mapErr((e) =>
        createError(
          'bigquery',
          `BigQuery health check failed: ${e.message}`,
          e,
        ),
      )
  }

  /**
   * Process all sources for daily mode.
   *
   * @param skipMerge - If true, load to staging but skip merge to final table
   * @param mergeOnly - If true, skip extraction and only run merge
   */
  private processSourcesDaily(
    runId: string,
    sources: Source[],
    lookbackHours: number,
    skipMerge?: boolean,
    mergeOnly?: boolean,
  ): ResultAsync<EtlMetrics, OrchestratorError> {
    const now = DateTime.utc()
    const sourceMetrics: Record<string, SourceMetrics> = {}
    let totalCount = 0
    const startTime = Date.now()

    // If mergeOnly, skip extraction and just run merge
    if (mergeOnly) {
      this.logger.info(
        { runId },
        'Running merge-only mode, skipping extraction',
      )
      return this.mergeToFinal(runId).map(() => ({
        sources: sourceMetrics,
        totalCount: 0,
        totalDurationMs: Date.now() - startTime,
      }))
    }

    // Track which sources actually have data to load
    const sourcesWithData: Source[] = []

    // Process each source sequentially
    const processSource = (
      index: number,
    ): ResultAsync<void, OrchestratorError> => {
      const source = sources[index]
      if (source === undefined) {
        return okAsync(undefined)
      }
      return this.processSourceDaily(runId, source, lookbackHours, now).andThen(
        (metrics) => {
          sourceMetrics[source] = metrics
          totalCount += metrics.count
          if (metrics.count > 0) {
            sourcesWithData.push(source)
          }
          return processSource(index + 1)
        },
      )
    }

    // Build the pipeline based on flags
    let pipeline = processSource(0)

    if (skipMerge) {
      // Load to staging only, skip merge
      this.logger.info(
        { runId },
        'Running skip-merge mode, loading to staging only',
      )
      pipeline = pipeline.andThen(() =>
        sourcesWithData.length > 0
          ? this.loadToStaging(runId, sourcesWithData)
          : okAsync(undefined),
      )
    } else {
      // Full pipeline: load and merge
      pipeline = pipeline.andThen(() =>
        sourcesWithData.length > 0
          ? this.loadAndMerge(runId, sourcesWithData)
          : okAsync(undefined),
      )
    }

    // Update watermarks (we extracted data, so update regardless of merge)
    return pipeline
      .andThen(() => this.updateWatermarks(sources, now))
      .map(() => ({
        sources: sourceMetrics,
        totalCount,
        totalDurationMs: Date.now() - startTime,
      }))
  }

  /**
   * Process a single source for daily mode.
   */
  private processSourceDaily(
    runId: string,
    source: Source,
    lookbackHours: number,
    now: DateTime,
  ): ResultAsync<SourceMetrics, OrchestratorError> {
    const connector = this.connectors.get(source)
    /* istanbul ignore next -- @preserve defensive check: unreachable due to enabledSources filtering in runDaily */
    if (!connector) {
      return errAsync(
        createError('config', `No connector configured for source: ${source}`),
      )
    }
    const startTime = Date.now()

    // Get watermark for this source
    return this.bq
      .getWatermark(source)
      .mapErr((e) => createError('bigquery', e.message, e))
      .andThen((watermark) => {
        // Calculate fetch window
        const from = watermark
          ? DateTime.fromISO(watermark.last_success_to_ts).minus({
              hours: lookbackHours,
            })
          : now.minus({ days: 30 }) // Default to 30 days if no watermark

        this.logger.info(
          { source, from: from.toISO(), to: now.toISO() },
          'Fetching events',
        )

        return connector
          .fetchAll({ from, to: now, runId })
          .mapErr((e: ConnectorError) => {
            return createError('connector', `${source}: ${e.message}`, e)
          })
      })
      .andThen((events) => {
        this.logger.info({ source, count: events.length }, 'Fetched events')

        if (events.length === 0) {
          return okAsync({ count: 0, durationMs: Date.now() - startTime })
        }

        return this.bq
          .writeEventsToGcs(events, runId, source)
          .mapErr((e) => createError('bigquery', e.message, e))
          .map((paths) => ({
            count: events.length,
            bytesWritten: paths.length * 1000, // Approximate
            durationMs: Date.now() - startTime,
          }))
      })
  }

  /**
   * Load data from GCS into staging table for all sources.
   */
  private loadToStaging(
    runId: string,
    sources: Source[],
  ): ResultAsync<void, OrchestratorError> {
    const loadSource = (
      index: number,
    ): ResultAsync<void, OrchestratorError> => {
      const source = sources[index]
      if (source === undefined) {
        return okAsync(undefined)
      }
      return this.bq
        .loadFromGcs(runId, source)
        .mapErr((e) =>
          createError('bigquery', `Load failed for ${source}: ${e.message}`, e),
        )
        .andThen((result) => {
          this.logger.info(
            { runId, source, rowsLoaded: result.rowsLoaded },
            'Loaded from GCS',
          )
          return loadSource(index + 1)
        })
    }

    return loadSource(0)
  }

  /**
   * Merge staging table data into canonical table.
   */
  private mergeToFinal(runId: string): ResultAsync<void, OrchestratorError> {
    return this.bq
      .merge(runId)
      .mapErr((e) => createError('bigquery', e.message, e))
      .andThen((result) => {
        this.logger.info(
          {
            runId,
            inserted: result.rowsInserted,
            updated: result.rowsUpdated,
          },
          'Merge completed',
        )
        // Update source coverage dates for disbursement deduplication
        return this.bq
          .updateSourceCoverage()
          .mapErr((e) => createError('bigquery', e.message, e))
      })
  }

  /**
   * Load data from GCS into staging table, then merge into canonical table.
   */
  private loadAndMerge(
    runId: string,
    sources: Source[],
  ): ResultAsync<void, OrchestratorError> {
    return this.loadToStaging(runId, sources).andThen(() =>
      this.mergeToFinal(runId),
    )
  }

  /**
   * Update watermarks for sources (only in daily mode).
   */
  private updateWatermarks(
    sources: Source[],
    now: DateTime,
  ): ResultAsync<void, OrchestratorError> {
    const updateSource = (
      index: number,
    ): ResultAsync<void, OrchestratorError> => {
      const source = sources[index]
      if (source === undefined) {
        return okAsync(undefined)
      }
      return this.bq
        .updateWatermark(source, now)
        .mapErr((e) => createError('bigquery', e.message, e))
        .andThen(() => updateSource(index + 1))
    }

    return updateSource(0)
  }

  /**
   * Finalize a run with success status.
   */
  private finalizeRun(
    runId: string,
    mode: 'daily' | 'backfill',
    status: 'succeeded' | 'failed',
    metrics?: EtlMetrics,
    error?: string,
  ): ResultAsync<RunResult, OrchestratorError> {
    return this.bq
      .updateRun(runId, status, metrics, error)
      .mapErr((e) => createError('bigquery', e.message, e))
      .map(() => ({
        runId,
        mode,
        status,
        metrics,
        error,
      }))
  }

  /**
   * Generate date chunks for backfill.
   */
  private generateChunks(
    from: string,
    to: string,
    chunk: 'day' | 'week' | 'month',
  ): { from: DateTime; to: DateTime }[] {
    const startDate = DateTime.fromISO(from, { zone: 'utc' })
    const endDate = DateTime.fromISO(to, { zone: 'utc' })
    const chunks: { from: DateTime; to: DateTime }[] = []

    let current = startDate
    while (current < endDate) {
      let next: DateTime
      switch (chunk) {
        case 'day':
          next = current.plus({ days: 1 })
          break
        case 'week':
          next = current.plus({ weeks: 1 })
          break
        case 'month':
          next = current.plus({ months: 1 })
          break
      }

      // Don't exceed endDate
      if (next > endDate) {
        next = endDate
      }

      chunks.push({ from: current, to: next })
      current = next
    }

    return chunks
  }

  /**
   * Process all sources concurrently, each with its own fetching strategy.
   */
  private processSourcesConcurrently(
    sources: Source[],
    from: DateTime,
    to: DateTime,
    chunkSize: 'day' | 'week' | 'month',
    skipMerge?: boolean,
  ): ResultAsync<RunResult[], OrchestratorError> {
    const runId = uuidv4()
    const startTime = Date.now()

    // Create a single run record for the entire backfill
    return this.bq
      .insertRun(runId, 'backfill', from, to)
      .mapErr((e) => createError('bigquery', e.message, e))
      .andThen(() => {
        // Run all sources concurrently using Promise.all
        const sourcePromises = sources.map((source) =>
          this.processSourceWithStrategy(runId, source, from, to, chunkSize),
        )

        return ResultAsync.fromPromise(
          Promise.all(sourcePromises.map((r) => r)),
          /* istanbul ignore next -- @preserve synchronous Promise.all rejection is impossible with ResultAsync */
          (e) =>
            createError(
              'internal',
              `Concurrent processing failed: ${String(e)}`,
            ),
        )
      })
      .andThen((results) => {
        // Combine results from all sources
        const sourceMetrics: Record<string, SourceMetrics> = {}
        const sourcesWithData: Source[] = []
        let totalCount = 0
        const errors: OrchestratorError[] = []

        for (const result of results) {
          if (result.isOk()) {
            const { source, metrics, hasData } = result.value
            sourceMetrics[source] = metrics
            totalCount += metrics.count
            if (hasData) {
              sourcesWithData.push(source)
            }
          } else {
            // Collect errors
            errors.push(result.error)
            this.logger.error({ error: result.error }, 'Source failed')
          }
        }

        // If any source failed, fail the entire backfill
        const firstError = errors[0]
        if (firstError !== undefined) {
          return errAsync(firstError)
        }

        // Load and merge if any sources have data
        if (sourcesWithData.length === 0) {
          this.logger.info({ runId }, 'No data to load')
          return okAsync({
            sources: sourceMetrics,
            totalCount,
            totalDurationMs: Date.now() - startTime,
          })
        }

        const loadOp = skipMerge
          ? this.loadToStaging(runId, sourcesWithData)
          : this.loadAndMerge(runId, sourcesWithData)

        return loadOp.map(() => ({
          sources: sourceMetrics,
          totalCount,
          totalDurationMs: Date.now() - startTime,
        }))
      })
      .andThen((metrics) =>
        this.finalizeRun(runId, 'backfill', 'succeeded', metrics),
      )
      .map((result) => [result])
      .orElse((error) => {
        return this.bq
          .updateRun(runId, 'failed', undefined, error.message)
          .mapErr(() => error)
          .andThen(() => errAsync(error))
      })
  }

  /**
   * Process a single source with chunking.
   *
   * All sources (Mercury, PayPal, Givebutter) support date filtering via their APIs,
   * so we use the same chunking strategy for all of them.
   */
  private processSourceWithStrategy(
    runId: string,
    source: Source,
    from: DateTime,
    to: DateTime,
    chunkSize: 'day' | 'week' | 'month',
  ): ResultAsync<
    { source: Source; metrics: SourceMetrics; hasData: boolean },
    OrchestratorError
  > {
    this.logger.info(
      { source, from: from.toISO(), to: to.toISO() },
      'Processing source',
    )

    const startTime = Date.now()

    return this.fetchSourceWithChunking(runId, source, from, to, chunkSize).map(
      (count) => ({
        source,
        metrics: { count, durationMs: Date.now() - startTime },
        hasData: count > 0,
      }),
    )
  }

  /**
   * Fetch source data using chunking (for sources that support date filtering).
   */
  private fetchSourceWithChunking(
    runId: string,
    source: Source,
    from: DateTime,
    to: DateTime,
    chunkSize: 'day' | 'week' | 'month',
  ): ResultAsync<number, OrchestratorError> {
    const connector = this.connectors.get(source)
    /* istanbul ignore next -- @preserve defensive check: unreachable due to enabledSources filtering in runBackfill */
    if (!connector) {
      return okAsync(0)
    }

    const fromDate = from.toISODate()
    const toDate = to.toISODate()
    /* istanbul ignore next -- @preserve defensive check: DateTime constructed from valid ISO strings in runBackfill */
    if (fromDate === null || toDate === null) {
      return errAsync(
        createError('internal', `Invalid date range for ${source}`),
      )
    }

    const chunks = this.generateChunks(fromDate, toDate, chunkSize)

    this.logger.info(
      { source, chunks: chunks.length, from: from.toISO(), to: to.toISO() },
      'Processing source with chunking',
    )

    let totalCount = 0

    // Process chunks sequentially for this source
    const processChunk = (
      index: number,
    ): ResultAsync<void, OrchestratorError> => {
      const chunk = chunks[index]
      if (chunk === undefined) {
        return okAsync(undefined)
      }

      return connector
        .fetchAll({ from: chunk.from, to: chunk.to, runId })
        .mapErr((e: ConnectorError) =>
          createError('connector', `${source}: ${e.message}`, e),
        )
        .andThen((events) => {
          this.logger.info(
            {
              source,
              chunk: `${index + 1}/${chunks.length}`,
              count: events.length,
            },
            'Fetched chunk',
          )

          if (events.length === 0) {
            return okAsync(undefined)
          }

          totalCount += events.length

          // Pass chunk index to create unique file names per date chunk
          return this.bq
            .writeEventsToGcs(events, runId, source, undefined, String(index))
            .mapErr((e) => createError('bigquery', e.message, e))
            .map(() => undefined)
        })
        .andThen(() => processChunk(index + 1))
    }

    return processChunk(0).map(() => totalCount)
  }
}
