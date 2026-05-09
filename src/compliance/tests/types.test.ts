/**
 * Tests for compliance type schemas.
 *
 * Covers: EntityIdentifiers, EntitySchema, FindingSchema, FindingSeveritySchema,
 *         SourceKindSchema, SourceRecordSchema, JurisdictionIdSchema.
 */
import { describe, expect, it } from 'vitest'
import {
  EntityIdentifiersSchema,
  EntitySchema,
  FindingSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  JurisdictionIdSchema,
  SourceAccessMethodSchema,
  SourceAuthRequirementSchema,
  SourceCredentialFieldSchema,
  SourceFreshnessSchema,
  SourceKindSchema,
  SourceMetadataSchema,
  SourceRecordSchema,
  SourceRunOutcomeSchema,
  SourceRunOutputSchema,
} from '../types/index.ts'

describe('JurisdictionIdSchema', () => {
  it('accepts a known jurisdiction id', () => {
    expect(JurisdictionIdSchema.parse('us-federal')).toBe('us-federal')
    expect(JurisdictionIdSchema.parse('us-ca')).toBe('us-ca')
  })

  it('rejects empty strings', () => {
    expect(() => JurisdictionIdSchema.parse('')).toThrow()
  })

  it('rejects non-string values', () => {
    expect(() => JurisdictionIdSchema.parse(42)).toThrow()
    expect(() => JurisdictionIdSchema.parse(null)).toThrow()
  })

  it('rejects ids with whitespace', () => {
    expect(() => JurisdictionIdSchema.parse('us federal')).toThrow()
  })
})

describe('SourceKindSchema', () => {
  it.each(['api', 'playwright', 'manual'])('accepts %s', (kind) => {
    expect(SourceKindSchema.parse(kind)).toBe(kind)
  })

  it('rejects unknown kinds', () => {
    expect(() => SourceKindSchema.parse('graphql')).toThrow()
  })
})

describe('SourceAccessMethodSchema', () => {
  it.each([
    'official_api',
    'official_bulk_download',
    'official_public_page',
    'playwright_readonly',
    'manual',
  ])('accepts %s', (method) => {
    expect(SourceAccessMethodSchema.parse(method)).toBe(method)
  })

  it('rejects unknown access methods', () => {
    expect(() =>
      SourceAccessMethodSchema.parse('undocumented_endpoint'),
    ).toThrow()
  })
})

describe('FindingSeveritySchema', () => {
  it.each(['info', 'warn', 'error'])('accepts %s', (s) => {
    expect(FindingSeveritySchema.parse(s)).toBe(s)
  })

  it('rejects invalid severities', () => {
    expect(() => FindingSeveritySchema.parse('critical')).toThrow()
  })
})

describe('FindingStatusSchema', () => {
  it.each(['open', 'resolved'])('accepts %s', (s) => {
    expect(FindingStatusSchema.parse(s)).toBe(s)
  })

  it('rejects invalid statuses', () => {
    expect(() => FindingStatusSchema.parse('closed')).toThrow()
  })
})

describe('EntityIdentifiersSchema', () => {
  it('accepts an empty object (no IDs known yet)', () => {
    expect(EntityIdentifiersSchema.parse({})).toEqual({})
  })

  it('accepts a fully populated record', () => {
    const data = {
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456', agCharityNumber: 'CT0123456' },
    }
    const parsed = EntityIdentifiersSchema.parse(data)
    expect(parsed).toEqual(data)
  })

  it('strips unknown jurisdiction keys', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'martian-republic': { foo: 'bar' } }),
    ).toThrow()
  })

  it('rejects non-object payloads', () => {
    expect(() => EntityIdentifiersSchema.parse('not-an-object')).toThrow()
  })

  it('rejects malformed EIN values', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'us-federal': { ein: '123' } }),
    ).toThrow()
  })

  it('accepts a 9-digit EIN with no dash', () => {
    const parsed = EntityIdentifiersSchema.parse({
      'us-federal': { ein: '123456789' },
    })
    expect(parsed['us-federal']?.ein).toBe('123456789')
  })

  it('rejects EIN with letters', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'us-federal': { ein: '12-34A6789' } }),
    ).toThrow()
  })

  it('accepts CA SOS entity number with letter prefix', () => {
    const parsed = EntityIdentifiersSchema.parse({
      'us-ca': { sosEntityNumber: 'C0123456' },
    })
    expect(parsed['us-ca']?.sosEntityNumber).toBe('C0123456')
  })

  it('accepts CA SOS numeric and new B-prefixed entity numbers', () => {
    expect(
      EntityIdentifiersSchema.parse({
        'us-ca': { sosEntityNumber: '201202310025' },
      })['us-ca']?.sosEntityNumber,
    ).toBe('201202310025')

    expect(
      EntityIdentifiersSchema.parse({
        'us-ca': { sosEntityNumber: 'B20250000001' },
      })['us-ca']?.sosEntityNumber,
    ).toBe('B20250000001')
  })

  it('accepts CA AG CT numbers and older six-digit numbers with leading zeroes', () => {
    expect(
      EntityIdentifiersSchema.parse({
        'us-ca': {
          sosEntityNumber: 'C0123456',
          agCharityNumber: 'CT0123456',
        },
      })['us-ca']?.agCharityNumber,
    ).toBe('CT0123456')

    expect(
      EntityIdentifiersSchema.parse({
        'us-ca': {
          sosEntityNumber: 'C0123456',
          agCharityNumber: '000123',
        },
      })['us-ca']?.agCharityNumber,
    ).toBe('000123')
  })

  it('accepts optional CA FTB lookup identifiers', () => {
    const parsed = EntityIdentifiersSchema.parse({
      'us-ca': {
        sosEntityNumber: 'C0123456',
        ftbEntityId: '1234567',
        ftbEntityName: 'Foo Foundation',
      },
    })

    expect(parsed['us-ca']?.ftbEntityId).toBe('1234567')
    expect(parsed['us-ca']?.ftbEntityName).toBe('Foo Foundation')
  })

  it('accepts optional CA CDTFA account identifiers without normalising them', () => {
    const parsed = EntityIdentifiersSchema.parse({
      'us-ca': {
        sosEntityNumber: 'C0123456',
        cdtfaSellerPermitNumber: '102-345678',
        cdtfaUseTaxAccountNumber: 'UT-00123456',
        cdtfaSpecialTaxAccountNumber: 'STF-000123',
      },
    })

    expect(parsed['us-ca']?.cdtfaSellerPermitNumber).toBe('102-345678')
    expect(parsed['us-ca']?.cdtfaUseTaxAccountNumber).toBe('UT-00123456')
    expect(parsed['us-ca']?.cdtfaSpecialTaxAccountNumber).toBe('STF-000123')
  })

  it('rejects empty CA SOS entity number', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'us-ca': { sosEntityNumber: '' } }),
    ).toThrow()
  })

  it('rejects malformed California identifiers', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({
        'us-ca': { sosEntityNumber: 'bad entity number!' },
      }),
    ).toThrow()
    expect(() =>
      EntityIdentifiersSchema.parse({
        'us-ca': {
          sosEntityNumber: 'C0123456',
          agCharityNumber: 'charity 123',
        },
      }),
    ).toThrow()
    expect(() =>
      EntityIdentifiersSchema.parse({
        'us-ca': {
          sosEntityNumber: 'C0123456',
          cdtfaSellerPermitNumber: '',
        },
      }),
    ).toThrow()
  })
})

describe('EntitySchema', () => {
  const valid = {
    legal_name: 'Foo Foundation',
    state_of_incorporation: 'CA',
    fiscal_year_end_month: 12,
    fiscal_year_end_day: 31,
    formation_date: '2010-01-15',
    mailing_address_line1: '123 Main St',
    mailing_address_line2: null,
    mailing_address_city: 'San Francisco',
    mailing_address_region: 'CA',
    mailing_address_postal_code: '94110',
    mailing_address_country: 'US',
    updated_at: '2024-01-15T00:00:00Z',
  }

  it('parses a valid entity row', () => {
    const result = EntitySchema.parse(valid)
    expect(result.legal_name).toBe('Foo Foundation')
    expect(result.fiscal_year_end_month).toBe(12)
  })

  it('coerces fiscal_year_end_month from string', () => {
    const result = EntitySchema.parse({ ...valid, fiscal_year_end_month: '6' })
    expect(result.fiscal_year_end_month).toBe(6)
  })

  it('rejects fiscal_year_end_month out of range', () => {
    expect(() =>
      EntitySchema.parse({ ...valid, fiscal_year_end_month: 13 }),
    ).toThrow()
    expect(() =>
      EntitySchema.parse({ ...valid, fiscal_year_end_month: 0 }),
    ).toThrow()
  })

  it('rejects fiscal_year_end_day out of range', () => {
    expect(() =>
      EntitySchema.parse({ ...valid, fiscal_year_end_day: 32 }),
    ).toThrow()
  })

  it('rejects malformed formation_date', () => {
    expect(() =>
      EntitySchema.parse({ ...valid, formation_date: 'last Tuesday' }),
    ).toThrow()
  })

  it('allows nullable address line 2', () => {
    const r = EntitySchema.parse(valid)
    expect(r.mailing_address_line2).toBeNull()
  })

  it('rejects missing legal_name', () => {
    const broken: Record<string, unknown> = { ...valid }
    delete broken.legal_name
    expect(() => EntitySchema.parse(broken)).toThrow()
  })

  it('extracts BigQueryTimestamp .value into updated_at', () => {
    const result = EntitySchema.parse({
      ...valid,
      updated_at: { value: '2024-02-02T00:00:00.000Z' },
    })
    expect(result.updated_at).toBe('2024-02-02T00:00:00.000Z')
  })

  it('extracts BigQueryDate .value into formation_date', () => {
    const result = EntitySchema.parse({
      ...valid,
      formation_date: { value: '2010-01-15' },
    })
    expect(result.formation_date).toBe('2010-01-15')
  })
})

describe('FindingSchema', () => {
  const valid = {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: 'us-federal',
    source_id: 'irs-teos',
    severity: 'warn',
    status: 'open',
    title: 'Missing latest 990 filing',
    detail: 'No Form 990 found on record for 2023.',
    evidence: { source_record_pointer: 'gs://bucket/x' },
    opened_at: '2024-03-01T00:00:00Z',
    resolved_at: null,
  }

  it('parses a valid finding', () => {
    const result = FindingSchema.parse(valid)
    expect(result.finding_id).toBe(valid.finding_id)
    expect(result.severity).toBe('warn')
  })

  it('parses a resolved finding', () => {
    const result = FindingSchema.parse({
      ...valid,
      status: 'resolved',
      resolved_at: '2024-04-01T00:00:00Z',
    })
    expect(result.status).toBe('resolved')
    expect(result.resolved_at).toBe('2024-04-01T00:00:00Z')
  })

  it('rejects invalid finding_id (not a UUID)', () => {
    expect(() =>
      FindingSchema.parse({ ...valid, finding_id: 'not-uuid' }),
    ).toThrow()
  })

  it('rejects empty title', () => {
    expect(() => FindingSchema.parse({ ...valid, title: '' })).toThrow()
  })

  it('extracts BigQueryTimestamp .value for opened_at', () => {
    const result = FindingSchema.parse({
      ...valid,
      opened_at: { value: '2024-03-02T00:00:00.000Z' },
    })
    expect(result.opened_at).toBe('2024-03-02T00:00:00.000Z')
  })

  it('parses BigQuery JSON evidence returned as a string', () => {
    const result = FindingSchema.parse({
      ...valid,
      evidence: '{"source_record_pointer":"gs://bucket/x"}',
    })

    expect(result.evidence).toEqual({
      source_record_pointer: 'gs://bucket/x',
    })
  })

  it('rejects invalid JSON evidence strings', () => {
    expect(() =>
      FindingSchema.parse({ ...valid, evidence: '{"broken"' }),
    ).toThrow()
  })

  it('rejects unknown severity', () => {
    expect(() =>
      FindingSchema.parse({ ...valid, severity: 'critical' }),
    ).toThrow()
  })
})

describe('SourceRecordSchema', () => {
  const valid = {
    record_id: '550e8400-e29b-41d4-a716-446655440000',
    source_id: 'irs-teos',
    fetched_at: '2024-03-01T00:00:00Z',
    payload: { kind: 'pub78-hit', deductibilityCode: 'PC' },
  }

  it('parses a valid record', () => {
    const result = SourceRecordSchema.parse(valid)
    expect(result.source_id).toBe('irs-teos')
    expect(result.payload).toEqual({
      kind: 'pub78-hit',
      deductibilityCode: 'PC',
    })
  })

  it('rejects empty source_id', () => {
    expect(() =>
      SourceRecordSchema.parse({ ...valid, source_id: '' }),
    ).toThrow()
  })

  it('rejects non-object payload', () => {
    expect(() =>
      SourceRecordSchema.parse({ ...valid, payload: 'foo' }),
    ).toThrow()
  })
})

describe('SourceFreshnessSchema', () => {
  it('parses observed and upstream publication timestamps', () => {
    const parsed = SourceFreshnessSchema.parse({
      observedAt: '2026-04-28T00:00:00.000Z',
      upstreamPublishedAt: '2026-04-15',
    })
    expect(parsed).toEqual({
      observedAt: '2026-04-28T00:00:00.000Z',
      upstreamPublishedAt: '2026-04-15',
    })
  })

  it('rejects an empty observedAt value', () => {
    expect(() => SourceFreshnessSchema.parse({ observedAt: '' })).toThrow()
  })
})

describe('SourceMetadataSchema', () => {
  const validAutomated = {
    accessUrl:
      'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
    tosUrl:
      'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
    accessMethod: 'official_bulk_download',
    automationAllowed: true,
    sourceFreshness: {
      observedAt: '2026-04-28T00:00:00.000Z',
      upstreamPublishedAt: '2026-04-15',
    },
  }

  it('parses metadata for an automated official bulk source', () => {
    const parsed = SourceMetadataSchema.parse(validAutomated)
    expect(parsed.accessMethod).toBe('official_bulk_download')
    expect(parsed.automationAllowed).toBe(true)
  })

  it('requires an accessUrl', () => {
    const missingAccessUrl: Record<string, unknown> = { ...validAutomated }
    delete missingAccessUrl.accessUrl
    expect(() => SourceMetadataSchema.parse(missingAccessUrl)).toThrow()
  })

  it('requires URL-shaped accessUrl and tosUrl values', () => {
    expect(() =>
      SourceMetadataSchema.parse({ ...validAutomated, accessUrl: 'not-a-url' }),
    ).toThrow()
    expect(() =>
      SourceMetadataSchema.parse({ ...validAutomated, tosUrl: 'not-a-url' }),
    ).toThrow()
  })

  it('requires a manual-only reason when automation is not allowed', () => {
    expect(() =>
      SourceMetadataSchema.parse({
        ...validAutomated,
        accessMethod: 'manual',
        automationAllowed: false,
      }),
    ).toThrow()
  })

  it('rejects manual-only reasons on automated sources', () => {
    expect(() =>
      SourceMetadataSchema.parse({
        ...validAutomated,
        manualOnlyReason: 'not needed',
      }),
    ).toThrow()
  })

  it('parses manual-only source metadata with a reason', () => {
    const parsed = SourceMetadataSchema.parse({
      accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
      tosUrl:
        'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use',
      accessMethod: 'manual',
      automationAllowed: false,
      manualOnlyReason:
        'Published bizfile terms prohibit scraping or similar automated collection.',
    })
    expect(parsed.automationAllowed).toBe(false)
    if (!parsed.automationAllowed) {
      expect(parsed.manualOnlyReason).toContain('scraping')
    }
  })

  it('parses authenticated source metadata without accepting credential values', () => {
    const parsed = SourceMetadataSchema.parse({
      ...validAutomated,
      accessMethod: 'playwright_readonly',
      auth: {
        loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
        credentialMode: 'user_entered_session',
        credentialFields: [
          {
            key: 'username',
            label: 'Username',
            required: true,
            secret: false,
          },
        ],
        mfa: 'user_assisted',
        instructions: ['Sign in using an authorized read-only account.'],
        evidenceFields: [
          {
            key: 'account_status',
            label: 'Account status',
            required: true,
          },
        ],
        forbiddenActions: ['Do not file returns.'],
      },
    })

    expect(parsed.auth?.loginUrl).toBe('https://onlineservices.cdtfa.ca.gov/')
    expect(parsed.auth?.credentialFields[0]?.secret).toBe(false)
    expect(JSON.stringify(parsed.auth)).not.toContain('password-value')
  })
})

describe('SourceCredentialFieldSchema', () => {
  it('parses public and secret credential field descriptors', () => {
    expect(
      SourceCredentialFieldSchema.parse({
        key: 'username',
        label: 'Username',
        required: true,
        secret: false,
      }),
    ).toEqual({
      key: 'username',
      label: 'Username',
      required: true,
      secret: false,
    })

    expect(
      SourceCredentialFieldSchema.parse({
        key: 'password',
        label: 'Password',
        required: true,
        secret: true,
      }).secret,
    ).toBe(true)
  })

  it('rejects empty credential field keys', () => {
    expect(() =>
      SourceCredentialFieldSchema.parse({
        key: '',
        label: 'Password',
        required: true,
        secret: true,
      }),
    ).toThrow()
  })
})

describe('SourceAuthRequirementSchema', () => {
  const validAuth = {
    loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
    credentialMode: 'user_entered_session',
    credentialFields: [
      { key: 'username', label: 'Username', required: true, secret: false },
    ],
    mfa: 'user_assisted',
    instructions: ['Sign in using an authorized read-only account.'],
    evidenceFields: [
      { key: 'account_status', label: 'Account status', required: true },
    ],
    forbiddenActions: ['Do not file returns.'],
  }

  it('parses user-assisted authenticated source requirements', () => {
    const parsed = SourceAuthRequirementSchema.parse(validAuth)

    expect(parsed.credentialMode).toBe('user_entered_session')
    expect(parsed.mfa).toBe('user_assisted')
    expect(parsed.forbiddenActions).toEqual(['Do not file returns.'])
  })

  it('parses Secret Manager credential mode with a secret name', () => {
    const parsed = SourceAuthRequirementSchema.parse({
      ...validAuth,
      credentialMode: 'secret_manager',
      credentialSecretName: 'compliance-credentials-ca-cdtfa-online-services',
      credentialFields: [
        { key: 'username', label: 'Username', required: true, secret: false },
        { key: 'password', label: 'Password', required: true, secret: true },
      ],
    })

    expect(parsed.credentialSecretName).toBe(
      'compliance-credentials-ca-cdtfa-online-services',
    )
    expect(parsed.credentialFields.map((field) => field.key)).toEqual([
      'username',
      'password',
    ])
  })

  it('rejects missing forbidden actions', () => {
    expect(() =>
      SourceAuthRequirementSchema.parse({
        ...validAuth,
        forbiddenActions: [],
      }),
    ).toThrow()
  })
})

describe('SourceRunOutputSchema', () => {
  it('parses a successful source output', () => {
    const parsed = SourceRunOutputSchema.parse({
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'irs-teos',
        fetched_at: '2024-03-01T00:00:00Z',
        payload: { kind: 'pub78-hit' },
      },
      findings: [],
    })
    expect(parsed.record.source_id).toBe('irs-teos')
  })
})

describe('SourceRunOutcomeSchema', () => {
  it('parses a success outcome', () => {
    const parsed = SourceRunOutcomeSchema.parse({
      status: 'success',
      output: {
        record: {
          record_id: '550e8400-e29b-41d4-a716-446655440000',
          source_id: 'irs-teos',
          fetched_at: '2024-03-01T00:00:00Z',
          payload: { kind: 'pub78-hit' },
        },
        findings: [],
      },
    })
    expect(parsed.status).toBe('success')
  })

  it('parses a source failure outcome', () => {
    const parsed = SourceRunOutcomeSchema.parse({
      status: 'source_failure',
      source_id: 'irs-teos',
      error_type: 'http',
      message: 'IRS returned 502',
    })
    expect(parsed.status).toBe('source_failure')
    if (parsed.status === 'source_failure') {
      expect(parsed.error_type).toBe('http')
    }
  })

  it('parses manual required evidence instructions', () => {
    const parsed = SourceRunOutcomeSchema.parse({
      status: 'manual_required',
      source_id: 'ca-sos-bizfile',
      instructions: ['Open bizfile search and record current entity status.'],
      evidenceFields: [
        {
          key: 'entityStatus',
          label: 'Entity status',
          required: true,
        },
      ],
    })
    expect(parsed.status).toBe('manual_required')
  })

  it('parses policy-blocked and auth-required outcomes', () => {
    expect(
      SourceRunOutcomeSchema.parse({
        status: 'policy_blocked',
        source_id: 'ca-sos-bizfile',
        reason: 'Automation is not permitted by the current source terms.',
      }).status,
    ).toBe('policy_blocked')

    expect(
      SourceRunOutcomeSchema.parse({
        status: 'auth_required',
        source_id: 'ca-ftb-entity-status-letter',
        message: 'The public page unexpectedly required login.',
        loginUrl: 'https://www.ftb.ca.gov/myftb/',
        credentialMode: 'user_entered_session',
        credentialFields: [
          { key: 'username', label: 'Username', required: true, secret: false },
        ],
        mfa: 'user_assisted',
        instructions: ['Sign in as an authorized business representative.'],
        evidenceFields: [
          { key: 'account_status', label: 'Account status', required: true },
        ],
        forbiddenActions: ['Do not file returns.'],
      }).status,
    ).toBe('auth_required')
  })

  it('rejects manual required outcomes without evidence fields', () => {
    expect(() =>
      SourceRunOutcomeSchema.parse({
        status: 'manual_required',
        source_id: 'ca-sos-bizfile',
        instructions: ['Open bizfile search and record current entity status.'],
        evidenceFields: [],
      }),
    ).toThrow()
  })
})
