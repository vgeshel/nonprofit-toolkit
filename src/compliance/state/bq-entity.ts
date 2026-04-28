/**
 * Entity-row accessor for the `compliance.entity` BigQuery table.
 *
 * Rather than depending on the `@google-cloud/bigquery` client directly, the
 * accessor takes a tiny `BqQueryRunner` port. This keeps the accessor's tests
 * fast (no GCP creds), keeps the production wiring simple (one place
 * constructs a real BigQuery and adapts it to the port), and lets every
 * accessor share the same port shape.
 *
 * Phase 1 stores a single entity row. We use MERGE so re-runs are idempotent.
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import type { z } from 'zod'
import type { Entity } from '../types/index.ts'
import {
  COMPLIANCE_DATASET,
  ComplianceEntityRowSchema,
  type BqFieldType,
} from './bq-rows.ts'

/**
 * Errors emitted by an entity-row operation.
 *
 * - `query` wraps an upstream BigQuery error (network, permission, etc.)
 * - `parse` means a row came back but did not match the schema
 * - `validation` means the input given to `upsertEntity` did not validate
 */
export type EntityAccessorError =
  | { type: 'query'; message: string }
  | { type: 'parse'; message: string }
  | { type: 'validation'; message: string }

/**
 * BigQuery-flavoured query parameter. We accept the basic JSON-shaped types
 * BigQuery's parameterised query feature supports.
 */
export type QueryParam = string | number | boolean | null

/**
 * Per-parameter BigQuery type hint, used as the companion `types` map for
 * named parameters. The set is reused from `BqFieldType` because every
 * column type the compliance schema declares is also a value-binding type
 * BigQuery accepts here.
 *
 * The map is required for any parameter whose value can be `null`: the
 * BigQuery nodejs SDK refuses to send a `null` parameter without an explicit
 * type, since it cannot infer the column type from the value.
 */
export type BqParameterType = BqFieldType

/**
 * Minimal port — the production wiring adapts a real `BigQuery` instance to
 * this shape; tests provide a `vi.fn()`.
 *
 * `query` MUST return a parameterised query result as an array of rows. The
 * runner is responsible for parameter binding; the accessor passes `params`
 * verbatim.
 *
 * `types` is optional. When supplied, it is a per-parameter map of BigQuery
 * type names (`'STRING'`, `'INT64'`, etc.). Accessors that bind nullable
 * columns MUST supply a type for those columns so a `null` value is accepted
 * by the SDK.
 */
export interface BqQueryRunner {
  query(
    sql: string,
    params?: Record<string, QueryParam>,
    types?: Record<string, BqParameterType>,
  ): ResultAsync<unknown[], { type: string; message: string }>
}

/**
 * Input shape accepted by `upsertEntity`. Mirrors `Entity` minus `updated_at`,
 * which the accessor sets from its `now` clock.
 */
export const EntityInputSchema = ComplianceEntityRowSchema.omit({
  updated_at: true,
})

export type EntityInput = z.infer<typeof EntityInputSchema>

/**
 * Accessor surface.
 */
export interface EntityAccessor {
  readEntity(): ResultAsync<Entity | null, EntityAccessorError>
  upsertEntity(input: EntityInput): ResultAsync<void, EntityAccessorError>
}

/**
 * Wiring arguments for the accessor.
 */
export interface EntityAccessorDeps {
  readonly runner: BqQueryRunner
  readonly projectId: string
  readonly now: () => Date
}

/**
 * Quote a BigQuery fully-qualified table name. Project, dataset, and table
 * are all controlled inputs (not user data) so this is safe.
 */
function tableRef(projectId: string, table: string): string {
  return `\`${projectId}.${COMPLIANCE_DATASET}.${table}\``
}

/**
 * Construct an entity accessor.
 */
export function createEntityAccessor(deps: EntityAccessorDeps): EntityAccessor {
  const tableName = tableRef(deps.projectId, 'entity')

  return {
    readEntity() {
      const sql = `SELECT * FROM ${tableName} LIMIT 1`
      return deps.runner
        .query(sql)
        .mapErr<EntityAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .andThen<Entity | null, EntityAccessorError>((rows) => {
          if (rows.length === 0) {
            return okAsync(null)
          }
          const parsed = ComplianceEntityRowSchema.safeParse(rows[0])
          if (!parsed.success) {
            return errAsync({
              type: 'parse',
              message: `Invalid entity row from BigQuery: ${parsed.error.message}`,
            })
          }
          return okAsync(parsed.data)
        })
    },

    upsertEntity(input) {
      const validation = EntityInputSchema.safeParse(input)
      if (!validation.success) {
        return errAsync<void, EntityAccessorError>({
          type: 'validation',
          message: validation.error.message,
        })
      }

      const v = validation.data
      const sql = `
        MERGE ${tableName} T
        USING (SELECT 1 AS one) S
        ON TRUE
        WHEN MATCHED THEN UPDATE SET
          legal_name = @legal_name,
          state_of_incorporation = @state_of_incorporation,
          fiscal_year_end_month = @fiscal_year_end_month,
          fiscal_year_end_day = @fiscal_year_end_day,
          formation_date = @formation_date,
          mailing_address_line1 = @mailing_address_line1,
          mailing_address_line2 = @mailing_address_line2,
          mailing_address_city = @mailing_address_city,
          mailing_address_region = @mailing_address_region,
          mailing_address_postal_code = @mailing_address_postal_code,
          mailing_address_country = @mailing_address_country,
          updated_at = @updated_at
        WHEN NOT MATCHED THEN INSERT (
          legal_name,
          state_of_incorporation,
          fiscal_year_end_month,
          fiscal_year_end_day,
          formation_date,
          mailing_address_line1,
          mailing_address_line2,
          mailing_address_city,
          mailing_address_region,
          mailing_address_postal_code,
          mailing_address_country,
          updated_at
        ) VALUES (
          @legal_name,
          @state_of_incorporation,
          @fiscal_year_end_month,
          @fiscal_year_end_day,
          @formation_date,
          @mailing_address_line1,
          @mailing_address_line2,
          @mailing_address_city,
          @mailing_address_region,
          @mailing_address_postal_code,
          @mailing_address_country,
          @updated_at
        )
      `
      const params: Record<string, QueryParam> = {
        legal_name: v.legal_name,
        state_of_incorporation: v.state_of_incorporation,
        fiscal_year_end_month: v.fiscal_year_end_month,
        fiscal_year_end_day: v.fiscal_year_end_day,
        formation_date: v.formation_date,
        mailing_address_line1: v.mailing_address_line1,
        mailing_address_line2: v.mailing_address_line2,
        mailing_address_city: v.mailing_address_city,
        mailing_address_region: v.mailing_address_region,
        mailing_address_postal_code: v.mailing_address_postal_code,
        mailing_address_country: v.mailing_address_country,
        updated_at: deps.now().toISOString(),
      }

      // BigQuery's nodejs SDK refuses null parameter values without an
      // explicit type. `mailing_address_line2` is the only nullable column
      // on `entity`, so it's the only one that needs a hint.
      const types: Record<string, BqParameterType> = {
        mailing_address_line2: 'STRING',
      }

      return deps.runner
        .query(sql, params, types)
        .mapErr<EntityAccessorError>((err) => ({
          type: 'query',
          message: err.message,
        }))
        .map(() => undefined)
    },
  }
}
