import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JurisdictionRegistry } from '../registry/jurisdiction-registry.ts'
import type { ComplianceMigrationPort } from '../skills/migrate.ts'
import {
  recordComplianceEvidence,
  type ComplianceEvidenceInput,
} from '../skills/record-evidence.ts'
import type { RunRecorder } from '../sources/runner.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { ComplianceDiscoveryRunRow } from '../state/bq-rows.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type {
  Entity,
  EntityIdentifiers,
  Finding,
  Jurisdiction,
  Source,
  SourceAuthRequirement,
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

function fakeEntityAccessor(entity: Entity | null): EntityAccessor {
  return {
    readEntity: vi.fn<EntityAccessor['readEntity']>(() => okAsync(entity)),
    upsertEntity: vi.fn<EntityAccessor['upsertEntity']>(() =>
      okAsync(undefined),
    ),
  }
}

function fakeIdsAccessor(
  identifiers: EntityIdentifiers | null,
): EntityIdsAccessor {
  return {
    read: vi.fn<EntityIdsAccessor['read']>(() => okAsync(identifiers)),
    write: vi.fn<EntityIdsAccessor['write']>(() => okAsync(undefined)),
  }
}

function fakeMigrationPort(
  overrides: Partial<ComplianceMigrationPort> = {},
): ComplianceMigrationPort {
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
    ...overrides,
  }
}

interface FakeRecorder extends RunRecorder {
  readonly rows: ComplianceDiscoveryRunRow[]
  readonly findings: Finding[]
}

function fakeRecorder(overrides: Partial<RunRecorder> = {}): FakeRecorder {
  const rows: ComplianceDiscoveryRunRow[] = []
  const findings: Finding[] = []
  return {
    rows,
    findings,
    recordRun: vi.fn<RunRecorder['recordRun']>((row) => {
      rows.push(row)
      return okAsync(undefined)
    }),
    recordFindings: vi.fn<RunRecorder['recordFindings']>((items) => {
      findings.push(...items)
      return okAsync(undefined)
    }),
    ...overrides,
  }
}

function fakeRegistry(sources: readonly Source[]): JurisdictionRegistry {
  const jurisdiction: Jurisdiction = {
    id: 'us-ca',
    entityIdSchema: z.object({}),
    sources,
    deadlineRules: [],
    forms: [],
  }
  return {
    register: vi.fn<JurisdictionRegistry['register']>(),
    get: vi.fn<JurisdictionRegistry['get']>(),
    list: () => [jurisdiction],
  }
}

function makeAuthenticatedSource(
  args: { readonly omitAuth?: boolean } = {},
): Source {
  const auth: SourceAuthRequirement = {
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
    instructions: ['Sign in and review the account.'],
    evidenceFields: [
      {
        key: 'cdtfa_accounts_present',
        label: 'Whether any CDTFA-managed account is present',
        required: true,
      },
      {
        key: 'account_statuses',
        label: 'Account statuses shown in Online Services',
        required: true,
      },
      {
        key: 'open_filing_obligations',
        label: 'Open filing obligations or none shown',
        required: false,
      },
      {
        key: 'notices_or_billings',
        label: 'Notices or billings shown, if any',
        required: false,
      },
      { key: 'reviewed_at', label: 'Reviewed-at date', required: true },
    ],
    forbiddenActions: ['Do not file returns.'],
  }
  return {
    id: 'ca-cdtfa-online-services',
    jurisdiction: 'us-ca',
    kind: 'playwright',
    authRequired: true,
    description: 'User-assisted CDTFA Online Services review.',
    accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
    accessMethod: 'playwright_readonly',
    automationAllowed: true,
    tosUrl: 'https://www.cdtfa.ca.gov/use.htm',
    auth: args.omitAuth === true ? undefined : auth,
    run: vi.fn<Source['run']>(),
  }
}

function makeManualSource(): Source {
  return {
    id: 'ca-sos-bizfile',
    jurisdiction: 'us-ca',
    kind: 'manual',
    authRequired: false,
    description: 'Manual California Secretary of State bizfile review.',
    accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
    accessMethod: 'manual',
    automationAllowed: false,
    manualOnlyReason: 'Terms require manual review.',
    manualInstructions: ['Search the SOS entity number.'],
    manualEvidenceFields: [
      { key: 'entity_status', label: 'Entity status', required: true },
      { key: 'entity_name', label: 'Entity name', required: true },
      { key: 'status_date', label: 'Status date', required: false },
    ],
    tosUrl:
      'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use',
    run: vi.fn<Source['run']>(),
  }
}

function makeFtbEntityStatusLetterSource(): Source {
  return {
    id: 'ca-ftb-entity-status-letter',
    jurisdiction: 'us-ca',
    kind: 'manual',
    authRequired: false,
    description:
      'Manual California Franchise Tax Board Entity Status Letter verification.',
    accessUrl: 'https://webapp.ftb.ca.gov/eletter/',
    accessMethod: 'manual',
    automationAllowed: false,
    manualOnlyReason: 'Manual source.',
    manualInstructions: ['Search the FTB status letter.'],
    manualEvidenceFields: [
      { key: 'ftb_status', label: 'FTB status', required: true },
      {
        key: 'exempt_status_verified',
        label: 'Exempt status verified',
        required: false,
      },
    ],
    tosUrl: 'https://www.ftb.ca.gov/help/business/entity-status-letter.asp',
    run: vi.fn<Source['run']>(),
  }
}

function makeAutomatedSource(): Source {
  return {
    id: 'irs-teos',
    jurisdiction: 'us-federal',
    kind: 'api',
    authRequired: false,
    description: 'IRS Tax Exempt Organization Search.',
    accessUrl:
      'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
    accessMethod: 'official_bulk_download',
    automationAllowed: true,
    tosUrl:
      'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
    run: vi.fn<Source['run']>(),
  }
}

const CDTFA_CLEAR_INPUT: ComplianceEvidenceInput = {
  sourceId: 'ca-cdtfa-online-services',
  observedAt: '2026-05-02T00:00:00.000Z',
  evidence: {
    cdtfa_accounts_present: true,
    account_statuses: 'Account exists; balance 0.',
    balance: '0',
    open_filing_obligations: 'none',
    notices_or_billings: 'none',
    reviewed_at: '2026-05-02',
  },
}

function baseArgs(
  input: ComplianceEvidenceInput,
  sources: readonly Source[] = [makeAuthenticatedSource()],
  recorder: RunRecorder = fakeRecorder(),
) {
  return {
    registry: fakeRegistry(sources),
    entityAccessor: fakeEntityAccessor(ENTITY),
    identifiersAccessor: fakeIdsAccessor(IDENTIFIERS),
    migrationPort: fakeMigrationPort(),
    recorder,
    now: () => new Date('2026-05-02T12:34:56.000Z'),
    input,
  }
}

describe('recordComplianceEvidence', () => {
  it('records authenticated evidence as a succeeded source run', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(CDTFA_CLEAR_INPUT, [makeAuthenticatedSource()], recorder),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.rows).toHaveLength(1)
    expect(recorder.rows[0]).toMatchObject({
      source_id: 'ca-cdtfa-online-services',
      jurisdiction_id: 'us-ca',
      status: 'succeeded',
      error_type: null,
      error_message: null,
      started_at: '2026-05-02T12:34:56.000Z',
      completed_at: '2026-05-02T12:34:56.000Z',
      duration_ms: 0,
      payload: {
        sourceId: 'ca-cdtfa-online-services',
        evidenceSource: 'user_provided',
        collectionMethod: 'user_assisted_authenticated',
        observedAt: '2026-05-02T00:00:00.000Z',
        recordedAt: '2026-05-02T12:34:56.000Z',
        cdtfa_accounts_present: true,
        account_statuses: 'Account exists; balance 0.',
        balance: '0',
        open_filing_obligations: 'none',
        notices_or_billings: 'none',
        reviewed_at: '2026-05-02',
      },
    })
    expect(recorder.findings).toEqual([])
    if (result.isOk()) {
      expect(result.value.sourceId).toBe('ca-cdtfa-online-services')
      expect(result.value.findings).toEqual([])
    }
  })

  it('records manual evidence using the source evidence field contract', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-sos-bizfile',
          evidence: {
            entity_status: 'Active',
            entity_name: 'FOO FOUNDATION',
          },
        },
        [makeManualSource()],
        recorder,
      ),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.rows[0]).toMatchObject({
      source_id: 'ca-sos-bizfile',
      status: 'succeeded',
      payload: {
        sourceId: 'ca-sos-bizfile',
        evidenceSource: 'user_provided',
        collectionMethod: 'manual',
        entity_status: 'Active',
        entity_name: 'FOO FOUNDATION',
      },
    })
  })

  it('rejects missing required evidence fields before writing', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {
            cdtfa_accounts_present: false,
            account_statuses: [],
            reviewed_at: '   ',
          },
        },
        [makeAuthenticatedSource()],
        recorder,
      ),
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toContain(
        'Account statuses shown in Online Services',
      )
      expect(result.error.message).toContain('Reviewed-at date')
    }
    expect(recorder.recordRun).not.toHaveBeenCalled()
  })

  it('treats absent and null required evidence values as missing', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {
            cdtfa_accounts_present: null,
            reviewed_at: '2026-05-02',
          },
        },
        [makeAuthenticatedSource()],
        recorder,
      ),
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain(
        'Whether any CDTFA-managed account is present',
      )
      expect(result.error.message).toContain(
        'Account statuses shown in Online Services',
      )
    }
    expect(recorder.recordRun).not.toHaveBeenCalled()
  })

  it('rejects unknown sources', async () => {
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'missing-source',
          evidence: {},
        },
        [makeAuthenticatedSource()],
      ),
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        type: 'validation',
        message: 'Unknown compliance source "missing-source".',
      })
    }
  })

  it('rejects automated sources that do not accept user-provided evidence', async () => {
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'irs-teos',
          evidence: {},
        },
        [makeAutomatedSource()],
      ),
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toContain(
        'does not declare manual or authenticated evidence fields',
      )
    }
  })

  it('rejects authenticated sources without evidence fields', async () => {
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {},
        },
        [
          makeAuthenticatedSource({
            omitAuth: true,
          }),
        ],
      ),
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toContain(
        'does not declare manual or authenticated evidence fields',
      )
    }
  })

  it('requires onboarding before evidence can be recorded', async () => {
    const result = await recordComplianceEvidence({
      ...baseArgs(CDTFA_CLEAR_INPUT),
      entityAccessor: fakeEntityAccessor(null),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('not_onboarded')
    }
  })

  it('requires identifiers before evidence can be recorded', async () => {
    const result = await recordComplianceEvidence({
      ...baseArgs(CDTFA_CLEAR_INPUT),
      identifiersAccessor: fakeIdsAccessor(null),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('not_onboarded')
    }
  })

  it('returns load errors from schema migration, entity, and identifiers reads', async () => {
    const migrationResult = await recordComplianceEvidence({
      ...baseArgs(CDTFA_CLEAR_INPUT),
      migrationPort: fakeMigrationPort({
        datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
          errAsync({ type: 'query', message: 'dataset broken' }),
        ),
      }),
    })
    const entityResult = await recordComplianceEvidence({
      ...baseArgs(CDTFA_CLEAR_INPUT),
      entityAccessor: {
        ...fakeEntityAccessor(ENTITY),
        readEntity: vi.fn<EntityAccessor['readEntity']>(() =>
          errAsync({ type: 'query', message: 'entity broken' }),
        ),
      },
    })
    const identifiersResult = await recordComplianceEvidence({
      ...baseArgs(CDTFA_CLEAR_INPUT),
      identifiersAccessor: {
        ...fakeIdsAccessor(IDENTIFIERS),
        read: vi.fn<EntityIdsAccessor['read']>(() =>
          errAsync({ type: 'sdk', message: 'ids broken' }),
        ),
      },
    })

    expect(migrationResult.isErr()).toBe(true)
    expect(entityResult.isErr()).toBe(true)
    expect(identifiersResult.isErr()).toBe(true)
    if (migrationResult.isErr()) {
      expect(migrationResult.error.message).toContain('dataset broken')
    }
    if (entityResult.isErr()) {
      expect(entityResult.error.message).toContain('entity broken')
    }
    if (identifiersResult.isErr()) {
      expect(identifiersResult.error.message).toContain('ids broken')
    }
  })

  it('returns persist errors from run or finding writes', async () => {
    const runFailure = await recordComplianceEvidence(
      baseArgs(
        CDTFA_CLEAR_INPUT,
        [makeAuthenticatedSource()],
        fakeRecorder({
          recordRun: vi.fn<RunRecorder['recordRun']>(() =>
            errAsync({ type: 'query', message: 'run insert broken' }),
          ),
        }),
      ),
    )
    const findingFailure = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {
            cdtfa_accounts_present: true,
            account_statuses: 'Active account; balance 10.',
            balance: '10',
            open_filing_obligations: 'Q1 return is due.',
            notices_or_billings: 'Billing notice is present.',
            reviewed_at: '2026-05-02',
          },
        },
        [makeAuthenticatedSource()],
        fakeRecorder({
          recordFindings: vi.fn<RunRecorder['recordFindings']>(() =>
            errAsync({ type: 'query', message: 'finding insert broken' }),
          ),
        }),
      ),
    )

    expect(runFailure.isErr()).toBe(true)
    expect(findingFailure.isErr()).toBe(true)
    if (runFailure.isErr()) {
      expect(runFailure.error.message).toContain('run insert broken')
    }
    if (findingFailure.isErr()) {
      expect(findingFailure.error.message).toContain('finding insert broken')
    }
  })

  it('emits issue findings when CDTFA evidence reports obligations, notices, or a balance', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {
            cdtfa_accounts_present: true,
            account_statuses: 'Active account.',
            balance: '$25.50',
            open_filing_obligations: 'Q1 return is due.',
            notices_or_billings: 'Billing notice is present.',
            reviewed_at: '2026-05-02',
          },
        },
        [makeAuthenticatedSource()],
        recorder,
      ),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.findings.map((finding) => finding.title).sort()).toEqual([
      'CDTFA Online Services shows a nonzero balance',
      'CDTFA Online Services shows notices or billings',
      'CDTFA Online Services shows open filing obligations',
    ])
    expect(
      recorder.findings.every(
        (finding) =>
          finding.status === 'open' &&
          finding.source_id === 'ca-cdtfa-online-services' &&
          finding.opened_at === '2026-05-02T12:34:56.000Z',
      ),
    ).toBe(true)
  })

  it('treats nonnumeric CDTFA balance text as an issue when it is not a clear value', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {
            cdtfa_accounts_present: true,
            account_statuses: 'Active account.',
            balance: 'Past due balance shown.',
            open_filing_obligations: 'none',
            notices_or_billings: 'none',
            reviewed_at: '2026-05-02',
          },
        },
        [makeAuthenticatedSource()],
        recorder,
      ),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.findings).toHaveLength(1)
    expect(recorder.findings[0]?.title).toBe(
      'CDTFA Online Services shows a nonzero balance',
    )
  })

  it('keeps a finding open when the FTB Entity Status Letter says exempt status is not verified', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-ftb-entity-status-letter',
          evidence: {
            ftb_status: 'ACTIVE',
            exempt_status_verified: 'NOT EXEMPT',
          },
        },
        [makeFtbEntityStatusLetterSource()],
        recorder,
      ),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.findings).toHaveLength(1)
    expect(recorder.findings[0]).toMatchObject({
      source_id: 'ca-ftb-entity-status-letter',
      title: 'California FTB exempt status is not verified',
      evidence: {
        code: 'ca.ftb.exempt_status_not_verified',
        exemptStatusVerified: 'NOT EXEMPT',
      },
    })
  })

  it('does not emit a finding when the FTB Entity Status Letter verifies exempt status', async () => {
    for (const exemptStatus of [
      'yes',
      'true',
      'verified',
      'exempt',
      'exempt status verified',
    ]) {
      const recorder = fakeRecorder()
      const result = await recordComplianceEvidence(
        baseArgs(
          {
            sourceId: 'ca-ftb-entity-status-letter',
            evidence: {
              ftb_status: 'ACTIVE',
              exempt_status_verified: exemptStatus,
            },
          },
          [makeFtbEntityStatusLetterSource()],
          recorder,
        ),
      )

      expect(result.isOk()).toBe(true)
      expect(recorder.findings).toEqual([])
    }
  })

  it('does not emit a finding when optional FTB exempt status evidence is absent', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-ftb-entity-status-letter',
          evidence: {
            ftb_status: 'ACTIVE',
          },
        },
        [makeFtbEntityStatusLetterSource()],
        recorder,
      ),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.findings).toEqual([])
  })

  it('ignores blank optional CDTFA issue fields', async () => {
    const recorder = fakeRecorder()
    const result = await recordComplianceEvidence(
      baseArgs(
        {
          sourceId: 'ca-cdtfa-online-services',
          evidence: {
            cdtfa_accounts_present: true,
            account_statuses: 'Active account.',
            balance: '   ',
            open_filing_obligations: '   ',
            notices_or_billings: '   ',
            reviewed_at: '2026-05-02',
          },
        },
        [makeAuthenticatedSource()],
        recorder,
      ),
    )

    expect(result.isOk()).toBe(true)
    expect(recorder.findings).toEqual([])
  })
})
