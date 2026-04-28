/**
 * Tests for the compliance-discover skill backend.
 *
 * `runDiscovery` loads the entity row and identifiers, then runs every source
 * registered in the registry. For Phase 1 only the IRS TEOS source exists,
 * but the orchestrator is shape-agnostic.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JurisdictionRegistry } from '../registry/jurisdiction-registry.ts'
import { runDiscovery } from '../skills/discover.ts'
import type { ComplianceMigrationPort } from '../skills/migrate.ts'
import type { RunRecorder } from '../sources/runner.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type {
  Entity,
  FetchImpl,
  Finding,
  Jurisdiction,
  Source,
  SourceRunOutput,
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
  updated_at: '2024-05-01T00:00:00Z',
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
  identifiers: {
    'us-federal'?: { ein: string }
    'us-ca'?: { sosEntityNumber: string }
  } | null,
): EntityIdsAccessor {
  return {
    read: vi.fn<EntityIdsAccessor['read']>(() => okAsync(identifiers)),
    write: vi.fn<EntityIdsAccessor['write']>(() => okAsync(undefined)),
  }
}

function fakeRecorder(): RunRecorder {
  return {
    recordRun: vi.fn<RunRecorder['recordRun']>(() => okAsync(undefined)),
    recordFindings: vi.fn<RunRecorder['recordFindings']>(() =>
      okAsync(undefined),
    ),
  }
}

/**
 * Default migration port for discover tests: dataset + tables already exist
 * (the common case after a one-time provisioning).
 */
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
    ...overrides,
  }
}

interface MakeFindingArgs {
  readonly source: string
  readonly title?: string
  readonly severity?: Finding['severity']
}

function makeFinding(args: MakeFindingArgs): Finding {
  return {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: 'us-federal',
    source_id: args.source,
    severity: args.severity ?? 'info',
    status: 'open',
    title: args.title ?? 'something',
    detail: 'detail',
    evidence: {},
    opened_at: '2024-05-01T00:00:01.000Z',
    resolved_at: null,
  }
}

interface MakeSourceArgs {
  readonly id: string
  readonly findings?: readonly Finding[]
  readonly fail?: boolean
}

function makeSource(args: MakeSourceArgs): Source {
  return {
    id: args.id,
    jurisdiction: 'us-federal',
    kind: 'api',
    authRequired: false,
    description: 'fake',
    tosUrl: 'https://example.com/tos',
    run: vi.fn<Source['run']>(() => {
      if (args.fail === true) {
        return errAsync({ type: 'http', status: 500, message: 'broken' })
      }
      const output: SourceRunOutput = {
        record: {
          record_id: '550e8400-e29b-41d4-a716-446655440000',
          source_id: args.id,
          fetched_at: '2024-05-01T00:00:01.000Z',
          payload: { ok: true, source: args.id },
        },
        findings: args.findings ?? [],
      }
      return okAsync(output)
    }),
  }
}

function fakeRegistry(jurisdictions: Jurisdiction[]): JurisdictionRegistry {
  return {
    register: vi.fn<JurisdictionRegistry['register']>(),
    get: vi.fn<JurisdictionRegistry['get']>(),
    list: () => jurisdictions,
  }
}

function makeJurisdiction(sources: Source[]): Jurisdiction {
  return {
    id: 'us-federal',
    entityIdSchema: z.object({}),
    sources,
    deadlineRules: [],
    forms: [],
  }
}

describe('runDiscovery', () => {
  it('runs every source from every registered jurisdiction', async () => {
    const sourceA = makeSource({ id: 'a' })
    const sourceB = makeSource({ id: 'b' })
    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([sourceA, sourceB])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date('2024-05-01T00:00:00Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.runs).toHaveLength(2)
    expect(sourceA.run).toHaveBeenCalledTimes(1)
    expect(sourceB.run).toHaveBeenCalledTimes(1)
  })

  it('returns a configuration error when the entity has not been onboarded', async () => {
    const source = makeSource({ id: 'a' })
    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(null),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('not_onboarded')
      expect(result.error.message).toMatch(/onboard/i)
    }
    expect(source.run).not.toHaveBeenCalled()
  })

  it('returns a configuration error when no identifiers are stored', async () => {
    const source = makeSource({ id: 'a' })
    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor(null),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('not_onboarded')
    }
    expect(source.run).not.toHaveBeenCalled()
  })

  it('captures per-source success and failure independently', async () => {
    const sourceA = makeSource({ id: 'a' })
    const sourceB = makeSource({ id: 'b', fail: true })

    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([sourceA, sourceB])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date('2024-05-01T00:00:00Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const successes = result.value.runs.filter((r) => r.outcome === 'ok')
    const failures = result.value.runs.filter((r) => r.outcome === 'err')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.sourceId).toBe('b')
  })

  it('aggregates findings across all sources', async () => {
    const sourceA = makeSource({
      id: 'a',
      findings: [makeFinding({ source: 'a', title: 'one' })],
    })
    const sourceB = makeSource({
      id: 'b',
      findings: [makeFinding({ source: 'b', title: 'two', severity: 'warn' })],
    })

    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([sourceA, sourceB])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date('2024-05-01T00:00:00Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.findings.map((f) => f.title)).toEqual(['one', 'two'])
  })

  it('passes identifiers + fetch + now into each source context', async () => {
    const source = makeSource({ id: 'a' })
    const fetchFn = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 200 })),
    )
    const fixedNow = new Date('2024-05-01T00:00:00.000Z')

    await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => fixedNow,
      fetch: fetchFn,
    })

    const [entity, ctx] = vi.mocked(source.run).mock.calls[0] ?? []
    expect(entity).toBe(ENTITY)
    expect(ctx?.identifiers).toEqual({ 'us-federal': { ein: '12-3456789' } })
    expect(ctx?.fetch).toBe(fetchFn)
    expect(ctx?.now()).toEqual(fixedNow)
  })

  it('propagates a load error if reading the entity fails for non-null reasons', async () => {
    const accessor: EntityAccessor = {
      readEntity: vi.fn<EntityAccessor['readEntity']>(() =>
        errAsync({ type: 'query', message: 'BQ down' }),
      ),
      upsertEntity: vi.fn<EntityAccessor['upsertEntity']>(() =>
        okAsync(undefined),
      ),
    }
    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([])]),
      entityAccessor: accessor,
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('load')
      expect(result.error.message).toContain('BQ down')
    }
  })

  it('propagates a load error if reading identifiers fails for non-null reasons', async () => {
    const accessor: EntityIdsAccessor = {
      read: vi.fn<EntityIdsAccessor['read']>(() =>
        errAsync({ type: 'sdk', message: 'SM down' }),
      ),
      write: vi.fn<EntityIdsAccessor['write']>(() => okAsync(undefined)),
    }
    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: accessor,
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('load')
      expect(result.error.message).toContain('SM down')
    }
  })

  it('returns an empty run set when no sources are registered', async () => {
    const result = await runDiscovery({
      registry: fakeRegistry([]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: fakeMigrationPort(),
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.runs).toEqual([])
    expect(result.value.findings).toEqual([])
  })

  it('runs the schema migration before any sources execute', async () => {
    const source = makeSource({ id: 'a' })
    const port = fakeMigrationPort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(false),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(false),
      ),
    })

    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: port,
      now: () => new Date('2024-05-01T00:00:00Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })
    expect(result.isOk()).toBe(true)
    expect(port.createDataset).toHaveBeenCalledTimes(1)
    expect(port.createTable).toHaveBeenCalledTimes(4)
    expect(source.run).toHaveBeenCalledTimes(1)
  })

  it('reports what the migration created on the discovery report', async () => {
    const source = makeSource({ id: 'a' })
    const port = fakeMigrationPort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        okAsync(false),
      ),
      tableExists: vi.fn<ComplianceMigrationPort['tableExists']>(() =>
        okAsync(false),
      ),
    })

    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: port,
      now: () => new Date('2024-05-01T00:00:00Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.migration.createdDataset).toBe(true)
    expect(result.value.migration.createdTables.length).toBe(4)
  })

  it('does not run sources if the migration fails', async () => {
    const source = makeSource({ id: 'a' })
    const port = fakeMigrationPort({
      datasetExists: vi.fn<ComplianceMigrationPort['datasetExists']>(() =>
        errAsync({ type: 'sdk', message: 'forbidden' }),
      ),
    })

    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: port,
      now: () => new Date(),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('load')
      expect(result.error.message).toContain('forbidden')
    }
    expect(source.run).not.toHaveBeenCalled()
  })

  it('reports a no-op migration when nothing needed creating', async () => {
    const source = makeSource({ id: 'a' })
    // Default fakeMigrationPort = everything already exists.
    const port = fakeMigrationPort()

    const result = await runDiscovery({
      registry: fakeRegistry([makeJurisdiction([source])]),
      entityAccessor: fakeEntityAccessor(ENTITY),
      identifiersAccessor: fakeIdsAccessor({
        'us-federal': { ein: '12-3456789' },
      }),
      recorder: fakeRecorder(),
      migrationPort: port,
      now: () => new Date('2024-05-01T00:00:00Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 200 })),
      ),
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.migration.createdDataset).toBe(false)
    expect(result.value.migration.createdTables).toEqual([])
    expect(port.createDataset).not.toHaveBeenCalled()
    expect(port.createTable).not.toHaveBeenCalled()
  })
})
