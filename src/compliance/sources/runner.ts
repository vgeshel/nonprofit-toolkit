/**
 * Source runner.
 *
 * Glue between a `Source` definition and the BigQuery state layer:
 *   1. Decide whether the source may run at all (Phase 1: api kind, no auth)
 *   2. Time the call
 *   3. Persist a `discovery_runs` row, success or failure
 *   4. Persist any findings the source emitted
 *   5. Return the source's result to the caller
 *
 * The runner does not retry, does not throttle, and does not de-dupe runs.
 * Those concerns belong in the orchestrator above (Phase 2+).
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import type { ComplianceDiscoveryRunRow } from '../state/bq-rows.ts'
import type {
  Entity,
  Finding,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../types/index.ts'
import { formatSourceError, type SourceError } from './errors.ts'

/**
 * Recorder error — the runner returns these wrapped as an `internal`
 * SourceError, but the recorder ports themselves are free to surface their
 * own typed errors. We only require an object with a `message` field.
 */
export interface RecorderError {
  type: string
  message: string
}

/**
 * Port the runner uses to persist discovery runs and findings. Phase 1's
 * concrete implementation lives in `state/bq-runs.ts` and `state/bq-findings.ts`;
 * tests inject fakes.
 */
export interface RunRecorder {
  recordRun(row: ComplianceDiscoveryRunRow): ResultAsync<void, RecorderError>
  recordFindings(findings: readonly Finding[]): ResultAsync<void, RecorderError>
}

/**
 * Arguments to runSource. Grouped into one object so call sites are
 * self-documenting at the use-site.
 */
export interface RunSourceArgs {
  readonly source: Source
  readonly entity: Entity
  readonly ctx: SourceContext
  readonly recorder: RunRecorder
}

/**
 * Run a single source against an entity, recording the outcome.
 */
export function runSource(
  args: RunSourceArgs,
): ResultAsync<SourceRunOutput, SourceError> {
  const { source, entity, ctx, recorder } = args

  // Phase 1 only knows how to dispatch `kind: 'api'` sources. `playwright`
  // sources arrive in Phase 2, `manual` sources never run automatically.
  // Refuse loudly so the missing kind is visible (the project rule is to fail
  // loudly rather than silently no-op).
  if (source.kind !== 'api') {
    return errAsync({
      type: 'tos',
      message: `Source kind "${source.kind}" not yet supported (Phase 1 supports only api sources). Source: ${source.id}`,
    })
  }

  // Phase 1 has no authentication context. Refuse to run a source that says
  // it needs auth so we don't silently call upstream unauthenticated.
  if (source.authRequired) {
    return errAsync({
      type: 'tos',
      message: `Source "${source.id}" requires auth, but Phase 1 has no auth context.`,
    })
  }

  const startedAt = ctx.now()

  return source
    .run(entity, ctx)
    .andThen((output) =>
      finishSuccess({ output, startedAt, source, ctx, recorder }),
    )
    .orElse((sourceError) =>
      finishFailure({ sourceError, startedAt, source, ctx, recorder }),
    )
}

interface FinishSuccessArgs {
  readonly output: SourceRunOutput
  readonly startedAt: Date
  readonly source: Source
  readonly ctx: SourceContext
  readonly recorder: RunRecorder
}

function finishSuccess(
  args: FinishSuccessArgs,
): ResultAsync<SourceRunOutput, SourceError> {
  const { output, startedAt, source, ctx, recorder } = args
  const completedAt = ctx.now()
  const row: ComplianceDiscoveryRunRow = {
    run_id: uuidv4(),
    source_id: source.id,
    jurisdiction_id: source.jurisdiction,
    status: 'succeeded',
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    error_type: null,
    error_message: null,
    payload: output.record.payload,
  }

  return recorder
    .recordRun(row)
    .mapErr<SourceError>((err) => ({
      type: 'internal',
      message: `Failed to persist discovery_runs row: ${err.message}`,
    }))
    .andThen(() => persistFindings(output.findings, recorder))
    .map(() => output)
}

interface FinishFailureArgs {
  readonly sourceError: SourceError
  readonly startedAt: Date
  readonly source: Source
  readonly ctx: SourceContext
  readonly recorder: RunRecorder
}

/**
 * Record a failed run. The original source error is what the caller cares
 * about, so we always end by re-emitting it. If the recorder fails, that
 * failure is *not* propagated up — losing the upstream cause would be
 * misleading. The orchestrator-level logger captures recorder failures
 * separately (Phase 2+).
 */
function finishFailure(
  args: FinishFailureArgs,
): ResultAsync<SourceRunOutput, SourceError> {
  const { sourceError, startedAt, source, ctx, recorder } = args
  const completedAt = ctx.now()
  const row: ComplianceDiscoveryRunRow = {
    run_id: uuidv4(),
    source_id: source.id,
    jurisdiction_id: source.jurisdiction,
    status: 'failed',
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    error_type: sourceError.type,
    error_message: formatSourceError(sourceError),
    payload: null,
  }

  return recorder
    .recordRun(row)
    .orElse(() => okAsync(undefined))
    .andThen(() => errAsync<SourceRunOutput, SourceError>(sourceError))
}

function persistFindings(
  findings: readonly Finding[],
  recorder: RunRecorder,
): ResultAsync<void, SourceError> {
  if (findings.length === 0) {
    return okAsync(undefined)
  }
  return recorder.recordFindings(findings).mapErr<SourceError>((err) => ({
    type: 'internal',
    message: `Failed to persist findings: ${err.message}`,
  }))
}
