/**
 * MCP tools: compliance-discover-start, -status, -result.
 *
 * Async-job control surface for compliance discovery. `start` returns a
 * job id immediately and triggers an out-of-band Cloud Run Job execution
 * that runs the discovery; `status` polls progress; `result` fetches the
 * final report.
 *
 * `start` writes a discovery_jobs row and launches the executor (which
 * writes downstream discovery_runs/findings rows), so it requires
 * `confirm: true`.
 */
import { err, ok, type Result } from 'neverthrow'
import type { Logger } from 'pino'
import { z } from 'zod'
import {
  readDiscoveryJobResultProduction,
  readDiscoveryJobStatusProduction,
  startDiscoveryJobProduction,
  type StartDiscoveryJobProductionError,
} from '../../../../../src/compliance/skills/discover-job-wiring.ts'
import type {
  DiscoveryJobFilter,
  DiscoveryJobStatusReport,
  ReadDiscoveryJobResultError,
  ReadDiscoveryJobStatusError,
  StartDiscoveryJobReport,
} from '../../../../../src/compliance/skills/discover-job.ts'
import type { FirestoreClientLike } from '../../../../../src/compliance/state/firestore-jobs.ts'
import type { Config } from '../../config'

/**
 * Error envelope for the start tool.
 */
export interface DiscoverStartError {
  readonly type: 'unconfirmed' | 'persist' | 'launch'
  readonly message: string
}

/**
 * Error envelope for the status tool.
 */
export interface DiscoverStatusError {
  readonly type: 'not_found' | 'load'
  readonly message: string
}

/**
 * Error envelope for the result tool.
 */
export interface DiscoverResultError {
  readonly type: 'not_found' | 'load' | 'not_ready'
  readonly message: string
}

/**
 * Tool input schema for `compliance-discover-start`.
 */
export const DiscoverStartInputSchema = {
  sources: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional filter: a list of source ids to run. Omit to run every registered source.',
    ),
  jurisdictionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional filter: a single jurisdiction id (e.g. "us-ca"). Omit to run every jurisdiction.',
    ),
}

/**
 * Production runner callables — overridable for tests.
 */
export type DiscoverStartRunner = (args: {
  readonly projectId: string
  readonly region: string
  readonly jobName: string
  readonly filter: DiscoveryJobFilter
  readonly firestore: FirestoreClientLike
}) => ReturnType<typeof startDiscoveryJobProduction>

export type DiscoverStatusRunner = (args: {
  readonly projectId: string
  readonly jobId: string
  readonly firestore: FirestoreClientLike
}) => ReturnType<typeof readDiscoveryJobStatusProduction>

export type DiscoverResultRunner = (args: {
  readonly projectId: string
  readonly jobId: string
  readonly firestore: FirestoreClientLike
}) => ReturnType<typeof readDiscoveryJobResultProduction>

export const defaultDiscoverStartRunner: DiscoverStartRunner = ({
  projectId,
  region,
  jobName,
  filter,
  firestore,
}) =>
  startDiscoveryJobProduction({
    projectId,
    region,
    jobName,
    filter,
    firestore,
  })

export const defaultDiscoverStatusRunner: DiscoverStatusRunner = ({
  projectId,
  jobId,
  firestore,
}) => readDiscoveryJobStatusProduction({ projectId, jobId, firestore })

export const defaultDiscoverResultRunner: DiscoverResultRunner = ({
  projectId,
  jobId,
  firestore,
}) => readDiscoveryJobResultProduction({ projectId, jobId, firestore })

export function resolveDiscoverStartRunner(
  override?: DiscoverStartRunner,
): DiscoverStartRunner {
  return override ?? defaultDiscoverStartRunner
}

export function resolveDiscoverStatusRunner(
  override?: DiscoverStatusRunner,
): DiscoverStatusRunner {
  return override ?? defaultDiscoverStatusRunner
}

export function resolveDiscoverResultRunner(
  override?: DiscoverResultRunner,
): DiscoverResultRunner {
  return override ?? defaultDiscoverResultRunner
}

/**
 * Shared deps for the three handlers.
 *
 * `firestore` is required: the async-job lifecycle (running ->
 * completed/failed) is tracked in Firestore because BigQuery's
 * streaming buffer doesn't allow UPDATEs on recently-inserted rows
 * (which leaves polling stuck on `running` for tens of minutes).
 */
export interface DiscoverDeps {
  readonly config: Config
  readonly logger: Logger
  readonly firestore: FirestoreClientLike
  readonly runDiscoverStart?: DiscoverStartRunner
  readonly runDiscoverStatus?: DiscoverStatusRunner
  readonly runDiscoverResult?: DiscoverResultRunner
}

/**
 * Translate a production-wiring start error into the tool envelope.
 */
export function translateStartError(
  e: StartDiscoveryJobProductionError,
): DiscoverStartError {
  return { type: e.type, message: e.message }
}

/**
 * Translate a status-read error into the tool envelope.
 */
export function translateStatusError(
  e: ReadDiscoveryJobStatusError,
): DiscoverStatusError {
  return { type: e.type, message: e.message }
}

/**
 * Translate a result-read error into the tool envelope.
 */
export function translateResultError(
  e: ReadDiscoveryJobResultError,
): DiscoverResultError {
  return { type: e.type, message: e.message }
}

/**
 * Build the canonical `DiscoveryJobFilter` from the tool's input. Both
 * filter fields default to null (= "no restriction") when absent.
 */
export function toJobFilter(input: {
  readonly sources?: readonly string[]
  readonly jurisdictionId?: string
}): DiscoveryJobFilter {
  return {
    sources: input.sources ?? null,
    jurisdictionId: input.jurisdictionId ?? null,
  }
}

/**
 * Handle compliance-discover-start.
 */
export async function handleComplianceDiscoverStart(
  input: {
    readonly confirm: boolean
    readonly sources?: readonly string[]
    readonly jurisdictionId?: string
  },
  deps: DiscoverDeps,
): Promise<Result<StartDiscoveryJobReport, DiscoverStartError>> {
  deps.logger.info('compliance-discover-start tool called')
  if (input.confirm !== true) {
    return err({
      type: 'unconfirmed',
      message:
        'compliance-discover-start requires confirm: true. Refusing to launch a job without an explicit confirmation.',
    })
  }
  const runner = resolveDiscoverStartRunner(deps.runDiscoverStart)
  const result = await runner({
    projectId: deps.config.PROJECT_ID,
    region: deps.config.REGION,
    jobName: deps.config.COMPLIANCE_DISCOVER_JOB_NAME,
    filter: toJobFilter(input),
    firestore: deps.firestore,
  })
  if (result.isErr()) {
    return err(translateStartError(result.error))
  }
  return ok(result.value)
}

/**
 * Handle compliance-discover-status.
 */
export async function handleComplianceDiscoverStatus(
  input: { readonly jobId: string },
  deps: DiscoverDeps,
): Promise<Result<DiscoveryJobStatusReport, DiscoverStatusError>> {
  deps.logger.info('compliance-discover-status tool called')
  const runner = resolveDiscoverStatusRunner(deps.runDiscoverStatus)
  const result = await runner({
    projectId: deps.config.PROJECT_ID,
    jobId: input.jobId,
    firestore: deps.firestore,
  })
  if (result.isErr()) {
    return err(translateStatusError(result.error))
  }
  return ok(result.value)
}

/**
 * Handle compliance-discover-result.
 */
export async function handleComplianceDiscoverResult(
  input: { readonly jobId: string },
  deps: DiscoverDeps,
): Promise<Result<unknown, DiscoverResultError>> {
  deps.logger.info('compliance-discover-result tool called')
  const runner = resolveDiscoverResultRunner(deps.runDiscoverResult)
  const result = await runner({
    projectId: deps.config.PROJECT_ID,
    jobId: input.jobId,
    firestore: deps.firestore,
  })
  if (result.isErr()) {
    return err(translateResultError(result.error))
  }
  return ok(result.value)
}
