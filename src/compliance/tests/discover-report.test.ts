import { describe, expect, it } from 'vitest'
import {
  formatDiscoveryReport,
  isDiscoveryComplete,
} from '../skills/discover-report.ts'
import type { DiscoveryReport } from '../skills/discover.ts'
import type { Entity, EntityIdentifiers, Finding } from '../types/index.ts'

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

function finding(args: {
  severity: Finding['severity']
  title: string
  jurisdiction: string
  source: string
}): Finding {
  return {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: args.jurisdiction,
    source_id: args.source,
    severity: args.severity,
    status: 'open',
    title: args.title,
    detail: 'detail',
    evidence: {},
    opened_at: '2026-04-28T12:00:00.000Z',
    resolved_at: null,
  }
}

function report(findings: readonly Finding[] = []): DiscoveryReport {
  return {
    entity: ENTITY,
    identifiers: IDENTIFIERS,
    migration: {
      createdDataset: false,
      createdTables: [],
      skippedTables: [],
      addedColumns: [],
      updatedViews: [],
    },
    findings,
    runs: [
      {
        sourceId: 'irs-eo-bmf',
        jurisdictionId: 'us-federal',
        description: 'IRS EO BMF',
        accessMethod: 'official_bulk_download',
        automationAllowed: true,
        outcome: {
          status: 'success',
          output: {
            record: {
              record_id: '550e8400-e29b-41d4-a716-446655440000',
              source_id: 'irs-eo-bmf',
              fetched_at: '2026-04-28T12:00:00.000Z',
              payload: { matchStatus: 'found' },
            },
            findings: [],
          },
        },
      },
      {
        sourceId: 'ca-sos-bizfile',
        jurisdictionId: 'us-ca',
        description: 'CA SOS bizfile',
        accessMethod: 'manual',
        automationAllowed: false,
        outcome: {
          status: 'manual_required',
          source_id: 'ca-sos-bizfile',
          instructions: ['Open bizfile.'],
          evidenceFields: [
            { key: 'entity_status', label: 'Entity status', required: true },
          ],
        },
      },
      {
        sourceId: 'ca-ag-registry',
        jurisdictionId: 'us-ca',
        description: 'CA AG Registry',
        accessMethod: 'official_bulk_download',
        automationAllowed: true,
        outcome: {
          status: 'source_failure',
          source_id: 'ca-ag-registry',
          error_type: 'parse',
          message: 'CSV schema changed',
        },
      },
    ],
  }
}

describe('formatDiscoveryReport', () => {
  it('renders source states distinctly and never reports all clear with gaps', () => {
    const rendered = formatDiscoveryReport(report())

    expect(rendered).toContain('Status: incomplete')
    expect(rendered).toContain(
      '- ERROR us-ca/ca-ag-registry: failed (parse) CSV schema changed',
    )
    expect(rendered).toContain(
      '- MANUAL us-ca/ca-sos-bizfile: manual verification required',
    )
    expect(rendered).toContain('- OK us-federal/irs-eo-bmf: success')
    expect(rendered).not.toContain('all clear')
  })

  it('orders findings by severity, jurisdiction, then source', () => {
    const rendered = formatDiscoveryReport(
      report([
        finding({
          severity: 'info',
          title: 'Informational',
          jurisdiction: 'us-federal',
          source: 'irs-teos',
        }),
        finding({
          severity: 'error',
          title: 'Action required',
          jurisdiction: 'us-ca',
          source: 'ca-ag-registry',
        }),
        finding({
          severity: 'warn',
          title: 'Action recommended',
          jurisdiction: 'us-ca',
          source: 'ca-sos-bizfile',
        }),
      ]),
    )

    const errorIndex = rendered.indexOf('Action required')
    const warnIndex = rendered.indexOf('Action recommended')
    const infoIndex = rendered.indexOf('Informational')
    expect(errorIndex).toBeLessThan(warnIndex)
    expect(warnIndex).toBeLessThan(infoIndex)
  })

  it('orders same-severity findings by jurisdiction, source, then title', () => {
    const rendered = formatDiscoveryReport(
      report([
        finding({
          severity: 'warn',
          title: 'Zulu',
          jurisdiction: 'us-federal',
          source: 'irs-teos',
        }),
        finding({
          severity: 'warn',
          title: 'Alpha',
          jurisdiction: 'us-ca',
          source: 'ca-sos-bizfile',
        }),
        finding({
          severity: 'warn',
          title: 'Beta',
          jurisdiction: 'us-ca',
          source: 'ca-sos-bizfile',
        }),
        finding({
          severity: 'warn',
          title: 'Gamma',
          jurisdiction: 'us-ca',
          source: 'ca-ag-registry',
        }),
      ]),
    )

    const gammaIndex = rendered.indexOf('Gamma')
    const alphaIndex = rendered.indexOf('Alpha')
    const betaIndex = rendered.indexOf('Beta')
    const zuluIndex = rendered.indexOf('Zulu')
    expect(gammaIndex).toBeLessThan(alphaIndex)
    expect(alphaIndex).toBeLessThan(betaIndex)
    expect(betaIndex).toBeLessThan(zuluIndex)
  })

  it('renders policy, auth, and migration states explicitly', () => {
    const base = report()
    const rendered = formatDiscoveryReport({
      ...base,
      migration: {
        createdDataset: true,
        createdTables: ['findings'],
        skippedTables: [],
        addedColumns: ['discovery_runs.payload'],
        updatedViews: ['current_open_findings'],
      },
      runs: [
        {
          sourceId: 'policy-source',
          jurisdictionId: 'us-ca',
          description: 'Policy source',
          accessMethod: 'manual',
          automationAllowed: false,
          outcome: {
            status: 'policy_blocked',
            source_id: 'policy-source',
            reason: 'No permitted automated access path was found.',
          },
        },
        {
          sourceId: 'auth-source',
          jurisdictionId: 'us-federal',
          description: 'Auth source',
          accessMethod: 'official_api',
          automationAllowed: true,
          outcome: {
            status: 'auth_required',
            source_id: 'auth-source',
            message: 'Authentication is required.',
          },
        },
      ],
    })

    expect(rendered).toContain(
      '- BLOCKED us-ca/policy-source: No permitted automated access path was found.',
    )
    expect(rendered).toContain(
      '- AUTH us-federal/auth-source: Authentication is required.',
    )
    expect(rendered).toContain(
      'Compliance storage was provisioned or migrated during this run.',
    )
  })

  it('renders complete status when every source succeeds and no findings remain', () => {
    const complete = report()
    const rendered = formatDiscoveryReport({
      ...complete,
      runs: complete.runs.filter((run) => run.outcome.status === 'success'),
      findings: [],
    })

    expect(rendered).toContain('Status: complete')
    expect(rendered).toContain('- None.')
  })

  it('renders complete status when every source succeeds and findings are informational', () => {
    const complete = report()
    const rendered = formatDiscoveryReport({
      ...complete,
      runs: complete.runs.filter((run) => run.outcome.status === 'success'),
      findings: [
        finding({
          severity: 'info',
          title: 'EIN listed in IRS Pub. 78',
          jurisdiction: 'us-federal',
          source: 'irs-teos',
        }),
      ],
    })

    expect(rendered).toContain('Status: complete')
    expect(
      isDiscoveryComplete({
        ...complete,
        runs: complete.runs.filter((run) => run.outcome.status === 'success'),
        findings: [
          finding({
            severity: 'warn',
            title: 'Manual verification required',
            jurisdiction: 'us-ca',
            source: 'ca-sos-bizfile',
          }),
        ],
      }),
    ).toBe(false)
  })
})

describe('isDiscoveryComplete', () => {
  it('is false when any source is failed or manual', () => {
    expect(isDiscoveryComplete(report())).toBe(false)
  })

  it('is false when all sources succeed but findings remain open', () => {
    const incomplete = report([
      finding({
        severity: 'warn',
        title: 'Action recommended',
        jurisdiction: 'us-ca',
        source: 'ca-sos-bizfile',
      }),
    ])

    expect(
      isDiscoveryComplete({
        ...incomplete,
        runs: incomplete.runs.filter((run) => run.outcome.status === 'success'),
      }),
    ).toBe(false)
  })

  it('is true only when every source succeeds and no findings are open', () => {
    const complete = report()
    const successOnly: DiscoveryReport = {
      ...complete,
      runs: complete.runs.filter((run) => run.outcome.status === 'success'),
      findings: [],
    }

    expect(isDiscoveryComplete(successOnly)).toBe(true)
  })
})
