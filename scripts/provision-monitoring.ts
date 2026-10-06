#!/usr/bin/env bun
/**
 * Ensure Cloud Monitoring alert policies and route them to Slack.
 *
 * Usage: bun scripts/provision-monitoring.ts --project <id> [--slack-channel <name>]
 *
 * Called by infra/provision.sh. All logic lives in monitoring-lib.ts.
 */
import { execFileSync } from 'node:child_process'
import { describeSummary, ensureMonitoring, parseArgs } from './monitoring-lib'

const options = parseArgs(process.argv.slice(2))
if (options.isErr()) {
  console.error(options.error.message)
  process.exit(1)
}

// Same credentials as the gcloud calls in provision.sh.
const accessToken = execFileSync('gcloud', ['auth', 'print-access-token'], {
  encoding: 'utf8',
}).trim()

const result = await ensureMonitoring(options.value, { fetch, accessToken })
if (result.isErr()) {
  console.error(`Monitoring provisioning failed: ${result.error.message}`)
  process.exit(1)
}

for (const line of describeSummary(result.value, options.value.slackChannel)) {
  console.log(`  ${line}`)
}
