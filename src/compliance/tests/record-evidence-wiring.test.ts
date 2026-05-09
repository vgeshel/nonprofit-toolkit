import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Jurisdiction, Source } from '../types/index.ts'

const mockBqQuery =
  vi.fn<(opts: unknown) => Promise<readonly [unknown, ...unknown[]]>>()
const mockBqDataset = vi.fn<
  (name: string) => {
    exists: () => Promise<unknown>
    createTable: (id: string, opts: unknown) => Promise<unknown>
    table: (id: string) => { exists: () => Promise<unknown> }
  }
>()
const mockBqCreateDataset = vi.fn<(name: string) => Promise<unknown>>()

const mockSmAccess =
  vi.fn<(req: { name: string }) => Promise<readonly [unknown, ...unknown[]]>>()
const mockSmGet =
  vi.fn<(req: { name: string }) => Promise<readonly [unknown, ...unknown[]]>>()
const mockSmCreate =
  vi.fn<(req: unknown) => Promise<readonly [unknown, ...unknown[]]>>()
const mockSmAdd =
  vi.fn<(req: unknown) => Promise<readonly [unknown, ...unknown[]]>>()

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class MockBigQuery {
    query = mockBqQuery
    dataset = mockBqDataset
    createDataset = mockBqCreateDataset
  },
}))

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class MockSm {
    accessSecretVersion = mockSmAccess
    getSecret = mockSmGet
    createSecret = mockSmCreate
    addSecretVersion = mockSmAdd
  },
}))

const { recordComplianceEvidenceProduction } =
  await import('../skills/record-evidence-wiring.ts')
const { BigQuery } = await import('@google-cloud/bigquery')
const { SecretManagerServiceClient } =
  await import('@google-cloud/secret-manager')

const ENTITY_ROW = {
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
  updated_at: { value: '2024-05-01T00:00:00.000Z' },
}

const IDENTIFIERS = {
  'us-federal': { ein: '12-3456789' },
  'us-ca': { sosEntityNumber: 'C0123456' },
}

function happyPath(): void {
  vi.clearAllMocks()
  mockBqDataset.mockReturnValue({
    exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([true])),
    createTable: vi.fn<(id: string, opts: unknown) => Promise<unknown>>(() =>
      Promise.resolve([{}]),
    ),
    table: vi.fn<(id: string) => { exists: () => Promise<unknown> }>(() => ({
      exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([true])),
    })),
  })
  mockBqQuery.mockImplementation((opts: unknown) => {
    if (
      typeof opts === 'object' &&
      opts !== null &&
      'query' in opts &&
      typeof opts.query === 'string'
    ) {
      if (opts.query.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return Promise.resolve([[[{ one: 1 }]], {}])
      }
      if (opts.query.toUpperCase().includes('SELECT')) {
        return Promise.resolve([[ENTITY_ROW], {}])
      }
    }
    return Promise.resolve([[], {}])
  })
  mockSmAccess.mockResolvedValue([
    {
      payload: {
        data: Buffer.from(JSON.stringify(IDENTIFIERS), 'utf8'),
      },
    },
  ])
}

function makeSource(id: string): Source {
  return {
    id,
    jurisdiction: 'us-ca',
    kind: 'playwright',
    authRequired: true,
    description: 'User-assisted source.',
    accessUrl: 'https://example.com/login',
    accessMethod: 'playwright_readonly',
    automationAllowed: true,
    tosUrl: 'https://example.com/terms',
    auth: {
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
      instructions: ['Sign in and review.'],
      evidenceFields: [
        { key: 'status', label: 'Status', required: true },
        { key: 'reviewed_at', label: 'Reviewed-at date', required: true },
      ],
      forbiddenActions: ['Do not transact.'],
    },
    run: vi.fn<Source['run']>(),
  }
}

function makeJurisdiction(
  id: string,
  sources: readonly Source[],
): Jurisdiction {
  return {
    id,
    entityIdSchema: z.object({}),
    sources,
    deadlineRules: [],
    forms: [],
  }
}

describe('recordComplianceEvidenceProduction', () => {
  it('uses injected production clients to persist a user evidence run', async () => {
    happyPath()
    const result = await recordComplianceEvidenceProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2026-05-02T12:34:56.000Z'),
      jurisdictions: [makeJurisdiction('us-ca', [makeSource('source-a')])],
      input: {
        sourceId: 'source-a',
        evidence: {
          status: 'Clear',
          reviewed_at: '2026-05-02',
        },
      },
    })

    expect(result.isOk()).toBe(true)
    const queries = mockBqQuery.mock.calls
      .map((call) => call[0])
      .filter(
        (
          call,
        ): call is {
          query: string
          params?: Record<string, unknown>
        } =>
          typeof call === 'object' &&
          call !== null &&
          'query' in call &&
          typeof call.query === 'string',
      )
    const runInsert = queries.find((query) =>
      query.query.includes('INSERT INTO `my-proj.compliance.discovery_runs`'),
    )
    expect(runInsert?.params).toMatchObject({
      source_id: 'source-a',
      status: 'succeeded',
      error_type: null,
      error_message: null,
    })
  })

  it('uses default clients and jurisdictions when optional wiring is omitted', async () => {
    happyPath()
    const result = await recordComplianceEvidenceProduction({
      projectId: 'my-proj',
      input: {
        sourceId: 'ca-cdtfa-online-services',
        evidence: {
          cdtfa_accounts_present: true,
          account_statuses: 'Account exists; balance 0.',
          reviewed_at: '2026-05-02',
        },
      },
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.sourceId).toBe('ca-cdtfa-online-services')
    }
  })

  it('returns a wiring error when jurisdiction registration fails', async () => {
    happyPath()
    const dup = makeJurisdiction('us-ca', [])
    const result = await recordComplianceEvidenceProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      jurisdictions: [dup, dup],
      input: {
        sourceId: 'source-a',
        evidence: {},
      },
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('wiring')
      expect(result.error.message).toContain('us-ca')
    }
  })
})
