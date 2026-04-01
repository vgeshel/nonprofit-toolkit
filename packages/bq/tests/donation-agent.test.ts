/**
 * Tests for donation query agent.
 *
 * Uses MockLanguageModelV3 from ai/test for deterministic agent testing.
 */
import { MockLanguageModelV3 } from 'ai/test'
import { errAsync, okAsync } from 'neverthrow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BigQueryError } from '../src/client'
import {
  buildAgentPrompt,
  buildQueryFn,
  createDonationAgent,
  runDonationAgent,
  type QueryFn,
} from '../src/donation-agent'
import type { BigQueryConfig } from '../src/types'

/**
 * Mock the vertex provider to return our mock model.
 * We keep a mutable reference so each test can set its own model.
 */
let mockModel: MockLanguageModelV3

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => () => {
    return mockModel
  },
}))

type ExecuteFn = Parameters<typeof buildQueryFn>[0]

const config: BigQueryConfig = {
  projectId: 'test-project',
  datasetRaw: 'donations_raw',
  datasetCanon: 'donations',
}

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

describe('buildAgentPrompt', () => {
  it('includes the canonical table name', () => {
    const prompt = buildAgentPrompt(config)
    expect(prompt).toContain('`donations.events`')
  })

  it('includes column descriptions', () => {
    const prompt = buildAgentPrompt(config)
    expect(prompt).toContain('amount_cents')
    expect(prompt).toContain('donor_name')
    expect(prompt).toContain('attribution_human')
  })

  it('includes SQL rules', () => {
    const prompt = buildAgentPrompt(config)
    expect(prompt).toContain('divide by 100')
    expect(prompt).toContain('SELECT statements')
  })

  it('includes Slack formatting rules', () => {
    const prompt = buildAgentPrompt(config)
    expect(prompt).toContain('mrkdwn')
    expect(prompt).toContain('bold')
  })

  it('uses custom dataset name', () => {
    const prompt = buildAgentPrompt({ ...config, datasetCanon: 'my_data' })
    expect(prompt).toContain('`my_data.events`')
  })

  it('includes current date', () => {
    const prompt = buildAgentPrompt(config)
    const today = new Date().toISOString().split('T')[0]
    expect(prompt).toContain(today)
  })

  it('includes org name when provided', () => {
    const prompt = buildAgentPrompt(config, { orgName: 'Test Foundation' })
    expect(prompt).toContain('Test Foundation')
  })

  it('uses generic label when org name not provided', () => {
    const prompt = buildAgentPrompt(config)
    expect(prompt).toContain('a nonprofit organization')
  })
})

describe('buildQueryFn', () => {
  it('returns rows on success', async () => {
    const mockExecute = vi
      .fn<ExecuteFn>()
      .mockReturnValue(okAsync([{ total: 5000 }]))
    const queryFn = buildQueryFn(mockExecute)

    const result = await queryFn('SELECT 1')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rows).toEqual([{ total: 5000 }])
      expect(result.totalRows).toBe(1)
    }
  })

  it('returns error on query failure', async () => {
    const mockExecute = vi.fn<ExecuteFn>().mockReturnValue(
      errAsync({
        type: 'query',
        message: 'BQ error',
      } satisfies BigQueryError),
    )
    const queryFn = buildQueryFn(mockExecute)

    const result = await queryFn('SELECT 1')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('BQ error')
    }
  })

  it('rejects non-SELECT SQL', async () => {
    const mockExecute = vi.fn<ExecuteFn>()
    const queryFn = buildQueryFn(mockExecute)

    const result = await queryFn('DROP TABLE donations.events')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('must start with SELECT')
    }
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('truncates rows to 50', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const mockExecute = vi.fn<ExecuteFn>().mockReturnValue(okAsync(rows))
    const queryFn = buildQueryFn(mockExecute)

    const result = await queryFn('SELECT id FROM events')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rows).toHaveLength(50)
      expect(result.totalRows).toBe(100)
    }
  })

  it('appends LIMIT when not present', async () => {
    const mockExecute = vi.fn<ExecuteFn>().mockReturnValue(okAsync([]))
    const queryFn = buildQueryFn(mockExecute)

    await queryFn('SELECT * FROM events')

    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 100'),
    )
  })
})

describe('createDonationAgent', () => {
  it('creates an agent that calls queryFn via the tool', async () => {
    const mockQueryFn = vi
      .fn<QueryFn>()
      .mockResolvedValue({ ok: true, rows: [{ total: 5000 }], totalRows: 1 })

    let callCount = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++
        if (callCount === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'query_bigquery',
                input: JSON.stringify({ sql: 'SELECT 1' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'Done' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const agent = createDonationAgent(config, mockQueryFn)
    const result = await agent.generate({ prompt: 'test' })

    expect(result.text).toBe('Done')
    expect(mockQueryFn).toHaveBeenCalledWith('SELECT 1')
  })
})

describe('runDonationAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns formatted text and SQL', async () => {
    const mockQueryFn = vi
      .fn<QueryFn>()
      .mockResolvedValue({ ok: true, rows: [{ total: 5000 }], totalRows: 1 })

    let callCount = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++
        if (callCount === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'query_bigquery',
                input: JSON.stringify({
                  sql: 'SELECT SUM(amount_cents)/100 FROM events',
                }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: '*$5,000* total' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const result = await runDonationAgent('How much?', config, mockQueryFn)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.text).toContain('$5,000')
      expect(result.value.sql).toContain('SUM(amount_cents)')
      expect(mockQueryFn).toHaveBeenCalled()
    }
  })

  it('returns null sql when model answers without querying', async () => {
    const mockQueryFn = vi.fn<QueryFn>()

    mockModel = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'I need more information.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      }),
    })

    const result = await runDonationAgent('huh?', config, mockQueryFn)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.sql).toBeNull()
      expect(mockQueryFn).not.toHaveBeenCalled()
    }
  })

  it('agent self-corrects on query error', async () => {
    let queryCallCount = 0
    const mockQueryFn = vi.fn<QueryFn>().mockImplementation(async () => {
      queryCallCount++
      if (queryCallCount === 1) {
        return { ok: false, error: 'Column not_real does not exist' }
      }
      return { ok: true, rows: [{ total: 100 }], totalRows: 1 }
    })

    let modelCallCount = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCallCount++
        if (modelCallCount === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'query_bigquery',
                input: JSON.stringify({ sql: 'SELECT not_real FROM events' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        if (modelCallCount === 2) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-2',
                toolName: 'query_bigquery',
                input: JSON.stringify({
                  sql: 'SELECT SUM(amount_cents)/100 AS total FROM events',
                }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: '$100 total' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const result = await runDonationAgent('total?', config, mockQueryFn)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.text).toContain('$100')
      expect(mockQueryFn).toHaveBeenCalledTimes(2)
      expect(result.value.sql).toContain('SUM(amount_cents)')
    }
  })

  it('handles tool call with invalid input gracefully', async () => {
    const mockQueryFn = vi
      .fn<QueryFn>()
      .mockResolvedValue({ ok: true, rows: [{ x: 1 }], totalRows: 1 })

    let modelCallCount = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCallCount++
        if (modelCallCount === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'query_bigquery',
                // Invalid input: number instead of {sql: string}
                input: JSON.stringify(42),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'Done' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const result = await runDonationAgent('test', config, mockQueryFn)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      // SQL should be null because the tool input was invalid
      expect(result.value.sql).toBeNull()
    }
  })

  it('returns error when agent.generate throws an Error', async () => {
    const mockQueryFn = vi.fn<QueryFn>()

    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('Model API error')
      },
    })

    const result = await runDonationAgent('test', config, mockQueryFn)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('agent')
      expect(result.error.message).toContain('Model API error')
    }
  })

  it('returns error when agent.generate throws a non-Error', async () => {
    const mockQueryFn = vi.fn<QueryFn>()

    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw 'string failure' // eslint-disable-line @typescript-eslint/only-throw-error
      },
    })

    const result = await runDonationAgent('test', config, mockQueryFn)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('string failure')
    }
  })

  it('returns error when model produces no text', async () => {
    const mockQueryFn = vi.fn<QueryFn>()

    mockModel = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      }),
    })

    const result = await runDonationAgent('test', config, mockQueryFn)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain('no text')
    }
  })

  it('passes conversation history as messages for follow-ups', async () => {
    const mockQueryFn = vi.fn<QueryFn>().mockResolvedValue({
      ok: true,
      rows: [{ source: 'mercury', total: 3000 }],
      totalRows: 1,
    })

    let modelCallCount = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCallCount++
        if (modelCallCount === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'query_bigquery',
                input: JSON.stringify({
                  sql: 'SELECT source, SUM(amount_cents)/100 AS total FROM events GROUP BY source',
                }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'Mercury: $3,000' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const history = [
      { role: 'user' as const, content: 'compare march donations' },
      {
        role: 'assistant' as const,
        content: '$10,000 in 2025 vs $15,000 in 2026',
      },
    ]

    const result = await runDonationAgent(
      'break down by source',
      config,
      mockQueryFn,
      history,
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.text).toContain('Mercury')
      expect(mockQueryFn).toHaveBeenCalled()
    }
  })
})
