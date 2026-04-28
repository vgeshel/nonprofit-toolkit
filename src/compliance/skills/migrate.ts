/**
 * Migration logic for the compliance dataset and its four tables.
 *
 * The CLI script in `scripts/compliance-migrate.ts` is a thin wrapper that
 * imports and calls `runCli` from this module's sibling
 * `migrate-cli.ts`. This module owns the orchestration logic only and is
 * fully port-driven, so its tests don't need a real BigQuery.
 */
import { Command } from 'commander'
import {
  type Result,
  ResultAsync,
  err,
  errAsync,
  ok,
  okAsync,
} from 'neverthrow'
import { z } from 'zod'
import {
  COMPLIANCE_DATASET,
  COMPLIANCE_TABLES,
  type TableSchemaField,
} from '../state/bq-rows.ts'

/**
 * One BigQuery operation the migration needs.
 */
export interface MigrationPortError {
  readonly type: string
  readonly message: string
}

/**
 * Arguments to `createTable`. The schema field is the same shape BigQuery's
 * `createTable` expects: `{ fields: [{ name, type, mode }] }`.
 */
export interface CreateTableRequest {
  readonly dataset: string
  readonly tableId: string
  readonly schema: { fields: readonly TableSchemaField[] }
  readonly description: string
}

/**
 * Port abstracting just the BigQuery operations we need. The production
 * adapter lives in `scripts/compliance-migrate.ts` and wraps the real
 * `BigQuery` client; tests inject a `vi.fn()`-based fake.
 */
export interface ComplianceMigrationPort {
  datasetExists(name: string): ResultAsync<boolean, MigrationPortError>
  createDataset(name: string): ResultAsync<void, MigrationPortError>
  tableExists(args: {
    dataset: string
    tableId: string
  }): ResultAsync<boolean, MigrationPortError>
  createTable(req: CreateTableRequest): ResultAsync<void, MigrationPortError>
}

/**
 * Migration outcome.
 */
export interface MigrationReport {
  readonly createdDataset: boolean
  readonly createdTables: readonly string[]
  readonly skippedTables: readonly string[]
}

/**
 * Wiring.
 */
export interface RunMigrationArgs {
  readonly port: ComplianceMigrationPort
  readonly dryRun: boolean
}

/**
 * Run the migration.
 */
export function runMigration(
  args: RunMigrationArgs,
): ResultAsync<MigrationReport, MigrationPortError> {
  return args.port
    .datasetExists(COMPLIANCE_DATASET)
    .andThen<MigrationReport, MigrationPortError>((datasetPresent) => {
      const datasetWork: ResultAsync<boolean, MigrationPortError> =
        datasetPresent
          ? okAsync(false)
          : args.dryRun
            ? okAsync(true)
            : args.port.createDataset(COMPLIANCE_DATASET).map(() => true)

      return datasetWork.andThen((createdDataset) =>
        ensureAllTables(args).map((tableReport) => ({
          createdDataset,
          createdTables: tableReport.created,
          skippedTables: tableReport.skipped,
        })),
      )
    })
}

interface TableEnsureReport {
  readonly created: readonly string[]
  readonly skipped: readonly string[]
}

type TableOutcome =
  | { kind: 'ok'; name: string; outcome: 'created' | 'skipped' }
  | { kind: 'err'; error: MigrationPortError }

function ensureAllTables(
  args: RunMigrationArgs,
): ResultAsync<TableEnsureReport, MigrationPortError> {
  const promises: Promise<TableOutcome>[] = []
  for (const def of COMPLIANCE_TABLES) {
    const ensure: Promise<TableOutcome> = args.port
      .tableExists({ dataset: COMPLIANCE_DATASET, tableId: def.name })
      .andThen<'created' | 'skipped', MigrationPortError>((exists) => {
        if (exists) {
          return okAsync('skipped')
        }
        if (args.dryRun) {
          return okAsync('created')
        }
        return args.port
          .createTable({
            dataset: COMPLIANCE_DATASET,
            tableId: def.name,
            schema: { fields: def.fields },
            description: def.description,
          })
          .map(() => 'created')
      })
      .match(
        (outcome): TableOutcome => ({ kind: 'ok', name: def.name, outcome }),
        (error): TableOutcome => ({ kind: 'err', error }),
      )
    promises.push(ensure)
  }

  return ResultAsync.fromSafePromise(Promise.all(promises)).andThen<
    TableEnsureReport,
    MigrationPortError
  >((results) => {
    const created: string[] = []
    const skipped: string[] = []
    for (const r of results) {
      if (r.kind === 'err') {
        return errAsync(r.error)
      }
      if (r.outcome === 'created') {
        created.push(r.name)
      } else {
        skipped.push(r.name)
      }
    }
    return okAsync({ created, skipped })
  })
}

/**
 * Parsed CLI options for the migration command.
 */
export const MigrationOptionsSchema = z.object({
  projectId: z.string().min(1),
  dryRun: z.boolean(),
})

export type MigrationOptions = z.infer<typeof MigrationOptionsSchema>

/**
 * CLI parse error.
 */
export type CliError =
  | { type: 'parse'; message: string }
  | { type: 'validation'; message: string }

/**
 * Raw shape commander emits. We only consume two fields (`project`,
 * `dryRun`); commander returns a `Record<string, unknown>` for opts.
 */
const RawSchema = z.object({
  project: z.string(),
  dryRun: z.boolean(),
})

/**
 * Render a thrown commander error as a string. Centralised so the
 * `instanceof Error` discriminator is in one place that can be exercised
 * from tests directly.
 */
export function describeParseFailure(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

/**
 * Parse migration CLI args. Uses `commander` for argument parsing and Zod
 * for the runtime shape — the project-wide pattern from `apps/runner`.
 *
 * Suppresses commander's stdout/stderr writes via `configureOutput` so the
 * caller can decide what to surface to the user.
 */
export function parseMigrationArgs(
  args: readonly string[],
): Result<MigrationOptions, CliError> {
  const noop = (): void => undefined
  const program = new Command()
    .name('compliance-migrate')
    .description('Create the compliance dataset and tables in BigQuery')
    .requiredOption('--project <id>', 'GCP project id')
    .option('--dry-run', 'Plan only; do not call BigQuery write APIs', false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeOut: noop, writeErr: noop })

  try {
    program.parse([...args], { from: 'user' })
  } catch (caught) {
    return err({ type: 'parse', message: describeParseFailure(caught) })
  }

  const rawValidation = RawSchema.safeParse(program.opts())
  if (!rawValidation.success) {
    return err({ type: 'validation', message: rawValidation.error.message })
  }

  const validation = MigrationOptionsSchema.safeParse({
    projectId: rawValidation.data.project,
    dryRun: rawValidation.data.dryRun,
  })
  if (!validation.success) {
    return err({ type: 'validation', message: validation.error.message })
  }
  return ok(validation.data)
}
