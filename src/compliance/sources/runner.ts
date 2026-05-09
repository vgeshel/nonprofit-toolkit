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
  SourceAuthRequirement,
  SourceContext,
  SourceRunOutcome,
  SourceRunOutput,
} from '../types/index.ts'
import { formatSourceError, type SourceError } from './errors.ts'

type ManualOnlySource = Extract<Source, { readonly automationAllowed: false }>

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

  // The legacy compatibility wrapper only dispatches `kind: 'api'` sources.
  // Use `runSourceOutcome` for Phase 3 public browser sources.
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

/**
 * Run a single source and return the Phase 2 typed outcome vocabulary.
 *
 * This is the public runner shape for Phase 2 orchestration. `runSource`
 * remains as the Phase 1 compatibility wrapper for callers that still expect
 * a `ResultAsync<SourceRunOutput, SourceError>`.
 */
export function runSourceOutcome(
  args: RunSourceArgs,
): ResultAsync<SourceRunOutcome, SourceError> {
  const { source, entity, ctx, recorder } = args

  if (!source.automationAllowed) {
    return finishBlockedByPolicy({ source, ctx, recorder })
  }

  if (source.authRequired) {
    return finishAuthRequired({ source, ctx, recorder })
  }

  if (!isRunnableAutomatedKind(source.kind)) {
    return finishFailureOutcome({
      sourceError: {
        type: 'tos',
        message: `Source kind "${source.kind}" not yet supported. Source: ${source.id}`,
      },
      startedAt: ctx.now(),
      source,
      ctx,
      recorder,
    })
  }

  const startedAt = ctx.now()

  return source
    .run(entity, ctx)
    .andThen((output) =>
      finishSuccess({ output, startedAt, source, ctx, recorder }),
    )
    .map<SourceRunOutcome>((output) => ({
      status: 'success',
      output: {
        record: output.record,
        findings: output.findings.slice(),
      },
    }))
    .orElse((sourceError) =>
      finishFailureOutcome({ sourceError, startedAt, source, ctx, recorder }),
    )
}

function isRunnableAutomatedKind(kind: Source['kind']): boolean {
  return kind === 'api' || kind === 'playwright'
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

interface FinishPolicyArgs {
  readonly source: ManualOnlySource
  readonly ctx: SourceContext
  readonly recorder: RunRecorder
}

function finishBlockedByPolicy(
  args: FinishPolicyArgs,
): ResultAsync<SourceRunOutcome, SourceError> {
  const { source, ctx, recorder } = args
  const startedAt = ctx.now()
  const completedAt = ctx.now()
  const hasManualInstructions =
    source.manualInstructions.length > 0 &&
    source.manualEvidenceFields.length > 0 &&
    source.kind === 'manual'
  const row: ComplianceDiscoveryRunRow = {
    run_id: uuidv4(),
    source_id: source.id,
    jurisdiction_id: source.jurisdiction,
    status: 'failed',
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    error_type: hasManualInstructions ? 'manual_required' : 'policy_blocked',
    error_message: source.manualOnlyReason,
    payload: hasManualInstructions
      ? {
          instructions: source.manualInstructions,
          evidenceFields: source.manualEvidenceFields,
        }
      : null,
  }

  const outcome: SourceRunOutcome = hasManualInstructions
    ? {
        status: 'manual_required',
        source_id: source.id,
        instructions: source.manualInstructions.slice(),
        evidenceFields: source.manualEvidenceFields.slice(),
      }
    : {
        status: 'policy_blocked',
        source_id: source.id,
        reason: source.manualOnlyReason,
      }

  return recorder
    .recordRun(row)
    .mapErr<SourceError>((err) => ({
      type: 'internal',
      message: `Failed to persist discovery_runs row: ${err.message}`,
    }))
    .map(() => outcome)
}

interface FinishAuthRequiredArgs {
  readonly source: Source
  readonly ctx: SourceContext
  readonly recorder: RunRecorder
}

function finishAuthRequired(
  args: FinishAuthRequiredArgs,
): ResultAsync<SourceRunOutcome, SourceError> {
  const { source, ctx, recorder } = args
  const startedAt = ctx.now()
  const completedAt = ctx.now()
  const message =
    source.auth === undefined
      ? `Source "${source.id}" requires auth, but no auth context is available.`
      : `Source "${source.id}" requires an authenticated user session.`
  const row: ComplianceDiscoveryRunRow = {
    run_id: uuidv4(),
    source_id: source.id,
    jurisdiction_id: source.jurisdiction,
    status: 'failed',
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    error_type: 'auth_required',
    error_message: message,
    payload:
      source.auth === undefined ? null : authRequirementPayload(source.auth),
  }

  return recorder
    .recordRun(row)
    .mapErr<SourceError>((err) => ({
      type: 'internal',
      message: `Failed to persist discovery_runs row: ${err.message}`,
    }))
    .map<SourceRunOutcome>(() => ({
      status: 'auth_required',
      source_id: source.id,
      message,
      ...authOutcomeDetails(source.auth),
    }))
}

type AuthOutcomeDetails = Omit<
  Extract<SourceRunOutcome, { readonly status: 'auth_required' }>,
  'status' | 'source_id' | 'message'
>

function authOutcomeDetails(
  auth: SourceAuthRequirement | undefined,
): AuthOutcomeDetails {
  if (auth === undefined) {
    return {}
  }
  return {
    loginUrl: auth.loginUrl,
    credentialMode: auth.credentialMode,
    credentialFields: auth.credentialFields.slice(),
    mfa: auth.mfa,
    instructions: auth.instructions.slice(),
    evidenceFields: auth.evidenceFields.slice(),
    forbiddenActions: auth.forbiddenActions.slice(),
  }
}

function authRequirementPayload(
  auth: SourceAuthRequirement,
): Record<string, unknown> {
  return {
    loginUrl: auth.loginUrl,
    credentialMode: auth.credentialMode,
    credentialFields: auth.credentialFields.slice(),
    mfa: auth.mfa,
    instructions: auth.instructions.slice(),
    evidenceFields: auth.evidenceFields.slice(),
    forbiddenActions: auth.forbiddenActions.slice(),
  }
}

function finishFailureOutcome(
  args: FinishFailureArgs,
): ResultAsync<SourceRunOutcome, SourceError> {
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
    .map(() => ({
      status: 'source_failure',
      source_id: source.id,
      error_type: sourceError.type,
      message: formatSourceError(sourceError),
    }))
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
