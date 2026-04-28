/**
 * Make-the-compliance-schema-exist helper.
 *
 * Per the project-wide rule that skills automate their own prerequisites,
 * every compliance skill calls this helper before running its own queries.
 * The compliance dataset and tables are created on-demand the first time a
 * skill runs in a fresh GCP project; subsequent runs are a no-op because the
 * underlying migration is idempotent.
 *
 * This is a thin façade over `runMigration` (in `../skills/migrate.ts`):
 *   - The dataset id is fixed to `COMPLIANCE_DATASET`.
 *   - Dry-run is always off — when a skill calls this, it intends to make the
 *     schema real, not plan it.
 *   - The returned `MigrationReport` is the same shape callers see from the
 *     CLI, so they can decide whether to chatter at the user.
 *
 * Errors are passed through verbatim (same `MigrationPortError` discriminated
 * union the CLI surfaces) so the caller's error-mapping logic does not have
 * to special-case ensure-vs-cli.
 */
import type { ResultAsync } from 'neverthrow'
import {
  runMigration,
  type ComplianceMigrationPort,
  type MigrationPortError,
  type MigrationReport,
} from '../skills/migrate.ts'

/**
 * Idempotently create the `compliance` dataset and its four tables if they
 * are missing. Caller passes a `ComplianceMigrationPort` (the same port the
 * CLI uses); production wiring builds one with `makeBqPort` from
 * `../skills/migrate-cli.ts`.
 *
 * On success, returns a `MigrationReport`. The report is silent on no-op
 * re-runs (`createdDataset: false`, `createdTables: []`); callers that want
 * to mention what happened should use `didCreateAnything` to decide whether
 * the report is worth printing.
 */
export function ensureComplianceSchema(
  port: ComplianceMigrationPort,
): ResultAsync<MigrationReport, MigrationPortError> {
  return runMigration({
    port,
    dryRun: false,
  })
}

/**
 * Did `ensureComplianceSchema` actually create anything?
 *
 * Skills use this to decide whether to print a "provisioned the compliance
 * schema" line to the user — silent on no-op re-runs is the rule, so this is
 * the only signal that should drive that chatter.
 */
export function didCreateAnything(report: MigrationReport): boolean {
  return report.createdDataset || report.createdTables.length > 0
}
