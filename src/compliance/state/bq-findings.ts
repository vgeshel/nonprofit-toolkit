/**
 * `compliance.findings` accessor.
 *
 * Inserts one row per finding. Trusts its caller's static types; the
 * Finding schema in `bq-rows.ts` is unit-tested as the runtime source of
 * truth.
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import type { Finding } from '../types/index.ts'
import type { BqParameterType, BqQueryRunner, QueryParam } from './bq-entity.ts'
import {
  COMPLIANCE_DATASET,
  CURRENT_OPEN_FINDINGS_VIEW,
  ComplianceFindingRowSchema,
} from './bq-rows.ts'

/**
 * Errors emitted by the findings accessor.
 */
export type FindingsAccessorError =
  | {
      readonly type: 'query'
      readonly message: string
    }
  | {
      readonly type: 'parse'
      readonly message: string
    }

/**
 * Wiring.
 */
export interface FindingsAccessorDeps {
  readonly runner: BqQueryRunner
  readonly projectId: string
}

/**
 * Accessor surface.
 */
export interface FindingsAccessor {
  recordFindings(
    findings: readonly Finding[],
  ): ResultAsync<void, FindingsAccessorError>
  listOpenFindings(): ResultAsync<readonly Finding[], FindingsAccessorError>
}

/**
 * Construct an accessor.
 */
export function createFindingsAccessor(
  deps: FindingsAccessorDeps,
): FindingsAccessor {
  const tableName = `\`${deps.projectId}.${COMPLIANCE_DATASET}.findings\``
  const currentOpenViewName = `\`${deps.projectId}.${COMPLIANCE_DATASET}.${CURRENT_OPEN_FINDINGS_VIEW}\``

  return {
    recordFindings(findings) {
      if (findings.length === 0) {
        return okAsync(undefined)
      }

      const sql = `
        INSERT INTO ${tableName} (
          finding_id,
          jurisdiction_id,
          source_id,
          severity,
          status,
          title,
          detail,
          evidence,
          opened_at,
          resolved_at
        )
        VALUES (
          @finding_id,
          @jurisdiction_id,
          @source_id,
          @severity,
          @status,
          @title,
          @detail,
          PARSE_JSON(@evidence),
          @opened_at,
          @resolved_at
        )
      `

      // Run inserts in sequence so a later failure stops the rest.
      // Phase 1 emits at most a few findings per run, so a multi-row INSERT is
      // not yet needed.
      //
      // BigQuery's nodejs SDK refuses null parameter values without an
      // explicit type. `resolved_at` is the only nullable column on
      // `findings`, so it's the only one that needs a hint. The hint is
      // attached unconditionally — equally correct whether the value is
      // null or a timestamp string.
      const types: Record<string, BqParameterType> = {
        resolved_at: 'TIMESTAMP',
      }

      return findings.reduce<ResultAsync<void, FindingsAccessorError>>(
        (chain, f) =>
          chain.andThen(() => {
            const params: Record<string, QueryParam> = {
              finding_id: f.finding_id,
              jurisdiction_id: f.jurisdiction_id,
              source_id: f.source_id,
              severity: f.severity,
              status: f.status,
              title: f.title,
              detail: f.detail,
              evidence: JSON.stringify(f.evidence),
              opened_at: f.opened_at,
              resolved_at: f.resolved_at,
            }
            return deps.runner
              .query(sql, params, types)
              .mapErr<FindingsAccessorError>((err) => ({
                type: 'query',
                message: err.message,
              }))
              .map(() => undefined)
          }),
        okAsync(undefined),
      )
    },

    listOpenFindings() {
      const sql = `
        SELECT *
        FROM ${currentOpenViewName}
        WHERE status = 'open'
        ORDER BY
          CASE severity
            WHEN 'error' THEN 0
            WHEN 'warn' THEN 1
            ELSE 2
          END,
          jurisdiction_id,
          source_id,
          title
      `

      return deps.runner
        .query(sql)
        .mapErr<FindingsAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .andThen((rows) => parseFindingRows(rows))
    },
  }
}

function parseFindingRows(
  rows: readonly unknown[],
): ResultAsync<readonly Finding[], FindingsAccessorError> {
  const parsedRows: Finding[] = []
  for (const row of rows) {
    const parsed = ComplianceFindingRowSchema.safeParse(row)
    if (!parsed.success) {
      return errAsync({
        type: 'parse',
        message: `Invalid findings row from BigQuery: ${parsed.error.message}`,
      })
    }
    parsedRows.push(parsed.data)
  }
  return okAsync(parsedRows)
}
