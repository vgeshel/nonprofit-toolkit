/**
 * Tests for check deposits transformer functions.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { CheckDepositRow } from '../../src/check-deposits/schema'
import {
  generateExternalId,
  parseAddress,
  parseAmountToCents,
  parseDateToISO,
  transformCheckDepositRow,
  transformCheckDepositRows,
} from '../../src/check-deposits/transformer'

describe('parseAmountToCents', () => {
  it('parses "$2,000" to 200000 cents', () => {
    expect(parseAmountToCents('$2,000')).toBe(200000)
  })

  it('parses "$500" to 50000 cents', () => {
    expect(parseAmountToCents('$500')).toBe(50000)
  })

  it('parses "$10,000" to 1000000 cents', () => {
    expect(parseAmountToCents('$10,000')).toBe(1000000)
  })

  it('parses "$1,000,000" to 100000000 cents', () => {
    expect(parseAmountToCents('$1,000,000')).toBe(100000000)
  })

  it('parses amount with decimal', () => {
    expect(parseAmountToCents('$1,234.56')).toBe(123456)
  })

  it('parses amount without dollar sign', () => {
    expect(parseAmountToCents('2000')).toBe(200000)
  })

  it('parses amount with only dollar sign', () => {
    expect(parseAmountToCents('$100')).toBe(10000)
  })

  it('handles whitespace', () => {
    expect(parseAmountToCents('  $500  ')).toBe(50000)
  })

  it('returns 0 for invalid input', () => {
    expect(parseAmountToCents('invalid')).toBe(0)
  })

  it('returns 0 for empty string', () => {
    expect(parseAmountToCents('')).toBe(0)
  })

  it('handles decimal precision correctly', () => {
    expect(parseAmountToCents('$0.01')).toBe(1)
    expect(parseAmountToCents('$0.99')).toBe(99)
  })
})

describe('parseDateToISO', () => {
  it('parses "9/18/2023" to ISO format', () => {
    const result = parseDateToISO('9/18/2023')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.year).toBe(2023)
    expect(dt.month).toBe(9)
    expect(dt.day).toBe(18)
  })

  it('parses "11/5/2023" (single-digit day)', () => {
    const result = parseDateToISO('11/5/2023')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.month).toBe(11)
    expect(dt.day).toBe(5)
  })

  it('parses "1/15/2024" (single-digit month)', () => {
    const result = parseDateToISO('1/15/2024')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.month).toBe(1)
    expect(dt.day).toBe(15)
  })

  it('parses "12/31/2023" (end of year)', () => {
    const result = parseDateToISO('12/31/2023')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.month).toBe(12)
    expect(dt.day).toBe(31)
  })

  it('parses MM/DD/YYYY format', () => {
    const result = parseDateToISO('01/05/2024')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.month).toBe(1)
    expect(dt.day).toBe(5)
  })

  it('parses YYYY-MM-DD format', () => {
    const result = parseDateToISO('2026-01-27')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.year).toBe(2026)
    expect(dt.month).toBe(1)
    expect(dt.day).toBe(27)
  })

  it('parses YYYY-MM-DD with single-digit month and day', () => {
    const result = parseDateToISO('2026-02-05')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.year).toBe(2026)
    expect(dt.month).toBe(2)
    expect(dt.day).toBe(5)
  })

  it('handles whitespace', () => {
    const result = parseDateToISO('  9/18/2023  ')
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt.month).toBe(9)
    expect(dt.day).toBe(18)
  })

  it('returns current time for invalid date', () => {
    const before = DateTime.utc()
    const result = parseDateToISO('invalid')
    const after = DateTime.utc()
    const dt = DateTime.fromISO(result, { zone: 'utc' })

    expect(dt.isValid).toBe(true)
    expect(dt >= before).toBe(true)
    expect(dt <= after).toBe(true)
  })
})

describe('parseAddress', () => {
  it('returns null for empty string', () => {
    expect(parseAddress('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseAddress('   ')).toBeNull()
  })

  it('parses address into line1 with US country', () => {
    const result = parseAddress('200 Myrtle Ave, Mill Valley CA 94941-1040')

    expect(result).toEqual({
      line1: '200 Myrtle Ave, Mill Valley CA 94941-1040',
      line2: null,
      city: null,
      state: null,
      postal_code: null,
      country: 'US',
    })
  })

  it('trims whitespace from address', () => {
    const result = parseAddress('  123 Main St  ')

    expect(result?.line1).toBe('123 Main St')
  })

  it('handles multi-line address as single line', () => {
    const result = parseAddress('123 Main St, Suite 100, City, ST 12345')

    expect(result?.line1).toBe('123 Main St, Suite 100, City, ST 12345')
  })
})

describe('generateExternalId', () => {
  const baseRow: CheckDepositRow = {
    check_number: '12345',
    check_date: '9/18/2023',
    deposit_date: '9/20/2023',
    payer_name: 'Vanguard Charitable',
    donor_name: 'John Doe',
    amount: '$2,000',
    donor_email: '',
    donor_address: '',
    bank_contact_info: '',
    file_name: '',
  }

  it('generates deterministic ID for same input', () => {
    const id1 = generateExternalId(baseRow)
    const id2 = generateExternalId(baseRow)

    expect(id1).toBe(id2)
  })

  it('generates different IDs for different check numbers', () => {
    const row2 = { ...baseRow, check_number: '67890' }

    const id1 = generateExternalId(baseRow)
    const id2 = generateExternalId(row2)

    expect(id1).not.toBe(id2)
  })

  it('includes "check_" prefix', () => {
    const id = generateExternalId(baseRow)

    expect(id.startsWith('check_')).toBe(true)
  })

  it('generates different IDs for different payer names', () => {
    const row2 = { ...baseRow, payer_name: 'Schwab Charitable' }

    const id1 = generateExternalId(baseRow)
    const id2 = generateExternalId(row2)

    expect(id1).not.toBe(id2)
  })

  it('generates same ID when only non-key fields differ', () => {
    // Only payer_name + check_number determine the ID
    const row2 = {
      ...baseRow,
      donor_name: 'Jane Doe',
      amount: '$3,000',
      deposit_date: '10/1/2023',
    }

    const id1 = generateExternalId(baseRow)
    const id2 = generateExternalId(row2)

    expect(id1).toBe(id2)
  })
})

describe('transformCheckDepositRow', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const baseRow: CheckDepositRow = {
    check_number: '12345',
    check_date: '9/18/2023',
    deposit_date: '9/20/2023',
    payer_name: 'Vanguard Charitable',
    donor_name: 'John Doe',
    amount: '$2,000',
    donor_email: 'john@example.com',
    donor_address: '123 Main St, City, ST 12345',
    bank_contact_info: 'Contact: Jane at Vanguard',
    file_name: 'checks-2023.csv',
  }

  it('transforms basic row correctly', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.source).toBe('check_deposits')

    expect(result.is_recurring).toBeNull()
    expect(result.external_id).toMatch(/^check_/)
    expect(result.amount_cents).toBe(200000)
    expect(result.fee_cents).toBe(0)
    expect(result.net_amount_cents).toBe(200000)
    expect(result.currency).toBe('USD')
    expect(result.donor_name).toBe('John Doe')
    expect(result.payer_name).toBe('Vanguard Charitable')
    expect(result.donor_email).toBe('john@example.com')
    expect(result.status).toBe('succeeded')
    expect(result.payment_method).toBe('check')
    expect(result.run_id).toBe(runId)
  })

  it('uses deposit_date as event_ts', () => {
    const result = transformCheckDepositRow(baseRow, runId)
    const eventTs = DateTime.fromISO(result.event_ts, { zone: 'utc' })

    expect(eventTs.month).toBe(9)
    expect(eventTs.day).toBe(20)
    expect(eventTs.year).toBe(2023)
  })

  it('uses check_date as created_at', () => {
    const result = transformCheckDepositRow(baseRow, runId)
    const createdAt = DateTime.fromISO(result.created_at, { zone: 'utc' })

    expect(createdAt.month).toBe(9)
    expect(createdAt.day).toBe(18)
    expect(createdAt.year).toBe(2023)
  })

  it('includes check details in source_metadata', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.source_metadata.check_number).toBe('12345')
    expect(result.source_metadata.check_date).toBe('9/18/2023')
    expect(result.source_metadata.bank_contact_info).toBe(
      'Contact: Jane at Vanguard',
    )
    expect(result.source_metadata.file_name).toBe('checks-2023.csv')
  })

  it('handles empty file_name in source_metadata', () => {
    const row = { ...baseRow, file_name: '' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.source_metadata.file_name).toBeNull()
  })

  it('parses donor address', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.donor_address).toEqual({
      line1: '123 Main St, City, ST 12345',
      line2: null,
      city: null,
      state: null,
      postal_code: null,
      country: 'US',
    })
  })

  it('returns null for empty donor address', () => {
    const row = { ...baseRow, donor_address: '' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.donor_address).toBeNull()
  })

  it('validates and sets donor email', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.donor_email).toBe('john@example.com')
  })

  it('returns null for empty donor email', () => {
    const row = { ...baseRow, donor_email: '' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.donor_email).toBeNull()
  })

  it('returns null for invalid email (no @)', () => {
    const row = { ...baseRow, donor_email: 'invalid-email' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.donor_email).toBeNull()
  })

  it('returns null for email with @ at start', () => {
    const row = { ...baseRow, donor_email: '@example.com' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.donor_email).toBeNull()
  })

  it('returns null for email with @ at end', () => {
    const row = { ...baseRow, donor_email: 'user@' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.donor_email).toBeNull()
  })

  it('sets donor_phone to null', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.donor_phone).toBeNull()
  })

  it('sets description to null', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.description).toBeNull()
  })

  it('sets attribution fields to null', () => {
    const result = transformCheckDepositRow(baseRow, runId)

    expect(result.attribution).toBeNull()
    expect(result.attribution_human).toBeNull()
  })

  it('sets ingested_at to current time', () => {
    const before = DateTime.utc()
    const result = transformCheckDepositRow(baseRow, runId)
    const after = DateTime.utc()

    const ingestedAt = DateTime.fromISO(result.ingested_at, { zone: 'utc' })
    expect(ingestedAt >= before).toBe(true)
    expect(ingestedAt <= after).toBe(true)
  })

  it('handles empty donor_name', () => {
    const row = { ...baseRow, donor_name: '' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.donor_name).toBeNull()
  })

  it('handles empty payer_name', () => {
    const row = { ...baseRow, payer_name: '' }
    const result = transformCheckDepositRow(row, runId)

    expect(result.payer_name).toBeNull()
  })
})

describe('transformCheckDepositRows', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createRow = (id: number): CheckDepositRow => ({
    check_number: `${10000 + id}`,
    check_date: `9/${id}/2023`,
    deposit_date: `9/${id + 1}/2023`,
    payer_name: `Payer ${id}`,
    donor_name: `Donor ${id}`,
    amount: `$${id * 1000}`,
    donor_email: '',
    donor_address: '',
    bank_contact_info: '',
    file_name: '',
  })

  it('transforms multiple rows', () => {
    const rows = [createRow(1), createRow(2), createRow(3)]

    const result = transformCheckDepositRows(rows, runId)

    expect(result).toHaveLength(3)
    expect(result[0]?.donor_name).toBe('Donor 1')
    expect(result[1]?.donor_name).toBe('Donor 2')
    expect(result[2]?.donor_name).toBe('Donor 3')
  })

  it('returns empty array for empty input', () => {
    const result = transformCheckDepositRows([], runId)

    expect(result).toEqual([])
  })

  it('sets same runId for all events', () => {
    const rows = [createRow(1), createRow(2)]

    const result = transformCheckDepositRows(rows, runId)

    expect(result[0]?.run_id).toBe(runId)
    expect(result[1]?.run_id).toBe(runId)
  })
})
