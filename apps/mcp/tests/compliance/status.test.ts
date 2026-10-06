/**
 * Tests for the compliance-status MCP tool handler.
 */
import { errAsync, okAsync } from 'neverthrow'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ComplianceStatusReport } from '../../../../src/compliance/skills/status.ts'
import type { Config } from '../../src/config'
import {
  defaultComplianceStatusReader,
  handleComplianceStatus,
  projectSourceMetadata,
  resolveStatusReader,
} from '../../src/tools/compliance/status'

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

const mockLogger = pino({ level: 'silent' })

describe('handleComplianceStatus', () => {
  it('returns the production report when the reader succeeds', async () => {
    const reader = vi.fn(() => okAsync(STUB_REPORT))
    const result = await handleComplianceStatus({
      config: testConfig,
      logger: mockLogger,
      readStatus: reader,
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.overall).toBe('clear')
    expect(reader).toHaveBeenCalledWith('test-project')
  })

  it('enriches the response with `now` and `sources` metadata', async () => {
    const reader = vi.fn(() => okAsync(STUB_REPORT))
    const result = await handleComplianceStatus({
      config: testConfig,
      logger: mockLogger,
      readStatus: reader,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    // ISO-8601 timestamp matching the server clock.
    expect(result.value.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    // sources includes every registered source, each with the URLs
    // the LLM needs to render a linkable narrative.
    expect(result.value.sources.length).toBeGreaterThan(0)
    for (const meta of result.value.sources) {
      expect(meta.sourceId).toMatch(/^[a-z0-9-]+$/)
      expect(meta.agency.length).toBeGreaterThan(0)
      expect(meta.accessUrl).toMatch(/^https?:\/\//)
    }
    // At least one source carries auth metadata (the user-assisted-
    // authenticated portals) so the LLM can link to the login page.
    const withAuth = result.value.sources.filter((s) => s.auth !== undefined)
    expect(withAuth.length).toBeGreaterThan(0)
    for (const s of withAuth) {
      expect(s.auth?.loginUrl).toMatch(/^https?:\/\//)
      expect(s.auth?.instructions.length).toBeGreaterThan(0)
    }
  })

  it('surfaces a not_onboarded error from the reader', async () => {
    const reader = vi.fn(() =>
      errAsync({
        type: 'not_onboarded' as const,
        message: 'onboard first',
      }),
    )
    const result = await handleComplianceStatus({
      config: testConfig,
      logger: mockLogger,
      readStatus: reader,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('not_onboarded')
    expect(result.error.message).toContain('onboard first')
  })

  it('surfaces a load error from the reader', async () => {
    const reader = vi.fn(() =>
      errAsync({
        type: 'load' as const,
        message: 'BQ down',
      }),
    )
    const result = await handleComplianceStatus({
      config: testConfig,
      logger: mockLogger,
      readStatus: reader,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('load')
  })
})

describe('defaultComplianceStatusReader', () => {
  it('is a function that adapts the production wiring', () => {
    // The wiring itself is exercised under status-wiring.test.ts. Here we
    // verify the adapter exists and is callable with a project id. We do
    // not await — invoking the GCP-backed wiring requires real creds.
    expect(typeof defaultComplianceStatusReader).toBe('function')
    const out = defaultComplianceStatusReader('test-project')
    expect(typeof out.match).toBe('function')
  })
})

describe('projectSourceMetadata', () => {
  it('returns one entry per registered source with at least the required URLs', () => {
    const items = projectSourceMetadata()
    expect(items.length).toBeGreaterThan(0)
    const ids = new Set(items.map((i) => i.sourceId))
    // sanity-check that the expected core sources are projected
    expect(ids).toContain('irs-teos')
    expect(ids).toContain('ca-sos-bizfile')
    expect(ids).toContain('ca-ag-registry')
    expect(ids).toContain('ca-ftb-myftb')
    for (const item of items) {
      expect(item.accessUrl).toMatch(/^https?:\/\//)
      expect(item.tosUrl).toMatch(/^https?:\/\//)
    }
  })

  it('includes auth metadata only for sources that declare an auth requirement', () => {
    const items = projectSourceMetadata()
    const ftbMyFtb = items.find((i) => i.sourceId === 'ca-ftb-myftb')
    expect(ftbMyFtb?.auth?.loginUrl).toMatch(/^https?:\/\//)
    const irsTeos = items.find((i) => i.sourceId === 'irs-teos')
    expect(irsTeos?.auth).toBeUndefined()
  })

  it('returns an empty list when no jurisdictions are supplied', () => {
    expect(projectSourceMetadata([])).toEqual([])
  })
})

describe('resolveStatusReader', () => {
  it('returns the supplied reader when one is provided', () => {
    const custom = vi.fn(() => okAsync(STUB_REPORT))
    expect(resolveStatusReader(custom)).toBe(custom)
  })

  it('falls back to the production default when no reader is supplied', () => {
    expect(resolveStatusReader()).toBe(defaultComplianceStatusReader)
  })

  it('falls back to the production default when undefined is passed', () => {
    expect(resolveStatusReader(undefined)).toBe(defaultComplianceStatusReader)
  })
})
