/**
 * Tests for the compliance dataset/table migration logic.
 *
 * `runMigration` is the pure function (port-driven) the CLI script wraps.
 * Tests cover: dataset creation when missing, idempotent skip when present,
 * per-table creation, idempotent re-runs, and error propagation.
 */
import { Command } from 'commander'
import { errAsync, okAsync } from 'neverthrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeParseFailure,
  parseMigrationArgs,
  runMigration,
  type ComplianceMigrationPort,
} from '../skills/migrate.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakePort(
  overrides: Partial<ComplianceMigrationPort> = {},
): ComplianceMigrationPort {
  return {
    datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
      okAsync(false),
    ),
    createDataset: vi.fn<ComplianceMigrationPort['createDataset']>(() =>
      okAsync(undefined),
    ),
    tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
      okAsync(false),
    ),
    createTable: vi.fn<ComplianceMigrationPort['createTable']>(() =>
      okAsync(undefined),
    ),
    createOrReplaceView: vi.fn<ComplianceMigrationPort['createOrReplaceView']>(
      () => okAsync(undefined),
    ),
    addTableColumn: vi.fn<ComplianceMigrationPort['addTableColumn']>(() =>
      okAsync(undefined),
    ),
    tableColumnExists: vi.fn<ComplianceMigrationPort['tableColumnExists']>(() =>
      okAsync(false),
    ),
    ...overrides,
  }
}

describe('describeParseFailure', () => {
  it('uses Error.message', () => {
    expect(describeParseFailure(new Error('bad flag'))).toBe('bad flag')
  })

  it('stringifies non-Error values', () => {
    expect(describeParseFailure('weird')).toBe('weird')
    expect(describeParseFailure(null)).toBe('null')
  })
})

describe('parseMigrationArgs', () => {
  it('parses a project flag', () => {
    const result = parseMigrationArgs(['--project', 'my-project'])
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.projectId).toBe('my-project')
      expect(result.value.dryRun).toBe(false)
    }
  })

  it('parses --dry-run', () => {
    const result = parseMigrationArgs(['--project', 'p', '--dry-run'])
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.dryRun).toBe(true)
    }
  })

  it('rejects when --project is missing', () => {
    const result = parseMigrationArgs([])
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
    }
  })

  it('rejects an empty project id', () => {
    const result = parseMigrationArgs(['--project', ''])
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
  })

  it('rejects unknown options', () => {
    const result = parseMigrationArgs(['--project', 'p', '--bogus'])
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
    }
  })

  it('returns validation errors when commander emits malformed option values', () => {
    const opts = vi
      .spyOn(Command.prototype, 'opts')
      .mockReturnValueOnce({ project: 42, dryRun: 'yes' })

    const result = parseMigrationArgs(['--project', 'p'])

    expect(opts).toHaveBeenCalledTimes(1)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
  })
})

describe('runMigration', () => {
  it('creates the dataset and every table when nothing exists', async () => {
    const port = fakePort()
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(port.createDataset).toHaveBeenCalledTimes(1)
    expect(port.createDataset).toHaveBeenCalledWith('compliance')
    expect(port.createTable).toHaveBeenCalledTimes(4)
    expect(port.createOrReplaceView).toHaveBeenCalledTimes(1)
    expect(port.addTableColumn).not.toHaveBeenCalled()

    expect(result.value.createdDataset).toBe(true)
    expect([...result.value.createdTables].sort()).toEqual([
      'discovery_runs',
      'entity',
      'findings',
      'sources',
    ])
    expect(result.value.updatedViews).toEqual(['current_open_findings'])
  })

  it('skips dataset creation when dataset already exists', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(port.createDataset).not.toHaveBeenCalled()
    expect(result.value.createdDataset).toBe(false)
  })

  it('skips table creation when each table already exists (idempotent)', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(port.createTable).not.toHaveBeenCalled()
    expect(port.createOrReplaceView).toHaveBeenCalledTimes(1)
    expect(result.value.createdTables).toEqual([])
    expect(result.value.addedColumns).toEqual([
      'sources.access_url',
      'sources.access_method',
      'sources.automation_allowed',
      'sources.manual_only_reason',
      'sources.source_freshness',
    ])
    expect(result.value.updatedViews).toEqual(['current_open_findings'])
  })

  it('skips actual creation calls when dryRun is true', async () => {
    const port = fakePort()
    const result = await runMigration({
      port,
      dryRun: true,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(port.createDataset).not.toHaveBeenCalled()
    expect(port.createTable).not.toHaveBeenCalled()
    expect(port.createOrReplaceView).not.toHaveBeenCalled()
    expect(port.addTableColumn).not.toHaveBeenCalled()
    // Plan still records what would have happened.
    expect(result.value.createdDataset).toBe(true)
    expect(result.value.createdTables.length).toBe(4)
    expect(result.value.addedColumns).toEqual([])
    expect(result.value.updatedViews).toEqual(['current_open_findings'])
  })

  it('plans Phase 2 column upgrades on dry-run when sources table already exists', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: true,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(port.addTableColumn).not.toHaveBeenCalled()
    expect(result.value.addedColumns).toEqual([
      'sources.access_url',
      'sources.access_method',
      'sources.automation_allowed',
      'sources.manual_only_reason',
      'sources.source_freshness',
    ])
    expect(result.value.updatedViews).toEqual(['current_open_findings'])
  })

  it('defines current findings in a view using semantic fields rather than finding_id', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
      tableColumnExists: vi.fn<ComplianceMigrationPort['tableColumnExists']>(
        () => okAsync(true),
      ),
    })

    const result = await runMigration({
      port,
      dryRun: false,
    })

    expect(result.isOk()).toBe(true)
    const [viewReq] = vi.mocked(port.createOrReplaceView).mock.calls[0] ?? []
    expect(viewReq?.dataset).toBe('compliance')
    expect(viewReq?.viewId).toBe('current_open_findings')
    expect(viewReq?.query).toMatch(/ROW_NUMBER\(\) OVER/i)
    expect(viewReq?.query).toMatch(/PARTITION BY/i)
    expect(viewReq?.query).toMatch(/jurisdiction_id/i)
    expect(viewReq?.query).toMatch(/source_id/i)
    expect(viewReq?.query).toMatch(/title/i)
    expect(viewReq?.query).toMatch(/detail/i)
    expect(viewReq?.query).toMatch(/TO_JSON_STRING\(evidence\)/i)
    expect(viewReq?.query).toMatch(
      /NOT COALESCE\(\s*JSON_VALUE\(f\.evidence, '\$\.code'\) = 'source\.failed'/i,
    )
    expect(viewReq?.query).not.toMatch(/PARTITION BY\s+finding_id/i)
  })

  it('returns the underlying error if datasetExists fails', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        errAsync({ type: 'sdk', message: 'BQ down' }),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
    }
  })

  it('returns the underlying error if createDataset fails', async () => {
    const port = fakePort({
      createDataset: vi.fn<ComplianceMigrationPort['createDataset']>(() =>
        errAsync({ type: 'sdk', message: 'no perms' }),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isErr()).toBe(true)
  })

  it('returns the underlying error if tableExists fails', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        errAsync({ type: 'sdk', message: 'glitch' }),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isErr()).toBe(true)
  })

  it('returns the underlying error if createTable fails', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      createTable: vi.fn<ComplianceMigrationPort['createTable']>(() =>
        errAsync({ type: 'sdk', message: 'oops' }),
      ),
    })
    const result = await runMigration({
      port,
      dryRun: false,
    })
    expect(result.isErr()).toBe(true)
  })

  it('passes the right schema fields to createTable', async () => {
    const port = fakePort()
    await runMigration({
      port,
      dryRun: false,
    })

    const calls = vi.mocked(port.createTable).mock.calls
    const entityCall = calls.find((c) => c[0]?.tableId === 'entity')
    expect(entityCall).toBeDefined()
    expect(entityCall?.[0]?.schema.fields.map((f) => f.name)).toContain(
      'legal_name',
    )
    expect(entityCall?.[0]?.dataset).toBe('compliance')
  })

  it('adds nullable Phase 2 columns to an existing sources table', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
    })

    const result = await runMigration({
      port,
      dryRun: false,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(port.addTableColumn).toHaveBeenCalledTimes(5)
    expect(port.addTableColumn).toHaveBeenCalledWith({
      dataset: 'compliance',
      tableId: 'sources',
      field: { name: 'access_url', type: 'STRING', mode: 'NULLABLE' },
    })
    expect(result.value.addedColumns).toContain('sources.access_url')
  })

  it('does not report Phase 2 columns as added when they already exist', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
      tableColumnExists: vi.fn<ComplianceMigrationPort['tableColumnExists']>(
        () => okAsync(true),
      ),
    })

    const result = await runMigration({
      port,
      dryRun: false,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(port.addTableColumn).not.toHaveBeenCalled()
    expect(result.value.addedColumns).toEqual([])
  })

  it('returns the underlying error if adding a Phase 2 column fails', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
      addTableColumn: vi.fn<ComplianceMigrationPort['addTableColumn']>(() =>
        errAsync({ type: 'sdk', message: 'alter failed' }),
      ),
    })

    const result = await runMigration({
      port,
      dryRun: false,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toBe('alter failed')
    }
  })
})
