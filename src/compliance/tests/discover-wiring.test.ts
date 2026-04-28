/**
 * Tests for `runDiscoveryProduction` and `buildRegistry`.
 *
 * The function is a thin glue layer between the production-side wiring
 * (`buildCommonDeps`) and the orchestration logic (`runDiscovery`). The
 * orchestration tests live in `discover.test.ts`; here we verify only the
 * wiring contract:
 *
 *   - Default `now`, `fetch`, and `jurisdictions` are supplied when
 *     omitted.
 *   - Injected factories propagate to the deps builder.
 *   - The recorder writes to BigQuery via the shared query runner.
 *   - `buildRegistry` succeeds for a clean list and reports the underlying
 *     `RegistryError` for a duplicate.
 *   - The `wiring` error path fires when registration fails.
 */
import { ResultAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type {
  Entity,
  FetchImpl,
  Finding,
  Jurisdiction,
  Source,
  SourceRunOutput,
} from '../types/index.ts'

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
const { runDiscoveryProduction, buildRegistry } =
  await import('../skills/discover-wiring.ts')

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

const ENTITY_ROW = {
  ...ENTITY,
  updated_at: { value: '2024-05-01T00:00:00.000Z' },
}

const IDENTIFIERS = {
  'us-federal': { ein: '12-3456789' },
  'us-ca': { sosEntityNumber: 'C0123456' },
}

function makeSource(args: {
  id: string
  findings?: readonly Finding[]
}): Source {
  return {
    id: args.id,
    jurisdiction: 'us-federal',
    kind: 'api',
    authRequired: false,
    description: 'fake',
    accessUrl: 'https://example.com/source',
    accessMethod: 'official_api',
    automationAllowed: true,
    tosUrl: 'https://example.com/tos',
    run: vi.fn<Source['run']>(() => {
      const output: SourceRunOutput = {
        record: {
          record_id: '550e8400-e29b-41d4-a716-446655440000',
          source_id: args.id,
          fetched_at: '2024-05-01T00:00:01.000Z',
          payload: { ok: true },
        },
        findings: args.findings ?? [],
      }
      return okAsync(output)
    }),
  }
}

function makeJurisdiction(id: string, sources: Source[]): Jurisdiction {
  return {
    id,
    entityIdSchema: z.object({}),
    sources,
    deadlineRules: [],
    forms: [],
  }
}

/**
 * Common mock setup. The migration is a no-op (dataset+tables exist), the
 * Secret Manager access returns the canonical identifiers payload, and the
 * BigQuery query that reads the entity row returns one row.
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

  // Sequence: first query reads the entity row, subsequent queries are
  // recordRun / recordFindings inserts. Resolve everything cleanly.
  mockBqQuery.mockImplementation((opts: unknown) => {
    if (
      typeof opts === 'object' &&
      opts !== null &&
      'query' in opts &&
      typeof opts.query === 'string' &&
      opts.query.toUpperCase().includes('SELECT')
    ) {
      return Promise.resolve([[ENTITY_ROW], {}])
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

describe('buildRegistry', () => {
  it('returns ok with a registry containing every jurisdiction', () => {
    const a = makeJurisdiction('us-federal', [])
    const b = makeJurisdiction('us-ca', [])
    const r = buildRegistry([a, b])
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(
      r.value
        .list()
        .map((j) => j.id)
        .sort(),
    ).toEqual(['us-ca', 'us-federal'])
  })

  it('returns the underlying RegistryError when registration fails', () => {
    const a = makeJurisdiction('us-federal', [])
    const dup = makeJurisdiction('us-federal', [])
    const r = buildRegistry([a, dup])
    expect(r.kind).toBe('err')
    if (r.kind !== 'err') return
    expect(r.error.type).toBe('duplicate')
    expect(r.error.id).toBe('us-federal')
  })
})

describe('runDiscoveryProduction', () => {
  it('runs every source and persists the record + findings via BigQuery', async () => {
    happyPath()

    const finding: Finding = {
      finding_id: '550e8400-e29b-41d4-a716-446655440000',
      jurisdiction_id: 'us-federal',
      source_id: 'fake-src',
      severity: 'info',
      status: 'open',
      title: 'hello',
      detail: 'world',
      evidence: {},
      opened_at: '2024-05-01T00:00:01.000Z',
      resolved_at: null,
    }
    const source = makeSource({ id: 'fake-src', findings: [finding] })

    const result = await runDiscoveryProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2024-05-01T00:00:00.000Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
      jurisdictions: [makeJurisdiction('us-federal', [source])],
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.runs).toHaveLength(1)
    expect(result.value.runs[0]?.outcome.status).toBe('success')
    expect(result.value.findings).toHaveLength(1)

    // The recorder fired two inserts (one run, one finding) plus one entity
    // SELECT + one identifiers SELECT (Secret Manager). Verify at least the
    // run-insert touched BQ.
    const insertOpts = mockBqQuery.mock.calls
      .map((c) => c[0])
      .filter(
        (opt): opt is { query: string } =>
          typeof opt === 'object' &&
          opt !== null &&
          'query' in opt &&
          typeof opt.query === 'string',
      )
      .map((opt) => opt.query)
    expect(insertOpts.some((q) => q.includes('INSERT INTO'))).toBe(true)
  })

  it('uses the system clock and global fetch when neither is supplied', async () => {
    // We don't actually exercise the global fetch (no source is provided), but
    // we DO exercise the `??` defaults. The default `fetch` is a thin closure
    // around the global; constructing it without calling it is enough for
    // coverage.
    happyPath()

    const result = await runDiscoveryProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      jurisdictions: [makeJurisdiction('us-federal', [])],
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.runs).toEqual([])
  })

  it('threads the global fetch through the default closure when fetch is omitted', async () => {
    // Replace the global `fetch` with a recording fake. The default closure
    // forwards `(input, init) => fetch(input, init)`; if that closure is
    // exercised, our fake gets called. We then assert it was hit by a source
    // whose `run` calls `ctx.fetch(...)`.
    happyPath()
    const captured = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 200 })),
    )
    // Bun's global `fetch` carries a `preconnect` method; the closure in
    // `runDiscoveryProduction` only invokes the call signature, so we can
    // synthesize a value that satisfies `typeof fetch` by attaching the real
    // `preconnect` to our recording fake.
    const realFetch = globalThis.fetch
    // The closure in `runDiscoveryProduction` only invokes the call signature
    // of `fetch`; `preconnect` is never used. Provide a no-op so the
    // `typeof fetch` shape is satisfied at the assignment site.
    const fakeFetch: typeof fetch = Object.assign(captured, {
      preconnect: () => undefined,
    })
    globalThis.fetch = fakeFetch

    // Build a source whose run reaches into ctx.fetch and resolves whatever
    // it returns. This is the only way to exercise the default closure body.
    const source: Source = {
      id: 'fake-src',
      jurisdiction: 'us-federal',
      kind: 'api',
      authRequired: false,
      description: 'fake',
      accessUrl: 'https://example.com/source',
      accessMethod: 'official_api',
      automationAllowed: true,
      tosUrl: 'https://example.com/tos',
      run: vi.fn<Source['run']>((_entity, ctx) =>
        ResultAsync.fromPromise(
          ctx.fetch('https://example.com/x'),
          () => ({ type: 'http', status: 0, message: 'unreachable' }) as const,
        ).map(
          (): SourceRunOutput => ({
            record: {
              record_id: '550e8400-e29b-41d4-a716-446655440000',
              source_id: 'fake-src',
              fetched_at: '2024-05-01T00:00:01.000Z',
              payload: {},
            },
            findings: [],
          }),
        ),
      ),
    }

    try {
      const result = await runDiscoveryProduction({
        projectId: 'my-proj',
        bqFactory: (projectId) => new BigQuery({ projectId }),
        secretManagerFactory: () => new SecretManagerServiceClient(),
        jurisdictions: [makeJurisdiction('us-federal', [source])],
      })

      expect(result.isOk()).toBe(true)
      expect(captured).toHaveBeenCalledWith('https://example.com/x', undefined)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('uses the default jurisdictions list when none is supplied', async () => {
    // Default is `[usFederalJurisdiction]`. The IRS TEOS source it ships
    // with will try to fetch — we inject a fetch that fails fast so the run
    // is recorded as a failure (which is fine; we are only proving the
    // default jurisdictions list reached `runDiscovery`).
    happyPath()

    const result = await runDiscoveryProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date('2024-05-01T00:00:00.000Z'),
      fetch: vi.fn<FetchImpl>(() => Promise.reject(new Error('blocked'))),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.runs.map((run) => run.sourceId).sort()).toEqual([
      'ca-ag-registry',
      'ca-ftb-entity-status-letter',
      'ca-sos-bizfile',
      'irs-eo-bmf',
      'irs-teos',
    ])
  })

  it('returns a wiring error when jurisdiction registration fails', async () => {
    happyPath()

    const dup = makeJurisdiction('us-federal', [])
    const result = await runDiscoveryProduction({
      projectId: 'my-proj',
      bqFactory: (projectId) => new BigQuery({ projectId }),
      secretManagerFactory: () => new SecretManagerServiceClient(),
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
      jurisdictions: [dup, dup],
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('wiring')
    expect(result.error.message).toContain('us-federal')
  })
})
