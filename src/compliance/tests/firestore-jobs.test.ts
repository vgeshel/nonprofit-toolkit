/**
 * Tests for the Firestore-backed discovery_jobs accessor.
 */
import { describe, expect, it } from 'vitest'
import type { ComplianceDiscoveryJobRow } from '../state/bq-rows.ts'
import {
  createFirestoreDiscoveryJobsAccessor,
  type FirestoreClientLike,
} from '../state/firestore-jobs.ts'

const JOB_ID = '11111111-1111-4111-8111-111111111111'

function makeFakeFirestore(): FirestoreClientLike & {
  readonly docs: Map<string, Record<string, unknown>>
} {
  const docs = new Map<string, Record<string, unknown>>()
  return {
    docs,
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
          docs.set(path, { ...(docs.get(path) ?? {}), ...patch })
          return Promise.resolve()
        },
      }
    },
  }
}

const ROW: ComplianceDiscoveryJobRow = {
  job_id: JOB_ID,
  started_at: '2024-05-01T00:00:00Z',
  finished_at: null,
  status: 'running',
  requested_sources: null,
  requested_jurisdiction: null,
  error_type: null,
  error_message: null,
  result: null,
}

describe('createFirestoreDiscoveryJobsAccessor.recordJob', () => {
  it('writes the job document under mcp_compliance_jobs/{jobId}', async () => {
    const fs = makeFakeFirestore()
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.recordJob(ROW)
    expect(result.isOk()).toBe(true)
    expect(fs.docs.has(`mcp_compliance_jobs/${JOB_ID}`)).toBe(true)
    expect(fs.docs.get(`mcp_compliance_jobs/${JOB_ID}`)?.status).toBe('running')
  })

  it('surfaces a query error if the Firestore write throws', async () => {
    const fs: FirestoreClientLike = {
      doc: () => ({
        get: () => Promise.reject(new Error('unused')),
        set: () => Promise.reject(new Error('firestore down')),
        update: () => Promise.reject(new Error('unused')),
      }),
    }
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.recordJob(ROW)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('query')
    expect(result.error.message).toContain('firestore down')
  })

  it('handles a thrown non-Error from Firestore as a string', async () => {
    const fs: FirestoreClientLike = {
      doc: () => ({
        get: () => Promise.reject(new Error('unused')),
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        set: () => Promise.reject('non-error-rejection'),
        update: () => Promise.reject(new Error('unused')),
      }),
    }
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.recordJob(ROW)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.message).toContain('non-error-rejection')
  })
})

describe('createFirestoreDiscoveryJobsAccessor.readJob', () => {
  it('returns the parsed row when the doc exists', async () => {
    const fs = makeFakeFirestore()
    fs.docs.set(`mcp_compliance_jobs/${JOB_ID}`, {
      job_id: JOB_ID,
      started_at: '2024-05-01T00:00:00Z',
      finished_at: null,
      status: 'running',
      requested_sources: null,
      requested_jurisdiction: null,
      error_type: null,
      error_message: null,
      result: null,
    })
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.readJob(JOB_ID)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.job_id).toBe(JOB_ID)
    expect(result.value.status).toBe('running')
  })

  it('returns not_found when the doc does not exist', async () => {
    const accessor = createFirestoreDiscoveryJobsAccessor(makeFakeFirestore())
    const result = await accessor.readJob(JOB_ID)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_found')
  })

  it('returns not_found when Firestore returns exists=true but no data', async () => {
    const fs: FirestoreClientLike = {
      doc: () => ({
        get: () => Promise.resolve({ exists: true, data: () => undefined }),
        set: () => Promise.resolve(),
        update: () => Promise.resolve(),
      }),
    }
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.readJob(JOB_ID)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_found')
  })

  it('returns parse error when the stored doc has the wrong shape', async () => {
    const fs = makeFakeFirestore()
    fs.docs.set(`mcp_compliance_jobs/${JOB_ID}`, {
      job_id: JOB_ID,
      started_at: '2024-05-01T00:00:00Z',
      // missing other required fields
      status: 'totally-invalid-status',
    })
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.readJob(JOB_ID)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
  })

  it('returns parse error when the canonical projection step fails', async () => {
    const fs = makeFakeFirestore()
    // Doc passes the Firestore-side schema but the BQ row schema fails
    // because job_id isn't a UUID.
    fs.docs.set(`mcp_compliance_jobs/${JOB_ID}`, {
      job_id: 'not-a-uuid-at-all',
      started_at: '2024-05-01T00:00:00Z',
      finished_at: null,
      status: 'running',
      requested_sources: null,
      requested_jurisdiction: null,
      error_type: null,
      error_message: null,
      result: null,
    })
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.readJob(JOB_ID)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
  })

  it('surfaces a query error if Firestore.get throws', async () => {
    const fs: FirestoreClientLike = {
      doc: () => ({
        get: () => Promise.reject(new Error('boom')),
        set: () => Promise.resolve(),
        update: () => Promise.resolve(),
      }),
    }
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.readJob(JOB_ID)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('query')
  })
})

describe('createFirestoreDiscoveryJobsAccessor.markJobFinished', () => {
  it('updates the job doc with the terminal status + result', async () => {
    const fs = makeFakeFirestore()
    fs.docs.set(`mcp_compliance_jobs/${JOB_ID}`, {
      job_id: JOB_ID,
      started_at: '2024-05-01T00:00:00Z',
      finished_at: null,
      status: 'running',
      requested_sources: null,
      requested_jurisdiction: null,
      error_type: null,
      error_message: null,
      result: null,
    })
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.markJobFinished({
      jobId: JOB_ID,
      finishedAt: '2024-05-01T00:00:30Z',
      status: 'completed',
      errorType: null,
      errorMessage: null,
      result: { runs: [], findings: [] },
    })
    expect(result.isOk()).toBe(true)
    const doc = fs.docs.get(`mcp_compliance_jobs/${JOB_ID}`)
    expect(doc?.status).toBe('completed')
    expect(doc?.finished_at).toBe('2024-05-01T00:00:30Z')
    expect(doc?.result).toEqual({ runs: [], findings: [] })
  })

  it('writes null result when none provided (e.g. on failure)', async () => {
    const fs = makeFakeFirestore()
    fs.docs.set(`mcp_compliance_jobs/${JOB_ID}`, {
      job_id: JOB_ID,
      started_at: '2024-05-01T00:00:00Z',
      finished_at: null,
      status: 'running',
      requested_sources: null,
      requested_jurisdiction: null,
      error_type: null,
      error_message: null,
      result: null,
    })
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    await accessor.markJobFinished({
      jobId: JOB_ID,
      finishedAt: '2024-05-01T00:00:30Z',
      status: 'failed',
      errorType: 'spawn',
      errorMessage: 'boom',
    })
    const doc = fs.docs.get(`mcp_compliance_jobs/${JOB_ID}`)
    expect(doc?.result).toBeNull()
    expect(doc?.error_type).toBe('spawn')
  })

  it('surfaces a query error if Firestore.update throws', async () => {
    const fs: FirestoreClientLike = {
      doc: () => ({
        get: () => Promise.resolve({ exists: false, data: () => undefined }),
        set: () => Promise.resolve(),
        update: () => Promise.reject(new Error('update down')),
      }),
    }
    const accessor = createFirestoreDiscoveryJobsAccessor(fs)
    const result = await accessor.markJobFinished({
      jobId: JOB_ID,
      finishedAt: '2024-05-01T00:00:30Z',
      status: 'completed',
      errorType: null,
      errorMessage: null,
      result: null,
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.message).toContain('update down')
  })
})
