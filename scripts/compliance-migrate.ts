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
import { runCli } from '../src/compliance/skills/migrate-cli.ts'
import { adaptBigQueryToBqClient } from '../src/compliance/state/bq-adapters.ts'

await runCli({
  argv: process.argv.slice(2),
  io: {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (c) => process.exit(c),
  },
  bqFactory: (projectId) =>
    adaptBigQueryToBqClient(new BigQuery({ projectId })),
})
