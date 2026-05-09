/**
 * Tests for the source runner.
 *
 * The runner:
 *   - dispatches automated public sources
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
import { runSource, runSourceOutcome } from '../sources/runner.ts'
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
  overrides: { readonly authRequired?: boolean } = {},
): Source {
  return {
    id: 'fake',
    jurisdiction: 'us-federal',
    kind: 'api',
    authRequired: overrides.authRequired ?? false,
    description: 'fake',
    accessUrl: 'https://example.com/source',
    accessMethod: 'official_api',
    automationAllowed: true,
    tosUrl: 'https://example.com/tos',
    run: () => okAsync(output),
  }
}

function makeAuthenticatedPortalSource(): Source {
  return {
    id: 'ca-cdtfa-online-services',
    jurisdiction: 'us-ca',
    kind: 'playwright',
    authRequired: true,
    description: 'CDTFA Online Services',
    accessUrl: 'https://onlineservices.cdtfa.ca.gov/',
    accessMethod: 'playwright_readonly',
    automationAllowed: true,
    tosUrl: 'https://www.cdtfa.ca.gov/use.htm',
    auth: {
      loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
      credentialMode: 'user_entered_session',
      credentialFields: [
        { key: 'username', label: 'Username', required: true, secret: false },
        { key: 'password', label: 'Password', required: true, secret: true },
      ],
      mfa: 'user_assisted',
      instructions: [
        'Sign in using an authorized account.',
        'Stop after the account overview loads.',
      ],
      evidenceFields: [
        { key: 'account_status', label: 'Account status', required: true },
      ],
      forbiddenActions: ['Do not file returns.', 'Do not make payments.'],
    },
    run: () => errAsync({ type: 'internal', message: 'must not run' }),
  }
}

function makePublicBrowserSource(output: SourceRunOutput): Source {
  return {
    id: 'public-browser-source',
    jurisdiction: 'us-ca',
    kind: 'playwright',
    authRequired: false,
    description: 'Public browser source',
    accessUrl: 'https://example.com/public-form',
    accessMethod: 'official_public_page',
    automationAllowed: true,
    tosUrl: 'https://example.com/tos',
    run: () => okAsync(output),
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
    accessUrl: 'https://example.com/source',
    accessMethod: 'official_api',
    automationAllowed: true,
    tosUrl: 'https://example.com/tos',
    run: () => errAsync(error),
  }
}

function makeManualSource(): Source {
  return {
    id: 'manual-check',
    jurisdiction: 'us-ca',
    kind: 'manual',
    authRequired: false,
    description: 'manual source',
    accessUrl: 'https://example.com/manual',
    accessMethod: 'manual',
    automationAllowed: false,
    manualOnlyReason: 'Current source terms prohibit automated collection.',
    manualInstructions: ['Open the public search page.', 'Record the status.'],
    manualEvidenceFields: [{ key: 'status', label: 'Status', required: true }],
    tosUrl: 'https://example.com/tos',
    run: () => errAsync({ type: 'internal', message: 'must not run' }),
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

  it('returns a typed manual-required outcome for manual sources without network access', async () => {
    const source = makeManualSource()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 200 })),
    )
    const ctx = makeContext({ fetch })

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    const row = recorder.recordRun.mock.calls[0]?.[0]
    expect(row?.status).toBe('failed')
    expect(row?.error_type).toBe('manual_required')
    if (result.isOk()) {
      expect(result.value).toEqual({
        status: 'manual_required',
        source_id: 'manual-check',
        instructions: ['Open the public search page.', 'Record the status.'],
        evidenceFields: [{ key: 'status', label: 'Status', required: true }],
      })
    }
  })

  it('returns a typed policy-blocked outcome for automated sources blocked by policy', async () => {
    const source: Source = {
      id: 'blocked',
      jurisdiction: 'us-ca',
      kind: 'api',
      authRequired: false,
      description: 'blocked',
      accessUrl: 'https://example.com/blocked',
      accessMethod: 'manual',
      automationAllowed: false,
      manualOnlyReason: 'No permitted automated access path was found.',
      manualInstructions: [],
      manualEvidenceFields: [],
      tosUrl: 'https://example.com/tos',
      run: () => errAsync({ type: 'internal', message: 'must not run' }),
    }
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 200 })),
    )
    const ctx = makeContext({ fetch })

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    if (result.isOk()) {
      expect(result.value).toEqual({
        status: 'policy_blocked',
        source_id: 'blocked',
        reason: 'No permitted automated access path was found.',
      })
    }
  })

  it('returns an internal error when policy-blocked run persistence fails', async () => {
    const source: Source = {
      id: 'blocked',
      jurisdiction: 'us-ca',
      kind: 'api',
      authRequired: false,
      description: 'blocked',
      accessUrl: 'https://example.com/blocked',
      accessMethod: 'manual',
      automationAllowed: false,
      manualOnlyReason: 'No permitted automated access path was found.',
      manualInstructions: [],
      manualEvidenceFields: [],
      tosUrl: 'https://example.com/tos',
      run: () => errAsync({ type: 'internal', message: 'must not run' }),
    }
    const ctx = makeContext()
    recorder.recordRun.mockReturnValueOnce(
      errAsync({ type: 'recorder', message: 'BQ unavailable' }),
    )

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('internal')
    expect(result.error.message).toContain('discovery_runs')
  })

  it('runs an unauthenticated public browser source through the outcome runner', async () => {
    const output: SourceRunOutput = {
      record: {
        record_id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: 'public-browser-source',
        fetched_at: '2024-01-01T00:00:01.000Z',
        payload: { ok: true },
      },
      findings: [],
    }
    const source = makePublicBrowserSource(output)
    const ctx = makeContext()

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual({
      status: 'success',
      output,
    })
    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    expect(recorder.recordRun.mock.calls[0]?.[0]).toMatchObject({
      source_id: 'public-browser-source',
      status: 'succeeded',
      payload: { ok: true },
    })
  })

  it('records a source-failure outcome for unsupported automated source kinds', async () => {
    const source = makeFailingSource(
      { type: 'internal', message: 'unused' },
      'manual',
    )
    const ctx = makeContext()

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toMatchObject({
      status: 'source_failure',
      source_id: 'fake',
      error_type: 'tos',
    })
    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
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

  it('returns a typed auth-required outcome and records the failed run', async () => {
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

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    const row = recorder.recordRun.mock.calls[0]?.[0]
    expect(row).toMatchObject({
      status: 'failed',
      error_type: 'auth_required',
      payload: null,
    })
    if (!result.isOk()) return
    expect(result.value).toEqual({
      status: 'auth_required',
      source_id: 'fake',
      message: 'Source "fake" requires auth, but no auth context is available.',
    })
  })

  it('returns detailed auth-required outcome for authenticated browser sources before unsupported dispatch', async () => {
    const source = makeAuthenticatedPortalSource()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 200 })),
    )
    const ctx = makeContext({ fetch })

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(recorder.recordRun).toHaveBeenCalledTimes(1)
    const row = recorder.recordRun.mock.calls[0]?.[0]
    expect(row).toMatchObject({
      status: 'failed',
      error_type: 'auth_required',
      error_message:
        'Source "ca-cdtfa-online-services" requires an authenticated user session.',
      payload: {
        loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
        credentialMode: 'user_entered_session',
        credentialFields: [
          { key: 'username', label: 'Username', required: true, secret: false },
          { key: 'password', label: 'Password', required: true, secret: true },
        ],
        mfa: 'user_assisted',
        instructions: [
          'Sign in using an authorized account.',
          'Stop after the account overview loads.',
        ],
        evidenceFields: [
          { key: 'account_status', label: 'Account status', required: true },
        ],
        forbiddenActions: ['Do not file returns.', 'Do not make payments.'],
      },
    })
    expect(JSON.stringify(row?.payload)).not.toContain('password-value')
    if (!result.isOk()) return
    expect(result.value).toEqual({
      status: 'auth_required',
      source_id: 'ca-cdtfa-online-services',
      message:
        'Source "ca-cdtfa-online-services" requires an authenticated user session.',
      loginUrl: 'https://onlineservices.cdtfa.ca.gov/',
      credentialMode: 'user_entered_session',
      credentialFields: [
        { key: 'username', label: 'Username', required: true, secret: false },
        { key: 'password', label: 'Password', required: true, secret: true },
      ],
      mfa: 'user_assisted',
      instructions: [
        'Sign in using an authorized account.',
        'Stop after the account overview loads.',
      ],
      evidenceFields: [
        { key: 'account_status', label: 'Account status', required: true },
      ],
      forbiddenActions: ['Do not file returns.', 'Do not make payments.'],
    })
  })

  it('returns an internal error when auth-required run persistence fails', async () => {
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
    recorder.recordRun.mockReturnValueOnce(
      errAsync({ type: 'recorder', message: 'BQ unavailable' }),
    )

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('internal')
    expect(result.error.message).toContain('discovery_runs')
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

  it('returns a source-failure outcome even when failed-run persistence fails', async () => {
    const source = makeFailingSource({ type: 'network', message: 'down' })
    const ctx = makeContext()
    recorder.recordRun.mockReturnValueOnce(
      errAsync({ type: 'recorder', message: 'BQ down' }),
    )

    const result = await runSourceOutcome({
      source,
      entity: ENTITY,
      ctx,
      recorder,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toEqual({
      status: 'source_failure',
      source_id: 'fake',
      error_type: 'network',
      message: '[network] down',
    })
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
