/**
 * Slack Block Kit formatter for donation query results.
 *
 * Formats BigQuery query results into readable Slack messages.
 */

/**
 * Block types used in query result formatting.
 */
interface SectionBlock {
  type: 'section'
  text: { type: 'mrkdwn'; text: string }
}

interface ContextBlock {
  type: 'context'
  elements: { type: 'mrkdwn'; text: string }[]
}

interface DividerBlock {
  type: 'divider'
}

type QueryBlock = SectionBlock | ContextBlock | DividerBlock

/**
 * Formatted query response ready to post to Slack.
 */
export interface QueryResponse {
  blocks: QueryBlock[]
  threadBlocks: QueryBlock[]
  text: string
}

/**
 * Maximum number of rows to display in the main message.
 */
const MAX_DISPLAY_ROWS = 15

/**
 * Maximum column width for table formatting.
 */
const MAX_COL_WIDTH = 22

/**
 * Check if a column name suggests dollar amounts.
 */
function isDollarColumn(colName: string): boolean {
  const lower = colName.toLowerCase()
  return (
    lower.includes('dollar') ||
    lower.includes('amount') ||
    lower.includes('total') ||
    lower.includes('avg') ||
    lower.includes('sum') ||
    lower.includes('min_dollar') ||
    lower.includes('max_dollar') ||
    lower.includes('stddev')
  )
}

/**
 * Format a number with commas and optional dollar sign.
 */
function formatNumber(value: number, isDollar: boolean): string {
  if (isDollar) {
    const rounded = Math.round(value)
    return `$${rounded.toLocaleString('en-US')}`
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString('en-US')
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

/**
 * Format a value for display in Slack.
 */
function formatValue(value: unknown, isDollar: boolean): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value, isDollar)
  if (typeof value === 'string') {
    // Try to format numeric strings
    const num = Number(value)
    if (!Number.isNaN(num) && value.trim() !== '') {
      return formatNumber(num, isDollar)
    }
    return value
  }
  if (typeof value === 'boolean') return value.toString()
  /* istanbul ignore next -- @preserve JSON.stringify always returns string for non-null objects */
  if (typeof value === 'object') return JSON.stringify(value)
  /* istanbul ignore next -- @preserve defensive: bigint/symbol not returned by BigQuery */
  return '—'
}

/**
 * Truncate a string to a max length.
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max - 1) + '…'
}

/**
 * Pad string to width.
 */
function pad(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length)
}

/**
 * Right-align string to width.
 */
function rpad(str: string, width: number): string {
  return str.length >= width ? str : ' '.repeat(width - str.length) + str
}

/**
 * Check if a value is numeric (for right-alignment).
 */
function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (typeof value === 'string') return /^-?[\d,.]+$/.test(value)
  return false
}

/**
 * Get the first row of a non-empty array.
 */
/* istanbul ignore next -- @preserve defensive: always called with non-empty arrays */
function firstRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (rows.length === 0) return {}
  return rows[0] ?? {}
}

/**
 * Pretty-print SQL with basic indentation.
 */
export function prettySql(sql: string): string {
  const keywords = [
    'SELECT',
    'FROM',
    'WHERE',
    'AND',
    'OR',
    'GROUP BY',
    'ORDER BY',
    'HAVING',
    'LIMIT',
    'JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'INNER JOIN',
    'OUTER JOIN',
    'ON',
    'UNION ALL',
    'UNION',
  ]

  let result = sql.trim()

  // Add newlines before major keywords (but not inside strings)
  for (const kw of keywords) {
    const regex = new RegExp(`\\s+${kw}\\b`, 'gi')
    result = result.replace(regex, `\n${kw}`)
  }

  // Indent continuation lines (AND, OR, ON)
  result = result.replace(/\n(AND|OR|ON)\b/gi, '\n  $1')

  return result.trim()
}

/**
 * Format query results as Slack blocks.
 */
export function formatQueryResult(
  rows: Record<string, unknown>[],
  explanation: string,
  sql: string,
): QueryResponse {
  const blocks: QueryBlock[] = []
  const threadBlocks: QueryBlock[] = []

  // Explanation
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: explanation },
  })

  // No results
  if (rows.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No results found._' },
    })
  } else if (rows.length === 1 && Object.keys(firstRow(rows)).length <= 3) {
    // Single row with few columns — display prominently
    const row = firstRow(rows)
    const parts = Object.entries(row).map(([key, value]) => {
      const dollar = isDollarColumn(key)
      return `*${key}:* ${formatValue(value, dollar)}`
    })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: parts.join('\n') },
    })
  } else {
    // Multiple rows — format as table
    const displayRows = rows.slice(0, MAX_DISPLAY_ROWS)
    const columns = Object.keys(firstRow(rows))
    const dollarCols = columns.map((col) => isDollarColumn(col))

    // Format all values first so we can measure widths
    const formattedRows = displayRows.map((row) =>
      columns.map(
        /* istanbul ignore next -- @preserve defensive: dollarCols always matches columns */
        (col, ci) => formatValue(row[col], dollarCols[ci] ?? false),
      ),
    )

    // Calculate column widths from formatted values
    const widths = columns.map((col, ci) => {
      /* istanbul ignore next -- @preserve defensive: formattedRows always matches columns */
      const values = formattedRows.map((r) => r[ci] ?? '')
      return Math.min(
        MAX_COL_WIDTH,
        Math.max(col.length, ...values.map((v) => v.length)),
      )
    })

    // Check which columns are numeric for right-alignment
    const numericCols = columns.map((col) =>
      displayRows.every((r) => r[col] === null || isNumeric(r[col])),
    )

    // Header
    const header = columns
      .map((col, i) => {
        /* istanbul ignore next -- @preserve defensive: widths always matches columns */
        const w = widths[i] ?? MAX_COL_WIDTH
        return numericCols[i]
          ? rpad(truncate(col, w), w)
          : pad(truncate(col, w), w)
      })
      .join('  ')

    // Rows
    const tableRows = formattedRows.map((fmtRow) =>
      fmtRow
        .map((val, i) => {
          /* istanbul ignore next -- @preserve defensive: widths always matches columns */
          const w = widths[i] ?? MAX_COL_WIDTH
          const truncated = truncate(val, w)
          return numericCols[i] ? rpad(truncated, w) : pad(truncated, w)
        })
        .join('  '),
    )

    const table = [`\`${header}\``, ...tableRows.map((r) => `\`${r}\``)].join(
      '\n',
    )
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: table },
    })

    if (rows.length > MAX_DISPLAY_ROWS) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_Showing ${MAX_DISPLAY_ROWS} of ${rows.length} results_`,
          },
        ],
      })
    }
  }

  // SQL in thread reply (pretty-printed, collapsed feel via context block)
  const formatted = prettySql(sql)
  threadBlocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_Generated SQL_' }],
  })
  threadBlocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `\`\`\`${formatted}\`\`\`` },
  })

  return {
    blocks,
    threadBlocks,
    text: explanation,
  }
}

/**
 * Format an error as Slack blocks.
 */
export function formatQueryError(message: string): QueryResponse {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `I couldn't answer that question. ${message}`,
        },
      },
    ],
    threadBlocks: [],
    text: `Error: ${message}`,
  }
}
