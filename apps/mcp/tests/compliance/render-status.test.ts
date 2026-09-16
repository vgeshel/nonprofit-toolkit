/**
 * Tests for the server-side Markdown renderer that the compliance-
 * status tool returns as primary content.
 *
 * Focus: the renderer is what closes the loop with the user — if it
 * regresses, the model goes back to writing unlinked, date-unaware
 * narratives. Every branch (overdue/upcoming, auth_required vs
 * substantive findings, detailUrl vs accessUrl, parseable vs
 * unparseable dates, info findings filtered from action items) is
 * exercised.
 */
import { describe, expect, it } from 'vitest'
import { renderComplianceStatusMarkdown } from '../../src/tools/compliance/render-status'
import type {
  ComplianceStatusSourceMeta,
  EnrichedComplianceStatusReport,
} from '../../src/tools/compliance/status'

const NOW_ISO = '2026-05-21T12:00:00.000Z'

const SOURCES: readonly ComplianceStatusSourceMeta[] = [
  {
    sourceId: 'ca-sos-bizfile',
    agency: 'California Secretary of State',
    description: 'CA SOS public bizfile search.',
    accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
    tosUrl: 'https://www.sos.ca.gov/administration/conditions-use',
    automationAllowed: true,
  },
  {
    sourceId: 'ca-ag-registry',
    agency: 'California Attorney General — Registry of Charitable Trusts',
    description: 'CA AG Registry of Charitable Trusts public search.',
    accessUrl: 'https://rct.doj.ca.gov/Verification/Web/Search.aspx',
    tosUrl: 'https://oag.ca.gov/charities',
    automationAllowed: true,
  },
  {
    sourceId: 'ca-ftb-myftb',
    agency: 'California Franchise Tax Board',
    description: 'CA FTB MyFTB user-authenticated business account.',
    accessUrl: 'https://www.ftb.ca.gov/myftb/',
    tosUrl: 'https://www.ftb.ca.gov/help/conditions-of-use.html',
    automationAllowed: true,
    auth: {
      loginUrl: 'https://www.ftb.ca.gov/myftb/',
      instructions: [
        'Sign in to MyFTB at the link.',
        'Open the Account Summary page for the business.',
      ],
      evidenceFields: [
        { key: 'accountBalance', label: 'Account balance', required: true },
      ],
      forbiddenActions: ['Do not file returns.'],
    },
  },
  {
    sourceId: 'ca-ftb-entity-status-letter',
    agency: 'California Franchise Tax Board',
    description: 'CA FTB Entity Status Letter public lookup.',
    accessUrl: 'https://webapp.ftb.ca.gov/eletter/',
    tosUrl: 'https://www.ftb.ca.gov/help/conditions-of-use.html',
    automationAllowed: true,
  },
  {
    sourceId: 'irs-teos',
    agency: 'IRS',
    description: 'IRS TEOS Pub. 78 download.',
    accessUrl: 'https://apps.irs.gov/app/eos/',
    tosUrl: 'https://www.irs.gov/privacy-disclosure/privacy-notice',
    automationAllowed: true,
  },
]

function buildReport(
  overrides: Partial<EnrichedComplianceStatusReport> = {},
): EnrichedComplianceStatusReport {
  return {
    overall: 'attention_required',
    now: NOW_ISO,
    entity: {
      legal_name: 'Test Foundation',
      state_of_incorporation: 'DC',
      fiscal_year_end_month: 12,
      fiscal_year_end_day: 31,
      formation_date: '2014-12-14',
      mailing_address_line1: '380 Hamilton Ave',
      mailing_address_line2: 'Unit 291',
      mailing_address_city: 'Palo Alto',
      mailing_address_region: 'CA',
      mailing_address_postal_code: '94302-2405',
      mailing_address_country: 'US',
      updated_at: '2026-05-01T00:00:00Z',
    },
    identifiers: {
      'us-federal': { ein: '47-2377309' },
      'us-ca': { sosEntityNumber: '6423690', agCharityNumber: 'CT0292660' },
    },
    sources: SOURCES,
    latestRuns: [],
    openFindings: [],
    ...overrides,
  }
}

describe('renderComplianceStatusMarkdown — structure', () => {
  it('opens with the entity legal name as the H1 and an overall-status line', () => {
    const out = renderComplianceStatusMarkdown(buildReport())
    expect(out).toContain('# Compliance Status: Test Foundation')
    expect(out).toMatch(/Attention Required/)
    expect(out).toContain('2026-05-21 12:00 UTC')
  })

  it('renders an Entity section with the mailing address joined', () => {
    const out = renderComplianceStatusMarkdown(buildReport())
    expect(out).toContain('## Entity')
    expect(out).toContain(
      '380 Hamilton Ave, Unit 291, Palo Alto, CA, 94302-2405',
    )
  })

  it('omits null mailing-address lines from the joined address', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        entity: {
          ...buildReport().entity,
          mailing_address_line2: null,
        },
      }),
    )
    expect(out).toContain('380 Hamilton Ave, Palo Alto, CA, 94302-2405')
    expect(out).not.toContain('null')
  })

  it('shows a "no action items" line when there are no findings or deadlines', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({ overall: 'clear' }),
    )
    expect(out).toContain('## Action items')
    expect(out).toContain('No action items')
  })

  it('uses the right overall label for each value', () => {
    expect(
      renderComplianceStatusMarkdown(buildReport({ overall: 'clear' })),
    ).toContain('✅ Clear')
    expect(
      renderComplianceStatusMarkdown(buildReport({ overall: 'unknown' })),
    ).toContain('❓ Unknown')
  })
})

describe('renderComplianceStatusMarkdown — per-source rows', () => {
  it('uses the stable source accessUrl as the link even when payload carries a detailUrl', () => {
    // payload.detailUrl appears per-entity but is session-bound on the
    // CA AG server (redirects to /ErrorPage.html when followed without
    // the original search session). We always link to the stable
    // accessUrl and surface the entity identifier (RCT #) in the
    // summary so the user can paste it into the search.
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440000',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:55:00.000Z',
            completed_at: '2026-05-21T11:55:30.000Z',
            duration_ms: 30000,
            error_type: null,
            error_message: null,
            payload: {
              detailUrl:
                'https://rct.doj.ca.gov/Verification/Web/Details.aspx?result=abc',
              renewalDueDate: '5/15/2026',
              registryStatus: 'Current',
              stateCharityRegistrationNumber: 'CT0292660',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain(
      '[**California Attorney General — Registry of Charitable Trusts**](https://rct.doj.ca.gov/Verification/Web/Search.aspx) (ca-ag-registry)',
    )
    // detailUrl is intentionally NOT rendered as a link.
    expect(out).not.toContain('result=abc')
    // The RCT number is surfaced in the row summary so the user can
    // paste it into the search.
    expect(out).toContain('CT0292660')
  })

  it('falls back to the source accessUrl when payload has no detailUrl', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440001',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { matchStatus: 'found' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain(
      '[**California Secretary of State**](https://bizfileonline.sos.ca.gov/search/business) (ca-sos-bizfile)',
    )
  })

  it('falls back to accessUrl when payload is a non-object', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440002',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: 'a string payload',
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain(
      '[**California Secretary of State**](https://bizfileonline.sos.ca.gov/search/business) (ca-sos-bizfile)',
    )
  })

  it('still picks accessUrl when detailUrl is empty or non-string', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440003',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { detailUrl: '' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain(
      '[**California Attorney General — Registry of Charitable Trusts**](https://rct.doj.ca.gov/Verification/Web/Search.aspx) (ca-ag-registry)',
    )
  })

  it('renders a failed run with the error type and message', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440004',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'failed',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: 'network',
            error_message: 'connection reset',
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('❌ network')
    expect(out).toContain('connection reset')
  })

  it('renders an auth_required failure with a single-line loginUrl + first instruction', () => {
    // Single-line callout, not multi-bullet, because client-side
    // paraphrasers compress sub-bullets but keep single lines intact.
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440005',
            source_id: 'ca-ftb-myftb',
            jurisdiction_id: 'us-ca',
            status: 'failed',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: 'auth_required',
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('🔐 sign in at')
    expect(out).toContain('https://www.ftb.ca.gov/myftb/')
    expect(out).toContain('Sign in to MyFTB at the link.')
    expect(out).toContain('`sourceId: ca-ftb-myftb`')
  })

  it('uses a default instruction when an auth-required source has no instructions configured', () => {
    const sourcesNoInstructions: readonly ComplianceStatusSourceMeta[] = [
      {
        sourceId: 'ca-ftb-myftb',
        agency: 'California Franchise Tax Board',
        description: 'x',
        accessUrl: 'https://www.ftb.ca.gov/myftb/',
        tosUrl: 'https://www.ftb.ca.gov/help/conditions-of-use.html',
        automationAllowed: true,
        auth: {
          loginUrl: 'https://www.ftb.ca.gov/myftb/',
          instructions: [],
          evidenceFields: [],
          forbiddenActions: [],
        },
      },
    ]
    const out = renderComplianceStatusMarkdown(
      buildReport({
        sources: sourcesNoInstructions,
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655441099',
            source_id: 'ca-ftb-myftb',
            jurisdiction_id: 'us-ca',
            status: 'failed',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: 'auth_required',
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Sign in and complete MFA.')
  })

  it('renders a failed run with null error_type as "failed"', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655441000',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'failed',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('❌ failed')
  })

  it('renders an auth_required failure without auth metadata as a bare "auth required"', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440006',
            source_id: 'unknown-source-no-meta',
            jurisdiction_id: 'us-ca',
            status: 'failed',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: 'auth_required',
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('auth required')
  })
})

describe('renderComplianceStatusMarkdown — date arithmetic', () => {
  it('marks a past renewal as overdue with the exact day count', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440007',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '5/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    // 5/15 -> 5/21 = 6 days overdue
    expect(out).toContain('Overdue by 6 days')
  })

  it('marks an upcoming renewal with days remaining', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440008',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '6/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    // 5/21 -> 6/15 = 25 days
    expect(out).toContain('Due in 25 days')
  })

  it('skips items in the action list when renewal is more than 60 days away', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        overall: 'clear',
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440009',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '12/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    // No "Due in X days" / "Overdue" line in action items for a 200+ day window.
    expect(out).not.toMatch(/\*\*\[Due in/)
    expect(out).toContain('No action items')
  })

  it('skips relative formatting when the date is unparseable', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440010',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: 'not-a-date-at-all',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: 'whenever' },
            job_id: null,
          },
        ],
      }),
    )
    // The unparseable observation date appears as-is, not as "ago".
    expect(out).toContain('not-a-date-at-all')
  })

  it('uses MM/dd/yyyy (zero-padded) for renewal dates if that is what the source returns', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440011',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '05/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Overdue by 6 days')
  })

  it('renders "checked just now" when completed_at == now', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440012',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: NOW_ISO,
            completed_at: NOW_ISO,
            duration_ms: 0,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('just now')
  })

  it('renders "checked N hours ago" for sub-day windows', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440013',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T08:00:00.000Z',
            completed_at: '2026-05-21T08:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('hours ago')
  })

  it('renders "checked N days ago" for multi-day windows', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440098',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            // 3 days before NOW_ISO (2026-05-21T12:00Z)
            started_at: '2026-05-18T12:00:00.000Z',
            completed_at: '2026-05-18T12:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('days ago')
  })

  it('falls back to absolute date when the observation is in the future', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440099',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-25T11:00:00.000Z',
            completed_at: '2026-05-25T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    // Future date shows as plain date, not "ago".
    expect(out).toContain('2026-05-25')
    expect(out).not.toMatch(/2026-05-25.*ago/)
  })

  it('renders "checked N minutes ago" for sub-hour windows', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440014',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:30:00.000Z',
            completed_at: '2026-05-21T11:30:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('minutes ago')
  })
})

describe('renderComplianceStatusMarkdown — per-source payload summaries', () => {
  it('summarises irs-eo-bmf with subsection/status/foundation/deductibility and tax-period financials', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550000',
            source_id: 'irs-eo-bmf',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              decoded: {
                subsection: '501(c)(3)',
                status: 'Unconditional Exemption',
                foundation:
                  'Public charity: substantial public/government support',
                deductibility: 'Contributions are deductible',
              },
              row: {
                revenueAmount: '2907823',
                assetAmount: '958949',
                taxPeriod: '202412',
              },
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('501(c)(3)')
    expect(out).toContain('Unconditional Exemption')
    expect(out).toContain('Public charity')
    expect(out).toContain('Contributions are deductible')
    expect(out).toContain('Tax period 2024-12')
    expect(out).toContain('revenue $2,907,823')
    expect(out).toContain('assets $958,949')
  })

  it('summarises irs-eo-bmf with revenue but missing assets', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550001',
            source_id: 'irs-eo-bmf',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              decoded: { subsection: '501(c)(3)' },
              row: { taxPeriod: '202412', revenueAmount: '1000000' },
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('revenue $1,000,000')
    expect(out).not.toContain('assets $')
  })

  it('skips the tax-period bullet when revenue is missing', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550002',
            source_id: 'irs-eo-bmf',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              decoded: { subsection: '501(c)(3)' },
              row: { taxPeriod: '202412' },
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Tax period')
  })

  it('skips the bmf summary entirely when the schema fails to parse', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550003',
            source_id: 'irs-eo-bmf',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { decoded: 'not-an-object' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('501(c)(3)')
  })

  it('skips the bmf decoded line entirely when all decoded fields are empty', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550004',
            source_id: 'irs-eo-bmf',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { decoded: {} },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Public charity')
  })

  it('skips the bmf financials when revenue is non-numeric', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550005',
            source_id: 'irs-eo-bmf',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              row: { taxPeriod: '202412', revenueAmount: 'banana' },
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('revenue $')
  })

  it('summarises irs-teos with deductibility code + no-auto-revocation', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550010',
            source_id: 'irs-teos',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              pub78: { deductibilityCode: 'PC' },
              autoRevocation: null,
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Listed in IRS Pub. 78')
    expect(out).toContain('**PC**')
    expect(out).toContain('No automatic revocation')
  })

  it('summarises irs-teos when autoRevocation is null but no deductibilityCode present', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550013',
            source_id: 'irs-teos',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { autoRevocation: null },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('No automatic revocation')
    expect(out).not.toContain('Listed in IRS Pub. 78')
  })

  it('summarises irs-teos with auto-revocation present (does not append the no-revocation line)', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550011',
            source_id: 'irs-teos',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              pub78: { deductibilityCode: 'PC' },
              autoRevocation: { revokedOn: '2025-01-01' },
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Listed in IRS Pub. 78')
    expect(out).not.toContain('No automatic revocation')
  })

  it('skips the irs-teos summary entirely on a payload that fails schema', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550012',
            source_id: 'irs-teos',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { pub78: 'invalid' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Listed in IRS Pub. 78')
  })

  it('summarises ca-sos-bizfile with entity status + standing + entity type + formed_in', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550020',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              entity_status: 'Active',
              standing: 'Good Standing',
              entity_type: 'Nonprofit Corporation - Out of State',
              formed_in: 'DISTRICT OF COLUMBIA',
              sos_entity_number: '6423690',
              initial_filing_date: '10/14/2024',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain(
      'Active · Good Standing · Nonprofit Corporation - Out of State',
    )
    expect(out).toContain('formed in DISTRICT OF COLUMBIA')
    expect(out).toContain('Entity #6423690')
    expect(out).toContain('initial filing 10/14/2024')
  })

  it('summarises ca-sos-bizfile when formed_in is absent', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550021',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              entity_status: 'Active',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Active')
    expect(out).not.toContain('formed in')
  })

  it('skips the ca-sos-bizfile summary when the payload fails the schema', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550022',
            source_id: 'ca-sos-bizfile',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { entity_status: 12345 },
            job_id: null,
          },
        ],
      }),
    )
    // entity_status is not a string -> safeParse fails -> no summary.
    expect(out).not.toContain('Active')
  })

  it('summarises ca-ag-registry with registry status + RCT # + overdue renewal + last renewal', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550030',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              registryStatus: 'Current',
              stateCharityRegistrationNumber: 'CT0292660',
              renewalDueDate: '5/15/2026',
              lastRenewal: '3/4/2026',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Registry status: **Current**')
    expect(out).toContain('CT0292660')
    expect(out).toContain('Next renewal: 5/15/2026')
    expect(out).toContain('Overdue by 6 days')
    expect(out).toContain('Last renewal filed: 3/4/2026')
  })

  it('shows "due in N days" for a future ca-ag-registry renewal', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550031',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              registryStatus: 'Current',
              renewalDueDate: '6/15/2026',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('due in 25 days')
  })

  it('shows "due today" for a ca-ag-registry renewal due today', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550032',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '5/21/2026' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('due today')
  })

  it('renders ca-ag-registry without RCT # when only registryStatus is present', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550033',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { registryStatus: 'Current' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Registry status: **Current**')
    expect(out).not.toContain('(RCT #')
  })

  it('renders ca-ag-registry with an unparseable renewal date as the raw value', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550034',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: 'whenever' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Next renewal: whenever')
  })

  it('skips ca-ag-registry summary entirely on a schema-violating payload', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550035',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { registryStatus: 42 },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Registry status')
  })

  it('summarises ca-ftb-entity-status-letter and warning-flags the NOT EXEMPT case', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550040',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              ftb_status: 'ACTIVE',
              exempt_status_verified: 'NOT EXEMPT',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Entity status: **ACTIVE**')
    expect(out).toContain('Exempt status: ⚠️ **NOT EXEMPT**')
  })

  it('renders ftb exempt-status alone when ftb_status is absent', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550043',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { exempt_status_verified: 'EXEMPT' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Entity status:')
    expect(out).toContain('Exempt status: **EXEMPT**')
  })

  it('renders ftb entity-status alone when exempt_status_verified is absent', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550044',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { ftb_status: 'ACTIVE' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Entity status: **ACTIVE**')
    expect(out).not.toContain('Exempt status:')
  })

  it('does NOT warning-flag an exempt-verified ftb result', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550041',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              ftb_status: 'ACTIVE',
              exempt_status_verified: 'EXEMPT',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Exempt status: **EXEMPT**')
    expect(out).not.toMatch(/Exempt status: ⚠️/)
  })

  it('skips the ftb letter summary entirely on a schema-violating payload', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550042',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { ftb_status: 12345 },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Entity status')
  })

  it('summarises ca-cdtfa-permit-license-verification with valid tag + account # + owner + start date', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550050',
            source_id: 'ca-cdtfa-permit-license-verification',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              account_type: 'Sellers Permit',
              account_number: '202-822944',
              owner_name: 'LELEKA FOUNDATION',
              start_date: '01-Sep-2023',
              is_valid: true,
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('**Valid** Sellers Permit #202-822944')
    expect(out).toContain('Owner: LELEKA FOUNDATION')
    expect(out).toContain('Start date: 01-Sep-2023')
  })

  it('skips the cdtfa account-line when account_number is missing', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550053',
            source_id: 'ca-cdtfa-permit-license-verification',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              account_type: 'Sellers Permit',
              owner_name: 'LELEKA FOUNDATION',
            },
            job_id: null,
          },
        ],
      }),
    )
    // account_type present but account_number missing → no "Sellers
    // Permit #..." line. Owner line still renders.
    expect(out).not.toMatch(/Sellers Permit #/)
    expect(out).toContain('Owner: LELEKA FOUNDATION')
  })

  it('omits the "Valid" prefix when is_valid is false', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550051',
            source_id: 'ca-cdtfa-permit-license-verification',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              account_type: 'Sellers Permit',
              account_number: '202-822944',
              owner_name: null,
              start_date: null,
              is_valid: false,
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Sellers Permit #202-822944')
    expect(out).not.toContain('**Valid** Sellers Permit')
    expect(out).not.toContain('Owner:')
    expect(out).not.toContain('Start date:')
  })

  it('skips the cdtfa summary entirely on a schema-violating payload', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550052',
            source_id: 'ca-cdtfa-permit-license-verification',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { account_number: 12345 },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Sellers Permit')
  })

  it('produces no summary for an unknown source_id', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550060',
            source_id: 'totally-unknown-source',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { hello: 'world' },
            job_id: null,
          },
        ],
      }),
    )
    // Source row still renders (checked-at marker at the end) but no
    // payload summary segment is present.
    expect(out).toMatch(/\(checked[\s\S]*?ago[\s\S]*?\)/)
  })

  it('produces no summary when payload is null even on a known source_id', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550061',
            source_id: 'irs-teos',
            jurisdiction_id: 'us-federal',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: null,
            job_id: null,
          },
        ],
      }),
    )
    expect(out).not.toContain('Listed in IRS Pub. 78')
  })

  it('action-item link includes the RCT # hint for ca-ag-registry overdue renewals', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550070',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: {
              renewalDueDate: '5/15/2026',
              stateCharityRegistrationNumber: 'CT0292660',
            },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Overdue by 6 days')
    expect(out).toContain('(RCT #CT0292660)')
  })

  it('action-item link omits the RCT # hint when the payload does not carry one', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655550071',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '5/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Overdue by 6 days')
    expect(out).not.toContain('RCT #')
  })
})

describe('renderComplianceStatusMarkdown — findings and action items', () => {
  it('renders an open finding with severity emoji + source link + detail', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440020',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'California FTB exempt status is not verified',
            detail: 'Entity Status Letter shows NOT EXEMPT.',
            evidence: { code: 'ca.ftb.exempt_status_not_verified' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    expect(out).toContain('## Open findings (1)')
    expect(out).toContain('⚠️')
    // The title itself is wrapped in the link (so client-side
    // paraphrasers can't strip the link without dropping the title).
    expect(out).toContain(
      '[**California FTB exempt status is not verified**](https://webapp.ftb.ca.gov/eletter/)',
    )
    expect(out).toContain('(ca-ftb-entity-status-letter)')
  })

  it('does NOT generate an action item for info-severity findings', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440021',
            source_id: 'irs-teos',
            jurisdiction_id: 'us-federal',
            severity: 'info',
            status: 'open',
            title: 'EIN listed in IRS Pub. 78',
            detail: 'Positive listing.',
            evidence: { code: 'irs.teos.pub78_listed' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    // The finding is in the Open findings list, but the Action items
    // section should still report "no action items".
    expect(out).toContain('EIN listed in IRS Pub. 78')
    expect(out).toContain('No action items')
  })

  it('renders an action item with the loginUrl for an auth_required finding', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440022',
            source_id: 'ca-ftb-myftb',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'Authentication required for MyFTB',
            detail: 'MyFTB requires a session.',
            evidence: {
              code: 'source.auth_required',
              loginUrl: 'https://www.ftb.ca.gov/myftb/',
            },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    expect(out).toContain('## Action items')
    expect(out).toContain('Sign in to California Franchise Tax Board')
    expect(out).toContain('https://www.ftb.ca.gov/myftb/')
    expect(out).toContain('`sourceId: ca-ftb-myftb`')
  })

  it('skips the action item for an auth_required finding that has no source metadata', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440023',
            source_id: 'no-such-source',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'Authentication required for mystery source',
            detail: 'No metadata.',
            evidence: { code: 'source.auth_required' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    // The finding is rendered but the action item is skipped because
    // we don't have a loginUrl to point the user to.
    expect(out).toContain('Authentication required for mystery source')
    expect(out).toContain('No action items')
  })

  it('renders an [Investigate] action for a substantive warn finding', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440024',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'California FTB exempt status is not verified',
            detail: 'Entity Status Letter shows NOT EXEMPT.',
            evidence: { code: 'ca.ftb.exempt_status_not_verified' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    expect(out).toContain('**⚠️ Investigate**')
    // The finding title is wrapped in the source's accessUrl so the
    // link survives client-side paraphrasing.
    expect(out).toContain(
      '[California FTB exempt status is not verified](https://webapp.ftb.ca.gov/eletter/)',
    )
  })

  it('renders [Blocker] for error-severity findings', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440025',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            severity: 'error',
            status: 'open',
            title: 'Hard block',
            detail: 'Stop the world.',
            evidence: { code: 'ca.ftb.block' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    expect(out).toContain('🛑')
    expect(out).toContain('**🛑 Blocker**')
  })

  it('sorts overdue items ahead of upcoming items in the action list', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440026',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            // 30 days overdue
            payload: { renewalDueDate: '4/21/2026' },
            job_id: null,
          },
        ],
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440027',
            source_id: 'ca-ftb-myftb',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'MyFTB auth required',
            detail: 'auth',
            evidence: {
              code: 'source.auth_required',
              loginUrl: 'https://www.ftb.ca.gov/myftb/',
            },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    const overdueIdx = out.indexOf('Overdue by')
    const authIdx = out.indexOf('Sign in to California Franchise Tax Board')
    expect(overdueIdx).toBeGreaterThan(-1)
    expect(authIdx).toBeGreaterThan(-1)
    expect(overdueIdx).toBeLessThan(authIdx)
  })

  it('interleaves deadlines and findings by urgency: overdue → blocker → imminent deadline → warning → later deadline → auth', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440200',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '5/15/2026' }, // 6 days overdue
            job_id: null,
          },
          {
            run_id: '550e8400-e29b-41d4-a716-446655440201',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '5/24/2026' }, // due in 3 days (imminent)
            job_id: null,
          },
          {
            run_id: '550e8400-e29b-41d4-a716-446655440202',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '6/30/2026' }, // due in 40 days (later)
            job_id: null,
          },
        ],
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440203',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            severity: 'error',
            status: 'open',
            title: 'Hard block',
            detail: 'Stop the world.',
            evidence: { code: 'ca.ftb.block' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440204',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'Exempt status not verified',
            detail: 'Investigate this.',
            evidence: { code: 'ca.ftb.exempt_status_not_verified' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440205',
            source_id: 'ca-ftb-myftb',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'MyFTB auth required',
            detail: 'auth',
            evidence: { code: 'source.auth_required' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    const overdueIdx = out.indexOf('Overdue by 6 days')
    const blockerIdx = out.indexOf('**🛑 Blocker**')
    const imminentIdx = out.indexOf('Due in 3 days')
    const warningIdx = out.indexOf('**⚠️ Investigate**')
    const laterIdx = out.indexOf('Due in 40 days')
    const authIdx = out.indexOf('Sign in to California Franchise Tax Board')
    for (const idx of [
      overdueIdx,
      blockerIdx,
      imminentIdx,
      warningIdx,
      laterIdx,
      authIdx,
    ]) {
      expect(idx).toBeGreaterThan(-1)
    }
    expect(overdueIdx).toBeLessThan(blockerIdx)
    expect(blockerIdx).toBeLessThan(imminentIdx)
    expect(imminentIdx).toBeLessThan(warningIdx)
    expect(warningIdx).toBeLessThan(laterIdx)
    expect(laterIdx).toBeLessThan(authIdx)
  })

  it('skips renewal payloads whose renewalDueDate is non-string', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        overall: 'clear',
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440028',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: 12345 },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('No action items')
  })

  it('renders the overdue action item without a link when source metadata is missing', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        sources: [],
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440101',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '5/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    // Still mentions the overdue status but without the [Open entity record] link.
    expect(out).toContain('Overdue by 6 days')
    expect(out).not.toContain('[Open entity record]')
  })

  it('renders the upcoming-renewal action item without a link when source metadata is missing', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        sources: [],
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440102',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: '6/15/2026' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('Due in 25 days')
    expect(out).not.toContain('[Open entity record]')
  })

  it('handles an empty instructions array on an auth_required finding', () => {
    const customSources: readonly ComplianceStatusSourceMeta[] = [
      {
        sourceId: 'ca-ftb-myftb',
        agency: 'California Franchise Tax Board',
        description: 'x',
        accessUrl: 'https://www.ftb.ca.gov/myftb/',
        tosUrl: 'https://www.ftb.ca.gov/help/conditions-of-use.html',
        automationAllowed: true,
        auth: {
          loginUrl: 'https://www.ftb.ca.gov/myftb/',
          instructions: [], // intentionally empty
          evidenceFields: [],
          forbiddenActions: [],
        },
      },
    ]
    const out = renderComplianceStatusMarkdown(
      buildReport({
        sources: customSources,
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440103',
            source_id: 'ca-ftb-myftb',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'Auth required',
            detail: 'sign in',
            evidence: { code: 'source.auth_required' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    expect(out).toContain('Sign in to California Franchise Tax Board')
    expect(out).toContain('`sourceId: ca-ftb-myftb`')
  })

  it('renders a substantive warn finding without a link when source meta is missing', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        sources: [],
        openFindings: [
          {
            finding_id: '550e8400-e29b-41d4-a716-446655440104',
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            severity: 'warn',
            status: 'open',
            title: 'FTB not exempt',
            detail: 'investigate',
            evidence: { code: 'ca.ftb.exempt_status_not_verified' },
            opened_at: '2026-05-21T11:00:00.000Z',
            resolved_at: null,
          },
        ],
      }),
    )
    expect(out).toContain('**⚠️ Investigate**')
    expect(out).toContain('FTB not exempt')
    // No link on the title because there's no source meta.
    expect(out).not.toMatch(/\[FTB not exempt\]\(http/)
  })

  it('skips renewal payloads whose date does not parse', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        overall: 'clear',
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440029',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: { renewalDueDate: 'not-a-date' },
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('No action items')
  })

  it('handles a non-object payload (string) when looking for renewalDueDate', () => {
    const out = renderComplianceStatusMarkdown(
      buildReport({
        overall: 'clear',
        latestRuns: [
          {
            run_id: '550e8400-e29b-41d4-a716-446655440030',
            source_id: 'ca-ag-registry',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            started_at: '2026-05-21T11:00:00.000Z',
            completed_at: '2026-05-21T11:00:01.000Z',
            duration_ms: 1000,
            error_type: null,
            error_message: null,
            payload: 'a string payload',
            job_id: null,
          },
        ],
      }),
    )
    expect(out).toContain('No action items')
  })
})
