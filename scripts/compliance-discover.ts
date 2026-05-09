#!/usr/bin/env bun
/**
 * CLI entry point for the `compliance-discover` skill.
 *
 * Calls `runDiscoveryProduction` with default GCP factories and prints a
 * compact human-readable summary of the run + findings. The full structured
 * report is also printed as JSON when `--json` is passed.
 *
 * Usage:
 *   bun scripts/compliance-discover.ts --project <id> [--json]
 *
 * The orchestration logic lives in
 * `src/compliance/skills/discover-wiring.ts` and is unit-tested there. This
 * file is a deliberately tiny adapter: a few lines of glue. Tests do not
 * import this file (the testable surface is `runDiscoveryProduction`), so
 * it does not appear in coverage measurement.
 */
import { Command } from 'commander'
import { z } from 'zod'
import { formatDiscoveryReport } from '../src/compliance/skills/discover-report.ts'
import { runDiscoveryProduction } from '../src/compliance/skills/discover-wiring.ts'

const OptionsSchema = z.object({
  projectId: z.string().min(1),
  json: z.boolean(),
})

const RawSchema = z.object({
  project: z.string(),
  json: z.boolean(),
})

const program = new Command()
  .name('compliance-discover')
  .description('Run compliance discovery sources and report findings.')
  .requiredOption('--project <id>', 'GCP project id')
  .option('--json', 'Print the full DiscoveryReport as JSON', false)
  .allowExcessArguments(false)

program.parse(process.argv)

const opts = OptionsSchema.parse({
  projectId: RawSchema.parse(program.opts()).project,
  json: RawSchema.parse(program.opts()).json,
})

const result = await runDiscoveryProduction({
  projectId: opts.projectId,
})

if (result.isErr()) {
  process.stderr.write(
    `compliance-discover: ${result.error.type}: ${result.error.message}\n`,
  )
  process.exit(1)
}

const report = result.value
if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

process.stdout.write(formatDiscoveryReport(report))
process.exit(0)
