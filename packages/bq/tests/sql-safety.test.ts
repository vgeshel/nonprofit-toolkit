/**
 * Tests for SQL safety validation.
 */
import { describe, expect, it } from 'vitest'
import { ensureLimit, validateReadOnlySql } from '../src/sql-safety'

describe('validateReadOnlySql', () => {
  it('accepts SELECT statements', () => {
    expect(validateReadOnlySql('SELECT * FROM donations.events')).toBeNull()
  })

  it('accepts WITH (CTE) statements', () => {
    expect(
      validateReadOnlySql(
        'WITH totals AS (SELECT SUM(amount_cents) FROM donations.events) SELECT * FROM totals',
      ),
    ).toBeNull()
  })

  it('is case-insensitive for SELECT', () => {
    expect(validateReadOnlySql('select * from donations.events')).toBeNull()
    expect(validateReadOnlySql('Select * From donations.events')).toBeNull()
  })

  it('rejects empty SQL', () => {
    expect(validateReadOnlySql('')).toBe('SQL query is empty')
    expect(validateReadOnlySql('   ')).toBe('SQL query is empty')
  })

  it('rejects DROP statements', () => {
    expect(validateReadOnlySql('DROP TABLE donations.events')).toContain(
      'must start with SELECT',
    )
  })

  it('rejects DELETE statements', () => {
    expect(
      validateReadOnlySql('DELETE FROM donations.events WHERE 1=1'),
    ).toContain('must start with SELECT')
  })

  it('rejects UPDATE statements', () => {
    expect(
      validateReadOnlySql('UPDATE donations.events SET status = "failed"'),
    ).toContain('must start with SELECT')
  })

  it('rejects INSERT statements', () => {
    expect(
      validateReadOnlySql(
        'INSERT INTO donations.events (source) VALUES ("test")',
      ),
    ).toContain('must start with SELECT')
  })

  it('rejects multi-statement queries (semicolons)', () => {
    expect(
      validateReadOnlySql('SELECT 1; DROP TABLE donations.events'),
    ).toContain('Multi-statement')
    expect(
      validateReadOnlySql(
        'SELECT * FROM donations.events; DELETE FROM donations.events',
      ),
    ).toContain('Multi-statement')
  })

  it('allows semicolons inside string literals', () => {
    expect(
      validateReadOnlySql(
        "SELECT * FROM donations.events WHERE description = 'foo; bar'",
      ),
    ).toBeNull()
  })

  it('rejects ALTER', () => {
    expect(
      validateReadOnlySql('ALTER TABLE donations.events ADD COLUMN x STRING'),
    ).toContain('must start with SELECT')
  })

  it('rejects CREATE', () => {
    expect(validateReadOnlySql('CREATE TABLE x (id INT64)')).toContain(
      'must start with SELECT',
    )
  })

  it('rejects TRUNCATE', () => {
    expect(validateReadOnlySql('TRUNCATE TABLE donations.events')).toContain(
      'must start with SELECT',
    )
  })

  it('rejects MERGE', () => {
    expect(
      validateReadOnlySql(
        'MERGE INTO donations.events USING source ON true WHEN MATCHED THEN DELETE',
      ),
    ).toContain('must start with SELECT')
  })

  it('rejects EXPORT DATA', () => {
    expect(
      validateReadOnlySql(
        'SELECT 1 EXPORT DATA OPTIONS(uri="gs://bucket/data")',
      ),
    ).toContain('Forbidden SQL keyword: EXPORT')
  })

  it('rejects EXECUTE IMMEDIATE', () => {
    expect(
      validateReadOnlySql('SELECT EXECUTE IMMEDIATE "DROP TABLE x"'),
    ).toContain('Forbidden SQL keyword: EXECUTE')
  })

  it('rejects CALL', () => {
    expect(validateReadOnlySql('SELECT 1 CALL my_procedure()')).toContain(
      'Forbidden SQL keyword: CALL',
    )
  })

  it('rejects DECLARE', () => {
    expect(validateReadOnlySql('SELECT 1 DECLARE x INT64 DEFAULT 0')).toContain(
      'Forbidden SQL keyword: DECLARE',
    )
  })

  it('rejects INFORMATION_SCHEMA access', () => {
    expect(
      validateReadOnlySql(
        'SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = "events"',
      ),
    ).toContain('INFORMATION_SCHEMA')
  })

  it('allows forbidden keywords inside backtick-quoted identifiers', () => {
    expect(
      validateReadOnlySql(
        'SELECT * FROM donations.events WHERE `drop_date` IS NOT NULL',
      ),
    ).toBeNull()
  })

  it('rejects GRANT', () => {
    expect(
      validateReadOnlySql('GRANT SELECT ON TABLE donations.events TO "user"'),
    ).toContain('must start with SELECT')
  })

  it('rejects REVOKE', () => {
    expect(
      validateReadOnlySql(
        'REVOKE SELECT ON TABLE donations.events FROM "user"',
      ),
    ).toContain('must start with SELECT')
  })

  it('allows forbidden keywords inside string literals', () => {
    expect(
      validateReadOnlySql(
        "SELECT * FROM donations.events WHERE description = 'Please delete this'",
      ),
    ).toBeNull()
  })

  it('allows forbidden keywords inside double-quoted identifiers', () => {
    expect(
      validateReadOnlySql(
        'SELECT * FROM donations.events WHERE "drop_date" IS NOT NULL',
      ),
    ).toBeNull()
  })
})

describe('ensureLimit', () => {
  it('appends LIMIT 100 when no LIMIT present', () => {
    const result = ensureLimit('SELECT * FROM donations.events')
    expect(result).toContain('LIMIT 100')
  })

  it('preserves existing LIMIT clause', () => {
    const sql = 'SELECT * FROM donations.events LIMIT 50'
    const result = ensureLimit(sql)
    expect(result).toBe(sql)
    expect(result).not.toContain('LIMIT 100')
  })

  it('preserves LIMIT in any case', () => {
    const sql = 'SELECT * FROM donations.events limit 25'
    expect(ensureLimit(sql)).toBe(sql)
  })

  it('uses custom default limit', () => {
    const result = ensureLimit('SELECT * FROM donations.events', 50)
    expect(result).toContain('LIMIT 50')
  })

  it('strips trailing semicolons', () => {
    const result = ensureLimit('SELECT * FROM donations.events;')
    expect(result).not.toContain(';')
    expect(result).toContain('LIMIT 100')
  })

  it('does not confuse LIMIT in subqueries with outer LIMIT', () => {
    const sql = 'SELECT * FROM (SELECT * FROM donations.events LIMIT 10) sub'
    const result = ensureLimit(sql)
    // The subquery has LIMIT but the outer query does not, so LIMIT should be appended
    expect(result).toContain('LIMIT 100')
  })

  it('preserves outer LIMIT when subquery also has LIMIT', () => {
    const sql =
      'SELECT * FROM (SELECT * FROM donations.events LIMIT 10) sub LIMIT 50'
    expect(ensureLimit(sql)).toBe(sql)
  })
})
