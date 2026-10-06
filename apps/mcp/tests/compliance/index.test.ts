/**
 * Tests for the compliance MCP registration callbacks.
 *
 * Each callback exported from `tools/compliance/index.ts` is exercised
 * directly so the registration code paths get covered without driving
 * the MCP transport. A separate test boots a real `McpServer` and
 * confirms registration succeeds + duplicates are rejected.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errAsync, okAsync } from 'neverthrow'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  DiscoveryJobStatusReport,
  StartDiscoveryJobReport,
} from '../../../../src/compliance/skills/discover-job.ts'
import type {
  OnboardingAnswers,
  OnboardingSummary,
} from '../../../../src/compliance/skills/onboard.ts'
import type { RecordComplianceEvidenceReport } from '../../../../src/compliance/skills/record-evidence.ts'
import type { ComplianceStatusReport } from '../../../../src/compliance/skills/status.ts'
import type { FirestoreClientLike } from '../../../../src/compliance/state/firestore-jobs.ts'
import type { Config } from '../../src/config'
import {
  createComplianceOverviewPromptCallback,
  createDiscoverResultToolCallback,
  createDiscoverStartToolCallback,
  createDiscoverStatusToolCallback,
  createOnboardToolCallback,
  createOnboardUpdateToolCallback,
  createRecordEvidenceToolCallback,
  createStatusResourceCallback,
  createStatusToolCallback,
  formatDiscoverErrorText,
  formatOnboardErrorText,
  formatRecordEvidenceErrorText,
  interviewQuestionsResourceCallback,
  manualEvidenceTemplateCallback,
  registerComplianceSurface,
  sourceRegistryResourceCallback,
} from '../../src/tools/compliance/index'
import { parseFirstResourceJson, parseFirstToolJson } from './test-utils'

function makeFakeFirestore(): FirestoreClientLike {
  const docs = new Map<string, Record<string, unknown>>()
  return {
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

const STUB_REPORT: ComplianceStatusReport = {
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
  latestRuns: [],
  openFindings: [],
  overall: 'clear',
}

const logger = pino({ level: 'silent' })

describe('createStatusToolCallback', () => {
  it('returns the serialised status JSON on success', async () => {
    const cb = createStatusToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      readStatus: () => okAsync(STUB_REPORT),
    })
    const result = await cb()
    expect(result.isError).toBeUndefined()
    // The tool returns exactly ONE content block — the server-
    // rendered Markdown narrative. Returning a second JSON block
    // gave the host model two things to splice between and produced
    // unlinked, date-wrong narratives in practice.
    expect(result.content.length).toBe(1)
    const first = result.content[0]
    expect(first?.type).toBe('text')
    if (first?.type === 'text') {
      expect(first.text).toContain('# Compliance Status:')
      expect(first.text).toContain('Clear')
    }
    expect(result.structuredContent).toBeUndefined()
  })

  it('returns an error result when the reader fails', async () => {
    const cb = createStatusToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      readStatus: () =>
        errAsync({
          type: 'not_onboarded' as const,
          message: 'onboard first',
        }),
    })
    const result = await cb()
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type).toBe('text')
    if (first?.type === 'text') {
      expect(first.text).toContain('not_onboarded')
    }
  })
})

describe('createStatusResourceCallback', () => {
  it('returns the status JSON when the reader succeeds', async () => {
    const cb = createStatusResourceCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      readStatus: () => okAsync(STUB_REPORT),
    })
    const result = await cb()
    expect(parseFirstResourceJson(result)).toMatchObject({
      overall: 'clear',
    })
  })

  it('returns a structured error payload when the reader fails', async () => {
    const cb = createStatusResourceCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      readStatus: () =>
        errAsync({
          type: 'load' as const,
          message: 'BQ down',
        }),
    })
    const result = await cb()
    const ErrorBodySchema = z.object({
      error: z.object({ type: z.string(), message: z.string() }),
    })
    const body = ErrorBodySchema.parse(parseFirstResourceJson(result))
    expect(body.error.type).toBe('load')
    expect(body.error.message).toContain('BQ down')
  })
})

describe('sourceRegistryResourceCallback', () => {
  it('returns the source-registry payload', () => {
    const result = sourceRegistryResourceCallback()
    const body = parseFirstResourceJson(result)
    expect(Array.isArray(body.sources)).toBe(true)
  })
})

describe('interviewQuestionsResourceCallback', () => {
  it('returns the interview-questions payload', () => {
    const result = interviewQuestionsResourceCallback()
    const body = parseFirstResourceJson(result)
    expect(Array.isArray(body.questions)).toBe(true)
  })
})

describe('manualEvidenceTemplateCallback', () => {
  const exampleUri = new URL(
    'compliance://sources/example/manual-evidence-instructions',
  )

  it('returns a missing_source_id error when the variable is empty', () => {
    const out = manualEvidenceTemplateCallback(exampleUri, { sourceId: '' })
    expect(parseFirstResourceJson(out)).toMatchObject({
      error: 'missing_source_id',
    })
  })

  it('returns a missing_source_id error when the variable is an empty array', () => {
    const out = manualEvidenceTemplateCallback(exampleUri, {
      sourceId: ['', ''],
    })
    expect(parseFirstResourceJson(out)).toMatchObject({
      error: 'missing_source_id',
    })
  })

  it('returns an unknown_source error for an unregistered source id', () => {
    const out = manualEvidenceTemplateCallback(exampleUri, {
      sourceId: 'never-existed',
    })
    expect(parseFirstResourceJson(out)).toMatchObject({
      error: 'unknown_source',
      sourceId: 'never-existed',
    })
  })

  it('returns the source detail for a registered source', () => {
    const out = manualEvidenceTemplateCallback(exampleUri, {
      sourceId: 'irs-eo-bmf',
    })
    expect(parseFirstResourceJson(out)).toMatchObject({
      sourceId: 'irs-eo-bmf',
    })
  })

  it('unwraps an array-valued sourceId by taking the first element', () => {
    const out = manualEvidenceTemplateCallback(exampleUri, {
      sourceId: ['irs-eo-bmf', 'extra-ignored'],
    })
    expect(parseFirstResourceJson(out)).toMatchObject({
      sourceId: 'irs-eo-bmf',
    })
  })
})

describe('createOnboardToolCallback', () => {
  const ANSWERS: OnboardingAnswers = {
    legalName: 'Foo',
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
    legalName: 'Foo',
    identifiers: {
      'us-federal': { ein: '12-3456789' },
      'us-ca': {
        sosEntityNumber: 'C0123456',
        agCharityNumber: 'CT0123456',
      },
    },
    entityRow: {
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
    },
    migration: {
      createdDataset: false,
      createdTables: [],
      skippedTables: [],
      addedColumns: [],
      updatedViews: [],
    },
  }

  it('returns the success body when confirmed', async () => {
    const cb = createOnboardToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runOnboard: () => okAsync(SUMMARY),
    })
    const result = await cb({ confirm: true, answers: ANSWERS })
    expect(result.isError).toBeUndefined()
    expect(parseFirstToolJson(result)).toMatchObject({
      ok: true,
      legalName: 'Foo',
    })
  })

  it('returns an error body when not confirmed', async () => {
    const cb = createOnboardToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runOnboard: () => okAsync(SUMMARY),
    })
    const result = await cb({ confirm: false, answers: ANSWERS })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    if (first?.type === 'text') {
      expect(first.text).toContain('unconfirmed')
    }
  })
})

describe('createOnboardUpdateToolCallback', () => {
  const SUMMARY: OnboardingSummary = {
    legalName: 'Foo',
    identifiers: {
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456' },
    },
    entityRow: {
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
    },
    migration: {
      createdDataset: false,
      createdTables: [],
      skippedTables: [],
      addedColumns: [],
      updatedViews: [],
    },
  }

  it('returns the success body when confirmed', async () => {
    const cb = createOnboardUpdateToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runOnboardUpdate: () => okAsync(SUMMARY),
    })
    const result = await cb({
      confirm: true,
      partial: { caAgCharityNumber: 'CT0123456' },
    })
    expect(result.isError).toBeUndefined()
    expect(parseFirstToolJson(result)).toMatchObject({
      ok: true,
      legalName: 'Foo',
    })
  })

  it('returns an error body when not confirmed', async () => {
    const cb = createOnboardUpdateToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runOnboardUpdate: () => okAsync(SUMMARY),
    })
    const result = await cb({
      confirm: false,
      partial: { caAgCharityNumber: 'CT0123456' },
    })
    expect(result.isError).toBe(true)
  })

  it('formats not_onboarded errors with the type prefix', async () => {
    const cb = createOnboardUpdateToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runOnboardUpdate: () =>
        errAsync({
          type: 'not_onboarded' as const,
          message: 'onboard first',
        }),
    })
    const result = await cb({
      confirm: true,
      partial: { caAgCharityNumber: 'CT0123456' },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    if (first?.type === 'text') {
      expect(first.text).toContain('not_onboarded')
    }
  })
})

describe('formatOnboardErrorText', () => {
  it('renders the type and message in a stable shape', () => {
    expect(formatOnboardErrorText({ type: 'unconfirmed', message: 'no' })).toBe(
      'Error (unconfirmed): no',
    )
  })
})

describe('formatRecordEvidenceErrorText', () => {
  it('renders the type and message in a stable shape', () => {
    expect(
      formatRecordEvidenceErrorText({
        type: 'unconfirmed',
        message: 'no',
      }),
    ).toBe('Error (unconfirmed): no')
  })
})

describe('createRecordEvidenceToolCallback', () => {
  const REPORT: RecordComplianceEvidenceReport = {
    sourceId: 'ca-cdtfa-online-services',
    jurisdictionId: 'us-ca',
    runId: '22222222-2222-4222-8222-222222222222',
    recordedAt: '2024-05-01T00:00:00Z',
    findings: [],
  }

  it('returns the success body when confirmed', async () => {
    const cb = createRecordEvidenceToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runRecordEvidence: () => okAsync(REPORT),
    })
    const result = await cb({
      confirm: true,
      sourceId: 'ca-cdtfa-online-services',
      evidence: { accountStatus: 'active' },
    })
    expect(result.isError).toBeUndefined()
    expect(parseFirstToolJson(result)).toMatchObject({
      ok: true,
      sourceId: 'ca-cdtfa-online-services',
    })
  })

  it('returns an error body when not confirmed', async () => {
    const cb = createRecordEvidenceToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runRecordEvidence: () => okAsync(REPORT),
    })
    const result = await cb({
      confirm: false,
      sourceId: 'ca-cdtfa-online-services',
      evidence: {},
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    if (first?.type === 'text') {
      expect(first.text).toContain('unconfirmed')
    }
  })

  it('returns an error body when the runner reports a wiring error', async () => {
    const cb = createRecordEvidenceToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runRecordEvidence: () =>
        errAsync({
          type: 'wiring' as const,
          message: 'jurisdiction conflict',
        }),
    })
    const result = await cb({
      confirm: true,
      sourceId: 'ca-cdtfa-online-services',
      evidence: {},
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    if (first?.type === 'text') {
      expect(first.text).toContain('wiring')
    }
  })
})

describe('formatDiscoverErrorText', () => {
  it('renders type + message for any discover-error shape', () => {
    expect(formatDiscoverErrorText({ type: 'persist', message: 'no' })).toBe(
      'Error (persist): no',
    )
    expect(
      formatDiscoverErrorText({ type: 'not_ready', message: 'wait' }),
    ).toBe('Error (not_ready): wait')
  })
})

describe('createDiscoverStartToolCallback', () => {
  const STARTED: StartDiscoveryJobReport = { jobId: 'job-1' }

  it('returns success when confirmed', async () => {
    const cb = createDiscoverStartToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runDiscoverStart: () => okAsync(STARTED),
    })
    const result = await cb({ confirm: true })
    expect(result.isError).toBeUndefined()
    expect(parseFirstToolJson(result)).toMatchObject({
      ok: true,
      jobId: 'job-1',
    })
  })

  it('returns error when unconfirmed', async () => {
    const cb = createDiscoverStartToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runDiscoverStart: () => okAsync(STARTED),
    })
    const result = await cb({ confirm: false })
    expect(result.isError).toBe(true)
  })
})

describe('createDiscoverStatusToolCallback', () => {
  const STATUS: DiscoveryJobStatusReport = {
    jobId: 'job-1',
    status: 'completed',
    startedAt: '2024-05-01T00:00:00Z',
    finishedAt: '2024-05-01T00:00:30Z',
    requestedSources: null,
    requestedJurisdiction: null,
    completedSourceCount: 2,
    errorType: null,
    errorMessage: null,
  }

  it('returns the status JSON', async () => {
    const cb = createDiscoverStatusToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runDiscoverStatus: () => okAsync(STATUS),
    })
    const result = await cb({ jobId: 'job-1' })
    expect(result.isError).toBeUndefined()
    expect(parseFirstToolJson(result)).toMatchObject({ status: 'completed' })
  })

  it('returns an error for unknown jobs', async () => {
    const cb = createDiscoverStatusToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runDiscoverStatus: () =>
        errAsync({ type: 'not_found' as const, message: 'gone' }),
    })
    const result = await cb({ jobId: 'missing' })
    expect(result.isError).toBe(true)
  })
})

describe('createDiscoverResultToolCallback', () => {
  it('returns the stored result', async () => {
    const cb = createDiscoverResultToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runDiscoverResult: () => okAsync({ runs: [], findings: [] }),
    })
    const result = await cb({ jobId: 'job-1' })
    expect(result.isError).toBeUndefined()
    expect(parseFirstToolJson(result)).toMatchObject({ ok: true })
  })

  it('returns an error when the job is not ready', async () => {
    const cb = createDiscoverResultToolCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      runDiscoverResult: () =>
        errAsync({
          type: 'not_ready' as const,
          message: 'still running',
        }),
    })
    const result = await cb({ jobId: 'job-1' })
    expect(result.isError).toBe(true)
  })
})

describe('createComplianceOverviewPromptCallback', () => {
  it('returns a single user-role text message', () => {
    const cb = createComplianceOverviewPromptCallback({
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
    })
    const result = cb()
    expect(result.messages).toHaveLength(1)
    const m = result.messages[0]
    expect(m?.role).toBe('user')
    expect(m?.content.type).toBe('text')
    expect(m?.content.text).toContain('Test Org')
  })
})

describe('registerComplianceSurface', () => {
  function buildServer(): McpServer {
    const mcp = new McpServer(
      { name: 'test', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    )
    registerComplianceSurface(mcp, {
      config: testConfig,
      logger,
      firestore: makeFakeFirestore(),
      readStatus: () => okAsync(STUB_REPORT),
    })
    return mcp
  }

  it('registers without throwing', () => {
    expect(buildServer()).toBeDefined()
  })

  it('accepts deps with no readStatus override (defaults to production wiring)', () => {
    const mcp = new McpServer(
      { name: 'test', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    )
    expect(() =>
      registerComplianceSurface(mcp, {
        config: testConfig,
        logger,
        firestore: makeFakeFirestore(),
      }),
    ).not.toThrow()
  })

  it('rejects duplicate registration on the same server', () => {
    const mcp = buildServer()
    expect(() =>
      registerComplianceSurface(mcp, {
        config: testConfig,
        logger,
        firestore: makeFakeFirestore(),
      }),
    ).toThrow()
  })
})
