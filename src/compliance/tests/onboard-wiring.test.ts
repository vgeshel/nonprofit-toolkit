/**
 * Tests for `runOnboardingProduction`.
 *
 * The function is a thin glue layer between the production-side wiring
 * (`buildCommonDeps`) and the orchestration logic (`runOnboarding`). The
 * orchestration tests live in `onboard.test.ts`; here we verify only the
 * wiring contract:
 *
 *   - Default `now` is used when not supplied (the BQ row's `updated_at`
 *     timestamp comes from a real clock).
 *   - Injected factories are propagated to the deps builder.
 *   - On a clean run, the answer bundle reaches the BigQuery and Secret
 *     Manager mocks.
 *   - Validation errors short-circuit before touching either backend.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OnboardingAnswers } from '../skills/onboard.ts'

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
const { runOnboardingProduction } = await import('../skills/onboard-wiring.ts')

const ANSWERS: OnboardingAnswers = {
  legalName: 'Foo Foundation',
  ein: '12-3456789',
  stateOfIncorporation: 'CA',
  caSosEntityNumber: 'C0123456',
  caAgCharityNumber: 'CT0123456',
  fiscalYearEndMonth: 12,
  fiscalYearEndDay: 31,
  formationDate: '2010-01-15',
  mailingAddressLine1: '1 Mission St',
  mailingAddressLine2: null,
  mailingAddressCity: 'San Francisco',
  mailingAddressRegion: 'CA',
  mailingAddressPostalCode: '94105',
  mailingAddressCountry: 'US',
}

/**
 * Common mock setup: dataset + tables already exist (the migration is a
 * no-op), Secret Manager getSecret succeeds (the secret already exists), and
 * the BQ query that performs the entity upsert resolves cleanly.
 */
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
  mockBqQuery.mockResolvedValue([[], {}])
  mockSmGet.mockResolvedValue([{ name: 'existing' }])
  mockSmAdd.mockResolvedValue([{}])
}

describe('runOnboardingProduction', () => {
  it('writes the entity row to BigQuery and the identifiers to Secret Manager on a clean run', async () => {
    happyPath()

    const result = await runOnboardingProduction({
      projectId: 'my-proj',
      answers: ANSWERS,
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2024-05-01T00:00:00Z'),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.legalName).toBe('Foo Foundation')
    expect(result.value.identifiers).toEqual({
      'us-federal': { ein: '12-3456789' },
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
      },
    })

    // Secret Manager was hit with the canonical secret name.
    const addCall = mockSmAdd.mock.calls[0]
    expect(addCall?.[0]).toMatchObject({
      parent: 'projects/my-proj/secrets/compliance-entity-ids',
    })

    // BigQuery was hit with the upsert SQL plus named params.
    const entityUpsert = mockBqQuery.mock.calls
      .map((call) => call[0])
      .find((opts) => {
        if (
          typeof opts !== 'object' ||
          opts === null ||
          !('parameterMode' in opts)
        ) {
          return false
        }
        return opts.parameterMode === 'named'
      })
    expect(entityUpsert).toMatchObject({
      parameterMode: 'named',
    })
  })

  it('uses the system clock when `now` is not supplied', async () => {
    happyPath()

    const before = Date.now()
    const result = await runOnboardingProduction({
      projectId: 'my-proj',
      answers: ANSWERS,
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })
    const after = Date.now()

    expect(result.isOk()).toBe(true)
    // The `updated_at` timestamp on the BQ params should fall in [before, after].
    const queryCall = mockBqQuery.mock.calls.find((call) => {
      const opts = call[0]
      return (
        typeof opts === 'object' &&
        opts !== null &&
        'params' in opts &&
        typeof opts.params === 'object' &&
        opts.params !== null &&
        'updated_at' in opts.params
      )
    })
    const params = (() => {
      const opts = queryCall?.[0]
      if (typeof opts !== 'object' || opts === null || !('params' in opts)) {
        return null
      }
      const p = opts.params
      return typeof p === 'object' ? p : null
    })()
    expect(params).not.toBeNull()
    if (params === null) return
    const updatedAt = (() => {
      if (!('updated_at' in params)) return null
      const v = params.updated_at
      return typeof v === 'string' ? v : null
    })()
    expect(updatedAt).not.toBeNull()
    if (updatedAt === null) return
    const ts = Date.parse(updatedAt)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('returns a validation error and does not touch BigQuery or Secret Manager when the EIN is malformed', async () => {
    happyPath()

    const result = await runOnboardingProduction({
      projectId: 'my-proj',
      answers: { ...ANSWERS, ein: 'not-an-ein' },
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2024-05-01T00:00:00Z'),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
    // The validation step short-circuits before any I/O.
    expect(mockSmGet).not.toHaveBeenCalled()
    expect(mockSmAdd).not.toHaveBeenCalled()
    expect(mockBqQuery).not.toHaveBeenCalled()
  })
})
