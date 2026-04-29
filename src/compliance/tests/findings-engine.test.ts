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
  accessUrl: 'https://www.oag.ca.gov/charities/reports',
  accessMethod: 'official_bulk_download',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-04-28T00:00:00.000Z',
    upstreamPublishedAt: '2026-04-15',
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
            message: 'CSV schema changed',
          },
        },
      ],
      now: () => new Date('2026-04-28T12:00:00.000Z'),
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'error',
      title: 'Source failed: CA AG Registry',
      detail: 'ca-ag-registry could not be read: CSV schema changed',
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
    })
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

  it('flags CA AG not-found results from the official Registry reports', () => {
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
      title: 'Entity not found in CA AG Registry reports',
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
      title: 'CA AG Registry reports not operating or dissolving status',
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
})
