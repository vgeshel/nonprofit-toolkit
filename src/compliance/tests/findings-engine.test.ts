import { describe, expect, it } from 'vitest'
import { deriveComplianceFindings } from '../rules/findings.ts'
import type {
  DiscoveryRun,
  DiscoveryRunSourceSummary,
} from '../skills/discover.ts'
import type {
  Entity,
  EntityIdentifiers,
  SourceRunOutcome,
} from '../types/index.ts'

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

const IDENTIFIERS: EntityIdentifiers = {
  'us-federal': { ein: '12-3456789' },
  'us-ca': { sosEntityNumber: 'C0123456' },
}

const SOURCE: DiscoveryRunSourceSummary = {
  sourceId: 'ca-ag-registry',
  jurisdictionId: 'us-ca',
  description: 'CA AG Registry',
  accessUrl: 'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y',
  accessMethod: 'official_public_page',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-05-02T00:00:00.000Z',
  },
  tosUrl: 'https://www.oag.ca.gov/privacy',
}

type SuccessOutcome = Extract<SourceRunOutcome, { status: 'success' }>

function output(payload: Record<string, unknown>): SuccessOutcome['output'] {
  return {
    record: {
      record_id: '550e8400-e29b-41d4-a716-446655440000',
      source_id: 'ca-ag-registry',
      fetched_at: '2026-04-28T00:00:00.000Z',
      payload,
    },
    findings: [],
  }
}

function ftbOutput(payload: Record<string, unknown>): SuccessOutcome['output'] {
  return {
    record: {
      record_id: '550e8400-e29b-41d4-a716-446655440000',
      source_id: 'ca-ftb-entity-status-letter',
      fetched_at: '2026-05-03T00:00:00.000Z',
      payload,
    },
    findings: [],
  }
}

function sosOutput(payload: Record<string, unknown>): SuccessOutcome['output'] {
  return {
    record: {
      record_id: '550e8400-e29b-41d4-a716-446655440000',
      source_id: 'ca-sos-bizfile',
      fetched_at: '2026-05-07T00:00:00.000Z',
      payload,
    },
    findings: [],
  }
}

function cdtfaOutput(
  payload: Record<string, unknown>,
): SuccessOutcome['output'] {
  return {
    record: {
      record_id: '550e8400-e29b-41d4-a716-446655440000',
      source_id: 'ca-cdtfa-permit-license-verification',
      fetched_at: '2026-05-07T00:00:00.000Z',
      payload,
    },
    findings: [],
  }
}

function ftbRun(payload: Record<string, unknown>): DiscoveryRun {
  return {
    ...SOURCE,
    sourceId: 'ca-ftb-entity-status-letter',
    description: 'CA FTB Entity Status Letter',
    accessUrl: 'https://webapp.ftb.ca.gov/eletter/',
    outcome: {
      status: 'success',
      output: ftbOutput(payload),
    },
  }
}

function sosRun(payload: Record<string, unknown>): DiscoveryRun {
  return {
    ...SOURCE,
    sourceId: 'ca-sos-bizfile',
    description: 'CA SOS bizfile',
    accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
    outcome: {
      status: 'success',
      output: sosOutput(payload),
    },
  }
}

function cdtfaRun(payload: Record<string, unknown>): DiscoveryRun {
  return {
    ...SOURCE,
    sourceId: 'ca-cdtfa-permit-license-verification',
    description: 'CA CDTFA Permit, License, or Account Verification',
    accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
    outcome: {
      status: 'success',
      output: cdtfaOutput(payload),
    },
  }
}

describe('deriveComplianceFindings', () => {
  it('creates a manual-required finding with a stable id', () => {
    const run: DiscoveryRun = {
      ...SOURCE,
      sourceId: 'ca-sos-bizfile',
      description: 'CA SOS bizfile',
      accessMethod: 'manual',
      automationAllowed: false,
      outcome: {
        status: 'manual_required',
        source_id: 'ca-sos-bizfile',
        instructions: ['Open bizfile and record entity status.'],
        evidenceFields: [
          { key: 'entity_status', label: 'Entity status', required: true },
        ],
      },
    }

    const first = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [run],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })
    const second = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [run],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'ca-sos-bizfile',
      severity: 'warn',
      status: 'open',
      title: 'Manual verification required: CA SOS bizfile',
      evidence: {
        code: 'source.manual_required',
        requiredFields: ['entity_status'],
      },
    })
    expect(second[0]?.finding_id).toBe(first[0]?.finding_id)
  })

  it('creates an error finding for source failures', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'source_failure',
            source_id: 'ca-ag-registry',
            error_type: 'parse',
            message: 'Registry Search Tool schema changed',
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'error',
      title: 'Source failed: CA AG Registry',
      detail:
        'ca-ag-registry could not be read: Registry Search Tool schema changed',
      evidence: { code: 'source.failed', errorType: 'parse' },
    })
  })

  it('flags missing California identifiers for California nonprofits', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: { 'us-federal': { ein: '12-3456789' } },
      runs: [],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings.map((finding) => finding.evidence.code)).toEqual([
      'entity.ca_sos_identifier_missing',
    ])
    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'entity-identifiers',
      severity: 'warn',
      title: 'California SOS entity number is not configured',
    })
  })

  it('does not require a California SOS identifier for non-California entities', () => {
    const findings = deriveComplianceFindings({
      entity: {
        ...ENTITY,
        state_of_incorporation: 'DE',
        mailing_address_region: 'NV',
      },
      identifiers: { 'us-federal': { ein: '12-3456789' } },
      runs: [],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('creates warning findings for policy-blocked and auth-required source outcomes', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'blocked-source',
          description: 'Blocked source',
          outcome: {
            status: 'policy_blocked',
            source_id: 'blocked-source',
            reason: 'Terms do not allow automated access.',
          },
        },
        {
          ...SOURCE,
          sourceId: 'auth-source',
          description: 'Auth source',
          outcome: {
            status: 'auth_required',
            source_id: 'auth-source',
            message: 'Authentication is required.',
            loginUrl: 'https://example.com/login',
            credentialMode: 'user_entered_session',
            credentialFields: [
              {
                key: 'username',
                label: 'Username',
                required: true,
                secret: false,
              },
              {
                key: 'password',
                label: 'Password',
                required: true,
                secret: true,
              },
            ],
            mfa: 'user_assisted',
            instructions: ['Sign in and stop at the overview page.'],
            evidenceFields: [
              {
                key: 'account_status',
                label: 'Account status',
                required: true,
              },
            ],
            forbiddenActions: ['Do not file returns.'],
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings.map((finding) => finding.evidence.code)).toEqual([
      'source.policy_blocked',
      'source.auth_required',
    ])
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Source blocked by policy: Blocked source',
      detail: 'Terms do not allow automated access.',
    })
    expect(findings[1]).toMatchObject({
      severity: 'warn',
      title: 'Authentication required: Auth source',
      detail: 'Authentication is required.',
      evidence: {
        code: 'source.auth_required',
        loginUrl: 'https://example.com/login',
        credentialMode: 'user_entered_session',
        requiredFields: ['account_status'],
        forbiddenActions: ['Do not file returns.'],
      },
    })
    expect(JSON.stringify(findings[1]?.evidence)).not.toContain(
      'password-value',
    )
  })

  it('creates auth-required findings when no detailed auth metadata is present', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'legacy-auth-source',
          description: 'Legacy auth source',
          outcome: {
            status: 'auth_required',
            source_id: 'legacy-auth-source',
            message: 'Authentication is required.',
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Authentication required: Legacy auth source',
      evidence: {
        code: 'source.auth_required',
        accessMethod: 'official_public_page',
      },
    })
    expect(findings[0]?.evidence).not.toHaveProperty('loginUrl')
    expect(findings[0]?.evidence).not.toHaveProperty('credentialMode')
    expect(findings[0]?.evidence).not.toHaveProperty('requiredFields')
    expect(findings[0]?.evidence).not.toHaveProperty('forbiddenActions')
  })

  it('does not create an open finding for the optional CA AG Online Renewal dashboard source', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'ca-ag-online-filing',
          jurisdictionId: 'us-ca',
          description:
            'User-assisted CA AG Registry Online Renewal System dashboard review.',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ag-online-filing',
            message: 'Authentication is required.',
            loginUrl: 'https://rct.doj.ca.gov/eGov/Home.aspx',
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('flags IRS EO BMF not-found results', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'irs-eo-bmf',
          jurisdictionId: 'us-federal',
          description: 'IRS EO BMF',
          accessMethod: 'official_bulk_download',
          outcome: {
            status: 'success',
            output: output({ matchStatus: 'not_found' }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-federal',
      source_id: 'irs-eo-bmf',
      severity: 'warn',
      title: 'EIN not found in IRS EO BMF',
      evidence: { code: 'federal.bmf_not_found' },
    })
  })

  it('ignores malformed IRS BMF payloads instead of inventing findings', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'irs-eo-bmf',
          jurisdictionId: 'us-federal',
          description: 'IRS EO BMF',
          accessMethod: 'official_bulk_download',
          outcome: {
            status: 'success',
            output: output({ unexpected: true }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('flags stale IRS BMF tax-period data when present', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'irs-eo-bmf',
          jurisdictionId: 'us-federal',
          description: 'IRS EO BMF',
          accessMethod: 'official_bulk_download',
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              row: { name: 'Foo Foundation', taxPeriod: '202112' },
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-federal',
      source_id: 'irs-eo-bmf',
      severity: 'warn',
      title: 'Latest IRS BMF tax period appears stale',
      evidence: { code: 'federal.bmf_tax_period_stale', taxPeriod: '202112' },
    })
  })

  it('flags IRS BMF legal-name mismatches', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          sourceId: 'irs-eo-bmf',
          jurisdictionId: 'us-federal',
          description: 'IRS EO BMF',
          accessMethod: 'official_bulk_download',
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              row: { name: 'Different Foundation', taxPeriod: '202412' },
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Legal name mismatch in IRS EO BMF',
      evidence: {
        code: 'cross_source.legal_name_mismatch',
        entityLegalName: 'Foo Foundation',
        sourceLegalName: 'Different Foundation',
      },
    })
  })

  it.each(['unknown', '', '   ', '12'])(
    'does not flag IRS BMF tax period %j when it cannot be interpreted as a year',
    (taxPeriod) => {
      const findings = deriveComplianceFindings({
        entity: ENTITY,
        identifiers: IDENTIFIERS,
        runs: [
          {
            ...SOURCE,
            sourceId: 'irs-eo-bmf',
            jurisdictionId: 'us-federal',
            description: 'IRS EO BMF',
            accessMethod: 'official_bulk_download',
            outcome: {
              status: 'success',
              output: output({
                matchStatus: 'found',
                row: { name: 'Foo Foundation', taxPeriod },
              }),
            },
          },
        ],
        now: () => new Date('2026-04-28T12:00:00.000Z'),
      })

      expect(findings).toEqual([])
    },
  )

  it('flags CA AG not-found results from the public Registry Search Tool', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({ matchStatus: 'not_found' }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Entity not found in CA AG Registry Search Tool',
      evidence: { code: 'ca.ag_not_found' },
    })
  })

  it('ignores malformed CA AG payloads instead of inventing findings', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({ unexpected: true }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('flags California AG statuses that do not allow operation or solicitation', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'may_not_operate_or_solicit',
              registryStatus: 'Delinquent',
              name: 'Foo Foundation',
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'ca-ag-registry',
      severity: 'error',
      title: 'CA AG Registry status blocks operation or solicitation',
      evidence: {
        code: 'ca.ag_may_not_operate',
        listCategory: 'may_not_operate_or_solicit',
        registryStatus: 'Delinquent',
      },
    })
  })

  it('flags undetermined CA AG Registry status', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'undetermined',
              registryStatus: 'Reporting Incomplete',
              name: 'Foo Foundation',
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'CA AG Registry status is undetermined',
      evidence: {
        code: 'ca.ag_status_undetermined',
        listCategory: 'undetermined',
        registryStatus: 'Reporting Incomplete',
      },
    })
  })

  it('flags not-operating or dissolving CA AG Registry status', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'not_operating_or_dissolving',
              registryStatus: 'Dissolution Pending',
              name: 'Foo Foundation',
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      severity: 'error',
      title: 'CA AG Registry lists not operating or dissolving status',
      evidence: {
        code: 'ca.ag_not_operating_or_dissolving',
        listCategory: 'not_operating_or_dissolving',
        registryStatus: 'Dissolution Pending',
      },
    })
  })

  it('uses null evidence when CA AG status findings omit registryStatus', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'may_not_operate_or_solicit',
              name: 'Foo Foundation',
            }),
          },
        },
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'undetermined',
              name: 'Foo Foundation',
            }),
          },
        },
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'not_operating_or_dissolving',
              name: 'Foo Foundation',
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(
      findings.map((finding) => ({
        code: finding.evidence.code,
        registryStatus: finding.evidence.registryStatus,
      })),
    ).toEqual([
      { code: 'ca.ag_may_not_operate', registryStatus: null },
      { code: 'ca.ag_status_undetermined', registryStatus: null },
      {
        code: 'ca.ag_not_operating_or_dissolving',
        registryStatus: null,
      },
    ])
  })

  it('flags source legal-name mismatches', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'may_operate_or_solicit',
              registryStatus: 'Current',
              name: 'Different Foundation',
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Legal name mismatch in CA AG Registry',
      evidence: {
        code: 'cross_source.legal_name_mismatch',
        entityLegalName: 'Foo Foundation',
        sourceLegalName: 'Different Foundation',
      },
    })
  })

  it('flags missing CA AG last-renewal evidence when the registry row is found', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        {
          ...SOURCE,
          outcome: {
            status: 'success',
            output: output({
              matchStatus: 'found',
              listCategory: 'may_operate_or_solicit',
              registryStatus: 'Current',
              name: 'Foo Foundation',
              lastRenewal: '',
            }),
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'CA AG Registry row has no last-renewal date',
      evidence: { code: 'ca.ag_last_renewal_missing' },
    })
  })

  it('flags automated FTB Entity Status Letter payloads that do not verify California exemption', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        ftbRun({
          matchStatus: 'found',
          entity_id: '6423690',
          entity_name: 'FOO FOUNDATION',
          ftb_status: 'ACTIVE',
          exempt_status_verified: 'NOT EXEMPT',
        }),
      ],
      now: () => new Date('2026-05-03T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'ca-ftb-entity-status-letter',
      severity: 'warn',
      title: 'California FTB exempt status is not verified',
      detail:
        'The public California FTB Entity Status Letter does not verify California exempt status.',
      evidence: {
        code: 'ca.ftb.exempt_status_not_verified',
        exemptStatusVerified: 'NOT EXEMPT',
      },
    })
  })

  it('does not flag automated FTB Entity Status Letter payloads with verified exemption', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        ftbRun({
          matchStatus: 'found',
          entity_id: '6423690',
          entity_name: 'FOO FOUNDATION',
          ftb_status: 'ACTIVE',
          exempt_status_verified: 'EXEMPT',
        }),
      ],
      now: () => new Date('2026-05-03T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('flags automated FTB Entity Status Letter not-found results', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        ftbRun({
          matchStatus: 'not_found',
          search: { field: 'Entity ID', value: '6423690' },
        }),
      ],
      now: () => new Date('2026-05-03T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Entity not found in CA FTB Entity Status Letter',
      evidence: { code: 'ca.ftb.entity_status_letter_not_found' },
    })
  })

  it('ignores malformed FTB Entity Status Letter payloads instead of inventing findings', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [ftbRun({ unexpected: true })],
      now: () => new Date('2026-05-03T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('does not flag automated CA SOS bizfile payloads with active status and matching name', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        sosRun({
          matchStatus: 'found',
          entity_name: 'Foo Foundation',
          sos_entity_number: 'C0123456',
          entity_status: 'Active',
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('flags automated CA SOS bizfile payloads when the configured entity is not found', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        sosRun({
          matchStatus: 'not_found',
          search: { field: 'SOS Entity Number', value: '0123456' },
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'ca-sos-bizfile',
      severity: 'warn',
      title: 'Entity not found in CA SOS bizfile',
      detail:
        'The public California Secretary of State bizfile search did not return the configured entity.',
      evidence: { code: 'ca.sos.bizfile_not_found' },
    })
  })

  it('flags automated CA SOS bizfile payloads with non-active status', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        sosRun({
          matchStatus: 'found',
          entity_name: 'Foo Foundation',
          sos_entity_number: 'C0123456',
          entity_status: 'Suspended',
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'ca-sos-bizfile',
      severity: 'error',
      title: 'CA SOS bizfile status is not active',
      detail:
        'The public California Secretary of State bizfile search lists entity status "Suspended".',
      evidence: {
        code: 'ca.sos.bizfile_not_active',
        entityStatus: 'Suspended',
      },
    })
  })

  it('flags legal-name mismatches in automated CA SOS bizfile payloads', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        sosRun({
          matchStatus: 'found',
          entity_name: 'Different Foundation',
          sos_entity_number: 'C0123456',
          entity_status: 'Active',
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title: 'Legal name mismatch in CA SOS bizfile',
      evidence: {
        code: 'cross_source.legal_name_mismatch',
        entityLegalName: 'Foo Foundation',
        sourceLegalName: 'Different Foundation',
      },
    })
  })

  it('ignores malformed CA SOS bizfile payloads instead of inventing findings', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [sosRun({ unexpected: true })],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('does not flag automated CDTFA public verification payloads when the permit is valid and name matches', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        cdtfaRun({
          matchStatus: 'found',
          account_type: 'Sellers Permit',
          account_number: '202-822944',
          verification_status: 'This is a valid Sellers Permit.',
          is_valid: true,
          owner_name: 'FOO FOUNDATION',
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })

  it('flags automated CDTFA public verification payloads when the permit is invalid', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        cdtfaRun({
          matchStatus: 'found',
          account_type: 'Sellers Permit',
          account_number: '999-999999',
          verification_status: 'This Sellers Permit is invalid.',
          is_valid: false,
          owner_name: null,
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      jurisdiction_id: 'us-ca',
      source_id: 'ca-cdtfa-permit-license-verification',
      severity: 'warn',
      title: 'CA CDTFA public verification says account is invalid',
      detail:
        'The public CA CDTFA permit, license, or account verification page says Sellers Permit 999-999999 is invalid.',
      evidence: {
        code: 'ca.cdtfa.public_verification_invalid',
        accountType: 'Sellers Permit',
        accountNumber: '999-999999',
        verificationStatus: 'This Sellers Permit is invalid.',
      },
    })
  })

  it('flags legal-name mismatches in automated CDTFA public verification payloads', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [
        cdtfaRun({
          matchStatus: 'found',
          account_type: 'Sellers Permit',
          account_number: '202-822944',
          verification_status: 'This is a valid Sellers Permit.',
          is_valid: true,
          owner_name: 'Different Foundation',
        }),
      ],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      title:
        'Legal name mismatch in CA CDTFA public permit, license, or account verification',
      evidence: {
        code: 'cross_source.legal_name_mismatch',
        entityLegalName: 'Foo Foundation',
        sourceLegalName: 'Different Foundation',
      },
    })
  })

  it('ignores malformed CDTFA public verification payloads instead of inventing findings', () => {
    const findings = deriveComplianceFindings({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      runs: [cdtfaRun({ unexpected: true })],
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    })

    expect(findings).toEqual([])
  })
})
