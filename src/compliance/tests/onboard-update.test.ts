/**
 * Tests for the compliance-onboard-update backend.
 *
 * `runOnboardingUpdate` is the partial-update flow used after initial
 * onboarding (e.g. to record the AG charity number once it's issued).
 *
 * Behaviour under test:
 *   1. Reads current entity row + identifiers, merges the partial, and
 *      delegates to `runOnboarding`.
 *   2. Rejects with `not_onboarded` when no prior state exists.
 *   3. Surfaces storage / validation errors from the underlying accessors.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { ComplianceMigrationPort } from '../skills/migrate.ts'
import {
  mergeAnswers,
  reconstructAnswers,
  runOnboardingUpdate,
} from '../skills/onboard-update.ts'
import type { OnboardingAnswers } from '../skills/onboard.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type { Entity, EntityIdentifiers } from '../types/index.ts'

const ENTITY: Entity = {
  legal_name: 'Foo Foundation',
  state_of_incorporation: 'CA',
  fiscal_year_end_month: 12,
  fiscal_year_end_day: 31,
  formation_date: '2010-01-15',
  mailing_address_line1: '1 Mission St',
  mailing_address_line2: null,
  mailing_address_city: 'San Francisco',
  mailing_address_region: 'CA',
  mailing_address_postal_code: '94105',
  mailing_address_country: 'US',
  updated_at: '2024-01-01T00:00:00Z',
}

const IDENTIFIERS: EntityIdentifiers = {
  'us-federal': { ein: '12-3456789' },
  'us-ca': {
    sosEntityNumber: 'C0123456',
  },
}

function fakeIds(
  read: () => ReturnType<EntityIdsAccessor['read']>,
  write: () => ReturnType<EntityIdsAccessor['write']> = () =>
    okAsync(undefined),
): EntityIdsAccessor & {
  readMock: ReturnType<typeof vi.fn<EntityIdsAccessor['read']>>
  writeMock: ReturnType<typeof vi.fn<EntityIdsAccessor['write']>>
} {
  const readMock = vi.fn<EntityIdsAccessor['read']>(read)
  const writeMock = vi.fn<EntityIdsAccessor['write']>(write)
  return { read: readMock, write: writeMock, readMock, writeMock }
}

function fakeBq(
  readEntity: () => ReturnType<EntityAccessor['readEntity']>,
  upsertEntity: () => ReturnType<EntityAccessor['upsertEntity']> = () =>
    okAsync(undefined),
): EntityAccessor & {
  readMock: ReturnType<typeof vi.fn<EntityAccessor['readEntity']>>
  upsertMock: ReturnType<typeof vi.fn<EntityAccessor['upsertEntity']>>
} {
  const readMock = vi.fn<EntityAccessor['readEntity']>(readEntity)
  const upsertMock = vi.fn<EntityAccessor['upsertEntity']>(upsertEntity)
  return {
    readEntity: readMock,
    upsertEntity: upsertMock,
    readMock,
    upsertMock,
  }
}

function fakeMigrationPort(): ComplianceMigrationPort {
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
      okAsync(true),
    ),
  }
}

describe('reconstructAnswers', () => {
  it('rebuilds an OnboardingAnswers from an entity row and identifiers', () => {
    const result = reconstructAnswers(ENTITY, IDENTIFIERS)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual({
      legalName: 'Foo Foundation',
      ein: '12-3456789',
      stateOfIncorporation: 'CA',
      caSosEntityNumber: 'C0123456',
      caAgCharityNumber: null,
      caFtbEntityId: null,
      caFtbEntityName: null,
      cdtfaSellerPermitNumber: null,
      cdtfaUseTaxAccountNumber: null,
      cdtfaSpecialTaxAccountNumber: null,
      fiscalYearEndMonth: 12,
      fiscalYearEndDay: 31,
      formationDate: '2010-01-15',
      mailingAddressLine1: '1 Mission St',
      mailingAddressLine2: null,
      mailingAddressCity: 'San Francisco',
      mailingAddressRegion: 'CA',
      mailingAddressPostalCode: '94105',
      mailingAddressCountry: 'US',
    })
  })

  it('preserves all optional CA identifier fields when present', () => {
    const result = reconstructAnswers(ENTITY, {
      'us-federal': { ein: '12-3456789' },
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
        ftbEntityId: '1234567',
        ftbEntityName: 'Foo',
        cdtfaSellerPermitNumber: 'SR123',
        cdtfaUseTaxAccountNumber: 'UT123',
        cdtfaSpecialTaxAccountNumber: 'ST123',
      },
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.caAgCharityNumber).toBe('CT0123456')
    expect(result.value.caFtbEntityId).toBe('1234567')
    expect(result.value.caFtbEntityName).toBe('Foo')
    expect(result.value.cdtfaSellerPermitNumber).toBe('SR123')
    expect(result.value.cdtfaUseTaxAccountNumber).toBe('UT123')
    expect(result.value.cdtfaSpecialTaxAccountNumber).toBe('ST123')
  })

  it('returns not_onboarded when us-federal identifiers are missing', () => {
    const result = reconstructAnswers(ENTITY, {
      'us-ca': { sosEntityNumber: 'C0123456' },
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
    expect(result.error.message).toContain('us-federal')
  })

  it('returns not_onboarded when us-ca identifiers are missing', () => {
    const result = reconstructAnswers(ENTITY, {
      'us-federal': { ein: '12-3456789' },
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
    expect(result.error.message).toContain('us-ca')
  })
})

describe('mergeAnswers', () => {
  const base: OnboardingAnswers = {
    legalName: 'Foo Foundation',
    ein: '12-3456789',
    stateOfIncorporation: 'CA',
    caSosEntityNumber: 'C0123456',
    caAgCharityNumber: null,
    caFtbEntityId: null,
    caFtbEntityName: null,
    cdtfaSellerPermitNumber: null,
    cdtfaUseTaxAccountNumber: null,
    cdtfaSpecialTaxAccountNumber: null,
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

  it('overrides only the supplied fields', () => {
    const merged = mergeAnswers(base, {
      caAgCharityNumber: 'CT0123456',
    })
    expect(merged.caAgCharityNumber).toBe('CT0123456')
    expect(merged.legalName).toBe('Foo Foundation')
  })

  it('returns the base unchanged when partial is empty', () => {
    expect(mergeAnswers(base, {})).toEqual(base)
  })
})

describe('runOnboardingUpdate', () => {
  it('rejects with not_onboarded when no entity row exists', async () => {
    const result = await runOnboardingUpdate({
      partial: { caAgCharityNumber: 'CT0123456' },
      entityAccessor: fakeBq(() => okAsync(null)),
      identifiersAccessor: fakeIds(() => okAsync(IDENTIFIERS)),
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
  })

  it('rejects with not_onboarded when identifiers are missing', async () => {
    const result = await runOnboardingUpdate({
      partial: { caAgCharityNumber: 'CT0123456' },
      entityAccessor: fakeBq(() => okAsync(ENTITY)),
      identifiersAccessor: fakeIds(() => okAsync(null)),
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
  })

  it('persists the merged answers when prior state exists', async () => {
    const ids = fakeIds(() => okAsync(IDENTIFIERS))
    const bq = fakeBq(() => okAsync(ENTITY))

    const result = await runOnboardingUpdate({
      partial: { caAgCharityNumber: 'CT0123456' },
      entityAccessor: bq,
      identifiersAccessor: ids,
      migrationPort: fakeMigrationPort(),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    // identifiers should now include the new AG number plus the existing SOS number
    expect(ids.writeMock).toHaveBeenCalledTimes(1)
    const written = ids.writeMock.mock.calls[0]?.[0]
    expect(written).toEqual({
      'us-federal': { ein: '12-3456789' },
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
      },
    })
    // entity row should still be the same legal name
    expect(bq.upsertMock).toHaveBeenCalledTimes(1)
    expect(bq.upsertMock.mock.calls[0]?.[0]?.legal_name).toBe('Foo Foundation')
  })

  it('supports updating a non-identifier (entity) field', async () => {
    const ids = fakeIds(() => okAsync(IDENTIFIERS))
    const bq = fakeBq(() => okAsync(ENTITY))

    const result = await runOnboardingUpdate({
      partial: { legalName: 'Renamed Foundation' },
      entityAccessor: bq,
      identifiersAccessor: ids,
      migrationPort: fakeMigrationPort(),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(bq.upsertMock.mock.calls[0]?.[0]?.legal_name).toBe(
      'Renamed Foundation',
    )
  })

  it('surfaces a storage error when readEntity fails', async () => {
    const result = await runOnboardingUpdate({
      partial: { caAgCharityNumber: 'CT0123456' },
      entityAccessor: fakeBq(() =>
        errAsync({ type: 'query', message: 'BQ down' }),
      ),
      identifiersAccessor: fakeIds(() => okAsync(IDENTIFIERS)),
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('storage')
    expect(result.error.message).toContain('BQ down')
  })

  it('surfaces a storage error when identifier read fails', async () => {
    const result = await runOnboardingUpdate({
      partial: { caAgCharityNumber: 'CT0123456' },
      entityAccessor: fakeBq(() => okAsync(ENTITY)),
      identifiersAccessor: fakeIds(() =>
        errAsync({ type: 'sdk', message: 'SM down' }),
      ),
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('storage')
    expect(result.error.message).toContain('SM down')
  })

  it('rejects when the merged result fails validation', async () => {
    const result = await runOnboardingUpdate({
      // Override EIN with an invalid value
      partial: { ein: 'not-an-ein' },
      entityAccessor: fakeBq(() => okAsync(ENTITY)),
      identifiersAccessor: fakeIds(() => okAsync(IDENTIFIERS)),
      migrationPort: fakeMigrationPort(),
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
  })

  it('propagates a not_onboarded error from reconstructAnswers when one jurisdiction is missing from the identifiers blob', async () => {
    // Identifiers row exists but is missing the us-federal block — the read
    // succeeds, the not-null check passes, and reconstructAnswers reports
    // not_onboarded. Exercises the otherwise-unreached error branch.
    const result = await runOnboardingUpdate({
      partial: { caAgCharityNumber: 'CT0123456' },
      entityAccessor: fakeBq(() => okAsync(ENTITY)),
      identifiersAccessor: fakeIds(() =>
        okAsync({ 'us-ca': { sosEntityNumber: 'C0123456' } }),
      ),
      migrationPort: fakeMigrationPort(),
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
    expect(result.error.message).toContain('us-federal')
  })
})
