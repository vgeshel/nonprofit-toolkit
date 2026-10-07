#!/usr/bin/env bun
/**
 * Make the alias rows in source_coverage match DISBURSEMENT_ALIASES.
 *
 * Usage: bun scripts/sync-disbursement-aliases.ts --project <id> --dataset-raw <name> --dataset-canon <name>
 *
 * Called by infra/provision.sh. All logic lives in disbursement-aliases-lib.ts.
 */
import { spawnRunner } from './command-runner'
import { parseArgs, syncAliases } from './disbursement-aliases-lib'

const options = parseArgs(process.argv.slice(2), process.env)
if (options.isErr()) {
  console.error(options.error.message)
  process.exit(1)
}

const result = await syncAliases(options.value, spawnRunner)
if (result.isErr()) {
  console.error(result.error.message)
  process.exit(1)
}
console.log(`  Disbursement aliases in sync (${result.value} configured)`)
