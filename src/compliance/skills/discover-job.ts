/**
 * Backend for the async `compliance-discover` flow exposed over MCP.
 *
 * Three operations:
 *   1. `startDiscoveryJob` — write a `discovery_jobs` row with status
 *      `running`, trigger the out-of-band executor via an injected
 *      `LaunchDiscovery`, and return the new `jobId` to the caller.
 *   2. `readDiscoveryJobStatus` — read the parent row + count of completed
 *      per-source runs.
 *   3. `readDiscoveryJobResult` — read the parent row and return its stored
 *      `result` payload, refusing if the job is not yet `completed`.
 *
 * The discovery itself runs in `runDiscoveryAndPersist`, invoked by the
 * executor — a Cloud Run Job in production (see `cloud-run-jobs.ts`) — not
 * inside the MCP request. Splitting the launch out as an injectable
 * strategy keeps both `startDiscoveryJob` and `runDiscoveryAndPersist`
 * directly testable without a real executor.
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import type { RunRecorder } from '../sources/runner.ts'
import type { FindingsAccessor } from '../state/bq-findings.ts'
import type { DiscoveryJobsAccessor } from '../state/bq-jobs.ts'
import type {
  ComplianceDiscoveryJobRow,
  ComplianceDiscoveryRunRow,
} from '../state/bq-rows.ts'
import type { DiscoveryRunsAccessor } from '../state/bq-runs.ts'
import type { Finding } from '../types/index.ts'
import type { DiscoveryError, DiscoveryReport } from './discover.ts'

/**
 * Filter the caller supplied when starting the job. `sources` and
 * `jurisdictionId` are both optional; null means "no restriction".
 */
export interface DiscoveryJobFilter {
  readonly sources: readonly string[] | null
  readonly jurisdictionId: string | null
}

/**
 * Failure modes for the start flow.
 */
export interface StartDiscoveryJobError {
  readonly type: 'persist' | 'launch'
  readonly message: string
}

/**
 * Failure modes for the status read.
 */
export type ReadDiscoveryJobStatusError =
  | { readonly type: 'not_found'; readonly message: string }
  | { readonly type: 'load'; readonly message: string }

/**
 * Failure modes for the result read.
 */
export type ReadDiscoveryJobResultError =
  | { readonly type: 'not_found'; readonly message: string }
  | { readonly type: 'load'; readonly message: string }
  | { readonly type: 'not_ready'; readonly message: string }

/**
 * Strategy injected for launching the out-of-band discovery executor.
 *
 * Production wires a launcher that triggers a Cloud Run **Job** execution
 * (`createCloudRunJobLauncher`), so the discovery runs in its own process
 * with a request-independent lifecycle — it survives the MCP service
 * scaling to zero and runs past the HTTP request timeout. The launcher
 * resolves as soon as the execution is *accepted*; the job itself reports
 * its own terminal status to Firestore via `runDiscoveryAndPersist`.
 *
 * Tests inject a fake launcher that records the call (and, when they want
 * to exercise the persistence path, run `runDiscoveryAndPersist` directly).
 */
export interface LaunchDiscoveryArgs {
  readonly jobId: string
  readonly filter: DiscoveryJobFilter
}

export interface LaunchDiscoveryError {
  readonly type: 'launch'
  readonly message: string
}

export type LaunchDiscovery = (
  args: LaunchDiscoveryArgs,
) => ResultAsync<void, LaunchDiscoveryError>

/**
 * Production-facing alias for the discovery-run function the orchestrator
 * invokes. The orchestrator passes the job-tagged `recorder` so child rows
 * carry the `job_id`. Errors are surfaced as the underlying
 * `DiscoveryError` shape; the orchestrator catches them and persists.
 */
export type RunDiscoveryForJob = (args: {
  readonly filter: DiscoveryJobFilter
  readonly recorder: RunRecorder
}) => ResultAsync<DiscoveryReport, DiscoveryError>

/**
 * Wiring for `startDiscoveryJob`. The start path only inserts the parent
 * row and hands off to the launcher — the heavy discovery deps
 * (`runsAccessor` / `findingsAccessor` / `runDiscovery`) live on
 * `RunDiscoveryAndPersistArgs`, consumed by the out-of-band executor.
 */
export interface StartDiscoveryJobArgs {
  readonly jobsAccessor: DiscoveryJobsAccessor
  readonly now: () => Date
  readonly filter: DiscoveryJobFilter
  readonly launch: LaunchDiscovery
  readonly generateJobId?: () => string
  /**
   * Optional logger so the start path can record a best-effort cleanup
   * failure (marking an un-launched job failed) the caller never sees.
   */
  readonly logger?: {
    error: (message: string, err: unknown) => void
  }
}

/**
 * Wiring for `runDiscoveryAndPersist` — the body the out-of-band executor
 * runs. It owns the discovery deps and transitions the parent row to its
 * terminal status.
 */
export interface RunDiscoveryAndPersistArgs {
  readonly jobsAccessor: DiscoveryJobsAccessor
  readonly runsAccessor: DiscoveryRunsAccessor
  readonly findingsAccessor: FindingsAccessor
  readonly now: () => Date
  readonly filter: DiscoveryJobFilter
  readonly runDiscovery: RunDiscoveryForJob
  readonly logger?: {
    error: (message: string, err: unknown) => void
  }
}

/**
 * Result envelope returned to the caller. The caller polls
 * `readDiscoveryJobStatus(jobId)` afterwards.
 */
export interface StartDiscoveryJobReport {
  readonly jobId: string
}

/**
 * Insert a `running` job row and launch the out-of-band discovery executor.
 *
 * Returns as soon as the executor has been *accepted* so the MCP caller can
 * stop waiting and start polling `readDiscoveryJobStatus`. The executor
 * (a Cloud Run Job in production) is responsible for transitioning the row
 * to `completed` / `failed` via `runDiscoveryAndPersist` before it exits.
 *
 * If the launch fails after the row is inserted, the `running` row would be
 * orphaned (no executor will ever finish it), so we best-effort mark it
 * `failed` before surfacing the launch error.
 */
export function startDiscoveryJob(
  args: StartDiscoveryJobArgs,
): ResultAsync<StartDiscoveryJobReport, StartDiscoveryJobError> {
  const generateJobId = args.generateJobId ?? uuidv4
  const jobId = generateJobId()
  const startedAt = args.now().toISOString()

  const row: ComplianceDiscoveryJobRow = {
    job_id: jobId,
    started_at: startedAt,
    finished_at: null,
    status: 'running',
    requested_sources: args.filter.sources,
    requested_jurisdiction: args.filter.jurisdictionId,
    error_type: null,
    error_message: null,
    result: null,
  }

  return args.jobsAccessor
    .recordJob(row)
    .mapErr<StartDiscoveryJobError>((err) => ({
      type: 'persist',
      message: `Failed to insert discovery_jobs row: ${err.message}`,
    }))
    .andThen(() => launchOrCleanup(jobId, args))
}

/**
 * Launch the executor; on launch failure, best-effort transition the
 * orphaned `running` row to `failed` and surface the launch error either
 * way.
 */
function launchOrCleanup(
  jobId: string,
  args: StartDiscoveryJobArgs,
): ResultAsync<StartDiscoveryJobReport, StartDiscoveryJobError> {
  return args
    .launch({ jobId, filter: args.filter })
    .map<StartDiscoveryJobReport>(() => ({ jobId }))
    .orElse((launchErr) => {
      const failure: StartDiscoveryJobError = {
        type: 'launch',
        message: launchErr.message,
      }
      return args.jobsAccessor
        .markJobFinished({
          jobId,
          finishedAt: args.now().toISOString(),
          status: 'failed',
          errorType: 'launch',
          errorMessage: launchErr.message,
          result: null,
        })
        .andThen(() =>
          errAsync<StartDiscoveryJobReport, StartDiscoveryJobError>(failure),
        )
        .orElse((cleanupErr) => {
          args.logger?.error(
            `Failed to mark job ${jobId} failed after launch error`,
            cleanupErr,
          )
          return errAsync<StartDiscoveryJobReport, StartDiscoveryJobError>(
            failure,
          )
        })
    })
}

/**
 * Background loop for one job. Exported for direct testing.
 */
export async function runDiscoveryAndPersist(
  jobId: string,
  args: RunDiscoveryAndPersistArgs,
): Promise<void> {
  const recorder = buildJobScopedRecorder(
    jobId,
    args.runsAccessor,
    args.findingsAccessor,
  )

  try {
    const outcome = await args.runDiscovery({
      filter: args.filter,
      recorder,
    })

    if (outcome.isOk()) {
      const finish = await args.jobsAccessor.markJobFinished({
        jobId,
        finishedAt: args.now().toISOString(),
        status: 'completed',
        errorType: null,
        errorMessage: null,
        result: outcome.value,
      })
      if (finish.isErr()) {
        args.logger?.error(
          `Failed to persist completed status for job ${jobId}`,
          finish.error,
        )
      }
      return
    }

    const finish = await args.jobsAccessor.markJobFinished({
      jobId,
      finishedAt: args.now().toISOString(),
      status: 'failed',
      errorType: outcome.error.type,
      errorMessage: outcome.error.message,
      result: null,
    })
    if (finish.isErr()) {
      args.logger?.error(
        `Failed to persist failed status for job ${jobId}`,
        finish.error,
      )
    }
  } catch (err) {
    // Anything not caught by `runDiscovery`'s Result wrapping lands here.
    const message = err instanceof Error ? err.message : String(err)
    const finish = await args.jobsAccessor.markJobFinished({
      jobId,
      finishedAt: args.now().toISOString(),
      status: 'failed',
      errorType: 'spawn',
      errorMessage: message,
      result: null,
    })
    if (finish.isErr()) {
      args.logger?.error(
        `Failed to persist spawn-error status for job ${jobId}`,
        finish.error,
      )
    }
  }
}

/**
 * Wrap the per-job accessors as a `RunRecorder`. Every `discovery_runs` row
 * forwarded through this recorder carries the parent `job_id`; findings
 * pass through unchanged (their `job_id` linkage is implicit via the
 * runs).
 */
export function buildJobScopedRecorder(
  jobId: string,
  runsAccessor: DiscoveryRunsAccessor,
  findingsAccessor: FindingsAccessor,
): RunRecorder {
  return {
    recordRun: (row) => runsAccessor.recordRun({ ...row, job_id: jobId }),
    recordFindings: (findings: readonly Finding[]) =>
      findingsAccessor.recordFindings(findings),
  }
}

/**
 * Status payload returned by `readDiscoveryJobStatus`.
 */
export interface DiscoveryJobStatusReport {
  readonly jobId: string
  readonly status: ComplianceDiscoveryJobRow['status']
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly requestedSources: readonly string[] | null
  readonly requestedJurisdiction: string | null
  readonly completedSourceCount: number
  readonly errorType: string | null
  readonly errorMessage: string | null
}

/**
 * Wiring for the status read.
 */
export interface ReadDiscoveryJobStatusArgs {
  readonly jobsAccessor: DiscoveryJobsAccessor
  readonly runsAccessor: DiscoveryRunsAccessor
  readonly jobId: string
}

/**
 * Read the parent row and count of completed per-source runs for the job.
 */
export function readDiscoveryJobStatus(
  args: ReadDiscoveryJobStatusArgs,
): ResultAsync<DiscoveryJobStatusReport, ReadDiscoveryJobStatusError> {
  return args.jobsAccessor
    .readJob(args.jobId)
    .mapErr<ReadDiscoveryJobStatusError>((err) =>
      err.type === 'not_found'
        ? { type: 'not_found', message: err.message }
        : { type: 'load', message: err.message },
    )
    .andThen((row) =>
      args.runsAccessor
        .listRunsByJob(args.jobId)
        .mapErr<ReadDiscoveryJobStatusError>((err) => ({
          type: 'load',
          message: `Failed to list runs for job ${args.jobId}: ${err.message}`,
        }))
        .map<DiscoveryJobStatusReport>((runs) => buildStatusReport(row, runs)),
    )
}

function buildStatusReport(
  row: ComplianceDiscoveryJobRow,
  runs: readonly ComplianceDiscoveryRunRow[],
): DiscoveryJobStatusReport {
  return {
    jobId: row.job_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    requestedSources: row.requested_sources,
    requestedJurisdiction: row.requested_jurisdiction,
    completedSourceCount: runs.length,
    errorType: row.error_type,
    errorMessage: row.error_message,
  }
}

/**
 * Wiring for the result read.
 */
export interface ReadDiscoveryJobResultArgs {
  readonly jobsAccessor: DiscoveryJobsAccessor
  readonly jobId: string
}

/**
 * Read the assembled `DiscoveryReport` from a completed job. Returns
 * `not_ready` if the job is still running, `not_found` if the row doesn't
 * exist, and `load` for any other accessor failure.
 */
export function readDiscoveryJobResult(
  args: ReadDiscoveryJobResultArgs,
): ResultAsync<unknown, ReadDiscoveryJobResultError> {
  return args.jobsAccessor
    .readJob(args.jobId)
    .mapErr<ReadDiscoveryJobResultError>((err) =>
      err.type === 'not_found'
        ? { type: 'not_found', message: err.message }
        : { type: 'load', message: err.message },
    )
    .andThen((row) => {
      if (row.status === 'running') {
        return errAsync<unknown, ReadDiscoveryJobResultError>({
          type: 'not_ready',
          message: `Job ${args.jobId} is still running. Poll compliance-discover-status until it completes.`,
        })
      }
      if (row.status === 'failed') {
        return errAsync<unknown, ReadDiscoveryJobResultError>({
          type: 'not_ready',
          message:
            row.error_message ??
            `Job ${args.jobId} failed without a recorded error message.`,
        })
      }
      return okAsync(row.result ?? null)
    })
}
