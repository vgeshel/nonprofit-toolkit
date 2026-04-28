/**
 * Tests for the shared production-wiring helpers.
 *
 * Coverage targets:
 *   - `buildCommonDeps` with injected factories — verifies it wires the
 *     adapters to the mocked SDK clients and threads through the project id
 *     and clock.
 *   - `buildCommonDeps` with default factories — exercises the
 *     `?? defaultBigQueryFactory` / `?? defaultSecretManagerFactory`
 *     branches.
 *   - `defaultBigQueryFactory` / `defaultSecretManagerFactory` — smoke tests
 *     that they produce instances of the SDK classes.
 *   - The internal `subsetSecretManagerClient` adapter — exercised end-to-end
 *     by calling each of the four methods through the
 *     `EntityIdsAccessor.read()` and `.write()` paths.
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
const { buildCommonDeps, defaultBigQueryFactory, defaultSecretManagerFactory } =
  await import('../skills/wiring-common.ts')

describe('defaultBigQueryFactory', () => {
  it('constructs a BigQuery instance with the supplied projectId', () => {
    const bq = defaultBigQueryFactory('my-project')
    expect(bq).toBeInstanceOf(BigQuery)
  })
})

describe('defaultSecretManagerFactory', () => {
  it('constructs a SecretManagerServiceClient instance', () => {
    const sm = defaultSecretManagerFactory()
    expect(sm).toBeInstanceOf(SecretManagerServiceClient)
  })
})

describe('buildCommonDeps', () => {
  it('uses the default factories when neither is supplied', () => {
    // Exercises the `??` defaults. The deps are built but no method on the
    // returned BigQuery / Secret Manager clients is called — so this
    // doesn't touch GCP.
    const deps = buildCommonDeps({
      projectId: 'p',
      now: () => new Date('2024-05-01T00:00:00Z'),
    })
    expect(deps.projectId).toBe('p')
    expect(typeof deps.migrationPort.datasetExists).toBe('function')
    expect(typeof deps.entityAccessor.readEntity).toBe('function')
    expect(typeof deps.identifiersAccessor.read).toBe('function')
    expect(typeof deps.queryRunner.query).toBe('function')
  })

  it('threads the injected factories all the way to the migration port', async () => {
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

    const bqFactory = vi.fn<
      (projectId: string) => InstanceType<typeof BigQuery>
    >((projectId) => new BigQuery({ projectId }))
    const smFactory = vi.fn<
      () => InstanceType<typeof SecretManagerServiceClient>
    >(() => new SecretManagerServiceClient())

    const deps = buildCommonDeps({
      projectId: 'my-proj',
      now: () => new Date('2024-05-01T00:00:00Z'),
      bqFactory,
      secretManagerFactory: smFactory,
    })

    expect(bqFactory).toHaveBeenCalledWith('my-proj')
    expect(smFactory).toHaveBeenCalledTimes(1)

    // Smoke: the migration port talks to the BigQuery mock.
    const got = await deps.migrationPort.datasetExists('compliance')
    expect(got.isOk()).toBe(true)
    expect(mockBqDataset).toHaveBeenCalledWith('compliance')
  })

  it('threads the injected factories through to the query runner', async () => {
    vi.clearAllMocks()
    mockBqQuery.mockResolvedValue([[{ count: 7 }], {}])

    const bqFactory = vi.fn<
      (projectId: string) => InstanceType<typeof BigQuery>
    >((projectId) => new BigQuery({ projectId }))

    const deps = buildCommonDeps({
      projectId: 'my-proj',
      now: () => new Date('2024-05-01T00:00:00Z'),
      bqFactory,
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    const got = await deps.queryRunner.query('SELECT COUNT(*) FROM x')
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toEqual([{ count: 7 }])
  })

  it('threads the injected factories all the way to the entity accessor', async () => {
    vi.clearAllMocks()
    mockBqQuery.mockResolvedValue([[], {}])

    const deps = buildCommonDeps({
      projectId: 'my-proj',
      now: () => new Date('2024-05-01T00:00:00Z'),
      bqFactory: () => new BigQuery({ projectId: 'my-proj' }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    const got = await deps.entityAccessor.readEntity()
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toBeNull()

    const queryCall = mockBqQuery.mock.calls[0]
    expect(queryCall?.[0]).toMatchObject({ parameterMode: 'named' })
  })

  it('routes accessSecretVersion through the SM client (read path)', async () => {
    vi.clearAllMocks()
    mockSmAccess.mockResolvedValue([
      {
        payload: {
          data: Buffer.from(
            JSON.stringify({
              'us-federal': { ein: '12-3456789' },
              'us-ca': { sosEntityNumber: 'C0123456' },
            }),
            'utf8',
          ),
        },
      },
    ])

    const deps = buildCommonDeps({
      projectId: 'my-proj',
      now: () => new Date('2024-05-01T00:00:00Z'),
      bqFactory: () => new BigQuery({ projectId: 'my-proj' }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    const got = await deps.identifiersAccessor.read()
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toEqual({
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456' },
    })

    const accessCall = mockSmAccess.mock.calls[0]
    expect(accessCall?.[0]).toEqual({
      name: 'projects/my-proj/secrets/compliance-entity-ids/versions/latest',
    })
  })

  it('routes getSecret + addSecretVersion through the SM client when the secret already exists (write path)', async () => {
    vi.clearAllMocks()
    mockSmGet.mockResolvedValue([{ name: 'existing' }])
    mockSmAdd.mockResolvedValue([{}])

    const deps = buildCommonDeps({
      projectId: 'my-proj',
      now: () => new Date('2024-05-01T00:00:00Z'),
      bqFactory: () => new BigQuery({ projectId: 'my-proj' }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    const got = await deps.identifiersAccessor.write({
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456' },
    })
    expect(got.isOk()).toBe(true)
    expect(mockSmGet).toHaveBeenCalledTimes(1)
    expect(mockSmAdd).toHaveBeenCalledTimes(1)
    expect(mockSmCreate).not.toHaveBeenCalled()
  })

  it('routes createSecret through the SM client when the secret does not exist (write path)', async () => {
    vi.clearAllMocks()
    // gRPC NOT_FOUND code = 5
    const notFound = Object.assign(new Error('not found'), { code: 5 })
    mockSmGet.mockRejectedValue(notFound)
    mockSmCreate.mockResolvedValue([{}])
    mockSmAdd.mockResolvedValue([{}])

    const deps = buildCommonDeps({
      projectId: 'my-proj',
      now: () => new Date('2024-05-01T00:00:00Z'),
      bqFactory: () => new BigQuery({ projectId: 'my-proj' }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    const got = await deps.identifiersAccessor.write({
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456' },
    })
    expect(got.isOk()).toBe(true)
    expect(mockSmCreate).toHaveBeenCalledTimes(1)
    expect(mockSmAdd).toHaveBeenCalledTimes(1)
  })
})
