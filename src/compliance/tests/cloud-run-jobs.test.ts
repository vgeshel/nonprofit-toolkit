/**
 * Tests for the Cloud Run Job launcher used by the async compliance-discover
 * flow.
 *
 * Coverage:
 *   - buildDiscoveryEnvOverrides emits the job id plus the optional filter
 *     fields only when present.
 *   - createCloudRunJobLauncher POSTs the `:run` endpoint with a bearer
 *     token and container env overrides, and maps non-2xx / token failures
 *     to a `launch` error.
 *   - defaultGetAccessToken mints a token via google-auth-library and
 *     rejects an empty one.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  buildDiscoveryEnvOverrides,
  createCloudRunJobLauncher,
  defaultGetAccessToken,
  type FetchLike,
  type GetAccessToken,
} from '../state/cloud-run-jobs.ts'

const RunRequestBodySchema = z.object({
  overrides: z.object({
    containerOverrides: z.array(
      z.object({
        env: z.array(z.object({ name: z.string(), value: z.string() })),
      }),
    ),
  }),
})

const { mockGetAccessToken } = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn<() => Promise<string | null | undefined>>(),
}))

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = mockGetAccessToken
  },
}))

const PROJECT = 'proj-1'
const REGION = 'us-central1'
const JOB = 'compliance-discover'
const JOB_ID = '11111111-1111-4111-8111-111111111111'
const EXPECTED_URL = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run`

const okToken: GetAccessToken = () => Promise.resolve('test-token')

describe('buildDiscoveryEnvOverrides', () => {
  it('emits only the job id when the filter is empty', () => {
    const env = buildDiscoveryEnvOverrides(JOB_ID, {
      sources: null,
      jurisdictionId: null,
    })
    expect(env).toEqual([{ name: 'DISCOVERY_JOB_ID', value: JOB_ID }])
  })

  it('adds DISCOVERY_SOURCES (comma-joined) when sources are present', () => {
    const env = buildDiscoveryEnvOverrides(JOB_ID, {
      sources: ['irs-teos', 'ca-ag-registry'],
      jurisdictionId: null,
    })
    expect(env).toContainEqual({
      name: 'DISCOVERY_SOURCES',
      value: 'irs-teos,ca-ag-registry',
    })
  })

  it('omits DISCOVERY_SOURCES when the sources array is empty', () => {
    const env = buildDiscoveryEnvOverrides(JOB_ID, {
      sources: [],
      jurisdictionId: null,
    })
    expect(env.some((e) => e.name === 'DISCOVERY_SOURCES')).toBe(false)
  })

  it('adds DISCOVERY_JURISDICTION_ID when present', () => {
    const env = buildDiscoveryEnvOverrides(JOB_ID, {
      sources: null,
      jurisdictionId: 'us-ca',
    })
    expect(env).toContainEqual({
      name: 'DISCOVERY_JURISDICTION_ID',
      value: 'us-ca',
    })
  })
})

describe('createCloudRunJobLauncher', () => {
  it('POSTs the :run endpoint with a bearer token and env overrides, and resolves ok', async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ name: 'op-1' }), { status: 200 }),
    )
    const launcher = createCloudRunJobLauncher({
      projectId: PROJECT,
      region: REGION,
      jobName: JOB,
      fetch: fetchMock,
      getAccessToken: okToken,
    })

    const result = await launcher({
      jobId: JOB_ID,
      filter: { sources: ['irs-teos'], jurisdictionId: 'us-federal' },
    })

    expect(result.isOk()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? []
    expect(calledUrl).toBe(EXPECTED_URL)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer test-token',
    )
    const body = RunRequestBodySchema.parse(JSON.parse(String(init?.body)))
    expect(body.overrides.containerOverrides[0]?.env).toContainEqual({
      name: 'DISCOVERY_JOB_ID',
      value: JOB_ID,
    })
    expect(body.overrides.containerOverrides[0]?.env).toContainEqual({
      name: 'DISCOVERY_SOURCES',
      value: 'irs-teos',
    })
  })

  it('returns a launch error when the API responds non-2xx', async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response('forbidden', { status: 403 }),
    )
    const launcher = createCloudRunJobLauncher({
      projectId: PROJECT,
      region: REGION,
      jobName: JOB,
      fetch: fetchMock,
      getAccessToken: okToken,
    })

    const result = await launcher({
      jobId: JOB_ID,
      filter: { sources: null, jurisdictionId: null },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('launch')
    expect(result.error.message).toContain('403')
    expect(result.error.message).toContain('forbidden')
  })

  it('returns a launch error when minting the token fails', async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response('{}', { status: 200 }),
    )
    const launcher = createCloudRunJobLauncher({
      projectId: PROJECT,
      region: REGION,
      jobName: JOB,
      fetch: fetchMock,
      getAccessToken: () => Promise.reject(new Error('no credentials')),
    })

    const result = await launcher({
      jobId: JOB_ID,
      filter: { sources: null, jurisdictionId: null },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('launch')
    expect(result.error.message).toBe('no credentials')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error rejection into the launch message', async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response('{}', { status: 200 }),
    )
    // A non-Error thrown value (typed `unknown`) exercises the `String(e)`
    // fallback in the launch-error mapper.
    const nonError: unknown = 'plain string failure'
    const launcher = createCloudRunJobLauncher({
      projectId: PROJECT,
      region: REGION,
      jobName: JOB,
      fetch: fetchMock,
      getAccessToken: () => {
        throw nonError
      },
    })

    const result = await launcher({
      jobId: JOB_ID,
      filter: { sources: null, jurisdictionId: null },
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.message).toBe('plain string failure')
  })

  it('falls back to the global fetch + default token source when omitted', () => {
    // Constructing without fetch/getAccessToken exercises the `?? fetch` /
    // `?? defaultGetAccessToken` defaults without making a network call
    // (the returned launcher is not invoked here).
    const launcher = createCloudRunJobLauncher({
      projectId: PROJECT,
      region: REGION,
      jobName: JOB,
    })
    expect(typeof launcher).toBe('function')
  })
})

describe('defaultGetAccessToken', () => {
  it('returns the token google-auth-library yields', async () => {
    mockGetAccessToken.mockResolvedValueOnce('minted-token')
    await expect(defaultGetAccessToken()).resolves.toBe('minted-token')
  })

  it('throws when the token is an empty string', async () => {
    mockGetAccessToken.mockResolvedValueOnce('')
    await expect(defaultGetAccessToken()).rejects.toThrow('empty token')
  })

  it('throws when the token is null', async () => {
    mockGetAccessToken.mockResolvedValueOnce(null)
    await expect(defaultGetAccessToken()).rejects.toThrow('empty token')
  })
})
