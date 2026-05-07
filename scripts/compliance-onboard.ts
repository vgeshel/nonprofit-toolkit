#!/usr/bin/env bun
/**
 * CLI entry point for the `compliance-onboard` skill.
 *
 * Reads onboarding answers as JSON (from stdin or `--answers-file`), then
 * calls `runOnboardingProduction` with default GCP factories. Prints a
 * one-line summary on success or a typed error on failure.
 *
 * Usage:
 *   bun scripts/compliance-onboard.ts --project <id> [--answers-file <path>]
 *   echo '{...}' | bun scripts/compliance-onboard.ts --project <id>
 *
 * The orchestration logic lives in
 * `src/compliance/skills/onboard-wiring.ts` and is unit-tested there. This
 * file is a deliberately tiny adapter: a few lines of glue. Tests do not
 * import this file (the testable surface is `runOnboardingProduction`), so
 * it does not appear in coverage measurement.
 */
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { runOnboardingProduction } from '../src/compliance/skills/onboard-wiring.ts'

const OptionsSchema = z.object({
  projectId: z.string().min(1),
  answersFile: z.string().optional(),
})

const RawSchema = z.object({
  project: z.string(),
  answersFile: z.string().optional(),
})

const AnswersSchema = z.object({
  legalName: z.string(),
  ein: z.string(),
  stateOfIncorporation: z.string(),
  caSosEntityNumber: z.string(),
  caAgCharityNumber: z.string().nullable(),
  caFtbEntityId: z.string().nullable().optional(),
  caFtbEntityName: z.string().nullable().optional(),
  cdtfaSellerPermitNumber: z.string().nullable().optional(),
  cdtfaUseTaxAccountNumber: z.string().nullable().optional(),
  cdtfaSpecialTaxAccountNumber: z.string().nullable().optional(),
  fiscalYearEndMonth: z.number(),
  fiscalYearEndDay: z.number(),
  formationDate: z.string(),
  mailingAddressLine1: z.string(),
  mailingAddressLine2: z.string().nullable(),
  mailingAddressCity: z.string(),
  mailingAddressRegion: z.string(),
  mailingAddressPostalCode: z.string(),
  mailingAddressCountry: z.string(),
})

function readStdin(): string {
  return readFileSync(0, 'utf8')
}

const program = new Command()
  .name('compliance-onboard')
  .description(
    'Persist nonprofit identity (entity IDs + entity row) for compliance.',
  )
  .requiredOption('--project <id>', 'GCP project id')
  .option(
    '--answers-file <path>',
    'JSON file with the answer bundle (defaults to stdin)',
  )
  .allowExcessArguments(false)

program.parse(process.argv)

const opts = OptionsSchema.parse({
  projectId: RawSchema.parse(program.opts()).project,
  answersFile: RawSchema.parse(program.opts()).answersFile,
})

const rawJson =
  opts.answersFile === undefined
    ? readStdin()
    : readFileSync(opts.answersFile, 'utf8')

const answers = AnswersSchema.parse(JSON.parse(rawJson))

const result = await runOnboardingProduction({
  projectId: opts.projectId,
  answers,
})

if (result.isErr()) {
  process.stderr.write(
    `compliance-onboard: ${result.error.type}: ${result.error.message}\n`,
  )
  process.exit(1)
}

const summary = result.value
process.stdout.write(
  `compliance-onboard: ok legal_name=${JSON.stringify(summary.legalName)} ` +
    `migration=dataset=${summary.migration.createdDataset ? 'created' : 'present'} ` +
    `created_tables=${summary.migration.createdTables.length}\n`,
)
process.exit(0)
