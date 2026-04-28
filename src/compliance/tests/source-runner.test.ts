/**
 * Tests for the source runner.
 *
 * The runner:
 *   - dispatches by kind (Phase 1 only accepts `api`)
 *   - calls source.run(entity, ctx)
 *   - records every run (success and failure) via the injected RunRecorder
 *   - records derived findings via the same RunRecorder on success
 *   - measures duration_ms
 *   - clamps started_at and completed_at to the injected `now` clock
 *   - never throws; every failure becomes a typed Result error
 */
import { errAsync, okAsync } from 'neverthrow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceError } from '../sources/errors.ts'
import type { RunRecorder } from '../sources/runner.ts'
import { runSource } from '../sources/runner.ts'
import type {
  Entity,
  FetchImpl,
  Finding,
  Source,
  SourceContext,
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
  updated_at: '2024-01-01T00:00:00Z',
}

interface FakeRecorderState {
  recordRun: ReturnType<typeof vi.fn<RunRecorder['recordRun']>>
  recordFindings: ReturnType<typeof vi.fn<RunRecorder['recordFindings']>>
}

function fakeRecorder(): FakeRecorderState & RunRecorder {
  const recordRun = vi.fn<RunRecorder['recordRun']>(() => okAsync(undefined))
  const recordFindings = vi.fn<RunRecorder['recordFindings']>(() =>
    okAsync(undefined),
  )
  return { recordRun, recordFindings }
}

function makeSuccessSource(
  output: SourceRunOutput,
  overrides: Partial<Source> = {},
): Source {
  return {
    id: 'fake',
    jurisdiction: 'us-federal',
    kind: 'api',
    authRequired: false,
    description: 'fake',
    tosUrl: 'https://example.com/tos',
    run: () => okAsync(output),
    ...overrides,
  }
}

function makeFailingSource(
  error: SourceError,
  kind: Source['kind'] = 'api',
): Source {
  return {
    id: 'fake',
    jurisdiction: 'us-federal',
    kind,
    authRequired: false,
    description: 'fake',
    tosUrl: 'https://example.com/tos',
    run: () => errAsync(error),
  }
}

function makeContext(overrides: Partial<SourceContext> = {}): SourceContext {
  let tickMs = 0
  return {
    now: () => new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + (tickMs += 1000)),
    fetch: vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 500 })),
    ),
    identifiers: { 'us-federal': { ein: '12-3456789' } },
    ...overrides,
  }
}

function makeFinding(): Finding {
  return {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: 'us-federal',
    source_id: 'fake',
    severity: 'info',
    status: 'open',
    title: 'EIN listed in Pub. 78',
    detail: 'EIN appears in IRS Pub. 78 with deductibility code PC.',
    evidence: { deductibilityCode: 'PC' },
    opened_at: '2024-01-01T00:00:01.000Z',
    resolved_at: null,
  }
}

describe('runSource', () => {
  let recorder: FakeRecorderState & RunRecorder

  beforeEach(() => {
    recorder = fakeRecorder()
  })

  it('runs a successful api source and returns its output', async () => {
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'fake',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [],
    }
    const source = makeSuccessSource(output)
    const ctx = makeContext()

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toEqual(output)
  })

  it('records a succeeded discovery_runs row on success', async () => {
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'fake',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [],
    }
    const source = makeSuccessSource(output)
    const ctx = makeContext()

    await runSource({ source, entity: ENTITY, ctx, recorder })

    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    const row = recorder.recordRun.mock.calls[0]?.[0]
    expect(row).toBeDefined()
    if (!row) return
    expect(row.source_id).toBe('fake')
    expect(row.jurisdiction_id).toBe('us-federal')
    expect(row.status).toBe('succeeded')
    expect(row.error_type).toBeNull()
    expect(row.error_message).toBeNull()
    expect(row.payload).toEqual({ ok: true })
    expect(row.started_at).toBe('2024-01-01T00:00:01.000Z')
    expect(row.completed_at).toBe('2024-01-01T00:00:02.000Z')
    expect(row.duration_ms).toBe(1000)
  })

  it('records findings when the source emits them', async () => {
    const finding = makeFinding()
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'fake',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [finding],
    }
    const source = makeSuccessSource(output)
    const ctx = makeContext()

    await runSource({ source, entity: ENTITY, ctx, recorder })

    expect(recorder.recordFindings).toHaveBeenCalledTimes(1)
    expect(recorder.recordFindings.mock.calls[0]?.[0]).toEqual([finding])
  })

  it('does not call recordFindings when the source emits zero findings', async () => {
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'fake',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [],
    }
    const source = makeSuccessSource(output)
    const ctx = makeContext()

    await runSource({ source, entity: ENTITY, ctx, recorder })

    expect(recorder.recordFindings).not.toHaveBeenCalled()
  })

  it('records a failed run when the source returns err', async () => {
    const source = makeFailingSource({
      type: 'http',
      status: 502,
      message: 'Bad Gateway',
    })
    const ctx = makeContext()

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('http')
    }

    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    const row = recorder.recordRun.mock.calls[0]?.[0]
    expect(row).toBeDefined()
    if (!row) return
    expect(row.status).toBe('failed')
    expect(row.error_type).toBe('http')
    expect(row.error_message).toContain('Bad Gateway')
    expect(row.payload).toBeNull()
  })

  it('does not record findings when the source fails', async () => {
    const source = makeFailingSource({
      type: 'parse',
      message: 'unexpected payload',
    })
    const ctx = makeContext()

    await runSource({ source, entity: ENTITY, ctx, recorder })

    expect(recorder.recordFindings).not.toHaveBeenCalled()
  })

  it('rejects a non-api source kind with a tos error', async () => {
    const source = makeFailingSource(
      { type: 'internal', message: 'unused' },
      'playwright',
    )
    const ctx = makeContext()

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('tos')
      expect(result.error.message).toContain('playwright')
    }
    // No discovery_run is recorded for a refused dispatch — there was no run.
    expect(recorder.recordRun).not.toHaveBeenCalled()
  })

  it('rejects a manual source kind in Phase 1', async () => {
    const source = makeFailingSource(
      { type: 'internal', message: 'unused' },
      'manual',
    )
    const ctx = makeContext()

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('tos')
      expect(result.error.message).toContain('manual')
    }
  })

  it('refuses to run a source that requires auth (Phase 1 has no auth context)', async () => {
    const source = makeSuccessSource(
      {
        record: {
          record_id: '550e8400-e29b-41d4-a716-446655440000',
          source_id: 'fake',
          fetched_at: '2024-01-01T00:00:01.000Z',
          payload: {},
        },
        findings: [],
      },
      { authRequired: true },
    )
    const ctx = makeContext()

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('tos')
      expect(result.error.message).toMatch(/auth/i)
    }
    expect(recorder.recordRun).not.toHaveBeenCalled()
  })

  it('still returns the source error even when recordRun itself errors', async () => {
    const source = makeFailingSource({ type: 'network', message: 'down' })
    const ctx = makeContext()
    recorder.recordRun.mockReturnValueOnce(
      errAsync({ type: 'recorder', message: 'BQ down' }),
    )

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      // The original source error is preserved; recorder failure only adds
      // context to the run row metadata. We don't lose the upstream cause.
      expect(result.error.type).toBe('network')
    }
  })

  it('returns the source error even when recordFindings fails', async () => {
    const finding = makeFinding()
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'fake',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [finding],
    }
    const source = makeSuccessSource(output)
    const ctx = makeContext()
    recorder.recordFindings.mockReturnValueOnce(
      errAsync({ type: 'recorder', message: 'BQ down' }),
    )

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    // Findings persistence failures bubble up as `internal` so the caller knows
    // the run succeeded but downstream record-keeping did not.
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toContain('findings')
    }
  })

  it('returns the source error when recordRun fails on a successful run', async () => {
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'fake',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [],
    }
    const source = makeSuccessSource(output)
    const ctx = makeContext()
    recorder.recordRun.mockReturnValueOnce(
      errAsync({ type: 'recorder', message: 'BQ unavailable' }),
    )

    const result = await runSource({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toContain('discovery_runs')
    }
  })
})
