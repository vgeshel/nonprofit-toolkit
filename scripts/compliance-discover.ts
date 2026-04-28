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

const ok = report.runs.filter((r) => r.outcome === 'ok').length
const errs = report.runs.filter((r) => r.outcome === 'err').length
process.stdout.write(
  `compliance-discover: ok=${ok} err=${errs} findings=${report.findings.length}\n`,
)
for (const run of report.runs) {
  if (run.outcome === 'ok') {
    process.stdout.write(`  + ${run.sourceId} (${run.jurisdictionId})\n`)
  } else {
    process.stdout.write(
      `  ! ${run.sourceId} (${run.jurisdictionId}): ${run.error.type}: ${run.error.message}\n`,
    )
  }
}
for (const f of report.findings) {
  process.stdout.write(
    `  [${f.severity}] ${f.source_id}: ${f.title} — ${f.detail}\n`,
  )
}
process.exit(0)
