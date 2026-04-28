/**
 * `compliance.discovery_runs` accessor.
 *
 * Inserts one row per source run. Uses parameterised SQL so a malicious
 * source_id can't inject. JSON columns ride as JSON-encoded strings —
 * BigQuery's JSON-typed parameter mode requires a string.
 *
 * The accessor trusts its caller's static types; the corresponding row
 * schema in `bq-rows.ts` is unit-tested as the runtime source of truth.
 */
import type { ResultAsync } from 'neverthrow'
import type { BqParameterType, BqQueryRunner, QueryParam } from './bq-entity.ts'
import {
  COMPLIANCE_DATASET,
  type ComplianceDiscoveryRunRow,
} from './bq-rows.ts'

/**
 * Errors emitted by the discovery_runs accessor.
 */
export interface RunsAccessorError {
  readonly type: 'query'
  readonly message: string
}

/**
 * Wiring.
 */
export interface DiscoveryRunsAccessorDeps {
  readonly runner: BqQueryRunner
  readonly projectId: string
}

/**
 * Accessor surface.
 */
export interface DiscoveryRunsAccessor {
  recordRun(
    row: ComplianceDiscoveryRunRow,
  ): ResultAsync<void, RunsAccessorError>
}

/**
 * Construct an accessor.
 */
export function createDiscoveryRunsAccessor(
  deps: DiscoveryRunsAccessorDeps,
): DiscoveryRunsAccessor {
  const tableName = `\`${deps.projectId}.${COMPLIANCE_DATASET}.discovery_runs\``

  return {
    recordRun(v) {
      const sql = `
        INSERT INTO ${tableName} (
          run_id,
          source_id,
          jurisdiction_id,
          status,
          started_at,
          completed_at,
          duration_ms,
          error_type,
          error_message,
          payload
        )
        VALUES (
          @run_id,
          @source_id,
          @jurisdiction_id,
          @status,
          @started_at,
          @completed_at,
          @duration_ms,
          @error_type,
          @error_message,
          PARSE_JSON(@payload)
        )
      `
      const params: Record<string, QueryParam> = {
        run_id: v.run_id,
        source_id: v.source_id,
        jurisdiction_id: v.jurisdiction_id,
        status: v.status,
        started_at: v.started_at,
        completed_at: v.completed_at,
        duration_ms: v.duration_ms,
        error_type: v.error_type,
        error_message: v.error_message,
        payload: v.payload === null ? null : JSON.stringify(v.payload),
      }

      // BigQuery's nodejs SDK refuses null parameter values without an
      // explicit type. Every nullable column gets a hint here. `payload`
      // travels as a JSON string into PARSE_JSON, so its parameter type is
      // STRING rather than JSON.
      const types: Record<string, BqParameterType> = {
        error_type: 'STRING',
        error_message: 'STRING',
        payload: 'STRING',
      }

      return deps.runner
        .query(sql, params, types)
        .mapErr<RunsAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .map(() => undefined)
    },
  }
}
