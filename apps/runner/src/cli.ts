/**
 * CLI interface for the ETL runner.
 *
 * Uses Commander for argument parsing and Zod for validation.
 */
import { SourceEnum, type Source } from '@donations-etl/types'
import { Command } from 'commander'
import { err, ok, type Result } from 'neverthrow'
import { z } from 'zod'

/**
 * CLI error.
 */
export interface CliError {
  type: 'parse' | 'validation'
  message: string
}

/**
 * Create a CLI error.
 */
function createError(type: CliError['type'], message: string): CliError {
  return { type, message }
}

/**
 * Parse a comma-separated source list.
 *
 * Uses the canonical SourceEnum from @donations-etl/types so the CLI
 * automatically picks up new sources without local duplication.
 */
function parseSourceList(value: string): Result<Source[], CliError> {
  const sources = value.split(',').map((s) => s.trim().toLowerCase())

  const validatedSources: Source[] = []
  for (const source of sources) {
    const result = SourceEnum.safeParse(source)
    if (!result.success) {
      return err(
        createError(
          'validation',
          `Invalid source: ${source}. Valid sources: ${SourceEnum.options.join(', ')}`,
        ),
      )
    }
    validatedSources.push(result.data)
  }

  return ok(validatedSources)
}

/**
 * Daily options schema.
 */
export const DailyOptionsSchema = z
  .object({
    sources: z.array(SourceEnum).optional(),
    skipMerge: z.boolean().optional(),
    mergeOnly: z.boolean().optional(),
    funraiseCsv: z.string().optional(),
    venmoDir: z.string().optional(),
  })
  .refine((data) => !(data.skipMerge && data.mergeOnly), {
    message: 'Cannot use --skip-merge and --merge-only together',
  })

export type DailyOptions = z.infer<typeof DailyOptionsSchema>

/**
 * Backfill options schema.
 *
 * When --merge-only is set, --from and --to are optional since we're just
 * merging existing staging data without extracting new data.
 */
export const BackfillOptionsSchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format')
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format')
      .optional(),
    chunk: z.enum(['day', 'week', 'month']).default('month'),
    sources: z.array(SourceEnum).optional(),
    skipMerge: z.boolean().optional(),
    mergeOnly: z.boolean().optional(),
    funraiseCsv: z.string().optional(),
    venmoDir: z.string().optional(),
  })
  .refine((data) => !(data.skipMerge && data.mergeOnly), {
    message: 'Cannot use --skip-merge and --merge-only together',
  })
  .refine(
    (data) => {
      if (data.mergeOnly) return true
      return data.from != null && data.to != null
    },
    {
      message: '--from and --to are required unless using --merge-only',
    },
  )

export type BackfillOptions = z.infer<typeof BackfillOptionsSchema>

/**
 * Report options schema.
 */
export const ReportOptionsSchema = z.object({
  period: z.enum(['weekly', 'monthly']),
})

export type ReportOptions = z.infer<typeof ReportOptionsSchema>

/**
 * Parsed CLI result.
 */
export type CliCommand =
  | { command: 'daily'; options: DailyOptions }
  | { command: 'backfill'; options: BackfillOptions }
  | { command: 'health' }
  | { command: 'report'; options: ReportOptions }

/**
 * Noop action handler - Commander requires an action but we handle commands manually in parseCli.
 * @remarks This function is never invoked at runtime - commands are processed by parseCli.
 * Exported for testing to achieve 100% function coverage.
 */
export const noop = (): void => {
  /* intentionally empty */
}

/**
 * Create the CLI program (for help and version display).
 */
export function createCli(): Command {
  const program = new Command()
    .name('donations-etl')
    .description('Donations ETL runner')
    .version('1.0.0')

  program
    .command('daily')
    .description('Run daily ETL')
    .option(
      '--sources <sources>',
      'Comma-separated sources (mercury,paypal,givebutter,check_deposits,funraise,venmo,wise)',
    )
    .option('--skip-merge', 'Extract and load to staging, skip merge to final')
    .option('--merge-only', 'Only run merge from staging to final table')
    .option('--funraise-csv <path>', 'Path to Funraise CSV export file')
    .option(
      '--venmo-dir <path>',
      'Path to directory containing Venmo CSV exports',
    )
    .action(noop)

  program
    .command('backfill')
    .description('Backfill historical data')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--chunk <size>', 'Chunk size (day|week|month)', 'month')
    .option('--sources <sources>', 'Comma-separated sources')
    .option('--skip-merge', 'Extract and load to staging, skip merge to final')
    .option('--merge-only', 'Only run merge from staging to final table')
    .option('--funraise-csv <path>', 'Path to Funraise CSV export file')
    .option(
      '--venmo-dir <path>',
      'Path to directory containing Venmo CSV exports',
    )
    .action(noop)

  program
    .command('health')
    .description('Check connector and BigQuery health')
    .action(noop)

  program
    .command('report')
    .description('Generate and send donation report to Slack')
    .requiredOption('--period <period>', 'Report period (weekly|monthly)')
    .action(noop)

  return program
}

/**
 * Raw Commander options schema for the daily command.
 * Commander returns strings for value options and booleans for flag options.
 */
const RawDailyOptsSchema = z.object({
  sources: z.string().optional(),
  skipMerge: z.boolean().optional(),
  mergeOnly: z.boolean().optional(),
  funraiseCsv: z.string().optional(),
  venmoDir: z.string().optional(),
})

/**
 * Raw Commander options schema for the report command.
 */
const RawReportOptsSchema = z.object({
  period: z.string(),
})

/**
 * Raw Commander options schema for the backfill command.
 */
const RawBackfillOptsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  chunk: z.string().optional(),
  sources: z.string().optional(),
  skipMerge: z.boolean().optional(),
  mergeOnly: z.boolean().optional(),
  funraiseCsv: z.string().optional(),
  venmoDir: z.string().optional(),
})

/**
 * Parse CLI arguments and return structured command.
 */
export function parseCli(args: string[]): Result<CliCommand, CliError> {
  const program = createCli()

  // Disable exit on error for programmatic parsing
  program.exitOverride()
  // Suppress Commander's console output - both callbacks do nothing
  program.configureOutput({
    writeErr: noop,
    writeOut: noop,
  })

  // Parse arguments
  try {
    program.parse(args, { from: 'user' })
  } catch {
    // Commander throws on invalid usage
    return err(
      createError(
        'parse',
        'Failed to parse command line arguments. Use --help for usage.',
      ),
    )
  }

  const commandName = program.args[0]
  const command = program.commands.find((c) => c.name() === commandName)

  /* istanbul ignore next -- @preserve */
  if (!command) {
    return err(createError('parse', `Unknown command: ${commandName}`))
  }

  switch (commandName) {
    case 'daily': {
      const opts = RawDailyOptsSchema.parse(command.opts())

      // Parse sources if provided
      let sources: Source[] | undefined
      if (opts.sources) {
        const sourcesResult = parseSourceList(opts.sources)
        if (sourcesResult.isErr()) {
          return err(sourcesResult.error)
        }
        sources = sourcesResult.value
      }

      const parseResult = DailyOptionsSchema.safeParse({
        sources,
        skipMerge: opts.skipMerge,
        mergeOnly: opts.mergeOnly,
        funraiseCsv: opts.funraiseCsv,
        venmoDir: opts.venmoDir,
      })
      if (!parseResult.success) {
        return err(createError('validation', parseResult.error.message))
      }

      return ok({ command: 'daily', options: parseResult.data })
    }

    case 'backfill': {
      const opts = RawBackfillOptsSchema.parse(command.opts())

      // Parse sources if provided
      let sources: Source[] | undefined
      if (opts.sources) {
        const sourcesResult = parseSourceList(opts.sources)
        if (sourcesResult.isErr()) {
          return err(sourcesResult.error)
        }
        sources = sourcesResult.value
      }

      const parseResult = BackfillOptionsSchema.safeParse({
        from: opts.from,
        to: opts.to,
        chunk: opts.chunk,
        sources,
        skipMerge: opts.skipMerge,
        mergeOnly: opts.mergeOnly,
        funraiseCsv: opts.funraiseCsv,
        venmoDir: opts.venmoDir,
      })
      if (!parseResult.success) {
        return err(createError('validation', parseResult.error.message))
      }

      return ok({ command: 'backfill', options: parseResult.data })
    }

    case 'health':
      return ok({ command: 'health' })

    case 'report': {
      const opts = RawReportOptsSchema.parse(command.opts())
      const parseResult = ReportOptionsSchema.safeParse({
        period: opts.period,
      })
      if (!parseResult.success) {
        return err(createError('validation', parseResult.error.message))
      }
      return ok({ command: 'report', options: parseResult.data })
    }

    /* istanbul ignore next -- @preserve defensive: all known commands handled above, unknown commands rejected earlier */
    default:
      return err(createError('parse', `Unknown command: ${commandName}`))
  }
}
