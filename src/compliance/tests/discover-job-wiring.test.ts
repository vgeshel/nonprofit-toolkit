/**
 * Tests for the async-discover production wiring.
 *
 * The pure orchestrator is tested in discover-job.test.ts; here we
 * verify the wiring side: filter-aware registry construction and the
 * GCP-backed default deps.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { usCaJurisdiction } from '../jurisdictions/us-ca/index.ts'
import { usFederalJurisdiction } from '../jurisdictions/us-federal/index.ts'
import type { LaunchDiscovery } from '../skills/discover-job.ts'
import type { FirestoreClientLike } from '../state/firestore-jobs.ts'

/**
 * In-memory Firestore stand-in for tests. Stores docs keyed by path.
 * Sufficient to satisfy DiscoveryJobsAccessor's set/update/get usage.
 */
function makeFakeFirestore(): FirestoreClientLike {
  const docs = new Map<string, Record<string, unknown>>()
  return {
    doc(path: string) {
      return {
        get(): Promise<{
          exists: boolean
          data(): Record<string, unknown> | undefined
        }> {
          const data = docs.get(path)
          return Promise.resolve({
            exists: data !== undefined,
            data: () => data,
          })
        },
        set(data: Record<string, unknown>): Promise<unknown> {
          docs.set(path, data)
          return Promise.resolve()
        },
        update(patch: Record<string, unknown>): Promise<unknown> {
          const prev = docs.get(path) ?? {}
          docs.set(path, { ...prev, ...patch })
          return Promise.resolve()
        },
      }
    },
  }
}

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

// Mock the token source so the default Cloud Run launcher (used when the
// caller omits `launch`) doesn't touch application-default credentials.
const { mockGetAccessToken } = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn<() => Promise<string | null | undefined>>(() =>
    Promise.resolve('test-token'),
  ),
}))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = mockGetAccessToken
  },
}))

const { BigQuery } = await import('@google-cloud/bigquery')
const { SecretManagerServiceClient } =
  await import('@google-cloud/secret-manager')
const {
  buildFilteredRegistry,
  defaultDiscoverJobFetch,
  executeDiscoveryJobProduction,
  parseDiscoverJobEnv,
  readDiscoveryJobResultProduction,
  readDiscoveryJobStatusProduction,
  startDiscoveryJobProduction,
} = await import('../skills/discover-job-wiring.ts')

const JOB_ID = '11111111-1111-4111-8111-111111111111'

describe('defaultDiscoverJobFetch', () => {
  it('delegates to the global fetch', async () => {
    // Stub the global so we don't make a real network call. Bun's
    // `typeof fetch` carries a `preconnect` no-op method; we stub it
    // with a passthrough rather than trying to bind to the original.
    const originalFetch = globalThis.fetch
    const spy = vi.fn<(input: string) => Promise<Response>>(
      async () => new Response('ok'),
    )
    const stubbedFetch: typeof fetch = Object.assign(
      (input: string | URL | Request) => {
        let key: string
        if (typeof input === 'string') {
          key = input
        } else if (input instanceof URL) {
          key = input.href
        } else {
          key = input.url
        }
        return spy(key)
      },
      {
        preconnect: (): void => {
          /* no-op stub */
        },
      },
    )
    globalThis.fetch = stubbedFetch
    try {
      const r = await defaultDiscoverJobFetch('https://example.invalid/')
      expect(await r.text()).toBe('ok')
      expect(spy).toHaveBeenCalledWith('https://example.invalid/')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('buildFilteredRegistry', () => {
  const jurisdictions = [usFederalJurisdiction, usCaJurisdiction] as const

  it('returns the full registry when no filter is supplied', () => {
    const out = buildFilteredRegistry(jurisdictions, {
      sources: null,
      jurisdictionId: null,
    })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.registry.list().length).toBeGreaterThan(0)
  })

  it('drops jurisdictions that do not match jurisdictionId', () => {
    const out = buildFilteredRegistry(jurisdictions, {
      sources: null,
      jurisdictionId: 'us-federal',
    })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    const ids = out.registry.list().map((j) => j.id)
    expect(ids).toEqual(['us-federal'])
  })

  it('filters sources by id', () => {
    const out = buildFilteredRegistry(jurisdictions, {
      sources: ['irs-eo-bmf'],
      jurisdictionId: null,
    })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    const sourceIds = out.registry
      .list()
      .flatMap((j) => j.sources.map((s) => s.id))
    expect(sourceIds).toEqual(['irs-eo-bmf'])
  })

  it('drops a jurisdiction whose sources are all filtered out', () => {
    const out = buildFilteredRegistry(jurisdictions, {
      sources: ['irs-eo-bmf'],
      jurisdictionId: null,
    })
    if (out.kind !== 'ok') return
    expect(out.registry.list().map((j) => j.id)).toEqual(['us-federal'])
  })

  it('returns wiring err when register() reports a duplicate', () => {
    const out = buildFilteredRegistry(
      [usFederalJurisdiction, usFederalJurisdiction],
      { sources: null, jurisdictionId: null },
    )
    expect(out.kind).toBe('err')
    if (out.kind !== 'err') return
    expect(out.message).toContain('us-federal')
  })
})

describe('startDiscoveryJobProduction', () => {
  it('writes the running job doc to Firestore and triggers the launcher', async () => {
    const fakeFirestore = makeFakeFirestore()
    const launchMock = vi.fn<LaunchDiscovery>(() => okAsync(undefined))

    const result = await startDiscoveryJobProduction({
      projectId: 'my-proj',
      region: 'us-central1',
      jobName: 'compliance-discover',
      filter: { sources: ['irs-eo-bmf'], jurisdictionId: 'us-federal' },
      firestore: fakeFirestore,
      launch: launchMock,
      generateJobId: () => JOB_ID,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.jobId).toBe(JOB_ID)

    const snap = await fakeFirestore.doc(`mcp_compliance_jobs/${JOB_ID}`).get()
    expect(snap.exists).toBe(true)
    expect(snap.data()?.status).toBe('running')

    expect(launchMock).toHaveBeenCalledTimes(1)
    expect(launchMock.mock.calls[0]?.[0]).toEqual({
      jobId: JOB_ID,
      filter: { sources: ['irs-eo-bmf'], jurisdictionId: 'us-federal' },
    })
  })

  it('returns a launch error and marks the job failed when the launcher fails', async () => {
    const fakeFirestore = makeFakeFirestore()
    const result = await startDiscoveryJobProduction({
      projectId: 'my-proj',
      region: 'us-central1',
      jobName: 'compliance-discover',
      filter: { sources: null, jurisdictionId: null },
      firestore: fakeFirestore,
      launch: () =>
        errAsync({ type: 'launch' as const, message: 'run rejected' }),
      generateJobId: () => JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('launch')

    const snap = await fakeFirestore.doc(`mcp_compliance_jobs/${JOB_ID}`).get()
    expect(snap.data()?.status).toBe('failed')
    expect(snap.data()?.error_type).toBe('launch')
  })

  it('uses the system clock + the default Cloud Run launcher when neither is supplied', async () => {
    // Omitting `launch` exercises the `?? createCloudRunJobLauncher(...)`
    // default path. We stub the global fetch + token so it issues a fake
    // `:run` POST instead of a real network call.
    const originalFetch = globalThis.fetch
    // Record the requested URL as a string (the launcher always passes a
    // string), so the assertion never stringifies a URL/Request object.
    const fetchSpy = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(JSON.stringify({ name: 'op' }), { status: 200 }),
    )
    const stubbedFetch: typeof fetch = Object.assign(
      (input: string | URL | Request) => {
        let key: string
        if (typeof input === 'string') {
          key = input
        } else if (input instanceof URL) {
          key = input.href
        } else {
          key = input.url
        }
        return fetchSpy(key)
      },
      {
        preconnect: (): void => {
          /* no-op stub */
        },
      },
    )
    globalThis.fetch = stubbedFetch
    try {
      const fakeFirestore = makeFakeFirestore()
      const result = await startDiscoveryJobProduction({
        projectId: 'my-proj',
        region: 'us-central1',
        jobName: 'compliance-discover',
        filter: { sources: null, jurisdictionId: null },
        firestore: fakeFirestore,
        generateJobId: () => JOB_ID,
      })
      expect(result.isOk()).toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/jobs/compliance-discover:run'),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('executeDiscoveryJobProduction', () => {
  it('marks the job failed with a wiring error when the registry build fails', async () => {
    const fakeFirestore = makeFakeFirestore()
    await executeDiscoveryJobProduction({
      projectId: 'my-proj',
      jobId: JOB_ID,
      filter: { sources: null, jurisdictionId: null },
      firestore: fakeFirestore,
      // Duplicate jurisdiction ids force a registration conflict.
      jurisdictions: [usFederalJurisdiction, usFederalJurisdiction],
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    const snap = await fakeFirestore.doc(`mcp_compliance_jobs/${JOB_ID}`).get()
    expect(snap.data()?.status).toBe('failed')
    expect(snap.data()?.error_type).toBe('wiring')
  })

  it('logs when the wiring-error status write fails', async () => {
    // A Firestore whose update() rejects so the markJobFinished cleanup
    // fails and the logger branch is exercised.
    const failingFirestore: FirestoreClientLike = {
      doc() {
        return {
          get: () => Promise.resolve({ exists: false, data: () => undefined }),
          set: () => Promise.resolve(),
          update: () => Promise.reject(new Error('firestore down')),
        }
      },
    }
    const logger = { error: vi.fn<(m: string, e: unknown) => void>() }
    await executeDiscoveryJobProduction({
      projectId: 'my-proj',
      jobId: JOB_ID,
      filter: { sources: null, jurisdictionId: null },
      firestore: failingFirestore,
      jurisdictions: [usFederalJurisdiction, usFederalJurisdiction],
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      logger,
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toContain('wiring-error status')
  })

  it('runs discovery and transitions the job to a terminal status', async () => {
    mockBqQuery.mockReset()
    mockBqQuery.mockResolvedValue([[], {}])
    mockBqDataset.mockReturnValue({
      exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([true])),
      createTable: vi.fn<(id: string, opts: unknown) => Promise<unknown>>(() =>
        Promise.resolve([{}]),
      ),
      table: vi.fn<(id: string) => { exists: () => Promise<unknown> }>(() => ({
        exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([true])),
      })),
    })

    const fakeFirestore = makeFakeFirestore()
    // Seed the running row the start path would have inserted.
    await fakeFirestore.doc(`mcp_compliance_jobs/${JOB_ID}`).set({
      job_id: JOB_ID,
      started_at: '2024-05-01T00:00:00Z',
      finished_at: null,
      status: 'running',
      requested_sources: [],
      requested_jurisdiction: null,
      error_type: null,
      error_message: null,
      result: null,
    })

    // An empty sources filter resolves to an empty registry, so discovery
    // completes without launching a browser.
    await executeDiscoveryJobProduction({
      projectId: 'my-proj',
      jobId: JOB_ID,
      filter: { sources: [], jurisdictionId: null },
      firestore: fakeFirestore,
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
    })

    expect(mockBqQuery).toHaveBeenCalled()
    const snap = await fakeFirestore.doc(`mcp_compliance_jobs/${JOB_ID}`).get()
    // Terminal: either completed or failed, but no longer running.
    expect(snap.data()?.status).not.toBe('running')
    expect(snap.data()?.finished_at).not.toBeNull()
  })
})

describe('parseDiscoverJobEnv', () => {
  it('parses the job id and treats an absent DISCOVERY_SOURCES as all sources', () => {
    const parsed = parseDiscoverJobEnv({
      PROJECT_ID: 'my-proj',
      DISCOVERY_JOB_ID: JOB_ID,
    })
    expect(parsed).toEqual({
      projectId: 'my-proj',
      jobId: JOB_ID,
      filter: { sources: null, jurisdictionId: null },
    })
  })

  it('splits a comma-separated DISCOVERY_SOURCES and carries the jurisdiction', () => {
    const parsed = parseDiscoverJobEnv({
      PROJECT_ID: 'my-proj',
      DISCOVERY_JOB_ID: JOB_ID,
      DISCOVERY_SOURCES: 'irs-teos, ca-ag-registry',
      DISCOVERY_JURISDICTION_ID: 'us-ca',
    })
    expect(parsed.filter).toEqual({
      sources: ['irs-teos', 'ca-ag-registry'],
      jurisdictionId: 'us-ca',
    })
  })

  it('treats an empty DISCOVERY_SOURCES as all sources', () => {
    const parsed = parseDiscoverJobEnv({
      PROJECT_ID: 'my-proj',
      DISCOVERY_JOB_ID: JOB_ID,
      DISCOVERY_SOURCES: '',
    })
    expect(parsed.filter.sources).toBeNull()
  })

  it('throws when DISCOVERY_JOB_ID is missing', () => {
    expect(() => parseDiscoverJobEnv({ PROJECT_ID: 'my-proj' })).toThrow()
  })
})

describe('readDiscoveryJobStatusProduction', () => {
  it('reads the job doc from Firestore and counts child runs from BQ', async () => {
    mockBqQuery.mockReset()
    mockBqQuery.mockResolvedValue([[], {}])
    const fakeFirestore = makeFakeFirestore()
    // Seed Firestore with a running job doc.
    await fakeFirestore
      .doc('mcp_compliance_jobs/11111111-1111-4111-8111-111111111111')
      .set({
        job_id: '11111111-1111-4111-8111-111111111111',
        started_at: '2024-05-01T00:00:00Z',
        finished_at: null,
        status: 'running',
        requested_sources: null,
        requested_jurisdiction: null,
        error_type: null,
        error_message: null,
        result: null,
      })

    const result = await readDiscoveryJobStatusProduction({
      projectId: 'my-proj',
      jobId: '11111111-1111-4111-8111-111111111111',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      firestore: fakeFirestore,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.status).toBe('running')
  })
})

describe('readDiscoveryJobResultProduction', () => {
  it('returns the stored result from Firestore when the job is completed', async () => {
    const fakeFirestore = makeFakeFirestore()
    await fakeFirestore
      .doc('mcp_compliance_jobs/11111111-1111-4111-8111-111111111111')
      .set({
        job_id: '11111111-1111-4111-8111-111111111111',
        started_at: '2024-05-01T00:00:00Z',
        finished_at: '2024-05-01T00:00:30Z',
        status: 'completed',
        requested_sources: null,
        requested_jurisdiction: null,
        error_type: null,
        error_message: null,
        result: { runs: [], findings: [] },
      })

    const result = await readDiscoveryJobResultProduction({
      projectId: 'my-proj',
      jobId: '11111111-1111-4111-8111-111111111111',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      firestore: fakeFirestore,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual({ runs: [], findings: [] })
  })
})
