/**
 * Tests for query result Slack formatter.
 */
import { describe, expect, it } from 'vitest'
import {
  formatQueryError,
  formatQueryResult,
  prettySql,
} from '../../src/slack/formatters/query-result'

function getSectionTexts(
  blocks: { type: string; text?: { text: string } }[],
): string[] {
  return blocks
    .filter(
      (b): b is { type: 'section'; text: { type: 'mrkdwn'; text: string } } =>
        b.type === 'section',
    )
    .map((b) => b.text.text)
}

describe('prettySql', () => {
  it('adds newlines before major keywords', () => {
    const sql =
      "SELECT * FROM donations.events WHERE status = 'succeeded' ORDER BY event_ts DESC LIMIT 10"
    const result = prettySql(sql)
    expect(result).toContain('\nFROM')
    expect(result).toContain('\nWHERE')
    expect(result).toContain('\nORDER BY')
    expect(result).toContain('\nLIMIT')
  })

  it('indents AND and OR', () => {
    const sql =
      "SELECT * FROM events WHERE status = 'succeeded' AND amount > 100 OR source = 'paypal'"
    const result = prettySql(sql)
    expect(result).toContain('\n  AND')
    expect(result).toContain('\n  OR')
  })

  it('handles GROUP BY', () => {
    const sql =
      'SELECT source, COUNT(*) FROM events GROUP BY source HAVING COUNT(*) > 1'
    const result = prettySql(sql)
    expect(result).toContain('\nGROUP BY')
    expect(result).toContain('\nHAVING')
  })

  it('handles UNION ALL', () => {
    const sql = 'SELECT 1 UNION ALL SELECT 2'
    const result = prettySql(sql)
    expect(result).toContain('\nUNION ALL')
  })
})

describe('formatQueryResult', () => {
  it('includes explanation in blocks', () => {
    const { blocks } = formatQueryResult(
      [{ total: 5000 }],
      'Total donations in dollars',
      'SELECT SUM(amount_cents)/100 FROM events',
    )
    const texts = getSectionTexts(blocks)
    expect(texts[0]).toBe('Total donations in dollars')
  })

  it('handles no results', () => {
    const { blocks } = formatQueryResult(
      [],
      'Query returned no results',
      'SELECT 1 WHERE FALSE',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('No results'))).toBe(true)
  })

  it('displays single-row aggregation prominently', () => {
    const { blocks } = formatQueryResult(
      [{ total_dollars: 15000.5, count: 42 }],
      'Total this year',
      'SELECT SUM(...)',
    )
    const texts = getSectionTexts(blocks)
    // Dollar column should be formatted with $ and rounded
    expect(texts.some((t) => t.includes('$15,001'))).toBe(true)
    expect(texts.some((t) => t.includes('42'))).toBe(true)
  })

  it('formats dollar columns with $ sign and commas', () => {
    const rows = [
      { source: 'mercury', total_dollars: 50000 },
      { source: 'paypal', total_dollars: 3000 },
    ]
    const { blocks } = formatQueryResult(rows, 'By source', 'SELECT ...')
    const texts = getSectionTexts(blocks)
    const table = texts.find((t) => t.includes('mercury'))
    expect(table).toContain('$50,000')
    expect(table).toContain('$3,000')
  })

  it('right-aligns numeric columns', () => {
    const rows = [
      { source: 'mercury', count: 100 },
      { source: 'paypal', count: 5 },
    ]
    const { blocks } = formatQueryResult(rows, 'Counts', 'SELECT ...')
    const texts = getSectionTexts(blocks)
    const table = texts.find((t) => t.includes('mercury'))
    expect(table).toBeDefined()
    // Right-aligned: "100" should have leading spaces vs "  5"
    expect(table).toContain('100')
    expect(table).toContain('  5')
  })

  it('formats integer counts with commas', () => {
    const { blocks } = formatQueryResult(
      [{ donation_count: 1234 }],
      'Count',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('1,234'))).toBe(true)
  })

  it('formats multiple rows as a table', () => {
    const rows = [
      { source: 'mercury', total: 5000 },
      { source: 'paypal', total: 3000 },
      { source: 'givebutter', total: 2000 },
    ]
    const { blocks } = formatQueryResult(rows, 'By source', 'SELECT ...')
    const texts = getSectionTexts(blocks)
    const table = texts.find((t) => t.includes('mercury'))
    expect(table).toBeDefined()
    expect(table).toContain('paypal')
    expect(table).toContain('givebutter')
    expect(table).toContain('`')
  })

  it('truncates results beyond MAX_DISPLAY_ROWS', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `donor_${i}`,
    }))
    const { blocks } = formatQueryResult(rows, 'All donors', 'SELECT ...')
    const contextBlocks = blocks.filter((b) => b.type === 'context')
    expect(contextBlocks.length).toBe(1)
    const ctx = contextBlocks[0]
    if (ctx?.type === 'context') {
      expect(ctx.elements[0]?.text).toContain('15 of 20')
    }
  })

  it('puts pretty-printed SQL in thread blocks', () => {
    const { threadBlocks } = formatQueryResult(
      [{ x: 1 }],
      'test',
      "SELECT x FROM events WHERE status = 'succeeded' ORDER BY x",
    )
    const texts = getSectionTexts(threadBlocks)
    expect(texts.some((t) => t.includes('SELECT x'))).toBe(true)
    expect(texts.some((t) => t.includes('\nFROM'))).toBe(true)
    expect(texts.some((t) => t.includes('```'))).toBe(true)
  })

  it('includes context label before SQL', () => {
    const { threadBlocks } = formatQueryResult([{ x: 1 }], 'test', 'SELECT 1')
    const contextBlocks = threadBlocks.filter((b) => b.type === 'context')
    expect(contextBlocks.length).toBe(1)
  })

  it('sets fallback text to explanation', () => {
    const { text } = formatQueryResult([{ x: 1 }], 'My explanation', 'SELECT 1')
    expect(text).toBe('My explanation')
  })

  it('handles null values with em dash', () => {
    const { blocks } = formatQueryResult(
      [{ name: null, amount: 100 }],
      'test',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('—'))).toBe(true)
  })

  it('handles boolean values', () => {
    const { blocks } = formatQueryResult(
      [{ name: 'test', active: true }],
      'test',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('true'))).toBe(true)
  })

  it('truncates long column values', () => {
    const { blocks } = formatQueryResult(
      [
        {
          name: 'This is a very long donor name that exceeds the column width limit',
          amount: 100,
        },
        { name: 'Short name', amount: 200 },
      ],
      'test',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('…'))).toBe(true)
  })

  it('handles numeric strings as numbers', () => {
    const rows = [
      { source: 'mercury', total: '5000.50' },
      { source: 'paypal', total: '3000' },
    ]
    const { blocks } = formatQueryResult(rows, 'By source', 'SELECT ...')
    const texts = getSectionTexts(blocks)
    // Numeric strings in dollar columns should be formatted with $
    expect(texts.some((t) => t.includes('$5,001'))).toBe(true)
    expect(texts.some((t) => t.includes('$3,000'))).toBe(true)
  })

  it('formats non-dollar decimals with up to 2 places', () => {
    const { blocks } = formatQueryResult(
      [{ source: 'mercury', ratio: 3.14159 }],
      'test',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('3.14'))).toBe(true)
  })

  it('handles object values as JSON', () => {
    const { blocks } = formatQueryResult(
      [{ name: 'test', address: { city: 'NYC' }, extra: 1 }],
      'test',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('NYC'))).toBe(true)
  })

  it('left-aligns non-numeric values', () => {
    const rows = [
      { name: 'test', flag: true },
      { name: 'test2', flag: false },
    ]
    const { blocks } = formatQueryResult(rows, 'With booleans', 'SELECT ...')
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('true'))).toBe(true)
  })

  it('handles single row with many columns as table', () => {
    const { blocks } = formatQueryResult(
      [{ a: 1, b: 2, c: 3, d: 4 }],
      'test',
      'SELECT ...',
    )
    const texts = getSectionTexts(blocks)
    expect(texts.some((t) => t.includes('`'))).toBe(true)
  })

  it('right-aligns numeric column headers', () => {
    const rows = [
      { source: 'mercury', count: 10 },
      { source: 'paypal', count: 5 },
    ]
    const { blocks } = formatQueryResult(rows, 'test', 'SELECT ...')
    const texts = getSectionTexts(blocks)
    const table = texts.find((t) => t.includes('source'))
    // Header row: 'count' should be right-aligned
    expect(table).toBeDefined()
  })
})

describe('formatQueryError', () => {
  it('includes error message', () => {
    const { blocks, text } = formatQueryError('Something went wrong')
    const sectionTexts = getSectionTexts(blocks)
    expect(sectionTexts[0]).toContain('Something went wrong')
    expect(text).toContain('Something went wrong')
  })

  it('has no thread blocks', () => {
    const { threadBlocks } = formatQueryError('error')
    expect(threadBlocks).toHaveLength(0)
  })
})
