/**
 * Tests for `runOnboardingUpdateProduction`.
 *
 * Mirrors the onboard-wiring tests but exercises the partial-update entry
 * point. Mocks GCP and runs through a single "happy" path.
 */
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
const { runOnboardingUpdateProduction } =
  await import('../skills/onboard-update-wiring.ts')

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

const IDENTIFIERS_PAYLOAD = JSON.stringify({
  'us-federal': { ein: '12-3456789' },
  'us-ca': { sosEntityNumber: 'C0123456' },
})

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
      typeof opts.query === 'string' &&
      opts.query.includes('.compliance.entity')
    ) {
      return Promise.resolve([[ENTITY_ROW], {}])
    }
    return Promise.resolve([[], {}])
  })
  mockSmAccess.mockResolvedValue([
    { payload: { data: Buffer.from(IDENTIFIERS_PAYLOAD, 'utf8') } },
  ])
  mockSmGet.mockResolvedValue([{ name: 'existing' }])
  mockSmAdd.mockResolvedValue([{}])
}

describe('runOnboardingUpdateProduction', () => {
  it('reads current entity + identifiers, merges, and persists', async () => {
    happyPath()

    const result = await runOnboardingUpdateProduction({
      projectId: 'my-proj',
      partial: { caAgCharityNumber: 'CT0123456' },
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2024-05-01T00:00:00Z'),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    // The merged identifiers now include the new AG charity number.
    expect(result.value.identifiers).toMatchObject({
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
      },
    })

    // Secret Manager `addSecretVersion` was hit with the updated payload.
    const addCall = mockSmAdd.mock.calls[0]
    expect(addCall?.[0]).toMatchObject({
      parent: 'projects/my-proj/secrets/compliance-entity-ids',
    })
  })

  it('returns not_onboarded when no entity row exists', async () => {
    happyPath()
    // Override the entity-read so it returns an empty result set.
    mockBqQuery.mockImplementation((opts: unknown) => {
      if (
        typeof opts === 'object' &&
        opts !== null &&
        'query' in opts &&
        typeof opts.query === 'string' &&
        opts.query.includes('.compliance.entity')
      ) {
        return Promise.resolve([[], {}])
      }
      return Promise.resolve([[], {}])
    })

    const result = await runOnboardingUpdateProduction({
      projectId: 'my-proj',
      partial: { caAgCharityNumber: 'CT0123456' },
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2024-05-01T00:00:00Z'),
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
  })

  it('uses the system clock when `now` is not supplied', async () => {
    happyPath()

    const result = await runOnboardingUpdateProduction({
      projectId: 'my-proj',
      partial: { caAgCharityNumber: 'CT0123456' },
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    expect(result.isOk()).toBe(true)
  })
})
