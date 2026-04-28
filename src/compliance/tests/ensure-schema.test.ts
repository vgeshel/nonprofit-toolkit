/**
 * Tests for the `ensureComplianceSchema` helper.
 *
 * The helper is the seam every skill uses to make sure the compliance dataset
 * and tables exist before the skill runs its own queries. It must be:
 *   - idempotent (re-runs on a fully-provisioned project are a no-op)
 *   - silent on no-change (caller decides whether to surface chatter)
 *   - a faithful Result-passthrough of the underlying migration's errors
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { ComplianceMigrationPort } from '../skills/migrate.ts'
import { ensureComplianceSchema } from '../state/ensure-schema.ts'

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
    ...overrides,
  }
}

describe('ensureComplianceSchema', () => {
  it('creates the dataset and every table when nothing exists', async () => {
    const port = fakePort()
    const result = await ensureComplianceSchema(port)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.createdDataset).toBe(true)
    expect(result.value.createdTables.length).toBe(4)
    expect(result.value.skippedTables).toEqual([])
    expect(port.createDataset).toHaveBeenCalledTimes(1)
    expect(port.createTable).toHaveBeenCalledTimes(4)
  })

  it('is a no-op when dataset and tables all already exist', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(true),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(true),
      ),
    })
    const result = await ensureComplianceSchema(port)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.createdDataset).toBe(false)
    expect(result.value.createdTables).toEqual([])
    expect(result.value.skippedTables.length).toBe(4)
    expect(port.createDataset).not.toHaveBeenCalled()
    expect(port.createTable).not.toHaveBeenCalled()
  })

  it('runs in real (not dry-run) mode — it actually creates resources', async () => {
    // If the helper accidentally passed dryRun=true we'd see no createDataset
    // call even when datasetExists returns false. This test pins the mode.
    const port = fakePort()
    const result = await ensureComplianceSchema(port)
    expect(result.isOk()).toBe(true)
    expect(port.createDataset).toHaveBeenCalledWith('compliance')
    expect(port.createTable).toHaveBeenCalled()
  })

  it('propagates a migration error verbatim (same shape as runMigration)', async () => {
    const port = fakePort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        errAsync({ type: 'sdk', message: 'permission denied' }),
      ),
    })
    const result = await ensureComplianceSchema(port)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
      expect(result.error.message).toBe('permission denied')
    }
  })
})

describe('didCreateAnything', () => {
  it('is true when the dataset was created', async () => {
    const { didCreateAnything } = await import('../state/ensure-schema.ts')
    expect(
      didCreateAnything({
        createdDataset: true,
        createdTables: [],
        skippedTables: ['entity', 'discovery_runs', 'findings', 'sources'],
      }),
    ).toBe(true)
  })

  it('is true when at least one table was created', async () => {
    const { didCreateAnything } = await import('../state/ensure-schema.ts')
    expect(
      didCreateAnything({
        createdDataset: false,
        createdTables: ['findings'],
        skippedTables: ['entity', 'discovery_runs', 'sources'],
      }),
    ).toBe(true)
  })

  it('is false on a pure no-op re-run', async () => {
    const { didCreateAnything } = await import('../state/ensure-schema.ts')
    expect(
      didCreateAnything({
        createdDataset: false,
        createdTables: [],
        skippedTables: ['entity', 'discovery_runs', 'findings', 'sources'],
      }),
    ).toBe(false)
  })
})
