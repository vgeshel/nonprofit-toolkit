/**
 * Backend for the `compliance-discover` skill.
 *
 * Phase 1 scope: load the entity row and identifiers, then run every source
 * registered in the jurisdiction registry. Each source's run is recorded to
 * BigQuery (`discovery_runs`); findings are recorded to `findings`. The
 * caller (the skill) prints the summary.
 *
 * Per-source failures are captured in the result rather than aborting the
 * whole flow — a CA source breaking shouldn't hide an IRS finding.
 */
import { ResultAsync, errAsync } from 'neverthrow'
import type { JurisdictionRegistry } from '../registry/jurisdiction-registry.ts'
import { deriveComplianceFindings } from '../rules/findings.ts'
import type { DownloadCacheStore } from '../sources/download-cache.ts'
import type { SourceError } from '../sources/errors.ts'
import { formatSourceError } from '../sources/errors.ts'
import { runSourceOutcome, type RunRecorder } from '../sources/runner.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import { ensureComplianceSchema } from '../state/ensure-schema.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type {
  Entity,
  EntityIdentifiers,
  FetchImpl,
  Finding,
  Source,
  SourceAccessMethod,
  SourceContext,
  SourceFreshness,
  SourceRunOutcome,
} from '../types/index.ts'
import type { ComplianceMigrationPort, MigrationReport } from './migrate.ts'

/**
 * Failure modes for the orchestrator itself (not for individual sources —
 * those are captured in the result struct).
 */
export type DiscoveryError =
  | { type: 'not_onboarded'; message: string }
  | { type: 'load'; message: string }
  | { type: 'persist'; message: string }

/**
 * Source metadata copied into each per-run report entry so report rendering
 * does not need to reach back into the registry.
 */
export interface DiscoveryRunSourceSummary {
  readonly sourceId: string
  readonly jurisdictionId: string
  readonly description: string
  readonly accessUrl: string
  readonly accessMethod: SourceAccessMethod
  readonly automationAllowed: boolean
  readonly manualOnlyReason?: string
  readonly sourceFreshness?: SourceFreshness
  readonly tosUrl: string
}

/**
 * One element of the per-run report.
 */
export interface DiscoveryRun extends DiscoveryRunSourceSummary {
  readonly outcome: SourceRunOutcome
}

/**
 * Discovery result aggregate.
 *
 * `migration` reflects what `ensureComplianceSchema` did at the start of the
 * run — a no-op on every call after the first onboarding; non-empty only the
 * very first time `compliance-discover` runs in a fresh GCP project.
 */
export interface DiscoveryReport {
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
  readonly runs: readonly DiscoveryRun[]
  readonly findings: readonly Finding[]
  readonly migration: MigrationReport
}

/**
 * Wiring.
 */
export interface RunDiscoveryArgs {
  readonly registry: JurisdictionRegistry
  readonly entityAccessor: EntityAccessor
  readonly identifiersAccessor: EntityIdsAccessor
  readonly recorder: RunRecorder
  readonly migrationPort: ComplianceMigrationPort
  readonly now: () => Date
  readonly fetch: FetchImpl
  readonly downloadCache?: DownloadCacheStore
}

/**
 * Run discovery. See module docstring for semantics.
 *
 * The compliance schema is ensured before any reads — running discovery on a
 * fresh project where onboarding has not been completed will fail loudly on
 * `not_onboarded` rather than on a missing-table error from BigQuery.
 */
export function runDiscovery(
  args: RunDiscoveryArgs,
): ResultAsync<DiscoveryReport, DiscoveryError> {
  return ensureComplianceSchema(args.migrationPort)
    .mapErr<DiscoveryError>((err) => ({
      type: 'load',
      message: `Compliance schema migration failed: ${err.message}`,
    }))
    .andThen((migration) => loadEntityAndRun({ ...args, migration }))
}

interface ExecuteArgs extends RunDiscoveryArgs {
  readonly migration: MigrationReport
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
}

interface PostMigrationArgs extends RunDiscoveryArgs {
  readonly migration: MigrationReport
}

/**
 * After the schema is guaranteed, load identity state and dispatch sources.
 * Split out so the migration step's error mapping stays in `runDiscovery` and
 * the entity-load mapping stays here.
 */
function loadEntityAndRun(
  args: PostMigrationArgs,
): ResultAsync<DiscoveryReport, DiscoveryError> {
  const entityResult = args.entityAccessor
    .readEntity()
    .mapErr<DiscoveryError>((err) => ({
      type: 'load',
      message: `Failed to read entity row: ${err.message}`,
    }))

  const idsResult = args.identifiersAccessor
    .read()
    .mapErr<DiscoveryError>((err) => ({
      type: 'load',
      message: `Failed to read entity identifiers: ${err.message}`,
    }))

  return entityResult.andThen((entity) =>
    idsResult.andThen((identifiers) => {
      if (entity === null || identifiers === null) {
        return errAsync<DiscoveryReport, DiscoveryError>({
          type: 'not_onboarded',
          message:
            'No entity record found. Run the compliance-onboard skill first.',
        })
      }
      return executeAllSources({ ...args, entity, identifiers })
    }),
  )
}

/**
 * Iterate the registered jurisdictions, run each source, accumulate.
 */
function executeAllSources(
  args: ExecuteArgs,
): ResultAsync<DiscoveryReport, DiscoveryError> {
  const ctx: SourceContext = {
    now: args.now,
    fetch: args.fetch,
    downloadCache: args.downloadCache,
    identifiers: args.identifiers,
  }

  const promises: Promise<DiscoveryRun>[] = []
  for (const j of args.registry.list()) {
    for (const source of j.sources) {
      const summary = summarizeSourceForReport(source, j.id)
      promises.push(
        runSourceOutcome({
          source,
          entity: args.entity,
          ctx,
          recorder: args.recorder,
        })
          .match<DiscoveryRun>(
            (outcome): DiscoveryRun => ({ ...summary, outcome }),
            (error): DiscoveryRun => ({
              ...summary,
              outcome: sourceErrorToOutcome(source.id, error),
            }),
          )
          .then((r) => r),
      )
    }
  }

  return ResultAsync.fromSafePromise(Promise.all(promises)).andThen(
    (runs): ResultAsync<DiscoveryReport, DiscoveryError> => {
      const sourceFindings = collectSourceFindings(runs)
      const derivedFindings = deriveComplianceFindings({
        entity: args.entity,
        identifiers: args.identifiers,
        runs,
        now: args.now,
      })
      return args.recorder
        .recordFindings(derivedFindings)
        .mapErr<DiscoveryError>((err) => ({
          type: 'persist',
          message: `Failed to persist derived findings: ${err.message}`,
        }))
        .map((): DiscoveryReport => {
          const findings: Finding[] = [...sourceFindings, ...derivedFindings]
          return {
            entity: args.entity,
            identifiers: args.identifiers,
            runs,
            findings,
            migration: args.migration,
          }
        })
    },
  )
}

function summarizeSourceForReport(
  source: Source,
  jurisdictionId: string,
): DiscoveryRunSourceSummary {
  const summary: DiscoveryRunSourceSummary = {
    sourceId: source.id,
    jurisdictionId,
    description: source.description,
    accessUrl: source.accessUrl,
    accessMethod: source.accessMethod,
    automationAllowed: source.automationAllowed,
    sourceFreshness: source.sourceFreshness,
    tosUrl: source.tosUrl,
  }
  if (source.automationAllowed) {
    return summary
  }
  return { ...summary, manualOnlyReason: source.manualOnlyReason }
}

function sourceErrorToOutcome(
  sourceId: string,
  error: SourceError,
): SourceRunOutcome {
  return {
    status: 'source_failure',
    source_id: sourceId,
    error_type: error.type,
    message: formatSourceError(error),
  }
}

function collectSourceFindings(runs: readonly DiscoveryRun[]): Finding[] {
  const findings: Finding[] = []
  for (const r of runs) {
    if (r.outcome.status === 'success') {
      findings.push(...r.outcome.output.findings)
    }
  }
  return findings
}
