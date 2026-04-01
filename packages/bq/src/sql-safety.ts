/**
 * SQL safety validation for read-only query execution.
 *
 * Ensures only SELECT statements are executed and enforces row limits.
 */

/**
 * Forbidden SQL keywords that indicate non-read-only operations.
 */
const FORBIDDEN_KEYWORDS = [
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'EXPORT',
  'CALL',
  'EXECUTE',
  'DECLARE',
  'BEGIN',
] as const

/**
 * Validate that a SQL string is a read-only SELECT statement.
 *
 * Returns an error message if invalid, or null if valid.
 */
export function validateReadOnlySql(sql: string): string | null {
  const trimmed = sql.trim()

  if (trimmed.length === 0) {
    return 'SQL query is empty'
  }

  // Must start with SELECT or WITH (for CTEs)
  const firstWord = trimmed.split(/\s/)[0]?.toUpperCase()
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return `Query must start with SELECT or WITH, got: ${firstWord}`
  }

  // Reject multi-statement queries (semicolons enable chaining attacks)
  const withoutStrings = trimmed
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/`[^`]*`/g, '')
  if (withoutStrings.includes(';')) {
    return 'Multi-statement queries are not allowed (semicolons forbidden)'
  }

  // Block INFORMATION_SCHEMA access (prevents schema enumeration)
  if (/\bINFORMATION_SCHEMA\b/i.test(withoutStrings)) {
    return 'INFORMATION_SCHEMA access is not allowed'
  }

  // Check for forbidden keywords as standalone words (not inside strings or identifiers)

  for (const keyword of FORBIDDEN_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, 'i')
    if (pattern.test(withoutStrings)) {
      return `Forbidden SQL keyword: ${keyword}`
    }
  }

  return null
}

/**
 * Ensure a SQL query has a LIMIT clause.
 *
 * If no LIMIT is present, appends LIMIT 100.
 */
export function ensureLimit(sql: string, defaultLimit = 100): string {
  const trimmed = sql.trim().replace(/;$/, '')

  // Check if LIMIT already exists (outside of subqueries)
  // Simple heuristic: check if LIMIT appears after the last closing paren
  const lastParen = trimmed.lastIndexOf(')')
  const afterLastParen = lastParen >= 0 ? trimmed.slice(lastParen) : trimmed
  if (/\bLIMIT\b/i.test(afterLastParen)) {
    return trimmed
  }

  return `${trimmed}\nLIMIT ${defaultLimit}`
}
