import { describe, expect, it, vi } from 'vitest'

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

const { BigQuery } = await import('@google-cloud/bigquery')
const { SecretManagerServiceClient } =
  await import('@google-cloud/secret-manager')
const { defaultComplianceStatusNow, getComplianceStatusProduction } =
  await import('../skills/status-wiring.ts')

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

const RUN_ROW = {
  run_id: '550e8400-e29b-41d4-a716-446655440000',
  source_id: 'irs-eo-bmf',
  jurisdiction_id: 'us-federal',
  status: 'succeeded',
  started_at: { value: '2026-04-28T12:00:00.000Z' },
  completed_at: { value: '2026-04-28T12:00:01.000Z' },
  duration_ms: 1000,
  error_type: null,
  error_message: null,
  payload: { matchStatus: 'found' },
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
      if (opts.query.includes('.compliance.entity')) {
        return Promise.resolve([[ENTITY_ROW], {}])
      }
      if (opts.query.includes('.compliance.discovery_runs')) {
        return Promise.resolve([[RUN_ROW], {}])
      }
      if (opts.query.includes('.compliance.findings')) {
        return Promise.resolve([[], {}])
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

describe('getComplianceStatusProduction', () => {
  it('provides a default clock for shared wiring', () => {
    expect(defaultComplianceStatusNow()).toBeInstanceOf(Date)
  })

  it('reads entity, identifiers, latest runs, and open findings from GCP-backed accessors', async () => {
    happyPath()

    const result = await getComplianceStatusProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('clear')
    expect(result.value.latestRuns).toHaveLength(1)
    expect(mockBqQuery).toHaveBeenCalledTimes(3)
    expect(mockSmAccess).toHaveBeenCalledTimes(1)
  })

  it('uses default GCP client factories when no factories are injected', async () => {
    happyPath()

    const result = await getComplianceStatusProduction({
      projectId: 'my-proj',
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.latestRuns[0]).toMatchObject({
      source_id: 'irs-eo-bmf',
      started_at: '2026-04-28T12:00:00.000Z',
      completed_at: '2026-04-28T12:00:01.000Z',
    })
    expect(mockBqQuery).toHaveBeenCalledTimes(3)
    expect(mockSmAccess).toHaveBeenCalledTimes(1)
  })
})
