/**
 * `compliance.discovery_jobs` accessor.
 *
 * Inserts one row per async compliance-discover job and updates it as the
 * job progresses. Reads return the parsed row. The accessor uses
 * parameterised SQL throughout. JSON columns ride as JSON-encoded strings
 * passed to `PARSE_JSON(...)`, matching the convention used in `bq-runs.ts`.
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import type { BqParameterType, BqQueryRunner, QueryParam } from './bq-entity.ts'
import {
  COMPLIANCE_DATASET,
  ComplianceDiscoveryJobRowSchema,
  type ComplianceDiscoveryJobRow,
} from './bq-rows.ts'

/**
 * Errors emitted by the discovery_jobs accessor.
 */
export type JobsAccessorError =
  | { readonly type: 'query'; readonly message: string }
  | { readonly type: 'parse'; readonly message: string }
  | { readonly type: 'not_found'; readonly message: string }

/**
 * Update payload for `markJobFinished`. The accessor enforces that one of
 * `completed` / `failed` is the new status — `running` is set only by
 * `recordJob` at insert time.
 *
 * `result` is the assembled DiscoveryReport (serialised on completion). It
 * is required on `completed`, omitted on `failed`. Stored as a JSON column
 * so callers can persist any shape.
 */
export interface JobFinishUpdate {
  readonly jobId: string
  readonly finishedAt: string
  readonly status: 'completed' | 'failed'
  readonly errorType: string | null
  readonly errorMessage: string | null
  readonly result?: unknown
}

/**
 * Wiring.
 */
export interface DiscoveryJobsAccessorDeps {
  readonly runner: BqQueryRunner
  readonly projectId: string
}

/**
 * Accessor surface.
 */
export interface DiscoveryJobsAccessor {
  /**
   * Insert a fresh `running` job row.
   */
  recordJob(
    row: ComplianceDiscoveryJobRow,
  ): ResultAsync<void, JobsAccessorError>
  /**
   * Read a single job by id. Returns `not_found` if no row matches.
   */
  readJob(
    jobId: string,
  ): ResultAsync<ComplianceDiscoveryJobRow, JobsAccessorError>
  /**
   * Transition a `running` job to a terminal state.
   */
  markJobFinished(update: JobFinishUpdate): ResultAsync<void, JobsAccessorError>
}

/**
 * Construct an accessor.
 */
export function createDiscoveryJobsAccessor(
  deps: DiscoveryJobsAccessorDeps,
): DiscoveryJobsAccessor {
  const tableName = `\`${deps.projectId}.${COMPLIANCE_DATASET}.discovery_jobs\``

  return {
    recordJob(v) {
      const sql = `
        INSERT INTO ${tableName} (
          job_id,
          started_at,
          finished_at,
          status,
          requested_sources,
          requested_jurisdiction,
          error_type,
          error_message,
          result
        )
        VALUES (
          @job_id,
          @started_at,
          @finished_at,
          @status,
          PARSE_JSON(@requested_sources),
          @requested_jurisdiction,
          @error_type,
          @error_message,
          PARSE_JSON(@result)
        )
      `
      const params: Record<string, QueryParam> = {
        job_id: v.job_id,
        started_at: v.started_at,
        finished_at: v.finished_at,
        status: v.status,
        requested_sources:
          v.requested_sources === null
            ? null
            : JSON.stringify(v.requested_sources),
        requested_jurisdiction: v.requested_jurisdiction,
        error_type: v.error_type,
        error_message: v.error_message,
        result: v.result === null ? null : JSON.stringify(v.result),
      }
      // Same null-parameter typing dance as bq-runs: every nullable column
      // needs an explicit type so BQ accepts the null. JSON columns ride as
      // STRINGs because we wrap them in PARSE_JSON.
      const types: Record<string, BqParameterType> = {
        finished_at: 'TIMESTAMP',
        requested_sources: 'STRING',
        requested_jurisdiction: 'STRING',
        error_type: 'STRING',
        error_message: 'STRING',
        result: 'STRING',
      }

      return deps.runner
        .query(sql, params, types)
        .mapErr<JobsAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .map(() => undefined)
    },

    readJob(jobId) {
      const sql = `
        SELECT *
        FROM ${tableName}
        WHERE job_id = @job_id
        LIMIT 1
      `
      const params: Record<string, QueryParam> = { job_id: jobId }

      return deps.runner
        .query(sql, params)
        .mapErr<JobsAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .andThen((rows) => {
          if (rows.length === 0) {
            return errAsync<ComplianceDiscoveryJobRow, JobsAccessorError>({
              type: 'not_found',
              message: `No discovery_jobs row for job_id=${jobId}`,
            })
          }
          const parsed = ComplianceDiscoveryJobRowSchema.safeParse(rows[0])
          if (!parsed.success) {
            return errAsync<ComplianceDiscoveryJobRow, JobsAccessorError>({
              type: 'parse',
              message: `Invalid discovery_jobs row from BigQuery: ${parsed.error.message}`,
            })
          }
          return okAsync(parsed.data)
        })
    },

    markJobFinished(update) {
      const sql = `
        UPDATE ${tableName}
        SET
          finished_at = @finished_at,
          status = @status,
          error_type = @error_type,
          error_message = @error_message,
          result = PARSE_JSON(@result)
        WHERE job_id = @job_id
      `
      const resultValue = update.result === undefined ? null : update.result
      const params: Record<string, QueryParam> = {
        job_id: update.jobId,
        finished_at: update.finishedAt,
        status: update.status,
        error_type: update.errorType,
        error_message: update.errorMessage,
        result: resultValue === null ? null : JSON.stringify(resultValue),
      }
      const types: Record<string, BqParameterType> = {
        error_type: 'STRING',
        error_message: 'STRING',
        result: 'STRING',
      }

      return deps.runner
        .query(sql, params, types)
        .mapErr<JobsAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .map(() => undefined)
    },
  }
}
