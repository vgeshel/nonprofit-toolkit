/**
 * Tests for the discovery_runs accessor.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { BqQueryRunner } from '../state/bq-entity.ts'
import type { ComplianceDiscoveryRunRow } from '../state/bq-rows.ts'
import { createDiscoveryRunsAccessor } from '../state/bq-runs.ts'

const ROW: ComplianceDiscoveryRunRow = {
  run_id: '550e8400-e29b-41d4-a716-446655440000',
  source_id: 'irs-teos',
  jurisdiction_id: 'us-federal',
  status: 'succeeded',
  started_at: '2024-05-01T00:00:00Z',
  completed_at: '2024-05-01T00:00:01Z',
  duration_ms: 1000,
  error_type: null,
  error_message: null,
  payload: { ok: true },
}

function fakeRunner(
  query: ReturnType<typeof vi.fn<BqQueryRunner['query']>>,
): BqQueryRunner {
  return { query }
}

describe('createDiscoveryRunsAccessor.recordRun', () => {
  it('inserts the row using parameterised SQL', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordRun(ROW)
    expect(result.isOk()).toBe(true)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/INSERT/i)
    expect(sql).toMatch(/`proj\.compliance\.discovery_runs`/)
    expect(params).toMatchObject({
      run_id: ROW.run_id,
      source_id: ROW.source_id,
      status: 'succeeded',
    })
    // payload travels as a JSON-encoded string for BQ JSON columns
    expect(typeof params?.payload).toBe('string')
    expect(JSON.parse(String(params?.payload))).toEqual({ ok: true })
  })

  it('passes a types map covering every nullable column', async () => {
    // BigQuery rejects null parameter values without an explicit type. The
    // accessor must always send a `types` map for nullable columns so that a
    // failed run (with null payload, error_type, error_message) inserts.
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    await accessor.recordRun(ROW)
    const [, , types] = query.mock.calls[0] ?? []
    expect(types).toEqual({
      error_type: 'STRING',
      error_message: 'STRING',
      payload: 'STRING',
    })
  })

  it('passes SQL NULL for a null payload', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const failed: ComplianceDiscoveryRunRow = {
      ...ROW,
      status: 'failed',
      error_type: 'http',
      error_message: '[http 502] Bad Gateway',
      payload: null,
    }
    await accessor.recordRun(failed)
    const [, params] = query.mock.calls[0] ?? []
    expect(params?.payload).toBeNull()
    expect(params?.error_type).toBe('http')
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordRun(ROW)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
      expect(result.error.message).toContain('BQ down')
    }
  })
})

describe('createDiscoveryRunsAccessor.listLatestRuns', () => {
  it('reads and validates the latest run rows ordered by jurisdiction and source', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([ROW]))
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.listLatestRuns()

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual([ROW])
    const [sql] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER/i)
    expect(sql).toMatch(/ORDER BY jurisdiction_id, source_id/i)
  })

  it('returns a parse error for malformed rows', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      okAsync([{ ...ROW, run_id: 'not-a-uuid' }]),
    )
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.listLatestRuns()

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Invalid discovery_runs row')
  })

  it('propagates query errors when listing latest runs', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createDiscoveryRunsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.listLatestRuns()

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('query')
    expect(result.error.message).toContain('BQ down')
  })
})
