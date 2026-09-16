/**
 * Tests for the compliance-overview MCP prompt.
 *
 * The single test asserts that every tool name and resource URI we
 * declare in registerComplianceSurface appears in the prompt text.
 * Adding a new tool/resource without updating the overview here will
 * be caught by this regression check.
 */
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/config'
import { buildComplianceOverviewPrompt } from '../../src/tools/compliance/prompt'

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

const ALL_TOOLS = [
  'compliance-status',
  'compliance-onboard',
  'compliance-onboard-update',
  'compliance-discover-start',
  'compliance-discover-status',
  'compliance-discover-result',
  'compliance-record-evidence',
]

const ALL_RESOURCES = [
  'compliance://status',
  'compliance://sources/registry',
  'compliance://onboarding/interview-questions',
  'compliance://sources/{sourceId}/manual-evidence-instructions',
]

describe('buildComplianceOverviewPrompt', () => {
  it('includes the configured org name', () => {
    const out = buildComplianceOverviewPrompt(testConfig)
    expect(out).toContain('Test Org')
  })

  it("includes today's date", () => {
    const out = buildComplianceOverviewPrompt(testConfig)
    const today = new Date().toISOString().split('T')[0]
    expect(out).toContain(today)
  })

  it('mentions every registered compliance tool', () => {
    const out = buildComplianceOverviewPrompt(testConfig)
    for (const tool of ALL_TOOLS) {
      expect(out).toContain(tool)
    }
  })

  it('mentions every registered compliance resource URI', () => {
    const out = buildComplianceOverviewPrompt(testConfig)
    for (const uri of ALL_RESOURCES) {
      expect(out).toContain(uri)
    }
  })

  it('mentions the confirm:true write-gate', () => {
    const out = buildComplianceOverviewPrompt(testConfig)
    expect(out).toContain('confirm: true')
  })

  it('requires the model to link sources and compute date math against `now`', () => {
    const out = buildComplianceOverviewPrompt(testConfig)
    // Linking requirement
    expect(out).toMatch(/link/i)
    expect(out).toContain('detailUrl')
    expect(out).toContain('accessUrl')
    expect(out).toContain('loginUrl')
    // Date math requirement
    expect(out).toContain('`now`')
    expect(out).toMatch(/overdue|due in/i)
    // Action-items section requirement
    expect(out).toMatch(/[Aa]ction items/)
    // Auth-required follow-up
    expect(out).toContain('compliance-record-evidence')
  })
})
