#!/usr/bin/env bun
/**
 * CLI entry point for compliance dataset/table migration.
 *
 * Usage:
 *   bun scripts/compliance-migrate.ts --project <id> [--dry-run]
 *
 * The full orchestration logic lives in
 * `src/compliance/skills/migrate-cli.ts` and is unit-tested there.
 * This file is a deliberately tiny adapter: a few lines of glue. Tests do
 * not import this file (the testable surface is `runCli`), so it does not
 * appear in coverage measurement.
 */
import { BigQuery } from '@google-cloud/bigquery'
import {
  runCli,
  type BqClient,
  type BqDataset,
} from '../src/compliance/skills/migrate-cli.ts'

/**
 * Adapt a real `BigQuery` client to the narrow `BqClient` shape `runCli`
 * expects. The `BigQuery` SDK's overloaded signatures don't structurally
 * match a single signature, so we wrap each call individually.
 */
function adaptBigQuery(bq: BigQuery): BqClient {
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
  }
}

await runCli({
  argv: process.argv.slice(2),
  io: {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (c) => process.exit(c),
  },
  bqFactory: (projectId) => adaptBigQuery(new BigQuery({ projectId })),
})
