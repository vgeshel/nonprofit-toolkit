/**
 * Tests for the compliance-record-evidence MCP tool handler.
 */
import { errAsync, okAsync } from 'neverthrow'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { RecordComplianceEvidenceReport } from '../../../../src/compliance/skills/record-evidence.ts'
import type { Config } from '../../src/config'
import {
  defaultRecordEvidenceRunner,
  handleComplianceRecordEvidence,
  resolveRecordEvidenceRunner,
  translateRecordEvidenceError,
  type RecordEvidenceRunner,
} from '../../src/tools/compliance/record-evidence'

const testConfig: Config = {
  PORT: 8080,
  LOG_LEVEL: 'info' as const,
  PROJECT_ID: 'test-project',
  DATASET_CANON: 'donations',
  REGION: 'us-central1',
  COMPLIANCE_DISCOVER_JOB_NAME: 'compliance-discover',
  GOOGLE_CLIENT_ID: 'test-client-id',
  BASE_URL: 'https://mcp.example.com',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  MCP_ALLOWED_DOMAIN: 'example.com',
  ORG_NAME: 'Test Org',
  ORG_ADDRESS: '123 Main St',
  ORG_MISSION: 'Test mission',
  ORG_TAX_STATUS: 'Test tax status',
  DEFAULT_SIGNER_NAME: 'Jane Doe',
  DEFAULT_SIGNER_TITLE: 'President',
}

const logger = pino({ level: 'silent' })

const REPORT: RecordComplianceEvidenceReport = {
  sourceId: 'ca-cdtfa-online-services',
  jurisdictionId: 'us-ca',
  runId: '22222222-2222-4222-8222-222222222222',
  recordedAt: '2024-05-01T00:00:00Z',
  findings: [],
}

describe('handleComplianceRecordEvidence', () => {
  it('refuses without confirm:true', async () => {
    const runner = vi.fn(() => okAsync(REPORT))
    const result = await handleComplianceRecordEvidence(
      {
        confirm: false,
        sourceId: 'ca-cdtfa-online-services',
        evidence: { accountStatus: 'active' },
      },
      { config: testConfig, logger, runRecordEvidence: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('unconfirmed')
    expect(runner).not.toHaveBeenCalled()
  })

  it('persists when confirmed and runner succeeds', async () => {
    const runner = vi.fn<RecordEvidenceRunner>(() => okAsync(REPORT))
    const result = await handleComplianceRecordEvidence(
      {
        confirm: true,
        sourceId: 'ca-cdtfa-online-services',
        evidence: { accountStatus: 'active' },
      },
      { config: testConfig, logger, runRecordEvidence: runner },
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.sourceId).toBe('ca-cdtfa-online-services')
    expect(runner).toHaveBeenCalledTimes(1)
    const call = runner.mock.calls[0]?.[0]
    expect(call?.projectId).toBe('test-project')
    expect(call?.input.sourceId).toBe('ca-cdtfa-online-services')
    expect(call?.input.observedAt).toBeUndefined()
  })

  it('forwards observedAt when supplied', async () => {
    const runner = vi.fn<RecordEvidenceRunner>(() => okAsync(REPORT))
    await handleComplianceRecordEvidence(
      {
        confirm: true,
        sourceId: 'ca-cdtfa-online-services',
        observedAt: '2024-05-01T12:00:00Z',
        evidence: { accountStatus: 'active' },
      },
      { config: testConfig, logger, runRecordEvidence: runner },
    )
    expect(runner.mock.calls[0]?.[0]?.input.observedAt).toBe(
      '2024-05-01T12:00:00Z',
    )
  })

  it('surfaces a not_onboarded error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({
        type: 'not_onboarded' as const,
        message: 'onboard first',
      }),
    )
    const result = await handleComplianceRecordEvidence(
      {
        confirm: true,
        sourceId: 'ca-cdtfa-online-services',
        evidence: {},
      },
      { config: testConfig, logger, runRecordEvidence: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
  })

  it('surfaces a wiring error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({ type: 'wiring' as const, message: 'jurisdiction conflict' }),
    )
    const result = await handleComplianceRecordEvidence(
      {
        confirm: true,
        sourceId: 'ca-cdtfa-online-services',
        evidence: {},
      },
      { config: testConfig, logger, runRecordEvidence: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('wiring')
  })
})

describe('translateRecordEvidenceError', () => {
  it('preserves the type and message verbatim', () => {
    expect(
      translateRecordEvidenceError({
        type: 'persist',
        message: 'persist failed',
      }),
    ).toEqual({ type: 'persist', message: 'persist failed' })
    expect(
      translateRecordEvidenceError({
        type: 'load',
        message: 'load failed',
      }),
    ).toEqual({ type: 'load', message: 'load failed' })
    expect(
      translateRecordEvidenceError({
        type: 'validation',
        message: 'bad field',
      }),
    ).toEqual({ type: 'validation', message: 'bad field' })
  })
})

describe('defaultRecordEvidenceRunner', () => {
  it('is a callable function', () => {
    expect(typeof defaultRecordEvidenceRunner).toBe('function')
    const out = defaultRecordEvidenceRunner({
      projectId: 'test-project',
      input: { sourceId: 'x', evidence: {} },
    })
    expect(typeof out.match).toBe('function')
  })
})

describe('resolveRecordEvidenceRunner', () => {
  it('returns the supplied runner when one is provided', () => {
    const custom = vi.fn(() => okAsync(REPORT))
    expect(resolveRecordEvidenceRunner(custom)).toBe(custom)
  })

  it('falls back to default when none is supplied', () => {
    expect(resolveRecordEvidenceRunner()).toBe(defaultRecordEvidenceRunner)
  })

  it('falls back to default when undefined is passed', () => {
    expect(resolveRecordEvidenceRunner(undefined)).toBe(
      defaultRecordEvidenceRunner,
    )
  })
})
