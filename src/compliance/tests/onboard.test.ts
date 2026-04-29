/**
 * Tests for the compliance-onboard skill backend.
 *
 * `runOnboarding` orchestrates Secret Manager + BigQuery writes:
 *   1. Validate the user-provided answers.
 *   2. Write entity identifiers to Secret Manager.
 *   3. Write entity attributes to BigQuery.
 *   4. Return a success confirmation summarising what was persisted.
 *
 * Tests inject fake accessor instances so no real GCP calls happen.
 */
import { errAsync, okAsync } from 'neverthrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComplianceMigrationPort } from '../skills/migrate.ts'
import {
  ONBOARD_INTERVIEW_QUESTIONS,
  runOnboarding,
  type OnboardingAnswers,
} from '../skills/onboard.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import { EntityIdentifiersSchema } from '../types/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const ANSWERS: OnboardingAnswers = {
  legalName: 'Foo Foundation',
  ein: '12-3456789',
  stateOfIncorporation: 'CA',
  caSosEntityNumber: 'C0123456',
  caAgCharityNumber: 'CT0123456',
  fiscalYearEndMonth: 12,
  fiscalYearEndDay: 31,
  formationDate: '2010-01-15',
  mailingAddressLine1: '1 Mission St',
  mailingAddressLine2: null,
  mailingAddressCity: 'San Francisco',
  mailingAddressRegion: 'CA',
  mailingAddressPostalCode: '94105',
  mailingAddressCountry: 'US',
}

function fakeIds(): EntityIdsAccessor & {
  readMock: ReturnType<typeof vi.fn<EntityIdsAccessor['read']>>
  writeMock: ReturnType<typeof vi.fn<EntityIdsAccessor['write']>>
} {
  const readMock = vi.fn<EntityIdsAccessor['read']>(() => okAsync(null))
  const writeMock = vi.fn<EntityIdsAccessor['write']>(() => okAsync(undefined))
  return { read: readMock, write: writeMock, readMock, writeMock }
}

function fakeBq(): EntityAccessor & {
  readMock: ReturnType<typeof vi.fn<EntityAccessor['readEntity']>>
  upsertMock: ReturnType<typeof vi.fn<EntityAccessor['upsertEntity']>>
} {
  const readMock = vi.fn<EntityAccessor['readEntity']>(() => okAsync(null))
  const upsertMock = vi.fn<EntityAccessor['upsertEntity']>(() =>
    okAsync(undefined),
  )
  return {
    readEntity: readMock,
    upsertEntity: upsertMock,
    readMock,
    upsertMock,
  }
}

/**
 * Fake migration port for skill-level tests. Default behaviour: dataset and
 * tables already exist, so `ensureComplianceSchema` is a silent no-op. Pass
 * `overrides` to simulate "first run on a fresh project" or BQ failures.
 */
function fakeMigrationPort(
  overrides: Partial<ComplianceMigrationPort> = {},
): ComplianceMigrationPort {
  return {
    datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
      okAsync(true),
    ),
    createDataset: vi.fn<ComplianceMigrationPort['createDataset']>(() =>
      okAsync(undefined),
    ),
    tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
      okAsync(true),
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

describe('ONBOARD_INTERVIEW_QUESTIONS', () => {
  it('lists every required answer field', () => {
    expect(ONBOARD_INTERVIEW_QUESTIONS.map((q) => q.field).sort()).toEqual(
      [
        'caAgCharityNumber',
        'caSosEntityNumber',
        'ein',
        'fiscalYearEndDay',
        'fiscalYearEndMonth',
        'formationDate',
        'legalName',
        'mailingAddressCity',
        'mailingAddressCountry',
        'mailingAddressLine1',
        'mailingAddressLine2',
        'mailingAddressPostalCode',
        'mailingAddressRegion',
        'stateOfIncorporation',
      ].sort(),
    )
  })

  it('flags fiscalYearEndMonth and fiscalYearEndDay as numeric', () => {
    const map = new Map(
      ONBOARD_INTERVIEW_QUESTIONS.map((q) => [q.field, q] as const),
    )
    expect(map.get('fiscalYearEndMonth')?.kind).toBe('number')
    expect(map.get('fiscalYearEndDay')?.kind).toBe('number')
  })

  it('flags caAgCharityNumber and mailingAddressLine2 as optional', () => {
    const map = new Map(
      ONBOARD_INTERVIEW_QUESTIONS.map((q) => [q.field, q] as const),
    )
    expect(map.get('caAgCharityNumber')?.optional).toBe(true)
    expect(map.get('mailingAddressLine2')?.optional).toBe(true)
  })
})

describe('runOnboarding', () => {
  it('persists IDs to Secret Manager and the entity row to BigQuery', async () => {
    const ids = fakeIds()
    const bq = fakeBq()

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isOk()).toBe(true)

    expect(ids.writeMock).toHaveBeenCalledTimes(1)
    expect(ids.writeMock.mock.calls[0]?.[0]).toEqual({
      'us-federal': { ein: '12-3456789' },
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
      },
    })

    expect(bq.upsertMock).toHaveBeenCalledTimes(1)
    expect(bq.upsertMock.mock.calls[0]?.[0]).toMatchObject({
      legal_name: 'Foo Foundation',
      state_of_incorporation: 'CA',
      formation_date: '2010-01-15',
      mailing_address_country: 'US',
    })
  })

  it('omits the CA AG number from secret payload when not provided', async () => {
    const ids = fakeIds()
    const bq = fakeBq()
    const answers: OnboardingAnswers = {
      ...ANSWERS,
      caAgCharityNumber: null,
    }

    const result = await runOnboarding({
      answers,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isOk()).toBe(true)

    expect(ids.writeMock.mock.calls[0]?.[0]).toEqual({
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456' },
    })
  })

  it('returns a validation error on a malformed EIN before touching backends', async () => {
    const ids = fakeIds()
    const bq = fakeBq()

    const result = await runOnboarding({
      answers: { ...ANSWERS, ein: '1234' },
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
    expect(ids.writeMock).not.toHaveBeenCalled()
    expect(bq.upsertMock).not.toHaveBeenCalled()
  })

  it('returns a validation error when fiscal year end is invalid', async () => {
    const ids = fakeIds()
    const bq = fakeBq()

    const result = await runOnboarding({
      answers: { ...ANSWERS, fiscalYearEndMonth: 13 },
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
  })

  it('returns a validation error if identifier construction fails', async () => {
    const invalidIdentifiers = EntityIdentifiersSchema.safeParse({
      'us-federal': { ein: '123' },
    })
    expect(invalidIdentifiers.success).toBe(false)

    vi.spyOn(EntityIdentifiersSchema, 'parse').mockImplementationOnce(() => {
      throw new Error('identifier validation escaped')
    })
    vi.spyOn(EntityIdentifiersSchema, 'safeParse').mockReturnValueOnce(
      invalidIdentifiers,
    )

    const ids = fakeIds()
    const bq = fakeBq()
    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toContain('EIN must be 9 digits')
    }
    expect(ids.writeMock).not.toHaveBeenCalled()
    expect(bq.upsertMock).not.toHaveBeenCalled()
  })

  it('propagates a Secret Manager write failure', async () => {
    const ids = fakeIds()
    ids.writeMock.mockReturnValueOnce(
      errAsync({ type: 'sdk', message: 'permission' }),
    )
    const bq = fakeBq()

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('storage')
      expect(result.error.message).toContain('permission')
    }
    // Secret write failure means no BQ write happens.
    expect(bq.upsertMock).not.toHaveBeenCalled()
  })

  it('propagates a BigQuery upsert failure', async () => {
    const ids = fakeIds()
    const bq = fakeBq()
    bq.upsertMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'bq down' }),
    )

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('storage')
      expect(result.error.message).toContain('bq down')
    }
  })

  it('emits a summary with what was persisted on success', async () => {
    const ids = fakeIds()
    const bq = fakeBq()

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.legalName).toBe('Foo Foundation')
    expect(result.value.identifiers).toEqual({
      'us-federal': { ein: '12-3456789' },
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
      },
    })
  })

  it('runs the schema migration before any secret/BQ writes', async () => {
    // Order matters: if the entity row write fired before ensureSchema, a
    // fresh project would 404 on the table.
    const ids = fakeIds()
    const bq = fakeBq()
    const port = fakeMigrationPort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(false),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(false),
      ),
    })

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: port,
    })
    expect(result.isOk()).toBe(true)
    expect(port.createDataset).toHaveBeenCalledTimes(1)
    expect(port.createTable).toHaveBeenCalledTimes(4)
    expect(ids.writeMock).toHaveBeenCalledTimes(1)
    expect(bq.upsertMock).toHaveBeenCalledTimes(1)
  })

  it('reports what the migration created on the success summary', async () => {
    const ids = fakeIds()
    const bq = fakeBq()
    const port = fakeMigrationPort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(false),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(false),
      ),
    })

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: port,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.migration.createdDataset).toBe(true)
    expect(result.value.migration.createdTables.length).toBe(4)
  })

  it('does not write anything if the migration fails', async () => {
    const ids = fakeIds()
    const bq = fakeBq()
    const port = fakeMigrationPort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        errAsync({ type: 'sdk', message: 'forbidden' }),
      ),
    })

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: port,
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('storage')
      expect(result.error.message).toContain('forbidden')
    }
    expect(ids.writeMock).not.toHaveBeenCalled()
    expect(bq.upsertMock).not.toHaveBeenCalled()
  })

  it('reports a no-op migration when nothing needed creating', async () => {
    const ids = fakeIds()
    const bq = fakeBq()
    // fakeMigrationPort default = dataset + tables all already exist.
    const port = fakeMigrationPort()

    const result = await runOnboarding({
      answers: ANSWERS,
      identifiersAccessor: ids,
      entityAccessor: bq,
      migrationPort: port,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.migration.createdDataset).toBe(false)
    expect(result.value.migration.createdTables).toEqual([])
    expect(port.createDataset).not.toHaveBeenCalled()
    expect(port.createTable).not.toHaveBeenCalled()
  })
})
