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
  COMPLIANCE_VIEWS,
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
 * One additive schema change for an existing table.
 */
export interface AddTableColumnRequest {
  readonly dataset: string
  readonly tableId: string
  readonly field: TableSchemaField
}

/**
 * Read-only column-existence check for idempotent additive migrations.
 */
export interface TableColumnExistsRequest {
  readonly dataset: string
  readonly tableId: string
  readonly columnName: string
}

/**
 * Create-or-replace request for one managed BigQuery view.
 */
export interface CreateOrReplaceViewRequest {
  readonly dataset: string
  readonly viewId: string
  readonly query: string
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
  addTableColumn(
    req: AddTableColumnRequest,
  ): ResultAsync<void, MigrationPortError>
  createOrReplaceView(
    req: CreateOrReplaceViewRequest,
  ): ResultAsync<void, MigrationPortError>
  tableColumnExists(
    req: TableColumnExistsRequest,
  ): ResultAsync<boolean, MigrationPortError>
}

/**
 * Migration outcome.
 */
export interface MigrationReport {
  readonly createdDataset: boolean
  readonly createdTables: readonly string[]
  readonly skippedTables: readonly string[]
  readonly addedColumns: readonly string[]
  readonly updatedViews: readonly string[]
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
        ensureAllTables(args).andThen((tableReport) =>
          ensureAllViews(args).map((updatedViews) => ({
            createdDataset,
            createdTables: tableReport.created,
            skippedTables: tableReport.skipped,
            addedColumns: tableReport.addedColumns,
            updatedViews,
          })),
        ),
      )
    })
}

interface TableEnsureReport {
  readonly created: readonly string[]
  readonly skipped: readonly string[]
  readonly addedColumns: readonly string[]
}

type TableOutcome =
  | {
      kind: 'ok'
      name: string
      outcome: 'created' | 'skipped'
      addedColumns: readonly string[]
    }
  | { kind: 'err'; error: MigrationPortError }

const SOURCE_POLICY_UPGRADE_FIELDS: readonly TableSchemaField[] = [
  { name: 'access_url', type: 'STRING', mode: 'NULLABLE' },
  { name: 'access_method', type: 'STRING', mode: 'NULLABLE' },
  { name: 'automation_allowed', type: 'BOOL', mode: 'NULLABLE' },
  { name: 'manual_only_reason', type: 'STRING', mode: 'NULLABLE' },
  { name: 'source_freshness', type: 'JSON', mode: 'NULLABLE' },
]

function ensureAllTables(
  args: RunMigrationArgs,
): ResultAsync<TableEnsureReport, MigrationPortError> {
  const promises: Promise<TableOutcome>[] = []
  for (const def of COMPLIANCE_TABLES) {
    const ensure: Promise<TableOutcome> = args.port
      .tableExists({ dataset: COMPLIANCE_DATASET, tableId: def.name })
      .andThen<TableOutcome, MigrationPortError>((exists) => {
        if (exists) {
          return ensureSchemaUpgradeColumns(args, def.name).map(
            (addedColumns): TableOutcome => ({
              kind: 'ok',
              name: def.name,
              outcome: 'skipped',
              addedColumns,
            }),
          )
        }
        if (args.dryRun) {
          return okAsync({
            kind: 'ok',
            name: def.name,
            outcome: 'created',
            addedColumns: [],
          })
        }
        return args.port
          .createTable({
            dataset: COMPLIANCE_DATASET,
            tableId: def.name,
            schema: { fields: def.fields },
            description: def.description,
          })
          .map(
            (): TableOutcome => ({
              kind: 'ok',
              name: def.name,
              outcome: 'created',
              addedColumns: [],
            }),
          )
      })
      .match(
        (outcome): TableOutcome => outcome,
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
    const addedColumns: string[] = []
    for (const r of results) {
      if (r.kind === 'err') {
        return errAsync(r.error)
      }
      if (r.outcome === 'created') {
        created.push(r.name)
      } else {
        skipped.push(r.name)
      }
      addedColumns.push(...r.addedColumns)
    }
    return okAsync({ created, skipped, addedColumns })
  })
}

function ensureSchemaUpgradeColumns(
  args: RunMigrationArgs,
  tableId: string,
): ResultAsync<readonly string[], MigrationPortError> {
  const fields = schemaUpgradeFieldsForTable(tableId)
  if (fields.length === 0) {
    return okAsync([])
  }
  if (args.dryRun) {
    return okAsync(fields.map((field) => `${tableId}.${field.name}`))
  }

  return ResultAsync.combine(
    fields.map((field) => ensureSchemaUpgradeColumn(args, tableId, field)),
  ).map((addedColumns) =>
    addedColumns.filter((column): column is string => column !== null),
  )
}

function schemaUpgradeFieldsForTable(
  tableId: string,
): readonly TableSchemaField[] {
  return tableId === 'sources' ? SOURCE_POLICY_UPGRADE_FIELDS : []
}

function ensureSchemaUpgradeColumn(
  args: RunMigrationArgs,
  tableId: string,
  field: TableSchemaField,
): ResultAsync<string | null, MigrationPortError> {
  const columnName = `${tableId}.${field.name}`
  const existsResult = args.port.tableColumnExists({
    dataset: COMPLIANCE_DATASET,
    tableId,
    columnName: field.name,
  })

  return existsResult.andThen((exists) => {
    if (exists) {
      return okAsync(null)
    }
    return args.port
      .addTableColumn({
        dataset: COMPLIANCE_DATASET,
        tableId,
        field,
      })
      .map(() => columnName)
  })
}

function ensureAllViews(
  args: RunMigrationArgs,
): ResultAsync<readonly string[], MigrationPortError> {
  if (args.dryRun) {
    return okAsync(COMPLIANCE_VIEWS.map((view) => view.name))
  }
  return ResultAsync.combine(
    COMPLIANCE_VIEWS.map((view) =>
      args.port
        .createOrReplaceView({
          dataset: COMPLIANCE_DATASET,
          viewId: view.name,
          query: view.query,
          description: view.description,
        })
        .map(() => view.name),
    ),
  )
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
