import { describe, expect, it } from 'vitest'
import { usCaJurisdiction } from '../jurisdictions/us-ca/index.ts'
import { caAgOnlineFilingSource } from '../jurisdictions/us-ca/sources/ca-ag-online-filing.ts'
import {
  caCdtfaOnlineServicesSource,
  caCdtfaPermitLicenseVerificationSource,
} from '../jurisdictions/us-ca/sources/ca-cdtfa.ts'
import { caFtbMyFtbSource } from '../jurisdictions/us-ca/sources/ca-ftb-myftb.ts'
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
      kind: 'playwright',
      accessMethod: 'official_public_page',
      automationAllowed: true,
    })
    expect(byId.get('ca-ftb-entity-status-letter')).toMatchObject({
      kind: 'playwright',
      accessMethod: 'official_public_page',
      authRequired: false,
      automationAllowed: true,
    })
    expect(byId.get('ca-cdtfa-permit-license-verification')).toMatchObject({
      kind: 'playwright',
      accessMethod: 'official_public_page',
      authRequired: false,
      automationAllowed: true,
    })
    expect(byId.get('ca-ag-registry')).toMatchObject({
      kind: 'api',
      accessMethod: 'official_public_page',
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

  it('runs SOS through a public browser-backed source instead of a manual ToS placeholder', () => {
    expect(caSosBizfileSource).toMatchObject({
      kind: 'playwright',
      accessMethod: 'official_public_page',
      automationAllowed: true,
      authRequired: false,
    })
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

  it('points CA AG authenticated review at the direct Online Renewal System login', () => {
    expect(caAgOnlineFilingSource.description).toContain(
      'Online Renewal System',
    )
    expect(caAgOnlineFilingSource.accessUrl).toBe(
      'https://rct.doj.ca.gov/eGov/Home.aspx',
    )
    expect(caAgOnlineFilingSource.auth?.loginUrl).toBe(
      'https://rct.doj.ca.gov/eGov/Home.aspx',
    )
    expect(caAgOnlineFilingSource.auth?.instructions.join(' ')).toContain(
      'optional dashboard-only details',
    )
    expect(caAgOnlineFilingSource.auth?.instructions.join(' ')).toContain(
      'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y',
    )
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

  it('runs CDTFA permit verification through a public browser-backed source', async () => {
    expect(caCdtfaPermitLicenseVerificationSource).toMatchObject({
      id: 'ca-cdtfa-permit-license-verification',
      kind: 'playwright',
      accessMethod: 'official_public_page',
      automationAllowed: true,
      authRequired: false,
    })

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      CONTEXT,
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
    expect(result.error.message).toContain('seller permit')
  })
})
