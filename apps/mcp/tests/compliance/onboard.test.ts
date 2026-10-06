/**
 * Tests for the compliance-onboard and compliance-onboard-update MCP
 * tool handlers.
 *
 * Each handler wraps a production wiring function and applies the
 * `confirm: true` write-gate. Both behaviors are exercised here with
 * injected runners.
 */
import { errAsync, okAsync } from 'neverthrow'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type {
  OnboardingAnswers,
  OnboardingSummary,
} from '../../../../src/compliance/skills/onboard.ts'
import type { Config } from '../../src/config'
import {
  defaultOnboardRunner,
  defaultOnboardUpdateRunner,
  handleComplianceOnboard,
  handleComplianceOnboardUpdate,
  resolveOnboardRunner,
  resolveOnboardUpdateRunner,
  translateUpdateError,
} from '../../src/tools/compliance/onboard'

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

const ANSWERS: OnboardingAnswers = {
  legalName: 'Foo Foundation',
  ein: '12-3456789',
  stateOfIncorporation: 'CA',
  caSosEntityNumber: 'C0123456',
  caAgCharityNumber: 'CT0123456',
  fiscalYearEndMonth: 12,
  fiscalYearEndDay: 31,
  formationDate: '2010-01-15',
  mailingAddressLine1: '1 Mission St',
  mailingAddressLine2: null,
  mailingAddressCity: 'San Francisco',
  mailingAddressRegion: 'CA',
  mailingAddressPostalCode: '94105',
  mailingAddressCountry: 'US',
}

const SUMMARY: OnboardingSummary = {
  legalName: 'Foo Foundation',
  identifiers: {
    'us-federal': { ein: '12-3456789' },
    'us-ca': {
      sosEntityNumber: 'C0123456',
      agCharityNumber: 'CT0123456',
    },
  },
  entityRow: {
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
  },
  migration: {
    createdDataset: false,
    createdTables: [],
    skippedTables: [],
    addedColumns: [],
    updatedViews: [],
  },
}

describe('handleComplianceOnboard', () => {
  it('refuses without confirm:true', async () => {
    const runner = vi.fn(() => okAsync(SUMMARY))
    const result = await handleComplianceOnboard(
      { confirm: false, answers: ANSWERS },
      { config: testConfig, logger, runOnboard: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('unconfirmed')
    expect(runner).not.toHaveBeenCalled()
  })

  it('persists when confirmed and runner succeeds', async () => {
    const runner = vi.fn(() => okAsync(SUMMARY))
    const result = await handleComplianceOnboard(
      { confirm: true, answers: ANSWERS },
      { config: testConfig, logger, runOnboard: runner },
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.legalName).toBe('Foo Foundation')
    expect(runner).toHaveBeenCalledWith({
      projectId: 'test-project',
      answers: ANSWERS,
    })
  })

  it('surfaces a validation error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({ type: 'validation' as const, message: 'bad EIN' }),
    )
    const result = await handleComplianceOnboard(
      { confirm: true, answers: ANSWERS },
      { config: testConfig, logger, runOnboard: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
    expect(result.error.message).toContain('bad EIN')
  })

  it('surfaces a storage error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({ type: 'storage' as const, message: 'BQ down' }),
    )
    const result = await handleComplianceOnboard(
      { confirm: true, answers: ANSWERS },
      { config: testConfig, logger, runOnboard: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('storage')
  })
})

describe('handleComplianceOnboardUpdate', () => {
  it('refuses without confirm:true', async () => {
    const runner = vi.fn(() => okAsync(SUMMARY))
    const result = await handleComplianceOnboardUpdate(
      { confirm: false, partial: { caAgCharityNumber: 'CT0123456' } },
      { config: testConfig, logger, runOnboardUpdate: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('unconfirmed')
    expect(runner).not.toHaveBeenCalled()
  })

  it('persists when confirmed and runner succeeds', async () => {
    const runner = vi.fn(() => okAsync(SUMMARY))
    const result = await handleComplianceOnboardUpdate(
      { confirm: true, partial: { caAgCharityNumber: 'CT0123456' } },
      { config: testConfig, logger, runOnboardUpdate: runner },
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.legalName).toBe('Foo Foundation')
  })

  it('translates a not_onboarded error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({
        type: 'not_onboarded' as const,
        message: 'no prior onboarding',
      }),
    )
    const result = await handleComplianceOnboardUpdate(
      { confirm: true, partial: { caAgCharityNumber: 'CT0123456' } },
      { config: testConfig, logger, runOnboardUpdate: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
  })

  it('translates a validation error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({ type: 'validation' as const, message: 'bad number' }),
    )
    const result = await handleComplianceOnboardUpdate(
      { confirm: true, partial: { ein: 'bad' } },
      { config: testConfig, logger, runOnboardUpdate: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
  })

  it('translates a storage error from the runner', async () => {
    const runner = vi.fn(() =>
      errAsync({ type: 'storage' as const, message: 'BQ down' }),
    )
    const result = await handleComplianceOnboardUpdate(
      { confirm: true, partial: { caAgCharityNumber: 'CT0123456' } },
      { config: testConfig, logger, runOnboardUpdate: runner },
    )
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('storage')
  })
})

describe('translateUpdateError', () => {
  it('maps not_onboarded to not_onboarded', () => {
    expect(
      translateUpdateError({ type: 'not_onboarded', message: 'x' }),
    ).toEqual({
      type: 'not_onboarded',
      message: 'x',
    })
  })

  it('maps validation to validation', () => {
    expect(translateUpdateError({ type: 'validation', message: 'x' })).toEqual({
      type: 'validation',
      message: 'x',
    })
  })

  it('maps storage to storage', () => {
    expect(translateUpdateError({ type: 'storage', message: 'x' })).toEqual({
      type: 'storage',
      message: 'x',
    })
  })
})

describe('defaultOnboardRunner / defaultOnboardUpdateRunner', () => {
  it('are callable functions', () => {
    expect(typeof defaultOnboardRunner).toBe('function')
    expect(typeof defaultOnboardUpdateRunner).toBe('function')
  })

  it('return Result-async values when invoked', () => {
    const out = defaultOnboardRunner({
      projectId: 'test-project',
      answers: ANSWERS,
    })
    expect(typeof out.match).toBe('function')
    const out2 = defaultOnboardUpdateRunner({
      projectId: 'test-project',
      partial: { caAgCharityNumber: 'CT0123456' },
    })
    expect(typeof out2.match).toBe('function')
  })
})

describe('resolveOnboardRunner', () => {
  it('returns the supplied runner when provided', () => {
    const custom = vi.fn(() => okAsync(SUMMARY))
    expect(resolveOnboardRunner(custom)).toBe(custom)
  })

  it('falls back to default when no runner is supplied', () => {
    expect(resolveOnboardRunner()).toBe(defaultOnboardRunner)
  })

  it('falls back to default when undefined is passed', () => {
    expect(resolveOnboardRunner(undefined)).toBe(defaultOnboardRunner)
  })
})

describe('resolveOnboardUpdateRunner', () => {
  it('returns the supplied runner when provided', () => {
    const custom = vi.fn(() => okAsync(SUMMARY))
    expect(resolveOnboardUpdateRunner(custom)).toBe(custom)
  })

  it('falls back to default when no runner is supplied', () => {
    expect(resolveOnboardUpdateRunner()).toBe(defaultOnboardUpdateRunner)
  })

  it('falls back to default when undefined is passed', () => {
    expect(resolveOnboardUpdateRunner(undefined)).toBe(
      defaultOnboardUpdateRunner,
    )
  })
})
