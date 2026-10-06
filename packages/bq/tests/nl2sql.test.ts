/**
 * Tests for NL2SQL generation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BigQueryConfig } from '../src/types'

// Mock the 'ai' module
const mockGenerateText =
  vi.fn<
    (opts: {
      model: string
      output: unknown
      system: string
      prompt: string
    }) => Promise<{ output: { sql: string; explanation: string } | null }>
  >()

vi.mock('@ai-sdk/google-vertex', () => ({
  createVertex: () => (modelName: string) => ({ modelId: modelName }),
}))

vi.mock('ai', () => ({
  generateText: (
    ...args: Parameters<typeof mockGenerateText>
  ): ReturnType<typeof mockGenerateText> => mockGenerateText(...args),
  Output: {
    object: (opts: { schema: unknown }) => opts,
  },
}))

// Import after mocking
import {
  buildSystemPrompt,
  generateSql,
  SqlResponseSchema,
} from '../src/nl2sql'

describe('SqlResponseSchema', () => {
  it('parses valid response', () => {
    const result = SqlResponseSchema.parse({
      sql: 'SELECT 1',
      explanation: 'Test query',
    })
    expect(result.sql).toBe('SELECT 1')
    expect(result.explanation).toBe('Test query')
  })

  it('rejects missing sql', () => {
    expect(() => SqlResponseSchema.parse({ explanation: 'Test' })).toThrow()
  })

  it('rejects missing explanation', () => {
    expect(() => SqlResponseSchema.parse({ sql: 'SELECT 1' })).toThrow()
  })
})

describe('buildSystemPrompt', () => {
  const config: BigQueryConfig = {
    projectId: 'test-project',
    datasetRaw: 'donations_raw',
    datasetCanon: 'donations',
  }

  it('includes the canonical dataset name', () => {
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('`donations.events`')
  })

  it('uses custom dataset name', () => {
    const prompt = buildSystemPrompt({
      ...config,
      datasetCanon: 'my_donations',
    })
    expect(prompt).toContain('`my_donations.events`')
    expect(prompt).not.toContain('`donations.events`')
  })

  it('includes column descriptions', () => {
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('amount_cents')
    expect(prompt).toContain('donor_name')
    expect(prompt).toContain('source')
    expect(prompt).toContain('event_ts')
    expect(prompt).toContain('attribution_human')
  })

  it('documents is_recurring and that NULL means unknown', () => {
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('| is_recurring | BOOL |')
    expect(prompt).toContain(
      '**Recurring** means `is_recurring = TRUE`. NULL means the source has no signal',
    )
  })

  it('includes rules about cents to dollars conversion', () => {
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('divide by 100')
  })

  it('includes few-shot examples', () => {
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('Top 10 donors')
    expect(prompt).toContain('SUM(amount_cents)')
  })

  it('includes instruction to only generate SELECT', () => {
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('Only generate SELECT')
  })
})

describe('generateSql', () => {
  const config: BigQueryConfig = {
    projectId: 'test-project',
    datasetRaw: 'donations_raw',
    datasetCanon: 'donations',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns SQL and explanation from the model', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        sql: "SELECT SUM(amount_cents) / 100 AS total FROM `donations.events` WHERE status = 'succeeded'",
        explanation: 'Total succeeded donations in dollars',
      },
    })

    const result = await generateSql('How much did we raise?', config)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.sql).toContain('SUM(amount_cents)')
      expect(result.value.explanation).toContain('Total')
    }
  })

  it('passes the question as prompt', async () => {
    mockGenerateText.mockResolvedValue({
      output: { sql: 'SELECT 1', explanation: 'test' },
    })

    await generateSql('Who are our top donors?', config)

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Who are our top donors?',
      }),
    )
  })

  it('passes a model to generateText', async () => {
    mockGenerateText.mockResolvedValue({
      output: { sql: 'SELECT 1', explanation: 'test' },
    })

    await generateSql('test', config)

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        model: expect.anything(),
      }),
    )
  })

  it('includes system prompt with schema', async () => {
    mockGenerateText.mockResolvedValue({
      output: { sql: 'SELECT 1', explanation: 'test' },
    })

    await generateSql('test', config)

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        system: expect.stringContaining('donations.events'),
      }),
    )
  })

  it('returns error when model returns no output', async () => {
    mockGenerateText.mockResolvedValue({ output: null })

    const result = await generateSql('test', config)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('generation')
      expect(result.error.message).toContain('no structured output')
    }
  })

  it('returns error when API call fails', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'))

    const result = await generateSql('test', config)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('generation')
      expect(result.error.message).toContain('API rate limit')
    }
  })

  it('handles non-Error API failures', async () => {
    mockGenerateText.mockRejectedValue('network error')

    const result = await generateSql('test', config)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('network error')
    }
  })
})
