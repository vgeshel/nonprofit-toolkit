/**
 * Firestore-backed `discovery_jobs` accessor.
 *
 * Why Firestore (and not BigQuery): BigQuery streaming inserts go into
 * a streaming buffer where DML (UPDATE/DELETE/MERGE) cannot affect them
 * for up to 90 minutes. We INSERT a job row in `running` state and then
 * UPDATE it on completion — the UPDATE silently fails to apply for the
 * buffer window, so callers polling `compliance-discover-status` see
 * stale `running` for tens of minutes after the job actually finished.
 *
 * Firestore has strong read-after-write consistency on single-document
 * writes. One collection, one document per job, simple update.
 */
import type { ResultAsync } from 'neverthrow'
import { ResultAsync as RA, errAsync, okAsync } from 'neverthrow'
import type {
  DiscoveryJobsAccessor,
  JobFinishUpdate,
  JobsAccessorError,
} from './bq-jobs.ts'
import type { ComplianceDiscoveryJobRow } from './bq-rows.ts'
import { ComplianceDiscoveryJobRowSchema } from './bq-rows.ts'

/**
 * Minimal Firestore surface we depend on. Typing the methods we use
 * instead of `Firestore` itself keeps this file testable without the
 * SDK at type level.
 */
export interface FirestoreClientLike {
  doc(path: string): FirestoreDocRef
}

export interface FirestoreDocRef {
  get(): Promise<FirestoreDocSnapshot>
  set(data: Record<string, unknown>): Promise<unknown>
  update(data: Record<string, unknown>): Promise<unknown>
}

export interface FirestoreDocSnapshot {
  readonly exists: boolean
  data(): Record<string, unknown> | undefined
}

const COLLECTION = 'mcp_compliance_jobs'

function toError(err: unknown): JobsAccessorError {
  return {
    type: 'query',
    message: err instanceof Error ? err.message : String(err),
  }
}

/**
 * Build the Firestore-backed accessor.
 */
export function createFirestoreDiscoveryJobsAccessor(
  db: FirestoreClientLike,
): DiscoveryJobsAccessor {
  function docFor(jobId: string): FirestoreDocRef {
    return db.doc(`${COLLECTION}/${jobId}`)
  }

  return {
    recordJob(row) {
      const doc: Record<string, unknown> = {
        job_id: row.job_id,
        started_at: row.started_at,
        finished_at: row.finished_at,
        status: row.status,
        requested_sources: row.requested_sources,
        requested_jurisdiction: row.requested_jurisdiction,
        error_type: row.error_type,
        error_message: row.error_message,
        result: row.result,
      }
      return RA.fromPromise(docFor(row.job_id).set(doc), toError).map(
        () => undefined,
      )
    },

    readJob(jobId) {
      return RA.fromPromise(docFor(jobId).get(), toError).andThen(
        (snap): ResultAsync<ComplianceDiscoveryJobRow, JobsAccessorError> => {
          if (!snap.exists) {
            return errAsync({
              type: 'not_found',
              message: `No discovery_jobs document for job_id=${jobId}`,
            })
          }
          const data = snap.data()
          if (data === undefined) {
            return errAsync({
              type: 'not_found',
              message: `Firestore returned empty data for job_id=${jobId}`,
            })
          }
          // Parse through the canonical BQ row schema directly. The
          // FirestoreJobDocSchema is a subset of the BQ schema (same
          // fields, fewer constraints) and the BQ schema's preprocess
          // helpers (parseJsonColumn, extractTimestampValue) tolerate
          // both string and object inputs, so a Firestore-resident JS
          // object round-trips cleanly.
          const parsedRow = ComplianceDiscoveryJobRowSchema.safeParse(data)
          if (!parsedRow.success) {
            return errAsync({
              type: 'parse',
              message: `Invalid Firestore discovery_jobs doc for job_id=${jobId}: ${parsedRow.error.message}`,
            })
          }
          return okAsync(parsedRow.data)
        },
      )
    },

    markJobFinished(update: JobFinishUpdate) {
      const patch: Record<string, unknown> = {
        finished_at: update.finishedAt,
        status: update.status,
        error_type: update.errorType,
        error_message: update.errorMessage,
        result: update.result ?? null,
      }
      return RA.fromPromise(docFor(update.jobId).update(patch), toError).map(
        () => undefined,
      )
    },
  }
}
