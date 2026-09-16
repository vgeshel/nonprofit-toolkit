/**
 * Tests for the discovery_jobs accessor.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { BqQueryRunner } from '../state/bq-entity.ts'
import {
  createDiscoveryJobsAccessor,
  type JobFinishUpdate,
} from '../state/bq-jobs.ts'
import type { ComplianceDiscoveryJobRow } from '../state/bq-rows.ts'

const ROW: ComplianceDiscoveryJobRow = {
  job_id: '11111111-1111-4111-8111-111111111111',
  started_at: '2024-05-01T00:00:00Z',
  finished_at: null,
  status: 'running',
  requested_sources: null,
  requested_jurisdiction: null,
  error_type: null,
  error_message: null,
  result: null,
}

function fakeRunner(
  query: ReturnType<typeof vi.fn<BqQueryRunner['query']>>,
): BqQueryRunner {
  return { query }
}

describe('createDiscoveryJobsAccessor.recordJob', () => {
  it('inserts a running job using parameterised SQL', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordJob(ROW)
    expect(result.isOk()).toBe(true)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params, types] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/INSERT/i)
    expect(sql).toMatch(/`proj\.compliance\.discovery_jobs`/)
    expect(params).toMatchObject({
      job_id: ROW.job_id,
      status: 'running',
      finished_at: null,
      requested_sources: null,
      requested_jurisdiction: null,
      result: null,
    })
    // BQ needs explicit types for every nullable parameter we may send null for.
    expect(types).toMatchObject({
      finished_at: 'TIMESTAMP',
      requested_sources: 'STRING',
      requested_jurisdiction: 'STRING',
      error_type: 'STRING',
      error_message: 'STRING',
      result: 'STRING',
    })
  })

  it('serialises requested_sources as a JSON string for PARSE_JSON', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordJob({
      ...ROW,
      requested_sources: ['irs-teos', 'ca-sos-bizfile'],
      requested_jurisdiction: 'us-ca',
    })
    expect(result.isOk()).toBe(true)

    const [sql, params] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/PARSE_JSON\(@requested_sources\)/)
    expect(typeof params?.requested_sources).toBe('string')
    expect(JSON.parse(String(params?.requested_sources))).toEqual([
      'irs-teos',
      'ca-sos-bizfile',
    ])
    expect(params?.requested_jurisdiction).toBe('us-ca')
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordJob(ROW)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
      expect(result.error.message).toBe('BQ down')
    }
  })

  it('serialises a non-null result at insert time', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const report = { runs: [], findings: [{ id: 'f1' }] }
    await accessor.recordJob({
      ...ROW,
      status: 'completed',
      finished_at: '2024-05-01T00:00:30Z',
      result: report,
    })

    const [, params] = query.mock.calls[0] ?? []
    expect(typeof params?.result).toBe('string')
    expect(JSON.parse(String(params?.result))).toEqual(report)
  })
})

describe('createDiscoveryJobsAccessor.readJob', () => {
  it('returns the parsed job row when it exists', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([ROW]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.readJob(ROW.job_id)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual(ROW)

    const [sql, params] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/SELECT \*/i)
    expect(sql).toMatch(/WHERE job_id = @job_id/i)
    expect(sql).toMatch(/LIMIT 1/i)
    expect(params).toEqual({ job_id: ROW.job_id })
  })

  it('returns not_found when no row matches', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.readJob(ROW.job_id)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_found')
    expect(result.error.message).toContain(ROW.job_id)
  })

  it('returns a parse error for malformed rows', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      okAsync([{ ...ROW, status: 'aborted' }]),
    )
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.readJob(ROW.job_id)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Invalid discovery_jobs row')
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.readJob(ROW.job_id)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
      expect(result.error.message).toBe('BQ down')
    }
  })
})

describe('createDiscoveryJobsAccessor.markJobFinished', () => {
  const update: JobFinishUpdate = {
    jobId: ROW.job_id,
    finishedAt: '2024-05-01T00:00:30Z',
    status: 'completed',
    errorType: null,
    errorMessage: null,
  }

  it('updates the job to a terminal state', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.markJobFinished(update)
    expect(result.isOk()).toBe(true)

    const [sql, params, types] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/UPDATE/i)
    expect(sql).toMatch(/WHERE job_id = @job_id/i)
    expect(params).toEqual({
      job_id: update.jobId,
      finished_at: update.finishedAt,
      status: 'completed',
      error_type: null,
      error_message: null,
      result: null,
    })
    expect(types).toEqual({
      error_type: 'STRING',
      error_message: 'STRING',
      result: 'STRING',
    })
  })

  it('serialises the result as JSON when persisting completion', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const report = { runs: [{ sourceId: 'irs-teos' }], findings: [] }
    await accessor.markJobFinished({ ...update, result: report })

    const [sql, params] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/PARSE_JSON\(@result\)/)
    expect(typeof params?.result).toBe('string')
    expect(JSON.parse(String(params?.result))).toEqual(report)
  })

  it('records the error metadata when the status is failed', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    await accessor.markJobFinished({
      ...update,
      status: 'failed',
      errorType: 'spawn',
      errorMessage: 'fetch unavailable',
    })
    const [, params] = query.mock.calls[0] ?? []
    expect(params?.status).toBe('failed')
    expect(params?.error_type).toBe('spawn')
    expect(params?.error_message).toContain('fetch')
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createDiscoveryJobsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.markJobFinished(update)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
      expect(result.error.message).toBe('BQ down')
    }
  })
})
