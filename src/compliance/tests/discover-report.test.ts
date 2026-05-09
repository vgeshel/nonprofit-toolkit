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
  'us-ca': {
    sosEntityNumber: 'C0123456',
    agCharityNumber: 'CT1234567',
    ftbEntityId: 'FTB-1234567',
    ftbEntityName: 'Foo Foundation',
    cdtfaSellerPermitNumber: 'SRKH123456789',
    cdtfaUseTaxAccountNumber: 'UT-123456',
    cdtfaSpecialTaxAccountNumber: 'ST-123456',
  },
}

function finding(args: {
  severity: Finding['severity']
  title: string
  jurisdiction: string
  source: string
  detail?: string
}): Finding {
  return {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: args.jurisdiction,
    source_id: args.source,
    severity: args.severity,
    status: 'open',
    title: args.title,
    detail: args.detail ?? 'detail',
    evidence: {},
    opened_at: '2026-04-28T12:00:00.000Z',
    resolved_at: null,
  }
}

function report(findings: readonly Finding[] = []): DiscoveryReport {
  const manualRun: DiscoveryReport['runs'][number] & {
    readonly accessUrl: string
    readonly manualOnlyReason: string
    readonly tosUrl: string
  } = {
    sourceId: 'ca-sos-bizfile',
    jurisdictionId: 'us-ca',
    description: 'CA SOS bizfile',
    accessMethod: 'manual',
    automationAllowed: false,
    accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
    tosUrl:
      'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use',
    manualOnlyReason:
      'CA SOS bizfile terms prohibit automated collection by robots or spiders.',
    outcome: {
      status: 'manual_required',
      source_id: 'ca-sos-bizfile',
      instructions: [
        'Open bizfile.',
        'Search for the exact SOS entity number.',
      ],
      evidenceFields: [
        { key: 'entity_status', label: 'Entity status', required: true },
        { key: 'status_date', label: 'Status date', required: false },
      ],
    },
  }

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
        accessUrl: 'https://www.irs.gov/charities-non-profits',
        accessMethod: 'official_bulk_download',
        automationAllowed: true,
        tosUrl: 'https://www.irs.gov/privacy-disclosure/irs-privacy-policy',
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
      manualRun,
      {
        sourceId: 'ca-ag-registry',
        jurisdictionId: 'us-ca',
        description: 'CA AG Registry',
        accessUrl:
          'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y',
        accessMethod: 'official_public_page',
        automationAllowed: true,
        tosUrl: 'https://www.oag.ca.gov/privacy',
        outcome: {
          status: 'source_failure',
          source_id: 'ca-ag-registry',
          error_type: 'parse',
          message: 'Registry Search Tool schema changed',
        },
      },
    ],
  }
}

function actionRequiredSection(rendered: string): string {
  const start = rendered.indexOf('## Action Required')
  const end = rendered.indexOf('## Source Runs')
  if (start === -1 || end === -1) {
    return ''
  }
  return rendered.slice(start, end)
}

describe('formatDiscoveryReport', () => {
  it('renders source states distinctly and never reports all clear with gaps', () => {
    const rendered = formatDiscoveryReport(report())

    expect(rendered).toContain('Status: incomplete')
    expect(rendered).toContain('## Action Required')
    expect(rendered.indexOf('## Action Required')).toBeLessThan(
      rendered.indexOf('## Source Runs'),
    )
    expect(rendered).toContain(
      'Discovery is incomplete until these manual or authenticated checks are completed.',
    )
    const actionSection = actionRequiredSection(rendered)
    expect(rendered).toContain(
      'Open CA Secretary of State bizfile: https://bizfileonline.sos.ca.gov/search/business',
    )
    expect(actionSection).toContain(
      'Search for this SOS entity number: C0123456.',
    )
    expect(rendered).toContain(
      'Reply in plain sentences or bullets. I will map your answers into structured compliance evidence.',
    )
    expect(rendered).toContain(
      '- ERROR CA Attorney General Registry Search Tool: failed (parse) Registry Search Tool schema changed',
    )
    expect(rendered).toContain(
      '- MANUAL CA Secretary of State bizfile: manual verification required',
    )
    expect(rendered).toContain(
      '- OK IRS Exempt Organizations Business Master File: success',
    )
    expect(actionSection).not.toContain('us-ca/ca-sos-bizfile')
    expect(actionSection).not.toContain('entity_status')
    expect(rendered).not.toContain('all clear')
  })

  it('uses official URLs, human source names, and configured values in the manual walkthrough', () => {
    const base = report()
    const caSosRun = base.runs[1]
    expect(caSosRun).toBeDefined()
    if (caSosRun === undefined) return

    const rendered = formatDiscoveryReport({
      ...base,
      runs: [
        caSosRun,
        {
          sourceId: 'ca-ftb-entity-status-letter',
          jurisdictionId: 'us-ca',
          description: 'CA FTB Entity Status Letter',
          accessUrl: 'https://webapp.ftb.ca.gov/eletter/',
          accessMethod: 'manual',
          automationAllowed: false,
          tosUrl:
            'https://www.ftb.ca.gov/help/business/entity-status-letter.asp',
          manualOnlyReason:
            'Automated read-only form use has not been approved.',
          outcome: {
            status: 'manual_required',
            source_id: 'ca-ftb-entity-status-letter',
            instructions: ['Use the lookup form.'],
            evidenceFields: [
              { key: 'ftb_status', label: 'FTB status', required: true },
              {
                key: 'exempt_status_verified',
                label: 'Exempt status verified',
                required: false,
              },
              {
                key: 'letter_date',
                label: 'Letter date',
                required: false,
              },
            ],
          },
        },
        {
          sourceId: 'ca-cdtfa-permit-license-verification',
          jurisdictionId: 'us-ca',
          description: 'CDTFA Permit License Verification',
          accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
          accessMethod: 'manual',
          automationAllowed: false,
          tosUrl: 'https://www.cdtfa.ca.gov/use.htm',
          manualOnlyReason:
            'No documented automated read-only request shape was identified.',
          outcome: {
            status: 'manual_required',
            source_id: 'ca-cdtfa-permit-license-verification',
            instructions: ['Use the permit verification page.'],
            evidenceFields: [
              {
                key: 'account_type',
                label: 'Account type',
                required: true,
              },
              {
                key: 'account_number',
                label: 'Account number',
                required: true,
              },
              {
                key: 'verification_status',
                label: 'Verification status',
                required: true,
              },
              { key: 'owner_name', label: 'Owner name', required: false },
              { key: 'status_date', label: 'Status date', required: false },
            ],
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(actionSection).toContain(
      'Open CA Franchise Tax Board Entity Status Letter: https://webapp.ftb.ca.gov/eletter/',
    )
    expect(actionSection).toContain(
      'Search for this FTB entity ID: FTB-1234567.',
    )
    expect(actionSection).toContain(
      'Use this exact legal name if the site asks for a name: Foo Foundation.',
    )
    expect(actionSection).toContain(
      'Open CA CDTFA Permit, License, or Account Verification: https://onlineservices.cdtfa.ca.gov/',
    )
    expect(actionSection).toContain(
      'Search these CDTFA account identifiers: SRKH123456789, UT-123456, ST-123456.',
    )
    expect(actionSection).not.toContain('ca-ftb-entity-status-letter')
    expect(actionSection).not.toContain('ftb_status')
    expect(actionSection).not.toContain('ca-cdtfa-permit-license-verification')
    expect(actionSection).not.toContain('verification_status')
  })

  it('prints complete organization context before manual and authenticated website steps', () => {
    const rendered = formatDiscoveryReport({
      ...report(),
      entity: {
        ...ENTITY,
        mailing_address_line2: 'Suite 200',
      },
      identifiers: {
        'us-federal': { ein: '12-3456789' },
        'us-ca': {
          sosEntityNumber: 'C0123456',
          ftbEntityId: 'FTB-1234567',
          ftbEntityName: 'Foo Foundation',
          cdtfaSellerPermitNumber: 'SRKH123456789',
          cdtfaUseTaxAccountNumber: 'UT-123456',
          cdtfaSpecialTaxAccountNumber: 'ST-123456',
        },
      },
      runs: [
        {
          sourceId: 'irs-eo-bmf',
          jurisdictionId: 'us-federal',
          description: 'IRS EO BMF',
          accessUrl: 'https://www.irs.gov/charities-non-profits',
          accessMethod: 'official_bulk_download',
          automationAllowed: true,
          tosUrl: 'https://www.irs.gov/privacy-disclosure/irs-privacy-policy',
          outcome: {
            status: 'success',
            output: {
              record: {
                record_id: '550e8400-e29b-41d4-a716-446655440000',
                source_id: 'irs-eo-bmf',
                fetched_at: '2026-04-28T12:00:00.000Z',
                payload: {
                  row: {
                    ruling: '201005',
                  },
                },
              },
              findings: [],
            },
          },
        },
        {
          sourceId: 'ca-ag-registry',
          jurisdictionId: 'us-ca',
          description: 'CA AG Registry',
          accessUrl:
            'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y',
          accessMethod: 'official_public_page',
          automationAllowed: true,
          tosUrl: 'https://www.oag.ca.gov/privacy',
          outcome: {
            status: 'success',
            output: {
              record: {
                record_id: '550e8400-e29b-41d4-a716-446655440002',
                source_id: 'ca-ag-registry',
                fetched_at: '2026-04-28T12:00:00.000Z',
                payload: {
                  registryStatus: 'Current',
                  stateCharityRegistrationNumber: 'CT1234567',
                  effectiveDate: '2024/03/20',
                  issueDate: '2024/03/19',
                  renewalDueDate: '2026/05/15',
                  lastRenewal: '2025/07/15',
                },
              },
              findings: [],
            },
          },
        },
        {
          sourceId: 'ca-sos-bizfile',
          jurisdictionId: 'us-ca',
          description: 'CA SOS bizfile',
          accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
          accessMethod: 'manual',
          automationAllowed: false,
          tosUrl:
            'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use',
          manualOnlyReason:
            'CA SOS bizfile terms prohibit automated collection.',
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
          sourceId: 'ca-ftb-myftb',
          jurisdictionId: 'us-ca',
          description: 'MyFTB',
          accessUrl: 'https://www.ftb.ca.gov/myftb/',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl:
            'https://www.ftb.ca.gov/myftb/general-terms-and-conditions.html',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ftb-myftb',
            message: 'Authentication is required.',
            loginUrl: 'https://www.ftb.ca.gov/myftb/',
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(actionSection).toContain('Use these exact values if a site asks:')
    expect(actionSection).toContain('- Legal entity name: Foo Foundation')
    expect(actionSection).toContain('- FEIN: 12-3456789')
    expect(actionSection).toContain('- State of incorporation: CA')
    expect(actionSection).toContain(
      '- State registration or formation date: 2010-01-15',
    )
    expect(actionSection).toContain(
      '- Mailing address: 1 Mission St Suite 200, San Francisco, CA 94105, US',
    )
    expect(actionSection).toContain('- California SOS entity number: C0123456')
    expect(actionSection).toContain(
      '- California AG charity registration number: CT1234567',
    )
    expect(actionSection).toContain('- FTB entity ID: FTB-1234567')
    expect(actionSection).toContain('- FTB entity name: Foo Foundation')
    expect(actionSection).toContain(
      '- CDTFA account identifiers: SRKH123456789, UT-123456, ST-123456',
    )
    expect(actionSection).toContain(
      '- IRS ruling or registration date from IRS EO BMF: 2010-05',
    )
    expect(actionSection).toContain('- CA AG registry status: Current')
    expect(actionSection).toContain('- CA AG registry status date: 2024/03/20')
    expect(actionSection).toContain(
      '- CA AG renewal due or expiration date: 2026/05/15',
    )
    expect(actionSection).toContain('- CA AG issue date: 2024/03/19')
    expect(actionSection).toContain('- CA AG effective date: 2024/03/20')
    expect(actionSection).toContain('- CA AG last renewal: 2025/07/15')
    expect(actionSection.indexOf('Use these exact values')).toBeLessThan(
      actionSection.indexOf('Manual checks:'),
    )
  })

  it('prints the California SOS entity number as the FTB entity ID fallback when no dedicated FTB ID is configured', () => {
    const rendered = formatDiscoveryReport({
      ...report(),
      identifiers: {
        ...IDENTIFIERS,
        'us-ca': {
          sosEntityNumber: '6423690',
          agCharityNumber: 'CT1234567',
        },
      },
      runs: [
        {
          sourceId: 'ca-ftb-myftb',
          jurisdictionId: 'us-ca',
          description: 'FTB MyFTB',
          accessUrl: 'https://www.ftb.ca.gov/myftb/',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl:
            'https://www.ftb.ca.gov/myftb/general-terms-and-conditions.html',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ftb-myftb',
            message: 'Authentication is required.',
            loginUrl: 'https://www.ftb.ca.gov/myftb/',
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(actionSection).toContain(
      '- FTB entity ID: 6423690 (using California SOS entity number)',
    )
    expect(actionSection).toContain(
      'Open the business account for this FTB entity ID: 6423690.',
    )
  })

  it('uses configured values for authenticated California walkthroughs without re-asking for CA AG public status', () => {
    const base = report()
    const rendered = formatDiscoveryReport({
      ...base,
      runs: [
        {
          sourceId: 'ca-ag-online-filing',
          jurisdictionId: 'us-ca',
          description: 'CA AG Online Renewal System',
          accessUrl: 'https://rct.doj.ca.gov/eGov/Home.aspx',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl: 'https://oag.ca.gov/privacy',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ag-online-filing',
            message: 'Authentication is required.',
            loginUrl: 'https://rct.doj.ca.gov/eGov/Home.aspx',
          },
        },
        {
          sourceId: 'ca-ftb-myftb',
          jurisdictionId: 'us-ca',
          description: 'MyFTB',
          accessUrl: 'https://www.ftb.ca.gov/myftb/',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl:
            'https://www.ftb.ca.gov/myftb/general-terms-and-conditions.html',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ftb-myftb',
            message: 'Authentication is required.',
            loginUrl: 'https://www.ftb.ca.gov/myftb/',
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(actionSection).not.toContain(
      'CA Attorney General Online Renewal System',
    )
    expect(actionSection).not.toContain('rct.doj.ca.gov/eGov/Home.aspx')
    expect(actionSection).not.toContain('Open the renewal account')
    expect(actionSection).toContain(
      'Open CA Franchise Tax Board MyFTB: https://www.ftb.ca.gov/myftb/',
    )
    expect(actionSection).toContain(
      'Open the business account for this FTB entity ID: FTB-1234567.',
    )
    expect(actionSection).not.toContain('ca-ag-online-filing')
    expect(actionSection).not.toContain('online_filing_access')
    expect(actionSection).not.toContain('ca-ftb-myftb')
    expect(actionSection).not.toContain('business_account_access')
    expect(rendered).toContain(
      '- INFO CA Attorney General Online Renewal System: optional dashboard review not required because CA AG public registry status is checked automatically',
    )
  })

  it('falls back to legal names and clear CDTFA guidance when identifiers are absent', () => {
    const base = report()
    const caSosRun = base.runs[1]
    expect(caSosRun).toBeDefined()
    if (caSosRun === undefined) return

    const rendered = formatDiscoveryReport({
      ...base,
      identifiers: {},
      runs: [
        caSosRun,
        {
          sourceId: 'ca-ftb-entity-status-letter',
          jurisdictionId: 'us-ca',
          description: 'CA FTB Entity Status Letter',
          accessUrl: 'https://webapp.ftb.ca.gov/eletter/',
          accessMethod: 'manual',
          automationAllowed: false,
          tosUrl:
            'https://www.ftb.ca.gov/help/business/entity-status-letter.asp',
          manualOnlyReason:
            'Automated read-only form use has not been approved.',
          outcome: {
            status: 'manual_required',
            source_id: 'ca-ftb-entity-status-letter',
            instructions: ['Use the lookup form.'],
            evidenceFields: [
              { key: 'ftb_status', label: 'FTB status', required: true },
            ],
          },
        },
        {
          sourceId: 'ca-cdtfa-permit-license-verification',
          jurisdictionId: 'us-ca',
          description: 'CDTFA Permit License Verification',
          accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
          accessMethod: 'manual',
          automationAllowed: false,
          tosUrl: 'https://www.cdtfa.ca.gov/use.htm',
          manualOnlyReason:
            'No documented automated read-only request shape was identified.',
          outcome: {
            status: 'manual_required',
            source_id: 'ca-cdtfa-permit-license-verification',
            instructions: ['Use the permit verification page.'],
            evidenceFields: [
              {
                key: 'verification_status',
                label: 'Verification status',
                required: true,
              },
            ],
          },
        },
        {
          sourceId: 'ca-ag-online-filing',
          jurisdictionId: 'us-ca',
          description: 'CA AG Online Renewal System',
          accessUrl: 'https://rct.doj.ca.gov/eGov/Home.aspx',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl: 'https://oag.ca.gov/privacy',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ag-online-filing',
            message: 'Authentication is required.',
          },
        },
        {
          sourceId: 'ca-ftb-myftb',
          jurisdictionId: 'us-ca',
          description: 'MyFTB',
          accessUrl: 'https://www.ftb.ca.gov/myftb/',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl:
            'https://www.ftb.ca.gov/myftb/general-terms-and-conditions.html',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-ftb-myftb',
            message: 'Authentication is required.',
            loginUrl: 'https://www.ftb.ca.gov/myftb/',
          },
        },
        {
          sourceId: 'ca-cdtfa-online-services',
          jurisdictionId: 'us-ca',
          description: 'CDTFA Online Services',
          accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl: 'https://www.cdtfa.ca.gov/use.htm',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-cdtfa-online-services',
            message: 'Authentication is required.',
            loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(actionSection).toContain(
      'Search for this exact legal name: Foo Foundation.',
    )
    expect(actionSection).not.toContain(
      'CA Attorney General Online Renewal System',
    )
    expect(actionSection).not.toContain('Open the renewal account')
    expect(actionSection).toContain(
      'Open the business account for this exact legal name: Foo Foundation.',
    )
    expect(actionSection).toContain(
      'No CDTFA account identifier is configured. If the organization has a CDTFA permit, license, or account number, use that number; otherwise tell me no CDTFA account identifier is available.',
    )
    expect(actionSection).toContain(
      'No CDTFA account identifier is configured. If the portal shows a CDTFA-managed account for this organization, use that account; otherwise tell me no CDTFA-managed account is present.',
    )
  })

  it('uses readable fallback names and result labels for unknown sources', () => {
    const base = report([
      finding({
        severity: 'warn',
        title: 'Custom source needs attention',
        jurisdiction: 'us-ca',
        source: 'custom-source',
      }),
    ])
    const rendered = formatDiscoveryReport({
      ...base,
      runs: [
        {
          sourceId: 'local-manual-source',
          jurisdictionId: 'us-ca',
          description: 'Manual Local Source.',
          accessUrl: 'https://example.com/manual',
          accessMethod: 'manual',
          automationAllowed: false,
          tosUrl: 'https://example.com/tos',
          manualOnlyReason: 'No permitted automated access path was found.',
          outcome: {
            status: 'manual_required',
            source_id: 'local-manual-source',
            instructions: ['Open the local source.'],
            evidenceFields: [
              { key: 'status', label: 'Status', required: true },
              {
                key: 'reviewed_date',
                label: 'Reviewed date',
                required: false,
              },
            ],
          },
        },
        {
          sourceId: 'portal-review',
          jurisdictionId: 'us-ca',
          description: 'User-assisted Portal Review.',
          accessUrl: 'https://example.com/portal',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl: 'https://example.com/tos',
          outcome: {
            status: 'auth_required',
            source_id: 'portal-review',
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
            ],
            mfa: 'user_assisted',
            instructions: ['Sign in.'],
            evidenceFields: [
              { key: 'status', label: 'Status', required: true },
              {
                key: 'reviewed_date',
                label: 'Reviewed date',
                required: false,
              },
            ],
            forbiddenActions: ['Do not submit changes.'],
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(actionSection).toContain('Local Source:')
    expect(actionSection).toContain(
      'Tell me these results: Status (required), Reviewed date if shown.',
    )
    expect(actionSection).toContain('Portal Review:')
    expect(rendered).toContain(
      '- WARN Custom Source: Custom source needs attention - detail',
    )
    expect(rendered).not.toContain('local-manual-source')
    expect(rendered).not.toContain('portal-review')
    expect(rendered).not.toContain('custom-source')
    expect(rendered).not.toContain('reviewed_date')
  })

  it('renders detailed manual evidence instructions for manual-required sources', () => {
    const rendered = formatDiscoveryReport(report())

    expect(rendered).toContain(
      'Why automatic scan is unavailable: CA SOS bizfile terms prohibit automated collection by robots or spiders.',
    )
    expect(rendered).toContain(
      'Official URL: https://bizfileonline.sos.ca.gov/search/business',
    )
    expect(rendered).toContain('Manual steps:')
    expect(rendered).toContain(
      '1. Open CA Secretary of State bizfile: https://bizfileonline.sos.ca.gov/search/business',
    )
    expect(rendered).toContain(
      '2. Search for this SOS entity number: C0123456.',
    )
    expect(rendered).toContain(
      'Tell me these values after you complete the check:',
    )
    expect(rendered).toContain('- Entity status (required)')
    expect(rendered).toContain('- Status date if shown')
    expect(rendered).not.toContain('source: us-ca/ca-sos-bizfile')
    expect(rendered).not.toContain('entity_status: <Entity status>')
  })

  it('uses a clear fallback when a manual-required run lacks a reason', () => {
    const base = report()
    const rendered = formatDiscoveryReport({
      ...base,
      runs: base.runs.map((run) => {
        if (run.outcome.status !== 'manual_required') {
          return run
        }
        return { ...run, manualOnlyReason: undefined }
      }),
    })

    expect(rendered).toContain(
      'Why automatic scan is unavailable: No manual-only reason was captured for this source.',
    )
    expect(rendered).not.toContain('undefined')
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

  it('renders finding detail with human source names instead of internal ids', () => {
    const rendered = formatDiscoveryReport(
      report([
        finding({
          severity: 'warn',
          title: 'Manual verification required',
          jurisdiction: 'us-ca',
          source: 'ca-sos-bizfile',
          detail:
            'ca-sos-bizfile cannot be automatically checked under the current source policy.',
        }),
        finding({
          severity: 'warn',
          title: 'Authentication required',
          jurisdiction: 'us-ca',
          source: 'ca-ftb-myftb',
          detail:
            'Source "ca-ftb-myftb" requires an authenticated user session.',
        }),
      ]),
    )

    expect(rendered).toContain(
      'CA Secretary of State bizfile cannot be automatically checked under the current source policy.',
    )
    expect(rendered).toContain(
      'CA Franchise Tax Board MyFTB requires an authenticated user session.',
    )
    expect(rendered).not.toContain('ca-sos-bizfile cannot')
    expect(rendered).not.toContain('Source "ca-ftb-myftb"')
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
          accessUrl: 'https://example.com/policy-source',
          accessMethod: 'manual',
          automationAllowed: false,
          manualOnlyReason: 'No permitted automated access path was found.',
          tosUrl: 'https://example.com/tos',
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
          accessUrl: 'https://example.com/auth-source',
          accessMethod: 'official_api',
          automationAllowed: true,
          tosUrl: 'https://example.com/tos',
          outcome: {
            status: 'auth_required',
            source_id: 'auth-source',
            message: 'Authentication is required.',
          },
        },
      ],
    })

    expect(rendered).toContain(
      '- BLOCKED Policy source: No permitted automated access path was found.',
    )
    expect(rendered).toContain(
      '- AUTH Auth source: Authentication is required.',
    )
    expect(rendered).toContain(
      'Compliance storage was provisioned or migrated during this run.',
    )
  })

  it('renders detailed auth-required instructions without credential values', () => {
    const base = report()
    const rendered = formatDiscoveryReport({
      ...base,
      runs: [
        {
          sourceId: 'ca-cdtfa-online-services',
          jurisdictionId: 'us-ca',
          description: 'CDTFA Online Services',
          accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
          accessMethod: 'playwright_readonly',
          automationAllowed: true,
          tosUrl: 'https://www.cdtfa.ca.gov/use.htm',
          outcome: {
            status: 'auth_required',
            source_id: 'ca-cdtfa-online-services',
            message:
              'Source "ca-cdtfa-online-services" requires an authenticated user session.',
            loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
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
              {
                key: 'backup_code',
                label: 'Backup code',
                required: false,
                secret: true,
              },
            ],
            mfa: 'user_assisted',
            instructions: [
              'Sign in using an authorized account.',
              'Stop after the account overview loads.',
            ],
            evidenceFields: [
              {
                key: 'account_status',
                label: 'Account status',
                required: true,
              },
              {
                key: 'notices_or_billings',
                label: 'Notices or billings shown, if any',
                required: false,
              },
            ],
            forbiddenActions: ['Do not file returns.', 'Do not make payments.'],
          },
        },
      ],
    })

    const actionSection = actionRequiredSection(rendered)
    expect(rendered).toContain(
      '- AUTH CA CDTFA Online Services: authenticated verification required',
    )
    expect(rendered).toContain(
      'Login URL: https://onlineservices.cdtfa.ca.gov/',
    )
    expect(rendered).toContain(
      'Source terms reviewed: https://www.cdtfa.ca.gov/use.htm',
    )
    expect(rendered).toContain(
      'Credential handling: Sign in yourself; do not paste passwords, MFA codes, backup codes, or session cookies into chat.',
    )
    expect(rendered).toContain('Auth/setup steps:')
    expect(rendered).toContain(
      '1. Open CA CDTFA Online Services: https://onlineservices.cdtfa.ca.gov/',
    )
    expect(rendered).toContain(
      '2. Sign in yourself with an authorized account and complete MFA yourself.',
    )
    expect(rendered).toContain(
      'Tell me these values after you complete the check:',
    )
    expect(rendered).toContain('- Account status (required)')
    expect(rendered).toContain('- Notices or billings shown, if any')
    expect(rendered).not.toContain('if any if shown')
    expect(rendered).toContain('Forbidden actions:')
    expect(rendered).toContain('1. Do not file returns.')
    expect(rendered).toContain(
      'Do not paste passwords, MFA codes, backup codes, or session cookies into chat.',
    )
    expect(actionSection).toContain(
      'Open CA CDTFA Online Services: https://onlineservices.cdtfa.ca.gov/',
    )
    expect(actionSection).toContain(
      'Sign in yourself with an authorized account and complete MFA yourself.',
    )
    expect(actionSection).toContain(
      'Use these CDTFA account identifiers if the portal asks you to choose an account: SRKH123456789, UT-123456, ST-123456.',
    )
    expect(actionSection).not.toContain('ca-cdtfa-online-services')
    expect(actionSection).not.toContain('account_status')
    expect(rendered).not.toContain('password-value')
  })

  it('renders complete status when every source succeeds and no findings remain', () => {
    const complete = report()
    const rendered = formatDiscoveryReport({
      ...complete,
      runs: complete.runs.filter((run) => run.outcome.status === 'success'),
      findings: [],
    })

    expect(rendered).toContain('Status: complete')
    expect(rendered).not.toContain('## Action Required')
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
  it('is false when no sources ran', () => {
    const empty: DiscoveryReport = {
      ...report(),
      runs: [],
      findings: [],
    }

    expect(isDiscoveryComplete(empty)).toBe(false)
    expect(formatDiscoveryReport(empty)).toContain('Status: incomplete')
  })

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
