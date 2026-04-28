/**
 * Tests for the findings accessor.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { BqQueryRunner } from '../state/bq-entity.ts'
import { createFindingsAccessor } from '../state/bq-findings.ts'
import type { Finding } from '../types/index.ts'

const FINDING_A: Finding = {
  finding_id: '550e8400-e29b-41d4-a716-446655440000',
  jurisdiction_id: 'us-federal',
  source_id: 'irs-teos',
  severity: 'warn',
  status: 'open',
  title: 'Auto-revoked',
  detail: 'EIN appears on the auto-revocation list.',
  evidence: { revocationDate: '2022-05-15' },
  opened_at: '2024-05-01T00:00:00Z',
  resolved_at: null,
}

const FINDING_B: Finding = {
  ...FINDING_A,
  finding_id: '550e8400-e29b-41d4-a716-446655440001',
  severity: 'info',
  title: 'Pub. 78 listing',
  detail: 'EIN appears in Pub. 78 with deductibility code PC.',
  evidence: { deductibilityCode: 'PC' },
}

function fakeRunner(
  query: ReturnType<typeof vi.fn<BqQueryRunner['query']>>,
): BqQueryRunner {
  return { query }
}

describe('createFindingsAccessor.recordFindings', () => {
  it('inserts each finding', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createFindingsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordFindings([FINDING_A, FINDING_B])
    expect(result.isOk()).toBe(true)
    expect(query).toHaveBeenCalledTimes(2)

    const [firstSql, firstParams] = query.mock.calls[0] ?? []
    expect(firstSql).toMatch(/`proj\.compliance\.findings`/)
    expect(firstParams).toMatchObject({ finding_id: FINDING_A.finding_id })

    const [, secondParams] = query.mock.calls[1] ?? []
    expect(secondParams).toMatchObject({ finding_id: FINDING_B.finding_id })
  })

  it('passes a types map covering every nullable column', async () => {
    // `resolved_at` is the only nullable column on `findings`. The schema
    // marks `detail` and `evidence` as REQUIRED, so they don't strictly need
    // a type hint, but the SDK requires the hint whenever the value can be
    // null at runtime. We only declare the genuinely nullable columns here
    // so the map stays minimal and accurate.
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createFindingsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    await accessor.recordFindings([FINDING_A])
    const [, , types] = query.mock.calls[0] ?? []
    expect(types).toEqual({ resolved_at: 'TIMESTAMP' })
  })

  it('is a no-op for an empty list', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createFindingsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordFindings([])
    expect(result.isOk()).toBe(true)
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createFindingsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordFindings([FINDING_A])
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
    }
  })

  it('stops inserting after the first runner error', async () => {
    const query = vi
      .fn<BqQueryRunner['query']>()
      .mockReturnValueOnce(errAsync({ type: 'query', message: 'BQ down' }))
      .mockReturnValue(okAsync([]))
    const accessor = createFindingsAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
    })

    const result = await accessor.recordFindings([FINDING_A, FINDING_B])

    expect(result.isErr()).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    const [, params] = query.mock.calls[0] ?? []
    expect(params?.finding_id).toBe(FINDING_A.finding_id)
  })
})
