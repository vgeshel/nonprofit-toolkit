/**
 * Tests for the query-bigquery MCP tool handler.
 */
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResultAsync } from 'neverthrow'

const mockExecuteReadOnlyQuery =
  vi.fn<
    (
      sql: string,
    ) => ResultAsync<
      Record<string, unknown>[],
      { type: string; message: string }
    >
  >()

vi.mock('@donations-etl/bq', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  return {
    ...actual,
    BigQueryClient: class MockBigQueryClient {
      executeReadOnlyQuery = mockExecuteReadOnlyQuery
    },
  }
})

const { handleQueryBigQuery } = await import('../src/tools/query-bigquery')

const mockLogger = pino({ level: 'silent' })

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

describe('handleQueryBigQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('executes valid SQL and returns rows', async () => {
    const { okAsync } = await import('neverthrow')
    const rows = [
      { donor_name: 'Alice', total: 5000 },
      { donor_name: 'Bob', total: 3000 },
    ]
    mockExecuteReadOnlyQuery.mockReturnValue(okAsync(rows))

    const result = await handleQueryBigQuery(
      {
        sql: 'SELECT donor_name, SUM(amount_cents) as total FROM donations.events GROUP BY 1',
      },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.rows).toEqual(rows)
      expect(result.value.totalRows).toBe(2)
    }
  })

  it('rejects non-SELECT SQL', async () => {
    const result = await handleQueryBigQuery(
      { sql: 'DELETE FROM donations.events' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
    expect(mockExecuteReadOnlyQuery).not.toHaveBeenCalled()
  })

  it('rejects DROP TABLE SQL', async () => {
    const result = await handleQueryBigQuery(
      { sql: 'DROP TABLE donations.events' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
  })

  it('returns query error from BigQuery', async () => {
    const { errAsync } = await import('neverthrow')
    mockExecuteReadOnlyQuery.mockReturnValue(
      errAsync({ type: 'query' as const, message: 'Column not found: foo' }),
    )

    const result = await handleQueryBigQuery(
      { sql: 'SELECT foo FROM donations.events' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
      expect(result.error.message).toBe('Column not found: foo')
    }
  })

  it('caps results at 50 rows', async () => {
    const { okAsync } = await import('neverthrow')
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    mockExecuteReadOnlyQuery.mockReturnValue(okAsync(rows))

    const result = await handleQueryBigQuery(
      { sql: 'SELECT * FROM donations.events LIMIT 100' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(50)
      expect(result.value.totalRows).toBe(100)
    }
  })

  it('returns empty result set', async () => {
    const { okAsync } = await import('neverthrow')
    mockExecuteReadOnlyQuery.mockReturnValue(okAsync([]))

    const result = await handleQueryBigQuery(
      { sql: 'SELECT * FROM donations.events WHERE 1=0' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.rows).toEqual([])
      expect(result.value.totalRows).toBe(0)
    }
  })

  it('adds LIMIT when missing', async () => {
    const { okAsync } = await import('neverthrow')
    mockExecuteReadOnlyQuery.mockReturnValue(okAsync([]))

    await handleQueryBigQuery(
      { sql: 'SELECT * FROM donations.events' },
      { config: testConfig, logger: mockLogger },
    )

    // ensureLimit adds LIMIT 50 if none present
    const calledSql = mockExecuteReadOnlyQuery.mock.calls[0]?.[0]
    expect(calledSql).toMatch(/LIMIT/i)
  })
})
