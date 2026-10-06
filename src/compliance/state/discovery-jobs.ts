/**
 * Discovery-job lifecycle accessor contract.
 *
 * One record per async compliance-discover job, written `running` when the
 * job starts and moved to `completed` / `failed` when it finishes. The
 * production implementation is Firestore-backed (`firestore-jobs.ts`); see
 * that module for why BigQuery is not used for this lifecycle.
 */
import type { ResultAsync } from 'neverthrow'
import type { ComplianceDiscoveryJobRow } from './bq-rows.ts'

/**
 * Errors emitted by a discovery-jobs accessor.
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
 * is required on `completed`, omitted on `failed`, and stored verbatim.
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
