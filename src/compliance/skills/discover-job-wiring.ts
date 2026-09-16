/**
 * Production wiring for the async compliance-discover job flow.
 *
 * `startDiscoveryJobProduction` inserts the parent `discovery_jobs` row and
 * triggers a Cloud Run **Job** execution (via `createCloudRunJobLauncher`)
 * that runs the discovery out-of-band. The Job process calls
 * `executeDiscoveryJobProduction` (which runs `runDiscoveryAndPersist`) and
 * records the terminal status. The caller polls via
 * `readDiscoveryJobStatusProduction` and fetches the report with
 * `readDiscoveryJobResultProduction`.
 */
import type { ResultAsync } from 'neverthrow'
import { join } from 'node:path'
import { z } from 'zod'
import { usCaJurisdiction } from '../jurisdictions/us-ca/index.ts'
import { usFederalJurisdiction } from '../jurisdictions/us-federal/index.ts'
import {
  createJurisdictionRegistry,
  type JurisdictionRegistry,
} from '../registry/jurisdiction-registry.ts'
import {
  LocalDownloadCacheStore,
  type DownloadCacheStore,
} from '../sources/download-cache.ts'
import { createFindingsAccessor } from '../state/bq-findings.ts'
import { createDiscoveryRunsAccessor } from '../state/bq-runs.ts'
import { createCloudRunJobLauncher } from '../state/cloud-run-jobs.ts'
import {
  createFirestoreDiscoveryJobsAccessor,
  type FirestoreClientLike,
} from '../state/firestore-jobs.ts'
import type { FetchImpl, Jurisdiction } from '../types/index.ts'
import {
  readDiscoveryJobResult,
  readDiscoveryJobStatus,
  runDiscoveryAndPersist,
  startDiscoveryJob,
  type DiscoveryJobFilter,
  type DiscoveryJobStatusReport,
  type LaunchDiscovery,
  type ReadDiscoveryJobResultError,
  type ReadDiscoveryJobStatusError,
  type StartDiscoveryJobError,
  type StartDiscoveryJobReport,
} from './discover-job.ts'
import { runDiscovery } from './discover.ts'
import {
  buildCommonDeps,
  type BigQueryFactory,
  type SecretManagerFactory,
} from './wiring-common.ts'

/**
 * Default system clock used when a caller doesn't supply `now`. Shared
 * across the three production entry points so the function reference is
 * coverage-counted once.
 */
function defaultDiscoverJobNow(): Date {
  return new Date()
}

/**
 * Default `fetch` implementation. Delegates to the global `fetch` (Bun's
 * native implementation). Exported so it's coverage-counted once and
 * tests can verify the wiring without exercising the full discovery
 * flow.
 */
export const defaultDiscoverJobFetch: FetchImpl = (input, init) =>
  fetch(input, init)

/**
 * Top-level error a production caller may see when starting a job:
 * `persist` (the parent row insert failed) or `launch` (the Cloud Run Job
 * execution could not be triggered). Filter/registry resolution happens
 * inside the executor (`executeDiscoveryJobProduction`), not here.
 */
export type StartDiscoveryJobProductionError = StartDiscoveryJobError

/**
 * Wiring args for the production start entry point.
 *
 * `firestore` is required because the async-job lifecycle (running /
 * completed / failed transitions) needs read-after-write consistency,
 * which BigQuery's streaming buffer cannot provide for ~30-90 minutes
 * after insert. Callers pass the same Firestore instance the OAuth
 * storage uses.
 *
 * `region` + `jobName` identify the Cloud Run Job to trigger. Tests inject
 * `launch` directly to avoid touching the Cloud Run Admin API.
 */
export interface StartDiscoveryJobProductionArgs {
  readonly projectId: string
  readonly region: string
  readonly jobName: string
  readonly filter: DiscoveryJobFilter
  readonly firestore: FirestoreClientLike
  readonly now?: () => Date
  readonly launch?: LaunchDiscovery
  readonly generateJobId?: () => string
  readonly logger?: { error: (message: string, err: unknown) => void }
}

/**
 * Start an async discover job against real GCP services. Inserts the parent
 * `discovery_jobs` row, then triggers a Cloud Run Job execution that runs
 * the discovery out-of-band. Returns `{ jobId }` as soon as the execution
 * is accepted; the caller polls `readDiscoveryJobStatusProduction`.
 */
export function startDiscoveryJobProduction(
  args: StartDiscoveryJobProductionArgs,
): ResultAsync<StartDiscoveryJobReport, StartDiscoveryJobProductionError> {
  const now = args.now ?? defaultDiscoverJobNow
  const launch =
    args.launch ??
    createCloudRunJobLauncher({
      projectId: args.projectId,
      region: args.region,
      jobName: args.jobName,
    })

  return startDiscoveryJob({
    jobsAccessor: createFirestoreDiscoveryJobsAccessor(args.firestore),
    now,
    filter: args.filter,
    launch,
    generateJobId: args.generateJobId,
    logger: args.logger,
  })
}

/**
 * Wiring args for the out-of-band executor entry point — the body the
 * Cloud Run Job process runs. It builds the full discovery deps against
 * real GCP services and transitions the parent row to its terminal status.
 */
export interface ExecuteDiscoveryJobProductionArgs {
  readonly projectId: string
  readonly jobId: string
  readonly filter: DiscoveryJobFilter
  readonly firestore: FirestoreClientLike
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
  readonly fetch?: FetchImpl
  readonly jurisdictions?: readonly Jurisdiction[]
  readonly downloadCache?: DownloadCacheStore
  readonly downloadCacheDir?: string
  readonly logger?: { error: (message: string, err: unknown) => void }
}

/**
 * Run one discovery job to completion (the body the Cloud Run Job executes)
 * and persist its terminal status. Resolves once the parent row has been
 * transitioned — it never rejects; failures are recorded on the job row.
 * A filter that resolves to no sources, or a registration conflict, marks
 * the job `failed` with a `wiring` error.
 */
export async function executeDiscoveryJobProduction(
  args: ExecuteDiscoveryJobProductionArgs,
): Promise<void> {
  const now = args.now ?? defaultDiscoverJobNow
  const fetchImpl: FetchImpl = args.fetch ?? defaultDiscoverJobFetch
  const jurisdictions = args.jurisdictions ?? [
    usFederalJurisdiction,
    usCaJurisdiction,
  ]
  const downloadCache =
    args.downloadCache ??
    new LocalDownloadCacheStore(
      args.downloadCacheDir ?? join(process.cwd(), '.cache', 'compliance'),
    )
  const jobsAccessor = createFirestoreDiscoveryJobsAccessor(args.firestore)

  const registryResult = buildFilteredRegistry(jurisdictions, args.filter)
  if (registryResult.kind === 'err') {
    const finish = await jobsAccessor.markJobFinished({
      jobId: args.jobId,
      finishedAt: now().toISOString(),
      status: 'failed',
      errorType: 'wiring',
      errorMessage: registryResult.message,
      result: null,
    })
    if (finish.isErr()) {
      args.logger?.error(
        `Failed to persist wiring-error status for job ${args.jobId}`,
        finish.error,
      )
    }
    return
  }

  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })
  const runsAccessor = createDiscoveryRunsAccessor({
    runner: deps.queryRunner,
    projectId: args.projectId,
  })
  const findingsAccessor = createFindingsAccessor({
    runner: deps.queryRunner,
    projectId: args.projectId,
  })

  await runDiscoveryAndPersist(args.jobId, {
    jobsAccessor,
    runsAccessor,
    findingsAccessor,
    now,
    filter: args.filter,
    runDiscovery: ({ recorder }) =>
      runDiscovery({
        registry: registryResult.registry,
        entityAccessor: deps.entityAccessor,
        identifiersAccessor: deps.identifiersAccessor,
        recorder,
        migrationPort: deps.migrationPort,
        now,
        fetch: fetchImpl,
        downloadCache,
      }),
    logger: args.logger,
  })
}

/**
 * Env schema for the Cloud Run Job entrypoint. `DISCOVERY_JOB_ID` (+ the
 * optional filter fields) are set by the launcher as execution-time
 * overrides; `PROJECT_ID` comes from the Job's deploy-time env. All
 * external — validated with Zod.
 */
const DiscoverJobEnvSchema = z.object({
  PROJECT_ID: z.string().min(1),
  DISCOVERY_JOB_ID: z.string().min(1),
  DISCOVERY_SOURCES: z.string().optional(),
  DISCOVERY_JURISDICTION_ID: z.string().optional(),
})

/**
 * Parsed form of the Cloud Run Job entrypoint environment.
 */
export interface ParsedDiscoverJobEnv {
  readonly projectId: string
  readonly jobId: string
  readonly filter: DiscoveryJobFilter
}

/**
 * Parse + validate the Cloud Run Job entrypoint's environment into a
 * project id, job id, and discovery filter. A comma-separated
 * `DISCOVERY_SOURCES` becomes an array; an empty or absent value means
 * "all sources".
 */
export function parseDiscoverJobEnv(
  env: Record<string, string | undefined>,
): ParsedDiscoverJobEnv {
  const parsed = DiscoverJobEnvSchema.parse(env)
  const sources =
    parsed.DISCOVERY_SOURCES === undefined
      ? null
      : parsed.DISCOVERY_SOURCES.split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
  return {
    projectId: parsed.PROJECT_ID,
    jobId: parsed.DISCOVERY_JOB_ID,
    filter: {
      sources: sources !== null && sources.length > 0 ? sources : null,
      jurisdictionId: parsed.DISCOVERY_JURISDICTION_ID ?? null,
    },
  }
}

/**
 * Wiring args for the production status entry point.
 */
export interface ReadDiscoveryJobStatusProductionArgs {
  readonly projectId: string
  readonly jobId: string
  readonly firestore: FirestoreClientLike
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
}

/**
 * Read job status against real GCP services.
 */
export function readDiscoveryJobStatusProduction(
  args: ReadDiscoveryJobStatusProductionArgs,
): ResultAsync<DiscoveryJobStatusReport, ReadDiscoveryJobStatusError> {
  const now = args.now ?? defaultDiscoverJobNow
  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })
  return readDiscoveryJobStatus({
    jobsAccessor: createFirestoreDiscoveryJobsAccessor(args.firestore),
    runsAccessor: createDiscoveryRunsAccessor({
      runner: deps.queryRunner,
      projectId: args.projectId,
    }),
    jobId: args.jobId,
  })
}

/**
 * Wiring args for the production result entry point.
 */
export interface ReadDiscoveryJobResultProductionArgs {
  readonly projectId: string
  readonly jobId: string
  readonly firestore: FirestoreClientLike
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
}

/**
 * Read the completed job's result against real GCP services.
 */
export function readDiscoveryJobResultProduction(
  args: ReadDiscoveryJobResultProductionArgs,
): ResultAsync<unknown, ReadDiscoveryJobResultError> {
  return readDiscoveryJobResult({
    jobsAccessor: createFirestoreDiscoveryJobsAccessor(args.firestore),
    jobId: args.jobId,
  })
}

type FilteredRegistryResult =
  | { kind: 'ok'; registry: JurisdictionRegistry }
  | { kind: 'err'; message: string }

/**
 * Build a JurisdictionRegistry, optionally filtered by jurisdictionId and/or
 * sources. The filter is applied before registration so the discovery loop
 * iterates only the sources the caller asked for.
 */
export function buildFilteredRegistry(
  list: readonly Jurisdiction[],
  filter: DiscoveryJobFilter,
): FilteredRegistryResult {
  const registry = createJurisdictionRegistry()
  const sourceFilter = filter.sources === null ? null : new Set(filter.sources)
  for (const j of list) {
    if (filter.jurisdictionId !== null && j.id !== filter.jurisdictionId) {
      continue
    }
    const filteredSources =
      sourceFilter === null
        ? j.sources
        : j.sources.filter((s) => sourceFilter.has(s.id))
    if (filteredSources.length === 0) {
      continue
    }
    const filteredJurisdiction: Jurisdiction = {
      ...j,
      sources: filteredSources,
    }
    const r = registry.register(filteredJurisdiction)
    if (r.isErr()) {
      return {
        kind: 'err',
        message: `Failed to register jurisdiction "${r.error.id}": ${r.error.message}`,
      }
    }
  }
  return { kind: 'ok', registry }
}
