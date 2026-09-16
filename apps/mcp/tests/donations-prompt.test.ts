/**
 * Tests for the donations-schema MCP prompt.
 */
import { describe, expect, it } from 'vitest'
import { buildDonationsPrompt } from '../src/tools/donations-prompt'

const testConfig = {
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

describe('buildDonationsPrompt', () => {
  it('includes the org name', () => {
    const prompt = buildDonationsPrompt(testConfig)
    expect(prompt).toContain('Test Org')
  })

  it('includes the dataset name in table reference', () => {
    const prompt = buildDonationsPrompt(testConfig)
    expect(prompt).toContain('`donations.events`')
  })

  it('uses a different dataset when configured', () => {
    const prompt = buildDonationsPrompt({
      ...testConfig,
      DATASET_CANON: 'custom_ds',
    })
    expect(prompt).toContain('`custom_ds.events`')
  })

  it('includes today date', () => {
    const prompt = buildDonationsPrompt(testConfig)
    const today = new Date().toISOString().split('T')[0]
    expect(prompt).toContain(today)
  })

  it('includes all column names', () => {
    const prompt = buildDonationsPrompt(testConfig)
    const columns = [
      'source',
      'external_id',
      'event_ts',
      'amount_cents',
      'fee_cents',
      'net_amount_cents',
      'currency',
      'donor_name',
      'donor_email',
      'status',
      'payment_method',
      'attribution_human',
    ]
    for (const col of columns) {
      expect(prompt).toContain(col)
    }
  })

  it('includes all source values', () => {
    const prompt = buildDonationsPrompt(testConfig)
    const sources = [
      'mercury',
      'paypal',
      'givebutter',
      'check_deposits',
      'funraise',
      'venmo',
      'wise',
      'patreon',
    ]
    for (const src of sources) {
      expect(prompt).toContain(src)
    }
  })

  it('includes SQL rules', () => {
    const prompt = buildDonationsPrompt(testConfig)
    expect(prompt).toContain('Amounts are in cents')
    expect(prompt).toContain('Only generate SELECT statements')
    expect(prompt).toContain('BigQuery SQL syntax')
    expect(prompt).toContain('Include a LIMIT')
  })

  it('includes query-bigquery tool reference', () => {
    const prompt = buildDonationsPrompt(testConfig)
    expect(prompt).toContain('query-bigquery')
  })

  it('does not include Slack formatting rules', () => {
    const prompt = buildDonationsPrompt(testConfig)
    expect(prompt).not.toContain('Slack mrkdwn')
    expect(prompt).not.toContain('posted to Slack')
  })
})
