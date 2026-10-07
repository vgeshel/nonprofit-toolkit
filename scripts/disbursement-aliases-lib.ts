/**
 * Disbursement aliases: per-nonprofit config, synced into BigQuery.
 *
 * Disbursement deduplication drops a bank (Mercury) row once a platform's own
 * donor-level data covers that period. It matches the bank description against
 * `source_coverage.description_pattern`, falling back to the source name. A
 * platform that pays out under another name — a donor-advised fund, a payout
 * entity — needs that name registered, and how it appears in a bank
 * description depends on the nonprofit's bank. So the aliases are config
 * (DISBURSEMENT_ALIASES in .env), never code:
 *
 *   DISBURSEMENT_ALIASES="benevity=<descriptor prefix>;benevity=<another>"
 *
 * Provisioning makes the alias rows in source_coverage match the config
 * exactly: missing aliases are added, unconfigured ones removed. A new alias
 * starts covering from its source's first succeeded donation; with no donations
 * yet it starts in the far future (covers nothing) until the job's coverage
 * refresh sets the real start.
 */
import { SourceEnum, type Source } from '@donations-etl/types'
import { Command } from 'commander'
import { Result, ResultAsync, err, errAsync, ok, okAsync } from 'neverthrow'
import { z } from 'zod'
import type { CommandRunner } from './command-runner'
import { describeParseError } from './secret-lib'

export type { CommandRunner }

export interface Alias {
  source: Exclude<Source, 'mercury'>
  /** Lowercased bank description prefix, matched before the first ';'. */
  pattern: string
}

export interface AliasError {
  type: 'config' | 'bq' | 'usage'
  message: string
}

/**
 * Descriptor characters allowed in the SQL string literal. Excludes quotes and
 * backslashes, so the literal can never be broken out of.
 */
const SAFE_PATTERN = /^[a-z0-9][a-z0-9 .&\-/*]*$/

function configError(entry: string, reason: string): AliasError {
  return {
    type: 'config',
    message: `DISBURSEMENT_ALIASES entry "${entry}": ${reason}`,
  }
}

function parseEntry(entry: string): Result<Alias, AliasError> {
  const separator = entry.indexOf('=')
  if (separator === -1) {
    return err({
      type: 'config',
      message: `DISBURSEMENT_ALIASES entry "${entry}" must look like source=bank descriptor prefix`,
    })
  }

  const sourceName = entry.slice(0, separator).trim()
  const pattern = entry
    .slice(separator + 1)
    .trim()
    .toLowerCase()

  const source = SourceEnum.safeParse(sourceName)
  if (!source.success) {
    return err(configError(entry, `unknown source "${sourceName}"`))
  }
  if (source.data === 'mercury') {
    return err(configError(entry, 'mercury is the bank, not a platform'))
  }
  if (!SAFE_PATTERN.test(pattern)) {
    return err(
      configError(
        entry,
        'the descriptor may only contain letters, digits, spaces and . & - / *',
      ),
    )
  }
  return ok({ source: source.data, pattern })
}

/**
 * Parse `source=pattern;source=pattern`. Unset or blank means no aliases.
 */
export function parseAliases(
  value: string | undefined,
): Result<Alias[], AliasError> {
  const entries = (value ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  return Result.combine(entries.map(parseEntry)).map((aliases) => {
    const seen = new Set<string>()
    return aliases.filter((alias) => {
      const key = `${alias.source}=${alias.pattern}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
}

/**
 * MERGE that makes the alias rows in source_coverage equal the config.
 * Rows without a pattern (one per source, maintained by the job) are untouched.
 */
export function buildSyncAliasesSql(
  aliases: Alias[],
  datasets: { datasetRaw: string; datasetCanon: string },
): string {
  const rows = aliases
    .map((alias) => `('${alias.source}', '${alias.pattern}')`)
    .join(', ')

  return `MERGE \`${datasets.datasetRaw}.source_coverage\` AS target
USING (
  SELECT a.source, a.pattern AS description_pattern,
    COALESCE(earliest.first_ts, TIMESTAMP '9999-12-31 00:00:00 UTC') AS covers_from
  FROM UNNEST(ARRAY<STRUCT<source STRING, pattern STRING>>[${rows}]) AS a
  LEFT JOIN (
    SELECT source, MIN(event_ts) AS first_ts
    FROM \`${datasets.datasetCanon}.events\`
    WHERE status = 'succeeded'
    GROUP BY source
  ) AS earliest
  ON earliest.source = a.source
) AS src
ON target.source = src.source
  AND target.description_pattern = src.description_pattern
WHEN NOT MATCHED BY TARGET THEN
  INSERT (source, description_pattern, covers_from)
  VALUES (src.source, src.description_pattern, src.covers_from)
WHEN NOT MATCHED BY SOURCE AND target.description_pattern IS NOT NULL THEN
  DELETE`
}

export interface SyncOptions {
  projectId: string
  datasetRaw: string
  datasetCanon: string
  aliases: Alias[]
}

/**
 * Apply the config to BigQuery. Returns the number of configured aliases.
 */
export function syncAliases(
  options: SyncOptions,
  run: CommandRunner,
): ResultAsync<number, AliasError> {
  return ResultAsync.fromPromise(
    run(
      'bq',
      [
        'query',
        `--project_id=${options.projectId}`,
        '--use_legacy_sql=false',
        '--quiet',
      ],
      { input: buildSyncAliasesSql(options.aliases, options) },
    ),
    (cause): AliasError => ({
      type: 'bq',
      message: `bq could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  ).andThen((result) =>
    result.code === 0
      ? okAsync<number, AliasError>(options.aliases.length)
      : errAsync<number, AliasError>({
          type: 'bq',
          message: `Syncing disbursement aliases failed: ${(result.stderr || result.stdout).trim()}`,
        }),
  )
}

const RawArgsSchema = z.object({
  project: z.string().min(1),
  datasetRaw: z.string().min(1),
  datasetCanon: z.string().min(1),
})

/**
 * Parse `--project --dataset-raw --dataset-canon`; aliases come from
 * DISBURSEMENT_ALIASES in the environment.
 */
export function parseArgs(
  args: string[],
  env: Record<string, string | undefined>,
): Result<SyncOptions, AliasError> {
  const program = new Command()
    .name('sync-disbursement-aliases')
    .description('Make source_coverage alias rows match DISBURSEMENT_ALIASES')
    .requiredOption('--project <id>', 'GCP project ID')
    .requiredOption('--dataset-raw <name>', 'Raw dataset (source_coverage)')
    .requiredOption('--dataset-canon <name>', 'Canonical dataset (events)')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })

  return Result.fromThrowable(
    (): unknown => program.parse(args, { from: 'user' }).opts(),
    (error): AliasError => ({
      type: 'usage',
      message: describeParseError(error),
    }),
  )()
    .andThen((opts) => {
      const parsed = RawArgsSchema.safeParse(opts)
      /* istanbul ignore if -- @preserve commander already enforces the required options */
      if (!parsed.success) {
        return err<z.infer<typeof RawArgsSchema>, AliasError>({
          type: 'usage',
          message: parsed.error.message,
        })
      }
      return ok<z.infer<typeof RawArgsSchema>, AliasError>(parsed.data)
    })
    .andThen((raw) =>
      parseAliases(env.DISBURSEMENT_ALIASES).map((aliases) => ({
        projectId: raw.project,
        datasetRaw: raw.datasetRaw,
        datasetCanon: raw.datasetCanon,
        aliases,
      })),
    )
}
