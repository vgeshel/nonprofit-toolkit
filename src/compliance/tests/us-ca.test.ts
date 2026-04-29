import { describe, expect, it } from 'vitest'
import { usCaJurisdiction } from '../jurisdictions/us-ca/index.ts'
import { caAgOnlineFilingSource } from '../jurisdictions/us-ca/sources/ca-ag-online-filing.ts'
import {
  caCdtfaOnlineServicesSource,
  caCdtfaPermitLicenseVerificationSource,
} from '../jurisdictions/us-ca/sources/ca-cdtfa.ts'
import { caFtbMyFtbSource } from '../jurisdictions/us-ca/sources/ca-ftb-myftb.ts'
import { caFtbEntityStatusLetterSource } from '../jurisdictions/us-ca/sources/ca-ftb.ts'
import { caSosBizfileSource } from '../jurisdictions/us-ca/sources/ca-sos.ts'
import type { Entity, FetchImpl, SourceContext } from '../types/index.ts'
import { SourceMetadataSchema } from '../types/index.ts'

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
  updated_at: '2024-05-01T00:00:00.000Z',
}

const FETCH: FetchImpl = () =>
  Promise.resolve(new Response('', { status: 200 }))

const CONTEXT: SourceContext = {
  now: () => new Date('2026-04-28T12:00:00.000Z'),
  fetch: FETCH,
  identifiers: { 'us-federal': { ein: '12-3456789' } },
}

describe('usCaJurisdiction', () => {
  it('exports the California jurisdiction with all Phase 2 public sources', () => {
    expect(usCaJurisdiction.id).toBe('us-ca')
    expect(usCaJurisdiction.sources.map((source) => source.id).sort()).toEqual([
      'ca-ag-online-filing',
      'ca-ag-registry',
      'ca-cdtfa-online-services',
      'ca-cdtfa-permit-license-verification',
      'ca-ftb-entity-status-letter',
      'ca-ftb-myftb',
      'ca-sos-bizfile',
    ])
  })

  it('validates supported California identifiers without losing leading zeroes', () => {
    expect(
      usCaJurisdiction.entityIdSchema.parse({
        sosEntityNumber: 'B20250000001',
        agCharityNumber: '000123',
        ftbEntityId: '0123456',
        ftbEntityName: 'Foo Foundation',
        cdtfaSellerPermitNumber: '102-345678',
        cdtfaUseTaxAccountNumber: 'UT-00123456',
        cdtfaSpecialTaxAccountNumber: 'STF-000123',
      }),
    ).toEqual({
      sosEntityNumber: 'B20250000001',
      agCharityNumber: '000123',
      ftbEntityId: '0123456',
      ftbEntityName: 'Foo Foundation',
      cdtfaSellerPermitNumber: '102-345678',
      cdtfaUseTaxAccountNumber: 'UT-00123456',
      cdtfaSpecialTaxAccountNumber: 'STF-000123',
    })
  })

  it('rejects unsupported California identifier formats', () => {
    expect(() =>
      usCaJurisdiction.entityIdSchema.parse({
        sosEntityNumber: 'not a number',
      }),
    ).toThrow()
    expect(() =>
      usCaJurisdiction.entityIdSchema.parse({
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT',
      }),
    ).toThrow()
  })

  it('declares source policy metadata for every source', () => {
    for (const source of usCaJurisdiction.sources) {
      expect(SourceMetadataSchema.safeParse(source).success).toBe(true)
      expect(source.accessUrl).toMatch(/^https:\/\//)
      expect(source.tosUrl).toMatch(/^https:\/\//)
    }
  })

  it('models public/manual and authenticated California sources distinctly', () => {
    const byId = new Map(
      usCaJurisdiction.sources.map((source) => [source.id, source]),
    )

    expect(byId.get('ca-sos-bizfile')).toMatchObject({
      kind: 'manual',
      accessMethod: 'manual',
      automationAllowed: false,
    })
    expect(byId.get('ca-ftb-entity-status-letter')).toMatchObject({
      kind: 'manual',
      accessMethod: 'manual',
      automationAllowed: false,
    })
    expect(byId.get('ca-cdtfa-permit-license-verification')).toMatchObject({
      kind: 'manual',
      accessMethod: 'manual',
      automationAllowed: false,
    })
    expect(byId.get('ca-ag-registry')).toMatchObject({
      kind: 'api',
      accessMethod: 'official_bulk_download',
      automationAllowed: true,
    })
    expect(byId.get('ca-cdtfa-online-services')).toMatchObject({
      kind: 'playwright',
      accessMethod: 'playwright_readonly',
      authRequired: true,
      automationAllowed: true,
    })
    expect(byId.get('ca-ftb-myftb')).toMatchObject({
      kind: 'playwright',
      accessMethod: 'playwright_readonly',
      authRequired: true,
      automationAllowed: true,
    })
    expect(byId.get('ca-ag-online-filing')).toMatchObject({
      kind: 'playwright',
      accessMethod: 'playwright_readonly',
      authRequired: true,
      automationAllowed: true,
    })
  })

  it('keeps SOS and FTB manual source run methods as explicit ToS errors', async () => {
    const sosResult = await caSosBizfileSource.run(ENTITY, CONTEXT)
    const ftbResult = await caFtbEntityStatusLetterSource.run(ENTITY, CONTEXT)

    expect(sosResult.isErr()).toBe(true)
    if (sosResult.isErr()) {
      expect(sosResult.error.type).toBe('tos')
      expect(sosResult.error.message).toContain('manual-only')
    }
    expect(ftbResult.isErr()).toBe(true)
    if (ftbResult.isErr()) {
      expect(ftbResult.error.type).toBe('tos')
      expect(ftbResult.error.message).toContain('manual-only')
    }
  })

  it('declares detailed auth requirements for every authenticated portal source', () => {
    const authSources = [
      caCdtfaOnlineServicesSource,
      caFtbMyFtbSource,
      caAgOnlineFilingSource,
    ]

    for (const source of authSources) {
      expect(source.authRequired).toBe(true)
      expect(source.auth?.loginUrl).toMatch(/^https:\/\//)
      expect(source.auth?.instructions.length).toBeGreaterThan(0)
      expect(source.auth?.evidenceFields.length).toBeGreaterThan(0)
      expect(source.auth?.forbiddenActions.length).toBeGreaterThan(0)
    }
  })

  it('keeps authenticated portal source run methods as explicit auth ToS errors', async () => {
    const sources = [
      caCdtfaOnlineServicesSource,
      caFtbMyFtbSource,
      caAgOnlineFilingSource,
    ]

    for (const source of sources) {
      const result = await source.run(ENTITY, CONTEXT)

      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.type).toBe('tos')
      expect(result.error.message).toContain('authenticated session')
    }
  })

  it('keeps CDTFA permit verification as a manual source with exact evidence fields', async () => {
    expect(caCdtfaPermitLicenseVerificationSource).toMatchObject({
      id: 'ca-cdtfa-permit-license-verification',
      kind: 'manual',
      accessMethod: 'manual',
      automationAllowed: false,
    })
    if (caCdtfaPermitLicenseVerificationSource.automationAllowed) {
      throw new Error('expected CDTFA verification source to be manual-only')
    }
    expect(
      caCdtfaPermitLicenseVerificationSource.manualEvidenceFields.map(
        (field) => field.key,
      ),
    ).toEqual([
      'account_type',
      'account_number',
      'verification_status',
      'owner_name',
      'status_date',
    ])

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      CONTEXT,
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('tos')
    expect(result.error.message).toContain('manual-only')
  })
})
