import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  formatComplianceStatusReport,
  getComplianceStatus,
} from '../skills/status.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { ComplianceDiscoveryRunRow } from '../state/bq-rows.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
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
    ftbEntityName: 'Foo Foundation FTB',
    cdtfaSellerPermitNumber: '202-822944',
    cdtfaUseTaxAccountNumber: 'UT-123456',
    cdtfaSpecialTaxAccountNumber: 'ST-123456',
  },
}

const RUN: ComplianceDiscoveryRunRow = {
  run_id: '550e8400-e29b-41d4-a716-446655440000',
  source_id: 'irs-eo-bmf',
  jurisdiction_id: 'us-federal',
  status: 'succeeded',
  started_at: '2026-04-28T12:00:00.000Z',
  completed_at: '2026-04-28T12:00:01.000Z',
  duration_ms: 1000,
  error_type: null,
  error_message: null,
  payload: { matchStatus: 'found' },
}

const IRS_BMF_RUN: ComplianceDiscoveryRunRow = {
  ...RUN,
  source_id: 'irs-eo-bmf',
  jurisdiction_id: 'us-federal',
  status: 'succeeded',
  payload: JSON.stringify({
    matchStatus: 'found',
    row: {
      ein: '123456789',
      name: 'FOO FOUNDATION',
      ruling: '201005',
    },
  }),
}

const CA_AG_REGISTRY_RUN: ComplianceDiscoveryRunRow = {
  ...RUN,
  source_id: 'ca-ag-registry',
  jurisdiction_id: 'us-ca',
  status: 'succeeded',
  payload: JSON.stringify({
    matchStatus: 'found',
    registryStatus: 'Current',
    stateCharityRegistrationNumber: 'CT1234567',
    effectiveDate: '2024/03/20',
    issueDate: '2024/03/19',
    renewalDueDate: '2026/05/15',
    lastRenewal: '2025/07/15',
  }),
}

const FINDING: Finding = {
  finding_id: '550e8400-e29b-41d4-a716-446655440001',
  jurisdiction_id: 'us-ca',
  source_id: 'ca-ag-registry',
  severity: 'error',
  status: 'open',
  title: 'CA AG Registry status blocks operation or solicitation',
  detail: 'detail',
  evidence: {},
  opened_at: '2026-04-28T12:00:00.000Z',
  resolved_at: null,
}

function entityAccessor(entity: Entity | null): EntityAccessor {
  return {
    readEntity: vi.fn<EntityAccessor['readEntity']>(() => okAsync(entity)),
    upsertEntity: vi.fn<EntityAccessor['upsertEntity']>(() =>
      okAsync(undefined),
    ),
  }
}

function identifiersAccessor(
  identifiers: EntityIdentifiers | null,
): EntityIdsAccessor {
  return {
    read: vi.fn<EntityIdsAccessor['read']>(() => okAsync(identifiers)),
    write: vi.fn<EntityIdsAccessor['write']>(() => okAsync(undefined)),
  }
}

describe('getComplianceStatus', () => {
  it('reads stored state without invoking source discovery', async () => {
    const listLatestRuns = vi.fn(() => okAsync([RUN]))
    const listOpenFindings = vi.fn(() => okAsync([]))

    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns },
      findingsAccessor: { listOpenFindings },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('clear')
    expect(result.value.latestRuns).toEqual([RUN])
    expect(listLatestRuns).toHaveBeenCalledTimes(1)
    expect(listOpenFindings).toHaveBeenCalledTimes(1)
  })

  it('marks status as attention_required when a stored run failed', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: {
        listLatestRuns: () =>
          okAsync([
            {
              ...RUN,
              status: 'failed',
              error_type: 'manual_required',
              error_message: 'Manual check needed',
            },
          ]),
      },
      findingsAccessor: { listOpenFindings: () => okAsync([]) },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('attention_required')
  })

  it('marks status as attention_required when open warning or error findings exist', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: { listOpenFindings: () => okAsync([FINDING]) },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('attention_required')
  })

  it('does not treat optional CA AG Online Renewal auth as attention when public CA AG status is stored', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: {
        listLatestRuns: () =>
          okAsync([
            CA_AG_REGISTRY_RUN,
            {
              ...RUN,
              source_id: 'ca-ag-online-filing',
              jurisdiction_id: 'us-ca',
              status: 'failed',
              error_type: 'auth_required',
              error_message: 'Authenticated session required.',
            },
          ]),
      },
      findingsAccessor: {
        listOpenFindings: () =>
          okAsync([
            {
              ...FINDING,
              source_id: 'ca-ag-online-filing',
              severity: 'warn',
              title:
                'Authentication required: User-assisted CA AG Registry Online Renewal System dashboard review.',
              evidence: { code: 'source.auth_required' },
            },
          ]),
      },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('clear')
  })

  it('uses the current-open-findings accessor result without doing table-history filtering in memory', async () => {
    const repeatedSourceFinding: Finding = {
      ...FINDING,
      finding_id: '550e8400-e29b-41d4-a716-446655440002',
      source_id: 'irs-eo-bmf',
      title: 'Source failed: IRS EO BMF',
      evidence: { code: 'source.failed' },
    }
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: {
        listOpenFindings: () =>
          okAsync([FINDING, FINDING, repeatedSourceFinding]),
      },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.openFindings).toEqual([
      FINDING,
      FINDING,
      repeatedSourceFinding,
    ])
  })

  it('marks status as unknown when no discovery runs are stored', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([]) },
      findingsAccessor: { listOpenFindings: () => okAsync([]) },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('unknown')
  })

  it('returns not_onboarded when stored entity state is missing', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(null),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: { listOpenFindings: () => okAsync([]) },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
  })

  it('maps accessor failures to load errors', async () => {
    const result = await getComplianceStatus({
      entityAccessor: {
        readEntity: vi.fn<EntityAccessor['readEntity']>(() =>
          errAsync({ type: 'query', message: 'BQ down' }),
        ),
        upsertEntity: vi.fn<EntityAccessor['upsertEntity']>(() =>
          okAsync(undefined),
        ),
      },
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: { listOpenFindings: () => okAsync([]) },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('BQ down')
  })

  it('maps identifier reader failures to load errors', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: {
        read: vi.fn<EntityIdsAccessor['read']>(() =>
          errAsync({ type: 'sdk', message: 'Secret Manager down' }),
        ),
        write: vi.fn<EntityIdsAccessor['write']>(() => okAsync(undefined)),
      },
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: { listOpenFindings: () => okAsync([]) },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('Secret Manager down')
  })

  it('maps latest-run reader failures to load errors', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: {
        listLatestRuns: () =>
          errAsync({ type: 'query', message: 'runs table unavailable' }),
      },
      findingsAccessor: { listOpenFindings: () => okAsync([]) },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('runs table unavailable')
  })

  it('maps open-finding reader failures to load errors', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: {
        listOpenFindings: () =>
          errAsync({ type: 'query', message: 'findings table unavailable' }),
      },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('findings table unavailable')
  })
})

describe('formatComplianceStatusReport', () => {
  it('guides the user through open manual and authenticated items', () => {
    const caSosRun: ComplianceDiscoveryRunRow = {
      ...RUN,
      source_id: 'ca-sos-bizfile',
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: 'manual_required',
      error_message:
        'California Secretary of State bizfile terms prohibit automated collection.',
    }
    const caCdtfaRun: ComplianceDiscoveryRunRow = {
      ...RUN,
      source_id: 'ca-cdtfa-permit-license-verification',
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: 'validation',
      error_message:
        'CDTFA public permit verification requires a configured seller permit or use-tax account number.',
    }
    const caAgRun: ComplianceDiscoveryRunRow = {
      ...RUN,
      source_id: 'ca-ag-online-filing',
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: 'auth_required',
      error_message: 'Authenticated session required.',
    }
    const caCdtfaAuthRun: ComplianceDiscoveryRunRow = {
      ...RUN,
      source_id: 'ca-cdtfa-online-services',
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: 'auth_required',
      error_message: 'Authenticated session required.',
    }
    const caFtbRun: ComplianceDiscoveryRunRow = {
      ...RUN,
      source_id: 'ca-ftb-entity-status-letter',
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: 'manual_required',
      error_message: 'Manual FTB status letter required.',
    }
    const caMyFtbRun: ComplianceDiscoveryRunRow = {
      ...RUN,
      source_id: 'ca-ftb-myftb',
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: 'auth_required',
      error_message: 'Authenticated session required.',
    }
    const duplicateCaAgFinding: Finding = {
      ...FINDING,
      source_id: 'ca-ag-online-filing',
      title:
        'Authentication required: User-assisted CA AG Registry Online Renewal System dashboard review.',
    }

    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        IRS_BMF_RUN,
        CA_AG_REGISTRY_RUN,
        caSosRun,
        caCdtfaRun,
        caAgRun,
        caCdtfaAuthRun,
        caFtbRun,
        caMyFtbRun,
      ],
      openFindings: [duplicateCaAgFinding],
      overall: 'attention_required',
    })

    expect(rendered).toContain('## Next Steps')
    expect(rendered).toContain('Use these exact values if a site asks:')
    expect(rendered).toContain('- Legal entity name: Foo Foundation')
    expect(rendered).toContain('- FEIN: 12-3456789')
    expect(rendered).toContain('- State of incorporation: CA')
    expect(rendered).toContain(
      '- State registration or formation date: 2010-01-15',
    )
    expect(rendered).toContain(
      '- Mailing address: 1 Mission St, San Francisco, CA 94105, US',
    )
    expect(rendered).toContain('- California SOS entity number: C0123456')
    expect(rendered).toContain(
      '- California AG charity registration number: CT1234567',
    )
    expect(rendered).toContain('- FTB entity ID: FTB-1234567')
    expect(rendered).toContain('- FTB entity name: Foo Foundation FTB')
    expect(rendered).toContain(
      '- CDTFA account identifiers: 202-822944, UT-123456, ST-123456',
    )
    expect(rendered).toContain(
      '- IRS ruling or registration date from IRS EO BMF: 2010-05',
    )
    expect(rendered).toContain('- CA AG registry status: Current')
    expect(rendered).toContain('- CA AG registry status date: 2024/03/20')
    expect(rendered).toContain(
      '- CA AG renewal due or expiration date: 2026/05/15',
    )
    expect(rendered).toContain('- CA AG issue date: 2024/03/19')
    expect(rendered).toContain('- CA AG effective date: 2024/03/20')
    expect(rendered).toContain('- CA AG last renewal: 2025/07/15')
    expect(rendered).toContain('CA Secretary of State bizfile:')
    expect(rendered).toContain(
      'The automated CA SOS bizfile public search did not complete in the latest stored run. Run compliance-discover again to retry the public-page check.',
    )
    expect(rendered).not.toContain(
      'Open https://bizfileonline.sos.ca.gov/search/business and search SOS entity number C0123456.',
    )
    expect(rendered).toContain(
      'CA CDTFA Permit, License, or Account Verification:',
    )
    expect(rendered).toContain(
      'The automated CA CDTFA public verification did not complete in the latest stored run. Run compliance-discover again to retry the public-page check.',
    )
    expect(rendered).toContain(
      'This is an automation or configuration issue, not a manual evidence request.',
    )
    expect(rendered).not.toContain(
      'Open https://onlineservices.cdtfa.ca.gov/ and choose the option to verify a permit, license, or account.',
    )
    expect(rendered).toContain('CA CDTFA Online Services:')
    expect(rendered).toContain(
      'Use CDTFA account identifier 202-822944, UT-123456, ST-123456 if the portal asks you to choose an account.',
    )
    expect(rendered).toContain('CA Franchise Tax Board Entity Status Letter:')
    expect(rendered).toContain(
      'Open https://webapp.ftb.ca.gov/eletter/ and search FTB entity ID FTB-1234567.',
    )
    expect(rendered).toContain('CA Franchise Tax Board MyFTB:')
    expect(rendered).toContain(
      'Open the business account for FTB entity ID FTB-1234567.',
    )
    expect(rendered).not.toContain('CA Attorney General Online Renewal System:')
    expect(rendered).not.toContain(
      'Use the Registry Search Tool at https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y',
    )
    expect(rendered).not.toContain('https://rct.doj.ca.gov/eGov/Home.aspx')
    expect(rendered).not.toContain('Open the renewal account for')
    expect(rendered).not.toContain('online_filing_access')
    expect(rendered).not.toContain(
      '- WARN us-ca/ca-ag-online-filing: Authentication required',
    )
    expect(rendered).toContain(
      '- INFO us-ca/ca-ag-online-filing: optional dashboard review not required because CA AG public registry status is checked automatically',
    )
  })

  it('falls back to legal names and generic guidance when source identifiers are absent', () => {
    const withoutFederalOrCaliforniaIdentifiers: EntityIdentifiers = {}
    const entityWithUnit: Entity = {
      ...ENTITY,
      mailing_address_line2: 'Suite 200',
    }
    const failedRun = (
      sourceId: string,
      errorType: string,
    ): ComplianceDiscoveryRunRow => ({
      ...RUN,
      source_id: sourceId,
      jurisdiction_id: 'us-ca',
      status: 'failed',
      error_type: errorType,
      error_message: 'Follow-up required.',
    })

    const rendered = formatComplianceStatusReport({
      entity: entityWithUnit,
      identifiers: withoutFederalOrCaliforniaIdentifiers,
      latestRuns: [
        failedRun('ca-ag-online-filing', 'auth_required'),
        failedRun('ca-cdtfa-online-services', 'auth_required'),
        failedRun('ca-cdtfa-permit-license-verification', 'validation'),
        failedRun('ca-ftb-entity-status-letter', 'manual_required'),
        failedRun('ca-ftb-myftb', 'auth_required'),
        failedRun('ca-sos-bizfile', 'manual_required'),
        failedRun('local-manual-source', 'manual_required'),
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'The automated CA SOS bizfile public search did not complete in the latest stored run. Run compliance-discover again to retry the public-page check.',
    )
    expect(rendered).not.toContain(
      'Open https://bizfileonline.sos.ca.gov/search/business and search exact legal name Foo Foundation.',
    )
    expect(rendered).toContain(
      'Open https://webapp.ftb.ca.gov/eletter/ and search exact legal name Foo Foundation.',
    )
    expect(rendered).toContain(
      'Open the business account for exact legal name Foo Foundation.',
    )
    expect(rendered).not.toContain('CA Attorney General Online Renewal System:')
    expect(rendered).not.toContain('Open the renewal account for')
    expect(rendered).toContain(
      'No CDTFA seller permit or use-tax account number is configured. Store the known CDTFA identifier, then run compliance-discover again.',
    )
    expect(rendered).not.toContain(
      'Open https://onlineservices.cdtfa.ca.gov/ and choose the option to verify a permit, license, or account.',
    )
    expect(rendered).toContain(
      'No CDTFA account identifier is configured. If the portal shows a CDTFA-managed account for this organization, use that account; otherwise tell me no CDTFA-managed account is present.',
    )
    expect(rendered).toContain('- FEIN: not configured')
    expect(rendered).toContain(
      '- Mailing address: 1 Mission St Suite 200, San Francisco, CA 94105, US',
    )
    expect(rendered).toContain('- California SOS entity number: not configured')
    expect(rendered).toContain(
      '- California AG charity registration number: not configured',
    )
    expect(rendered).toContain('- FTB entity ID: not configured')
    expect(rendered).toContain('- FTB entity name: not configured')
    expect(rendered).toContain('- CDTFA account identifiers: not configured')
    expect(rendered).toContain(
      '- IRS ruling or registration date from IRS EO BMF: not available in stored status',
    )
    expect(rendered).toContain('local-manual-source:')
    expect(rendered).toContain(
      'Review the finding detail below, resolve the issue with the official source, then run compliance-discover again.',
    )
  })

  it('uses stored source payloads for organization context when configured identifiers are incomplete', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: {
        'us-federal': { ein: '12-3456789' },
        'us-ca': { sosEntityNumber: 'C0123456' },
      },
      latestRuns: [
        IRS_BMF_RUN,
        CA_AG_REGISTRY_RUN,
        {
          ...RUN,
          source_id: 'ca-sos-bizfile',
          jurisdiction_id: 'us-ca',
          status: 'failed',
          error_type: 'manual_required',
          error_message: 'Manual SOS check required.',
        },
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      '- California AG charity registration number: CT1234567',
    )
    expect(rendered).toContain(
      '- IRS ruling or registration date from IRS EO BMF: 2010-05',
    )
    expect(rendered).toContain('- CA AG registry status: Current')
    expect(rendered).toContain('- CA AG registry status date: 2024/03/20')
    expect(rendered).toContain(
      '- CA AG renewal due or expiration date: 2026/05/15',
    )
    expect(rendered).toContain('- CA AG last renewal: 2025/07/15')
  })

  it('uses stored manual evidence identifiers when configured identifiers are incomplete', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: {
        'us-federal': { ein: '12-3456789' },
        'us-ca': { sosEntityNumber: 'C0123456' },
      },
      latestRuns: [
        IRS_BMF_RUN,
        CA_AG_REGISTRY_RUN,
        {
          ...RUN,
          source_id: 'ca-cdtfa-permit-license-verification',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            account_number: '202-822944',
            account_type: 'Sellers Permit',
            verification_status: 'valid',
          },
        },
        {
          ...RUN,
          source_id: 'ca-ftb-entity-status-letter',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            entity_id: '6423690',
            entity_name: 'LELEKA FOUNDATION',
            ftb_status: 'ACTIVE',
            exempt_status_verified: 'EXEMPT',
          },
        },
        {
          ...RUN,
          source_id: 'ca-cdtfa-online-services',
          jurisdiction_id: 'us-ca',
          status: 'failed',
          error_type: 'auth_required',
          error_message: 'Authenticated session required.',
        },
        {
          ...RUN,
          source_id: 'ca-ftb-myftb',
          jurisdiction_id: 'us-ca',
          status: 'failed',
          error_type: 'auth_required',
          error_message: 'Authenticated session required.',
        },
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(rendered).toContain('- FTB entity ID: 6423690')
    expect(rendered).toContain('- FTB entity name: LELEKA FOUNDATION')
    expect(rendered).toContain('- CDTFA account identifiers: 202-822944')
    expect(rendered).toContain(
      'Use CDTFA account identifier 202-822944 if the portal asks you to choose an account.',
    )
    expect(rendered).toContain(
      'Open the business account for FTB entity ID 6423690.',
    )
  })

  it('summarizes the latest automated FTB status letter when it shows the issue', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-ftb-entity-status-letter',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            ftb_status: 'ACTIVE',
            exempt_status_verified: 'NOT EXEMPT',
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-ftb-entity-status-letter',
          title: 'California FTB exempt status is not verified',
          evidence: {
            code: 'ca.ftb.exempt_status_not_verified',
            exemptStatusVerified: 'NOT EXEMPT',
          },
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain('CA Franchise Tax Board Entity Status Letter:')
    expect(rendered).toContain(
      'Latest public FTB Entity Status Letter says FTB status ACTIVE and California exempt status NOT EXEMPT.',
    )
    expect(rendered).toContain(
      'The public Entity Status Letter check is automated; run compliance-discover again whenever you want to refresh this stored status.',
    )
    expect(rendered).not.toContain('Open https://webapp.ftb.ca.gov/eletter/')
  })

  it('summarizes the latest automated CA SOS bizfile result when it shows the issue', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-sos-bizfile',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            matchStatus: 'found',
            entity_name: 'Foo Foundation',
            sos_entity_number: 'C0123456',
            initial_filing_date: '2010-01-15',
            entity_status: 'Suspended',
            entity_type: 'Nonprofit Corporation',
            formed_in: 'CALIFORNIA',
            agent: 'Example Agent',
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-sos-bizfile',
          title: 'CA SOS bizfile status is not active',
          evidence: {
            code: 'ca.sos.bizfile_not_active',
            entityStatus: 'Suspended',
          },
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Latest public CA SOS bizfile search says entity status Suspended, entity name Foo Foundation, SOS entity number C0123456, initial filing date 2010-01-15, entity type Nonprofit Corporation, formed in CALIFORNIA, and agent Example Agent.',
    )
    expect(rendered).toContain(
      'The public bizfile check is automated; run compliance-discover again whenever you want to refresh this stored status.',
    )
    expect(rendered).not.toContain(
      'Open https://bizfileonline.sos.ca.gov/search/business',
    )
  })

  it('summarizes an automated CA SOS bizfile not-found result without asking for a manual re-check', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-sos-bizfile',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            matchStatus: 'not_found',
            search: { field: 'SOS Entity Number', value: 'C0123456' },
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-sos-bizfile',
          title: 'Entity not found in CA SOS bizfile',
          evidence: {
            code: 'ca.sos.bizfile_not_found',
          },
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Latest public CA SOS bizfile search did not return the configured entity.',
    )
    expect(rendered).toContain(
      'confirm the configured SOS entity number and legal name',
    )
    expect(rendered).not.toContain(
      'Open https://bizfileonline.sos.ca.gov/search/business',
    )
  })

  it('summarizes the latest automated CDTFA public verification result when it shows the issue', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-cdtfa-permit-license-verification',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            matchStatus: 'found',
            account_type: 'Sellers Permit',
            account_number: '999-999999',
            verification_status: 'This Sellers Permit is invalid.',
            is_valid: false,
            owner_name: 'LELEKA FOUNDATION',
            start_date: '01-Sep-2023',
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-cdtfa-permit-license-verification',
          title: 'CA CDTFA public verification says account is invalid',
          evidence: {
            code: 'ca.cdtfa.public_verification_invalid',
            accountType: 'Sellers Permit',
            accountNumber: '999-999999',
            verificationStatus: 'This Sellers Permit is invalid.',
          },
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Latest public CA CDTFA verification says Sellers Permit 999-999999 status This Sellers Permit is invalid, owner name LELEKA FOUNDATION, start date 01-Sep-2023.',
    )
    expect(rendered).toContain(
      'The public CDTFA verification check is automated; run compliance-discover again whenever you want to refresh this stored status.',
    )
    expect(rendered).not.toContain(
      'Open https://onlineservices.cdtfa.ca.gov/ and choose the option to verify a permit, license, or account.',
    )
  })

  it('summarizes CDTFA public verification when optional owner and start date fields are absent', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-cdtfa-permit-license-verification',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            matchStatus: 'found',
            account_type: 'Sellers Permit',
            account_number: '999-999999',
            verification_status: 'This Sellers Permit is invalid.',
            is_valid: false,
            owner_name: null,
            start_date: null,
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-cdtfa-permit-license-verification',
          title: 'CA CDTFA public verification says account is invalid',
          evidence: {
            code: 'ca.cdtfa.public_verification_invalid',
            accountType: 'Sellers Permit',
            accountNumber: '999-999999',
            verificationStatus: 'This Sellers Permit is invalid.',
          },
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Latest public CA CDTFA verification says Sellers Permit 999-999999 status This Sellers Permit is invalid.',
    )
    expect(rendered).not.toContain(
      'status This Sellers Permit is invalid, owner name',
    )
    expect(rendered).not.toContain(
      'status This Sellers Permit is invalid, start date',
    )
  })

  it('treats malformed stored CDTFA public verification payloads as an automation retry', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-cdtfa-permit-license-verification',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            matchStatus: 'found',
            account_number: '202-822944',
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-cdtfa-permit-license-verification',
          title: 'CDTFA public verification payload needs refresh',
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'The automated CA CDTFA public verification did not complete in the latest stored run. Run compliance-discover again to retry the public-page check.',
    )
  })

  it('uses normal FTB status-letter instructions when stored evidence verifies exempt status', () => {
    for (const exemptStatus of [
      'yes',
      'true',
      'verified',
      'exempt',
      'exempt status verified',
    ]) {
      const rendered = formatComplianceStatusReport({
        entity: ENTITY,
        identifiers: IDENTIFIERS,
        latestRuns: [
          {
            ...RUN,
            source_id: 'ca-ftb-entity-status-letter',
            jurisdiction_id: 'us-ca',
            status: 'succeeded',
            payload: {
              ftb_status: 'ACTIVE',
              exempt_status_verified: exemptStatus,
            },
          },
        ],
        openFindings: [
          {
            ...FINDING,
            jurisdiction_id: 'us-ca',
            source_id: 'ca-ftb-entity-status-letter',
            title: 'Manual FTB status letter review is stale.',
          },
        ],
        overall: 'attention_required',
      })

      expect(rendered).toContain(
        'Open https://webapp.ftb.ca.gov/eletter/ and search FTB entity ID FTB-1234567.',
      )
      expect(rendered).not.toContain(
        'Latest public FTB Entity Status Letter says',
      )
    }
  })

  it('uses normal FTB status-letter instructions when stored evidence omits exempt status', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-ftb-entity-status-letter',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            ftb_status: 'ACTIVE',
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-ftb-entity-status-letter',
          title: 'Manual FTB status letter review is stale.',
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Open https://webapp.ftb.ca.gov/eletter/ and search FTB entity ID FTB-1234567.',
    )
    expect(rendered).not.toContain(
      'Latest public FTB Entity Status Letter says',
    )
  })

  it('states when stored FTB issue evidence does not include FTB status', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-ftb-entity-status-letter',
          jurisdiction_id: 'us-ca',
          status: 'succeeded',
          payload: {
            exempt_status_verified: 'NOT EXEMPT',
          },
        },
      ],
      openFindings: [
        {
          ...FINDING,
          jurisdiction_id: 'us-ca',
          source_id: 'ca-ftb-entity-status-letter',
          title: 'California FTB exempt status is not verified',
          evidence: {
            code: 'ca.ftb.exempt_status_not_verified',
            exemptStatusVerified: 'NOT EXEMPT',
          },
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Latest public FTB Entity Status Letter says FTB status not available in stored status and California exempt status NOT EXEMPT.',
    )
    expect(rendered).not.toContain('Open https://webapp.ftb.ca.gov/eletter/')
  })

  it('ignores malformed stored JSON payloads in organization context', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...IRS_BMF_RUN,
          payload: 'not-json',
        },
        {
          ...RUN,
          source_id: 'ca-sos-bizfile',
          jurisdiction_id: 'us-ca',
          status: 'failed',
          error_type: 'manual_required',
          error_message: 'Manual SOS check required.',
        },
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      '- IRS ruling or registration date from IRS EO BMF: not available in stored status',
    )
  })

  it('uses the California SOS entity number as the FTB entity ID fallback when no dedicated FTB ID is configured', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: {
        'us-federal': { ein: '12-3456789' },
        'us-ca': {
          sosEntityNumber: '6423690',
          ftbEntityName: 'Foo Foundation FTB',
        },
      },
      latestRuns: [
        {
          ...RUN,
          source_id: 'ca-ftb-entity-status-letter',
          jurisdiction_id: 'us-ca',
          status: 'failed',
          error_type: 'manual_required',
          error_message: 'Manual FTB status letter required.',
        },
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      '- FTB entity ID: 6423690 (using California SOS entity number)',
    )
    expect(rendered).toContain(
      'Open https://webapp.ftb.ca.gov/eletter/ and search FTB entity ID 6423690.',
    )
  })

  it('renders generic next steps when attention is required without a source action', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [RUN],
      openFindings: [
        {
          ...FINDING,
          severity: 'info',
          title: 'Informational finding only',
        },
      ],
      overall: 'attention_required',
    })

    expect(rendered).toContain(
      'Review the open findings below, resolve the underlying compliance issue, then run compliance-discover again to refresh stored status.',
    )
  })

  it('does not render next steps when stored status is clear', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [RUN],
      openFindings: [],
      overall: 'clear',
    })

    expect(rendered).not.toContain('## Next Steps')
  })

  it('tells the user to run discovery when stored status is unknown', () => {
    const rendered = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [],
      openFindings: [],
      overall: 'unknown',
    })

    expect(rendered).toContain('## Next Steps')
    expect(rendered).toContain(
      'Run compliance-discover to create the first stored discovery snapshot.',
    )
  })

  it('renders stored runs and open findings', async () => {
    const result = await getComplianceStatus({
      entityAccessor: entityAccessor(ENTITY),
      identifiersAccessor: identifiersAccessor(IDENTIFIERS),
      runsAccessor: { listLatestRuns: () => okAsync([RUN]) },
      findingsAccessor: { listOpenFindings: () => okAsync([FINDING]) },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const rendered = formatComplianceStatusReport(result.value)
    expect(rendered).toContain('# Compliance Status: Foo Foundation')
    expect(rendered).toContain('Overall: attention_required')
    expect(rendered).toContain(
      '- ERROR us-ca/ca-ag-registry: CA AG Registry status blocks operation or solicitation',
    )
    expect(rendered).not.toContain('Network')
  })

  it('renders empty stored status and failed runs distinctly', () => {
    const renderedEmpty = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [],
      openFindings: [],
      overall: 'unknown',
    })

    expect(renderedEmpty).toContain('- None recorded.')
    expect(renderedEmpty).toContain('- None.')

    const renderedFailed = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          status: 'failed',
          error_type: 'manual_required',
          error_message: 'Manual check needed',
        },
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(renderedFailed).toContain(
      '- FAILED us-federal/irs-eo-bmf: manual_required Manual check needed',
    )

    const renderedUnknownFailure = formatComplianceStatusReport({
      entity: ENTITY,
      identifiers: IDENTIFIERS,
      latestRuns: [
        {
          ...RUN,
          status: 'failed',
          error_type: null,
          error_message: null,
        },
      ],
      openFindings: [],
      overall: 'attention_required',
    })

    expect(renderedUnknownFailure).toContain(
      '- FAILED us-federal/irs-eo-bmf: unknown',
    )
  })
})
