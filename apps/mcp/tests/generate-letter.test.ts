/**
 * Tests for the generate-letter MCP tool handler.
 */
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the letter package
/* eslint-disable local/require-typed-vi-fn -- types inferred via vi.mocked() below */
vi.mock('@donations-etl/letter', () => ({
  queryDonations: vi.fn(),
  processQueryResults: vi.fn(),
  generateLetterHtml: vi.fn(),
  generatePdf: vi.fn(),
}))
/* eslint-enable local/require-typed-vi-fn */

const { queryDonations, processQueryResults, generateLetterHtml, generatePdf } =
  await import('@donations-etl/letter')
const { handleGenerateLetter } = await import('../src/tools/generate-letter')

const mockQueryDonations = vi.mocked(queryDonations)
const mockProcessQueryResults = vi.mocked(processQueryResults)
const mockGenerateLetterHtml = vi.mocked(generateLetterHtml)
const mockGeneratePdf = vi.mocked(generatePdf)

const mockLogger = pino({ level: 'silent' })

const testConfig = {
  PORT: 8080,
  LOG_LEVEL: 'info' as const,
  PROJECT_ID: 'test-project',
  DATASET_CANON: 'donations',
  REGION: 'us-central1',
  COMPLIANCE_DISCOVER_JOB_NAME: 'compliance-discover',
  BASE_URL: 'https://mcp.example.com',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  MCP_ALLOWED_DOMAIN: 'example.com',
  ORG_NAME: 'Test Org',
  ORG_ADDRESS: '123 Main St',
  ORG_MISSION: 'Test mission',
  ORG_TAX_STATUS: 'Test tax status',
  DEFAULT_SIGNER_NAME: 'Jane Doe',
  DEFAULT_SIGNER_TITLE: 'President',
}

const sampleRows = [
  {
    event_ts: { value: '2025-01-15T00:00:00Z' },
    amount: 100,
    currency: 'USD',
    source: 'mercury',
    status: 'succeeded',
    donor_name: 'John Doe',
    donor_email: 'john@example.com',
  },
]

const sampleLetterData = {
  donorName: 'John Doe',
  date: 'January 15, 2025',
  yearGroups: [],
  grandTotals: [],
  totalCount: 1,
  signerName: 'Jane Doe',
  signerTitle: 'President',
  orgName: 'Test Org',
  orgAddress: '123 Main St',
  orgMission: 'Test mission',
  orgTaxStatus: 'Test tax status',
}

describe('handleGenerateLetter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates HTML letter', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'html' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.format).toBe('html')
      expect(result.value.content).toBe('<html>letter</html>')
      expect(result.value.donorName).toBe('John Doe')
    }
    expect(mockGeneratePdf).not.toHaveBeenCalled()
  })

  it('generates PDF letter by default', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')
    mockGeneratePdf.mockReturnValue(okAsync(Buffer.from('pdf-content')))

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'] },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.format).toBe('pdf')
      expect(result.value.content).toBe(
        Buffer.from('pdf-content').toString('base64'),
      )
      expect(result.value.donorName).toBe('John Doe')
    }
  })

  it('passes config org fields to processQueryResults', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html></html>')

    await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'html' },
      { config: testConfig, logger: mockLogger },
    )

    expect(mockProcessQueryResults).toHaveBeenCalledWith(sampleRows, {
      signerName: 'Jane Doe',
      signerTitle: 'President',
      orgName: 'Test Org',
      orgAddress: '123 Main St',
      orgMission: 'Test mission',
      orgTaxStatus: 'Test tax status',
    })
  })

  it('passes custom signer to processQueryResults', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html></html>')

    await handleGenerateLetter(
      {
        emails: ['john@example.com'],
        format: 'html',
        signerName: 'Bob Smith',
        signerTitle: 'Treasurer',
      },
      { config: testConfig, logger: mockLogger },
    )

    expect(mockProcessQueryResults).toHaveBeenCalledWith(
      sampleRows,
      expect.objectContaining({
        signerName: 'Bob Smith',
        signerTitle: 'Treasurer',
      }),
    )
  })

  it('passes date range to queryDonations', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html></html>')

    await handleGenerateLetter(
      {
        emails: ['john@example.com'],
        from: '2025-01-01',
        to: '2025-12-31',
        format: 'html',
      },
      { config: testConfig, logger: mockLogger },
    )

    expect(mockQueryDonations).toHaveBeenCalledWith(
      { projectId: 'test-project', dataset: 'donations' },
      ['john@example.com'],
      '2025-01-01',
      '2025-12-31',
    )
  })

  it('returns error when query fails', async () => {
    const { errAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(
      errAsync({
        type: 'query' as const,
        message: 'BigQuery error',
      }),
    )

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'] },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toBe('BigQuery error')
    }
  })

  it('returns error when no donations found', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync([]))

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'] },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toBe(
        'No donations found for the given email(s)',
      )
    }
  })

  it('returns error when PDF generation fails', async () => {
    const { okAsync, errAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html></html>')
    mockGeneratePdf.mockReturnValue(
      errAsync({
        type: 'pdf' as const,
        message: 'Browser crashed',
      }),
    )

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'pdf' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toBe('Browser crashed')
    }
  })

  it('returns error when HTML generation fails for html format', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockRejectedValue(new Error('Render error'))

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'html' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('HTML generation failed')
    }
  })

  it('returns error when HTML generation fails for pdf format', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockRejectedValue(new Error('Render error'))

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'pdf' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('HTML generation failed')
    }
  })

  it('returns error when HTML generation fails with non-Error for html format', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockRejectedValue('string error')

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'html' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('string error')
    }
  })

  it('returns error when HTML generation fails with non-Error for pdf format', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockRejectedValue('string error')

    const result = await handleGenerateLetter(
      { emails: ['john@example.com'], format: 'pdf' },
      { config: testConfig, logger: mockLogger },
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('string error')
    }
  })

  it('handles multiple emails', async () => {
    const { okAsync } = await import('neverthrow')
    mockQueryDonations.mockReturnValue(okAsync(sampleRows))
    mockProcessQueryResults.mockReturnValue(sampleLetterData)
    mockGenerateLetterHtml.mockResolvedValue('<html></html>')

    const result = await handleGenerateLetter(
      { emails: ['a@b.com', 'c@d.com'], format: 'html' },
      { config: testConfig, logger: mockLogger },
    )

    expect(mockQueryDonations).toHaveBeenCalledWith(
      expect.any(Object),
      ['a@b.com', 'c@d.com'],
      undefined,
      undefined,
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.donorName).toBe('John Doe')
    }
  })
})
