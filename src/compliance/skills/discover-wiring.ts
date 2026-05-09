/**
 * Production wiring for the `compliance-discover` skill.
 *
 * `runDiscoveryProduction` is the function the skill (or the thin
 * `scripts/compliance-discover.ts` adapter) calls. It:
 *
 *   1. Builds the shared GCP-backed deps (BigQuery + Secret Manager) via
 *      `buildCommonDeps`.
 *   2. Adds the discovery-specific bits: a `RunRecorder` composed from the
 *      `discovery_runs` and `findings` accessors, plus a jurisdiction
 *      registry pre-populated with the Phase 2 public-source jurisdictions.
 *   3. Calls `runDiscovery`.
 *
 * Tests inject factories / fetch / clock to avoid hitting GCP or the network.
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync } from 'neverthrow'
import { join } from 'node:path'
import { usCaJurisdiction } from '../jurisdictions/us-ca/index.ts'
import { usFederalJurisdiction } from '../jurisdictions/us-federal/index.ts'
import {
  createJurisdictionRegistry,
  type JurisdictionRegistry,
  type RegistryError,
} from '../registry/jurisdiction-registry.ts'
import {
  LocalDownloadCacheStore,
  type DownloadCacheStore,
} from '../sources/download-cache.ts'
import type { RunRecorder } from '../sources/runner.ts'
import { createFindingsAccessor } from '../state/bq-findings.ts'
import { createDiscoveryRunsAccessor } from '../state/bq-runs.ts'
import type { FetchImpl, Jurisdiction } from '../types/index.ts'
import type { DiscoveryError, DiscoveryReport } from './discover.ts'
import { runDiscovery } from './discover.ts'
import {
  buildCommonDeps,
  type BigQueryFactory,
  type SecretManagerFactory,
} from './wiring-common.ts'

/**
 * Errors `runDiscoveryProduction` can emit. Includes everything
 * `runDiscovery` can report plus `wiring`, which fires only if jurisdiction
 * registration fails (typically: caller passed two jurisdictions with the
 * same id).
 */
export type DiscoveryProductionError =
  | DiscoveryError
  | { type: 'wiring'; message: string }

/**
 * Wiring args for the production discovery entry point.
 *
 * `jurisdictions` defaults to federal and California public-source modules.
 *
 * `fetch` defaults to the global `fetch` (Bun's native implementation).
 */
export interface RunDiscoveryProductionArgs {
  readonly projectId: string
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
  readonly fetch?: FetchImpl
  readonly jurisdictions?: readonly Jurisdiction[]
  readonly downloadCache?: DownloadCacheStore
  readonly downloadCacheDir?: string
}

/**
 * Run discovery against real GCP services (or test-injected fakes).
 */
export function runDiscoveryProduction(
  args: RunDiscoveryProductionArgs,
): ResultAsync<DiscoveryReport, DiscoveryProductionError> {
  const now = args.now ?? (() => new Date())
  const fetchImpl: FetchImpl =
    args.fetch ?? ((input, init) => fetch(input, init))
  const jurisdictions = args.jurisdictions ?? [
    usFederalJurisdiction,
    usCaJurisdiction,
  ]
  const downloadCache =
    args.downloadCache ??
    new LocalDownloadCacheStore(
      args.downloadCacheDir ?? join(process.cwd(), '.cache', 'compliance'),
    )

  const registryResult = buildRegistry(jurisdictions)
  if (registryResult.kind === 'err') {
    return errAsync<DiscoveryReport, DiscoveryProductionError>({
      type: 'wiring',
      message: `Failed to register jurisdiction "${registryResult.error.id}": ${registryResult.error.message}`,
    })
  }

  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })

  const recorder: RunRecorder = {
    recordRun: (row) =>
      createDiscoveryRunsAccessor({
        runner: deps.queryRunner,
        projectId: args.projectId,
      }).recordRun(row),
    recordFindings: (findings) =>
      createFindingsAccessor({
        runner: deps.queryRunner,
        projectId: args.projectId,
      }).recordFindings(findings),
  }

  return runDiscovery({
    registry: registryResult.value,
    entityAccessor: deps.entityAccessor,
    identifiersAccessor: deps.identifiersAccessor,
    recorder,
    migrationPort: deps.migrationPort,
    now,
    fetch: fetchImpl,
    downloadCache,
  })
}

type BuildRegistryResult =
  | { kind: 'ok'; value: JurisdictionRegistry }
  | { kind: 'err'; error: RegistryError }

/**
 * Build a fresh registry and register every jurisdiction in `list`. Pulled
 * out so the failure branch (a `register` call that returns `err`) is
 * directly testable without injecting a registry from the outside.
 */
export function buildRegistry(
  list: readonly Jurisdiction[],
): BuildRegistryResult {
  const registry = createJurisdictionRegistry()
  for (const j of list) {
    const r = registry.register(j)
    if (r.isErr()) {
      return { kind: 'err', error: r.error }
    }
  }
  return { kind: 'ok', value: registry }
}
