#!/usr/bin/env bun
/**
 * Create or update a Secret Manager secret without ever blanking it.
 *
 * Usage: VALUE=... bun scripts/ensure-secret.ts --project <id> --name <secret> --from-env VALUE
 *
 * Called by the deploy scripts. All logic lives in secret-lib.ts.
 */
import { spawnRunner } from './command-runner'
import { ensureSecret, parseArgs } from './secret-lib'

const options = parseArgs(process.argv.slice(2), process.env)
if (options.isErr()) {
  console.error(options.error.message)
  process.exit(1)
}

const result = await ensureSecret(options.value, spawnRunner)
if (result.isErr()) {
  console.error(result.error.message)
  process.exit(1)
}
console.log(`  ${options.value.name} — ${result.value}`)
