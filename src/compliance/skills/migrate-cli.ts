/**
 * Entry-point glue for the compliance-migrate CLI.
 *
 * `runCli` is the single function `scripts/compliance-migrate.ts` calls. It
 * takes everything `main` needs (argv, stdout/stderr, exit, BQ factory,
 * port factory) as inputs, so tests inject fakes and exercise every branch
 * without spawning a child process.
 */
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { TableSchemaField } from '../state/bq-rows.ts'
import {
  parseMigrationArgs,
  runMigration,
  type ComplianceMigrationPort,
  type CreateTableRequest,
  type MigrationPortError,
} from './migrate.ts'

/**
 * Minimal surface we need from a `BigQuery` instance — defined here so the
 * CLI tests don't pull in a real BigQuery client.
 */
export interface BqDataset {
  exists(): Promise<unknown>
  createTable(
    tableId: string,
    options: {
      schema: { fields: readonly TableSchemaField[] }
      description: string
    },
  ): Promise<unknown>
  table(tableId: string): {
    exists(): Promise<unknown>
  }
}

export interface BqClient {
  dataset(name: string): BqDataset
  createDataset(name: string): Promise<unknown>
}

/**
 * I/O ports the runner uses. Exposed so tests can inject fakes.
 */
export interface CliIo {
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
  readonly exit: (code: number) => void
}

/**
 * Wiring.
 */
export interface RunCliArgs {
  readonly argv: readonly string[]
  readonly io: CliIo
  readonly bqFactory: (projectId: string) => BqClient
}

/**
 * BigQuery's `dataset.exists()` returns `[boolean]`. Validate that shape so
 * we know we're getting a typed boolean.
 */
const ExistsTupleSchema = z.tuple([z.boolean()])

export function parseExists(value: unknown): boolean {
  const parsed = ExistsTupleSchema.safeParse(value)
  if (!parsed.success) {
    return false
  }
  return parsed.data[0]
}

/**
 * Translate a thrown SDK value into a typed `MigrationPortError`.
 */
export function toPortError(err: unknown): MigrationPortError {
  if (err instanceof Error) {
    return { type: 'sdk', message: err.message }
  }
  return { type: 'sdk', message: String(err) }
}

/**
 * Build a `ComplianceMigrationPort` backed by a real `BigQuery` client.
 */
export function makeBqPort(bq: BqClient): ComplianceMigrationPort {
  return {
    datasetExists(name) {
      return ResultAsync.fromPromise(
        bq.dataset(name).exists(),
        toPortError,
      ).map(parseExists)
    },
    createDataset(name) {
      return ResultAsync.fromPromise(bq.createDataset(name), toPortError).map(
        () => undefined,
      )
    },
    tableExists({ dataset, tableId }) {
      return ResultAsync.fromPromise(
        bq.dataset(dataset).table(tableId).exists(),
        toPortError,
      ).map(parseExists)
    },
    createTable(req: CreateTableRequest) {
      return ResultAsync.fromPromise(
        bq.dataset(req.dataset).createTable(req.tableId, {
          schema: { fields: [...req.schema.fields] },
          description: req.description,
        }),
        toPortError,
      ).map(() => undefined)
    },
  }
}

/**
 * Run the CLI.
 *
 * Always returns; never throws. Exit codes:
 *   0 — success
 *   1 — runtime error (BigQuery permission, transient failure, etc.)
 *   2 — argument parse / validation error
 */
export async function runCli(args: RunCliArgs): Promise<void> {
  const parsed = parseMigrationArgs(args.argv)
  if (parsed.isErr()) {
    args.io.stderr(`compliance-migrate: ${parsed.error.message}\n`)
    args.io.exit(2)
    return
  }
  const opts = parsed.value

  const bq = args.bqFactory(opts.projectId)
  const port = makeBqPort(bq)

  const result = await runMigration({
    port,
    dryRun: opts.dryRun,
  })
  if (result.isErr()) {
    args.io.stderr(
      `compliance-migrate: ${result.error.type}: ${result.error.message}\n`,
    )
    args.io.exit(1)
    return
  }

  const r = result.value
  args.io.stdout(
    `compliance-migrate: dataset=${r.createdDataset ? 'created' : 'present'} ` +
      `created_tables=${r.createdTables.length} ` +
      `skipped_tables=${r.skippedTables.length}` +
      (opts.dryRun ? ' (dry-run)' : '') +
      '\n',
  )
  args.io.exit(0)
}
