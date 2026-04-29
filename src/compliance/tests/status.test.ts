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
  'us-ca': { sosEntityNumber: 'C0123456' },
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
