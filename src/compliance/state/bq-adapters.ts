/**
 * Shared BigQuery adapters.
 *
 * Two functions live here so the production wiring for compliance skills
 * (onboard, discover) does not have to hand-roll the same boilerplate every
 * time:
 *
 *   - `adaptBigQueryToBqClient(bq)` — used by the migration / `ensureSchema`
 *     plumbing. Wraps `BigQuery`'s overloaded `dataset` / `createDataset` API
 *     into the narrow `BqClient` shape.
 *
 *   - `adaptBigQueryToQueryRunner(bq)` — used by the entity / runs / findings
 *     accessors. Wraps `BigQuery.query(...)` into the `BqQueryRunner` port:
 *     parameter mode is fixed to `'named'`, the `[rows, ...]` tuple is
 *     unwrapped to a row array, and SDK errors are translated into typed
 *     `{ type: 'query'; message: string }` errors.
 *
 * Both adapters are pure pass-throughs and have no behaviour beyond shape
 * adaptation. The migration / accessor / runner logic is tested elsewhere
 * with port-level fakes; this module only verifies the shape adaptation.
 */
import { BigQuery } from '@google-cloud/bigquery'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { BqClient, BqDataset } from '../skills/migrate-cli.ts'
import type { BqParameterType, BqQueryRunner, QueryParam } from './bq-entity.ts'

/**
 * Re-export the SDK class so wiring code has a single import surface for
 * "the production BigQuery type".
 */
export { BigQuery }

/**
 * Adapt a real `BigQuery` instance to the narrow `BqClient` shape.
 *
 * The shape is the one `runMigration` / `ensureComplianceSchema` consume:
 * `dataset(name).{exists,createTable,table().exists}` and `createDataset`.
 * Each method is a thin wrapper around the corresponding SDK call.
 */
export function adaptBigQueryToBqClient(bq: BigQuery): BqClient {
  return {
    dataset(name: string): BqDataset {
      const ds = bq.dataset(name)
      return {
        exists: () => ds.exists(),
        createTable: (tableId, options) =>
          ds.createTable(tableId, {
            schema: {
              fields: options.schema.fields.map((f) => ({
                name: f.name,
                type: f.type,
                mode: f.mode,
              })),
            },
            description: options.description,
          }),
        table: (tableId: string) => {
          const t = ds.table(tableId)
          return { exists: () => t.exists() }
        },
      }
    },
    createDataset: (name: string) => bq.createDataset(name),
    query: (options) => bq.query(options),
  }
}

/**
 * Schema for the tuple `BigQuery.query` resolves to. The SDK types it as
 * `[any[], ...]`, so we narrow at runtime: a successful query is `[rows]`
 * where `rows` is an array. Anything else is treated as "no rows" — the
 * accessor layer decides what that means in context.
 */
const QueryResultSchema = z.tuple([z.array(z.unknown())]).rest(z.unknown())

/**
 * Render a thrown SDK value as a string. Centralised so the `instanceof
 * Error` branch is in one place we can directly exercise from tests.
 */
function describeQueryError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

/**
 * Adapt a real `BigQuery` instance to the `BqQueryRunner` port.
 *
 * The accessor port expects `{ type: 'query'; message: string }` errors and
 * an `unknown[]` row array; this adapter does the unwrapping and
 * normalisation.
 *
 * `parameterMode: 'named'` is hard-coded because every accessor in this
 * codebase uses `@name`-style parameters. If a future accessor needs
 * positional binding, it should compose a different runner.
 */
export function adaptBigQueryToQueryRunner(bq: BigQuery): BqQueryRunner {
  return {
    query(
      sql: string,
      params?: Record<string, QueryParam>,
      types?: Record<string, BqParameterType>,
    ) {
      // Build the SDK options object incrementally so an absent `types` map
      // is not serialised as an empty object — the SDK treats present-but-
      // empty differently from absent in some edge cases, and accessors that
      // bind only non-nullable values shouldn't pay that risk.
      const options: {
        query: string
        params: Record<string, QueryParam>
        parameterMode: 'named'
        types?: Record<string, BqParameterType>
      } = {
        query: sql,
        params: params ?? {},
        parameterMode: 'named',
      }
      if (types !== undefined) {
        options.types = types
      }

      return ResultAsync.fromPromise(bq.query(options), (err) => ({
        type: 'query',
        message: describeQueryError(err),
      })).map((response) => {
        const parsed = QueryResultSchema.safeParse(response)
        if (!parsed.success) {
          return []
        }
        return parsed.data[0]
      })
    },
  }
}
