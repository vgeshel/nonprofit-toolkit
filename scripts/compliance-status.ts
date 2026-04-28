#!/usr/bin/env bun
import { Command } from 'commander'
import { z } from 'zod'
import { getComplianceStatusProduction } from '../src/compliance/skills/status-wiring.ts'
import { formatComplianceStatusReport } from '../src/compliance/skills/status.ts'

const OptionsSchema = z.object({
  projectId: z.string().min(1),
  json: z.boolean(),
})

const RawSchema = z.object({
  project: z.string(),
  json: z.boolean(),
})

const program = new Command()
  .name('compliance-status')
  .description(
    'Read stored compliance discovery state without running sources.',
  )
  .requiredOption('--project <id>', 'GCP project id')
  .option('--json', 'Print the full ComplianceStatusReport as JSON', false)
  .allowExcessArguments(false)

program.parse(process.argv)

const raw = RawSchema.parse(program.opts())
const opts = OptionsSchema.parse({
  projectId: raw.project,
  json: raw.json,
})

const result = await getComplianceStatusProduction({
  projectId: opts.projectId,
})

if (result.isErr()) {
  process.stderr.write(
    `compliance-status: ${result.error.type}: ${result.error.message}\n`,
  )
  process.exit(1)
}

const report = result.value
if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

process.stdout.write(formatComplianceStatusReport(report))
process.exit(0)
