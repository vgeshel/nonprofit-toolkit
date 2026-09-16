/**
 * Tests for the async compliance-discover orchestrator.
 *
 * Coverage:
 *   - startDiscoveryJob inserts a running row, kicks off background work,
 *     and returns the job id.
 *   - The background path marks the job completed on success (with the
 *     serialised report) or failed (with the error metadata).
 *   - The recorder threads the parent job_id onto every run row.
 *   - status / result readers behave correctly for each lifecycle phase.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  buildJobScopedRecorder,
  readDiscoveryJobResult,
  readDiscoveryJobStatus,
  runDiscoveryAndPersist,
  startDiscoveryJob,
  type LaunchDiscovery,
  type RunDiscoveryAndPersistArgs,
  type RunDiscoveryForJob,
} from '../skills/discover-job.ts'
import type { DiscoveryReport } from '../skills/discover.ts'
import type { FindingsAccessor } from '../state/bq-findings.ts'
import type { DiscoveryJobsAccessor } from '../state/bq-jobs.ts'
import type {
  ComplianceDiscoveryJobRow,
  ComplianceDiscoveryRunRow,
} from '../state/bq-rows.ts'
import type { DiscoveryRunsAccessor } from '../state/bq-runs.ts'

const JOB_ID = '11111111-1111-4111-8111-111111111111'

function fixedNow(): Date {
  return new Date('2024-05-01T00:00:00Z')
}

function fakeJobs(): DiscoveryJobsAccessor & {
  recordMock: ReturnType<typeof vi.fn<DiscoveryJobsAccessor['recordJob']>>
  readMock: ReturnType<typeof vi.fn<DiscoveryJobsAccessor['readJob']>>
  finishMock: ReturnType<typeof vi.fn<DiscoveryJobsAccessor['markJobFinished']>>
} {
  const recordMock = vi.fn<DiscoveryJobsAccessor['recordJob']>(() =>
    okAsync(undefined),
  )
  const readMock = vi.fn<DiscoveryJobsAccessor['readJob']>(() =>
    errAsync({ type: 'not_found', message: 'none' }),
  )
  const finishMock = vi.fn<DiscoveryJobsAccessor['markJobFinished']>(() =>
    okAsync(undefined),
  )
  return {
    recordJob: recordMock,
    readJob: readMock,
    markJobFinished: finishMock,
    recordMock,
    readMock,
    finishMock,
  }
}

function fakeRuns(): DiscoveryRunsAccessor & {
  recordMock: ReturnType<typeof vi.fn<DiscoveryRunsAccessor['recordRun']>>
  listByJobMock: ReturnType<
    typeof vi.fn<DiscoveryRunsAccessor['listRunsByJob']>
  >
} {
  const recordMock = vi.fn<DiscoveryRunsAccessor['recordRun']>(() =>
    okAsync(undefined),
  )
  const listByJobMock = vi.fn<DiscoveryRunsAccessor['listRunsByJob']>(() =>
    okAsync([]),
  )
  const listLatestMock = vi.fn<DiscoveryRunsAccessor['listLatestRuns']>(() =>
    okAsync([]),
  )
  return {
    recordRun: recordMock,
    listLatestRuns: listLatestMock,
    listRunsByJob: listByJobMock,
    recordMock,
    listByJobMock,
  }
}

function fakeFindings(): FindingsAccessor & {
  recordMock: ReturnType<typeof vi.fn<FindingsAccessor['recordFindings']>>
} {
  const recordMock = vi.fn<FindingsAccessor['recordFindings']>(() =>
    okAsync(undefined),
  )
  return {
    recordFindings: recordMock,
    listOpenFindings: () => okAsync([]),
    recordMock,
  }
}

const STUB_REPORT: DiscoveryReport = {
  entity: {
    legal_name: 'Foo',
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
  },
  identifiers: {
    'us-federal': { ein: '12-3456789' },
    'us-ca': { sosEntityNumber: 'C0123456' },
  },
  runs: [],
  findings: [],
  migration: {
    createdDataset: false,
    createdTables: [],
    skippedTables: [],
    addedColumns: [],
    updatedViews: [],
  },
}

/**
 * A launcher that records its calls. Defaults to accepting the launch
 * (`okAsync`); tests pass an impl that returns an err to exercise the
 * launch-failure path.
 */
function recordingLaunch(impl: LaunchDiscovery = () => okAsync(undefined)): {
  launch: LaunchDiscovery
  mock: ReturnType<typeof vi.fn<LaunchDiscovery>>
} {
  const mock = vi.fn<LaunchDiscovery>(impl)
  return { launch: mock, mock }
}

/**
 * Build a runDiscovery callback that throws synchronously. Typed against
 * `RunDiscoveryForJob` so test fixtures don't need a type cast on the
 * StartDiscoveryJobArgs literal.
 */
function throwingDiscovery(thrown: unknown): RunDiscoveryForJob {
  return () => {
    throw thrown
  }
}

describe('buildJobScopedRecorder', () => {
  it('tags every run row with the parent job id', async () => {
    const runs = fakeRuns()
    const findings = fakeFindings()
    const recorder = buildJobScopedRecorder(JOB_ID, runs, findings)

    const baseRow: ComplianceDiscoveryRunRow = {
      run_id: '22222222-2222-4222-8222-222222222222',
      source_id: 'irs-teos',
      jurisdiction_id: 'us-federal',
      status: 'succeeded',
      started_at: '2024-05-01T00:00:00Z',
      completed_at: '2024-05-01T00:00:01Z',
      duration_ms: 100,
      error_type: null,
      error_message: null,
      payload: { ok: true },
      job_id: null,
    }
    await recorder.recordRun(baseRow)

    expect(runs.recordMock).toHaveBeenCalledTimes(1)
    expect(runs.recordMock.mock.calls[0]?.[0].job_id).toBe(JOB_ID)
  })

  it('forwards findings unchanged', async () => {
    const runs = fakeRuns()
    const findings = fakeFindings()
    const recorder = buildJobScopedRecorder(JOB_ID, runs, findings)

    await recorder.recordFindings([])
    expect(findings.recordMock).toHaveBeenCalledTimes(1)
    expect(findings.recordMock.mock.calls[0]?.[0]).toEqual([])
  })
})

describe('startDiscoveryJob', () => {
  it('defaults the id-generator when not supplied', async () => {
    const jobs = fakeJobs()
    const { launch } = recordingLaunch()

    const result = await startDiscoveryJob({
      jobsAccessor: jobs,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      launch,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    // uuid v4 shape
    expect(result.value.jobId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('inserts a running row, launches the executor, and returns the job id', async () => {
    const jobs = fakeJobs()
    const { launch, mock } = recordingLaunch()

    const result = await startDiscoveryJob({
      jobsAccessor: jobs,
      now: fixedNow,
      filter: { sources: ['irs-teos'], jurisdictionId: 'us-federal' },
      launch,
      generateJobId: () => JOB_ID,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.jobId).toBe(JOB_ID)

    expect(jobs.recordMock).toHaveBeenCalledTimes(1)
    const insertedRow: ComplianceDiscoveryJobRow | undefined =
      jobs.recordMock.mock.calls[0]?.[0]
    expect(insertedRow?.job_id).toBe(JOB_ID)
    expect(insertedRow?.status).toBe('running')
    expect(insertedRow?.finished_at).toBeNull()

    // The launcher was handed the job id + filter to trigger the executor.
    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock.mock.calls[0]?.[0]).toEqual({
      jobId: JOB_ID,
      filter: { sources: ['irs-teos'], jurisdictionId: 'us-federal' },
    })
    // The start path itself never runs discovery / finishes the job.
    expect(jobs.finishMock).not.toHaveBeenCalled()
  })

  it('returns a persist error when recordJob fails (and does not launch)', async () => {
    const jobs = fakeJobs()
    jobs.recordMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const { launch, mock } = recordingLaunch()

    const result = await startDiscoveryJob({
      jobsAccessor: jobs,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      launch,
      generateJobId: () => JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('persist')
    expect(result.error.message).toContain('BQ down')
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns a launch error and marks the orphaned job failed when the launch fails', async () => {
    const jobs = fakeJobs()
    const { launch } = recordingLaunch(() =>
      errAsync({ type: 'launch', message: 'Cloud Run rejected the run' }),
    )

    const result = await startDiscoveryJob({
      jobsAccessor: jobs,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      launch,
      generateJobId: () => JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('launch')
    expect(result.error.message).toContain('Cloud Run rejected')

    // The orphaned `running` row is transitioned to failed.
    expect(jobs.finishMock).toHaveBeenCalledTimes(1)
    const finishCall = jobs.finishMock.mock.calls[0]?.[0]
    expect(finishCall?.status).toBe('failed')
    expect(finishCall?.errorType).toBe('launch')
  })

  it('still surfaces the launch error (and logs) when the cleanup write also fails', async () => {
    const jobs = fakeJobs()
    jobs.finishMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'firestore down' }),
    )
    const { launch } = recordingLaunch(() =>
      errAsync({ type: 'launch', message: 'Cloud Run rejected the run' }),
    )
    const logger = {
      error: vi.fn<(message: string, err: unknown) => void>(),
    }

    const result = await startDiscoveryJob({
      jobsAccessor: jobs,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      launch,
      generateJobId: () => JOB_ID,
      logger,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('launch')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toContain('after launch error')
  })
})

describe('runDiscoveryAndPersist', () => {
  it('persists a completed status with the serialised report when discovery succeeds', async () => {
    const jobs = fakeJobs()
    const runs = fakeRuns()
    const findings = fakeFindings()

    await runDiscoveryAndPersist(JOB_ID, {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: ['irs-teos'], jurisdictionId: 'us-federal' },
      runDiscovery: () => okAsync(STUB_REPORT),
    })

    expect(jobs.finishMock).toHaveBeenCalledTimes(1)
    const finishCall = jobs.finishMock.mock.calls[0]?.[0]
    expect(finishCall?.jobId).toBe(JOB_ID)
    expect(finishCall?.status).toBe('completed')
    expect(finishCall?.result).toEqual(STUB_REPORT)
  })

  it('persists a failed status when discovery returns an error', async () => {
    const jobs = fakeJobs()
    const runs = fakeRuns()
    const findings = fakeFindings()

    await runDiscoveryAndPersist(JOB_ID, {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      runDiscovery: () =>
        errAsync({
          type: 'not_onboarded' as const,
          message: 'Run compliance-onboard first',
        }),
    })

    const finishCall = jobs.finishMock.mock.calls[0]?.[0]
    expect(finishCall?.status).toBe('failed')
    expect(finishCall?.errorType).toBe('not_onboarded')
    expect(finishCall?.errorMessage).toContain('compliance-onboard')
    expect(finishCall?.result).toBeNull()
  })

  it('catches a thrown error and persists status=failed with type=spawn', async () => {
    const jobs = fakeJobs()
    const runs = fakeRuns()
    const findings = fakeFindings()

    const args: RunDiscoveryAndPersistArgs = {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      runDiscovery: throwingDiscovery(new Error('connector exploded')),
    }
    await runDiscoveryAndPersist(JOB_ID, args)

    const finishCall = jobs.finishMock.mock.calls[0]?.[0]
    expect(finishCall?.status).toBe('failed')
    expect(finishCall?.errorType).toBe('spawn')
    expect(finishCall?.errorMessage).toContain('connector exploded')
  })

  it('catches a non-Error thrown value (stringifies for the error_message)', async () => {
    const jobs = fakeJobs()
    const runs = fakeRuns()
    const findings = fakeFindings()

    const args: RunDiscoveryAndPersistArgs = {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      runDiscovery: throwingDiscovery('connector exploded (string throw)'),
    }
    await runDiscoveryAndPersist(JOB_ID, args)

    const finishCall = jobs.finishMock.mock.calls[0]?.[0]
    expect(finishCall?.status).toBe('failed')
    expect(finishCall?.errorMessage).toBe('connector exploded (string throw)')
  })

  it('logs but does not throw when markJobFinished fails after a successful run', async () => {
    const jobs = fakeJobs()
    jobs.finishMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const runs = fakeRuns()
    const findings = fakeFindings()
    const logger = {
      error: vi.fn<(message: string, err: unknown) => void>(),
    }

    await runDiscoveryAndPersist(JOB_ID, {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      runDiscovery: () => okAsync(STUB_REPORT),
      logger,
    })

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toContain('completed status')
  })

  it('logs but does not throw when markJobFinished fails after a failed run', async () => {
    const jobs = fakeJobs()
    jobs.finishMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const runs = fakeRuns()
    const findings = fakeFindings()
    const logger = {
      error: vi.fn<(message: string, err: unknown) => void>(),
    }

    await runDiscoveryAndPersist(JOB_ID, {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      runDiscovery: () =>
        errAsync({
          type: 'not_onboarded',
          message: 'onboard first',
        }),
      logger,
    })

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toContain('failed status')
  })

  it('logs but does not throw when markJobFinished fails after a thrown error', async () => {
    const jobs = fakeJobs()
    jobs.finishMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const runs = fakeRuns()
    const findings = fakeFindings()
    const logger = {
      error: vi.fn<(message: string, err: unknown) => void>(),
    }

    await runDiscoveryAndPersist(JOB_ID, {
      jobsAccessor: jobs,
      runsAccessor: runs,
      findingsAccessor: findings,
      now: fixedNow,
      filter: { sources: null, jurisdictionId: null },
      runDiscovery: throwingDiscovery(new Error('boom')),
      logger,
    })

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toContain('spawn-error')
  })
})

describe('readDiscoveryJobStatus', () => {
  const RUNNING_ROW: ComplianceDiscoveryJobRow = {
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

  it('reports a running job with no completed sources yet', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(okAsync(RUNNING_ROW))
    const runs = fakeRuns()
    runs.listByJobMock.mockReturnValueOnce(okAsync([]))

    const result = await readDiscoveryJobStatus({
      jobsAccessor: jobs,
      runsAccessor: runs,
      jobId: JOB_ID,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.status).toBe('running')
    expect(result.value.completedSourceCount).toBe(0)
  })

  it('reports completed source count by listing the runs', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(okAsync(RUNNING_ROW))
    const runs = fakeRuns()
    const childRow: ComplianceDiscoveryRunRow = {
      run_id: '22222222-2222-4222-8222-222222222222',
      source_id: 'irs-teos',
      jurisdiction_id: 'us-federal',
      status: 'succeeded',
      started_at: '2024-05-01T00:00:00Z',
      completed_at: '2024-05-01T00:00:01Z',
      duration_ms: 100,
      error_type: null,
      error_message: null,
      payload: { ok: true },
      job_id: JOB_ID,
    }
    runs.listByJobMock.mockReturnValueOnce(okAsync([childRow, childRow]))

    const result = await readDiscoveryJobStatus({
      jobsAccessor: jobs,
      runsAccessor: runs,
      jobId: JOB_ID,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.completedSourceCount).toBe(2)
  })

  it('returns not_found when the job row is missing', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      errAsync({ type: 'not_found', message: 'gone' }),
    )

    const result = await readDiscoveryJobStatus({
      jobsAccessor: jobs,
      runsAccessor: fakeRuns(),
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_found')
  })

  it('returns load when the underlying accessor fails for a non-not_found reason', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ down' }),
    )

    const result = await readDiscoveryJobStatus({
      jobsAccessor: jobs,
      runsAccessor: fakeRuns(),
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('BQ down')
  })

  it('returns load when listRunsByJob fails', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(okAsync(RUNNING_ROW))
    const runs = fakeRuns()
    runs.listByJobMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ runs down' }),
    )

    const result = await readDiscoveryJobStatus({
      jobsAccessor: jobs,
      runsAccessor: runs,
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('BQ runs down')
  })
})

describe('readDiscoveryJobResult', () => {
  function rowWith(
    overrides: Partial<ComplianceDiscoveryJobRow>,
  ): ComplianceDiscoveryJobRow {
    return {
      job_id: JOB_ID,
      started_at: '2024-05-01T00:00:00Z',
      finished_at: null,
      status: 'running',
      requested_sources: null,
      requested_jurisdiction: null,
      error_type: null,
      error_message: null,
      result: null,
      ...overrides,
    }
  }

  it('returns the stored report when the job has completed', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      okAsync(
        rowWith({
          status: 'completed',
          finished_at: '2024-05-01T00:00:30Z',
          result: STUB_REPORT,
        }),
      ),
    )

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual(STUB_REPORT)
  })

  it('returns not_ready when the job is still running', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(okAsync(rowWith({ status: 'running' })))

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_ready')
    expect(result.error.message).toContain('still running')
  })

  it('returns not_ready when the job failed (and includes the error message)', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      okAsync(
        rowWith({
          status: 'failed',
          finished_at: '2024-05-01T00:00:05Z',
          error_type: 'spawn',
          error_message: 'fetch unavailable',
        }),
      ),
    )

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_ready')
    expect(result.error.message).toContain('fetch unavailable')
  })

  it('returns not_ready with a default message when the failed job has no error_message', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      okAsync(
        rowWith({
          status: 'failed',
          finished_at: '2024-05-01T00:00:05Z',
          error_type: 'spawn',
          error_message: null,
        }),
      ),
    )

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_ready')
    expect(result.error.message).toContain('without a recorded error')
  })

  it('returns not_found when the job row does not exist', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      errAsync({ type: 'not_found', message: 'gone' }),
    )

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_found')
  })

  it('returns load when the accessor fails for a non-not_found reason', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      errAsync({ type: 'query', message: 'BQ down' }),
    )

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
    expect(result.error.message).toContain('BQ down')
  })

  it('returns null when the completed job has no result payload', async () => {
    const jobs = fakeJobs()
    jobs.readMock.mockReturnValueOnce(
      okAsync(
        rowWith({
          status: 'completed',
          finished_at: '2024-05-01T00:00:30Z',
          result: null,
        }),
      ),
    )

    const result = await readDiscoveryJobResult({
      jobsAccessor: jobs,
      jobId: JOB_ID,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBeNull()
    }
  })
})
