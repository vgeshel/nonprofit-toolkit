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
import type { SourceError } from '../sources/errors.ts'
import { runSource, type RunRecorder } from '../sources/runner.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type {
  Entity,
  EntityIdentifiers,
  FetchImpl,
  Finding,
  SourceContext,
  SourceRunOutput,
} from '../types/index.ts'

/**
 * Failure modes for the orchestrator itself (not for individual sources —
 * those are captured in the result struct).
 */
export type DiscoveryError =
  | { type: 'not_onboarded'; message: string }
  | { type: 'load'; message: string }

/**
 * One element of the per-run report.
 */
export type DiscoveryRun =
  | {
      readonly outcome: 'ok'
      readonly sourceId: string
      readonly jurisdictionId: string
      readonly output: SourceRunOutput
    }
  | {
      readonly outcome: 'err'
      readonly sourceId: string
      readonly jurisdictionId: string
      readonly error: SourceError
    }

/**
 * Discovery result aggregate.
 */
export interface DiscoveryReport {
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
  readonly runs: readonly DiscoveryRun[]
  readonly findings: readonly Finding[]
}

/**
 * Wiring.
 */
export interface RunDiscoveryArgs {
  readonly registry: JurisdictionRegistry
  readonly entityAccessor: EntityAccessor
  readonly identifiersAccessor: EntityIdsAccessor
  readonly recorder: RunRecorder
  readonly now: () => Date
  readonly fetch: FetchImpl
}

/**
 * Run discovery. See module docstring for semantics.
 */
export function runDiscovery(
  args: RunDiscoveryArgs,
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

interface ExecuteArgs extends RunDiscoveryArgs {
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
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
    identifiers: args.identifiers,
  }

  const promises: Promise<DiscoveryRun>[] = []
  for (const j of args.registry.list()) {
    for (const source of j.sources) {
      promises.push(
        runSource({
          source,
          entity: args.entity,
          ctx,
          recorder: args.recorder,
        })
          .match<DiscoveryRun>(
            (output): DiscoveryRun => ({
              outcome: 'ok',
              sourceId: source.id,
              jurisdictionId: j.id,
              output,
            }),
            (error): DiscoveryRun => ({
              outcome: 'err',
              sourceId: source.id,
              jurisdictionId: j.id,
              error,
            }),
          )
          .then((r) => r),
      )
    }
  }

  return ResultAsync.fromSafePromise(Promise.all(promises)).map(
    (runs): DiscoveryReport => {
      const findings: Finding[] = []
      for (const r of runs) {
        if (r.outcome === 'ok') {
          findings.push(...r.output.findings)
        }
      }
      return {
        entity: args.entity,
        identifiers: args.identifiers,
        runs,
        findings,
      }
    },
  )
}
