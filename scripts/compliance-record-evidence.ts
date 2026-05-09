#!/usr/bin/env bun
/**
 * CLI entry point for recording user-provided compliance evidence.
 *
 * Reads a JSON object from stdin or `--evidence-file`, validates it against
 * the source's declared manual/authenticated evidence fields, and records a
 * successful discovery run. This intentionally records history in
 * `compliance.discovery_runs`; current-state views decide which old manual or
 * auth-required findings are no longer open.
 */
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { recordComplianceEvidenceProduction } from '../src/compliance/skills/record-evidence-wiring.ts'
import {
  ComplianceEvidenceInputSchema,
  type ComplianceEvidenceInput,
} from '../src/compliance/skills/record-evidence.ts'

const OptionsSchema = z.object({
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  evidenceFile: z.string().optional(),
  json: z.boolean(),
})

const RawSchema = z.object({
  project: z.string(),
  source: z.string(),
  evidenceFile: z.string().optional(),
  json: z.boolean(),
})

function readStdin(): string {
  return readFileSync(0, 'utf8')
}

const program = new Command()
  .name('compliance-record-evidence')
  .description('Record user-provided manual/authenticated compliance evidence.')
  .requiredOption('--project <id>', 'GCP project id')
  .requiredOption('--source <source-id>', 'Compliance source id')
  .option(
    '--evidence-file <path>',
    'JSON file with evidence fields (defaults to stdin)',
  )
  .option('--json', 'Print the structured recording report as JSON', false)
  .allowExcessArguments(false)

program.parse(process.argv)

const raw = RawSchema.parse(program.opts())
const opts = OptionsSchema.parse({
  projectId: raw.project,
  sourceId: raw.source,
  evidenceFile: raw.evidenceFile,
  json: raw.json,
})

const rawJson =
  opts.evidenceFile === undefined
    ? readStdin()
    : readFileSync(opts.evidenceFile, 'utf8')

const parsedJson: unknown = JSON.parse(rawJson)
const evidence =
  parsedJson !== null &&
  typeof parsedJson === 'object' &&
  'evidence' in parsedJson
    ? parsedJson
    : { evidence: parsedJson }

const input: ComplianceEvidenceInput = ComplianceEvidenceInputSchema.parse({
  sourceId: opts.sourceId,
  ...evidence,
})

const result = await recordComplianceEvidenceProduction({
  projectId: opts.projectId,
  input,
})

if (result.isErr()) {
  process.stderr.write(
    `compliance-record-evidence: ${result.error.type}: ${result.error.message}\n`,
  )
  process.exit(1)
}

if (opts.json) {
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
  process.exit(0)
}

process.stdout.write(
  `compliance-record-evidence: ok source=${result.value.sourceId} ` +
    `run_id=${result.value.runId} findings=${result.value.findings.length}\n`,
)
process.exit(0)
