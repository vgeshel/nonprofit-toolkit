/**
 * Tests for syncing disbursement aliases from config into BigQuery.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildSyncAliasesSql,
  parseAliases,
  parseArgs,
  syncAliases,
  type CommandRunner,
} from './disbursement-aliases-lib'

describe('parseAliases', () => {
  it('parses source=pattern entries separated by semicolons', () => {
    expect(
      parseAliases(
        'benevity=example giving fdn; benevity=Other Fund Ltd ;givebutter=gb payout',
      )._unsafeUnwrap(),
    ).toEqual([
      { source: 'benevity', pattern: 'example giving fdn' },
      { source: 'benevity', pattern: 'other fund ltd' },
      { source: 'givebutter', pattern: 'gb payout' },
    ])
  })

  it('treats an empty or unset value as no aliases', () => {
    expect(parseAliases('')._unsafeUnwrap()).toEqual([])
    expect(parseAliases(undefined)._unsafeUnwrap()).toEqual([])
    expect(parseAliases(' ; ')._unsafeUnwrap()).toEqual([])
  })

  it('drops duplicate entries', () => {
    expect(
      parseAliases('benevity=a fund;benevity=A Fund')._unsafeUnwrap(),
    ).toEqual([{ source: 'benevity', pattern: 'a fund' }])
  })

  it('rejects an entry without =', () => {
    expect(parseAliases('benevity')._unsafeUnwrapErr()).toEqual({
      type: 'config',
      message:
        'DISBURSEMENT_ALIASES entry "benevity" must look like source=bank descriptor prefix',
    })
  })

  it('rejects an unknown source', () => {
    expect(parseAliases('stripe=x')._unsafeUnwrapErr().message).toBe(
      'DISBURSEMENT_ALIASES entry "stripe=x": unknown source "stripe"',
    )
  })

  it('rejects mercury, which cannot cover itself', () => {
    expect(parseAliases('mercury=x')._unsafeUnwrapErr().message).toBe(
      'DISBURSEMENT_ALIASES entry "mercury=x": mercury is the bank, not a platform',
    )
  })

  it('rejects characters that could break the SQL literal', () => {
    expect(
      parseAliases("benevity=o'brien fund")._unsafeUnwrapErr().message,
    ).toBe(
      'DISBURSEMENT_ALIASES entry "benevity=o\'brien fund": the descriptor may only contain letters, digits, spaces and . & - / *',
    )
    expect(parseAliases('benevity=a\\b')._unsafeUnwrapErr().type).toBe('config')
    expect(parseAliases('benevity=')._unsafeUnwrapErr().type).toBe('config')
  })
})

describe('buildSyncAliasesSql', () => {
  const datasets = { datasetRaw: 'raw', datasetCanon: 'canon' }

  it('upserts every alias and deletes alias rows no longer configured', () => {
    const sql = buildSyncAliasesSql(
      [
        { source: 'benevity', pattern: 'example giving fdn' },
        { source: 'benevity', pattern: 'other fund ltd' },
      ],
      datasets,
    )

    expect(sql).toBe(
      `MERGE \`raw.source_coverage\` AS target
USING (
  SELECT a.source, a.pattern AS description_pattern,
    COALESCE(earliest.first_ts, TIMESTAMP '9999-12-31 00:00:00 UTC') AS covers_from
  FROM UNNEST(ARRAY<STRUCT<source STRING, pattern STRING>>[('benevity', 'example giving fdn'), ('benevity', 'other fund ltd')]) AS a
  LEFT JOIN (
    SELECT source, MIN(event_ts) AS first_ts
    FROM \`canon.events\`
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
  DELETE`,
    )
  })

  it('removes every alias row when none are configured', () => {
    const sql = buildSyncAliasesSql([], datasets)

    expect(sql).toContain(
      'UNNEST(ARRAY<STRUCT<source STRING, pattern STRING>>[]) AS a',
    )
    expect(sql).toContain(
      'WHEN NOT MATCHED BY SOURCE AND target.description_pattern IS NOT NULL THEN',
    )
  })
})

describe('syncAliases', () => {
  const options = {
    projectId: 'p',
    datasetRaw: 'raw',
    datasetCanon: 'canon',
    aliases: [{ source: 'benevity' as const, pattern: 'example giving fdn' }],
  }

  it('runs the MERGE through bq with standard SQL', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    })

    const result = await syncAliases(options, run)

    expect(result._unsafeUnwrap()).toBe(1)
    expect(run).toHaveBeenCalledWith(
      'bq',
      ['query', '--project_id=p', '--use_legacy_sql=false', '--quiet'],
      { input: buildSyncAliasesSql(options.aliases, options) },
    )
  })

  it('reports a failed query', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({
      code: 1,
      stdout: 'Error in query string',
      stderr: '',
    })

    const result = await syncAliases(options, run)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'bq',
      message: 'Syncing disbursement aliases failed: Error in query string',
    })
  })

  it('reports bq failing to start', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('ENOENT'))

    const result = await syncAliases(options, run)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'bq',
      message: 'bq could not run: ENOENT',
    })
  })

  it('reports a non-Error failure to start', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue('spawn failed')

    const result = await syncAliases(options, run)

    expect(result._unsafeUnwrapErr().message).toBe(
      'bq could not run: spawn failed',
    )
  })
})

describe('parseArgs', () => {
  it('reads datasets from flags and aliases from DISBURSEMENT_ALIASES', () => {
    expect(
      parseArgs(
        ['--project', 'p', '--dataset-raw', 'raw', '--dataset-canon', 'canon'],
        { DISBURSEMENT_ALIASES: 'benevity=example giving fdn' },
      )._unsafeUnwrap(),
    ).toEqual({
      projectId: 'p',
      datasetRaw: 'raw',
      datasetCanon: 'canon',
      aliases: [{ source: 'benevity', pattern: 'example giving fdn' }],
    })
  })

  it('passes on a config error', () => {
    expect(
      parseArgs(
        ['--project', 'p', '--dataset-raw', 'raw', '--dataset-canon', 'canon'],
        { DISBURSEMENT_ALIASES: 'nope' },
      )._unsafeUnwrapErr().type,
    ).toBe('config')
  })

  it('requires the project and datasets', () => {
    expect(parseArgs(['--project', 'p'], {})._unsafeUnwrapErr()).toEqual({
      type: 'usage',
      message: "error: required option '--dataset-raw <name>' not specified",
    })
  })

  it('returns --help as a usage result instead of printing and exiting', () => {
    expect(parseArgs(['--help'], {})._unsafeUnwrapErr()).toEqual({
      type: 'usage',
      message: '(outputHelp)',
    })
  })
})
