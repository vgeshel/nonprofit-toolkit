/**
 * Tests for Funraise transformer functions.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { FunraiseCsvRow } from '../../src/funraise/schema'
import {
  buildSourceMetadata,
  extractDonorAddress,
  extractEmail,
  extractPhone,
  formatDonorName,
  mapFunraiseRecurring,
  mapFunraiseStatus,
  parseAmountToCents,
  parseFunraiseDateToISO,
  transformFunraiseRow,
  transformFunraiseRows,
} from '../../src/funraise/transformer'

describe('mapFunraiseStatus', () => {
  it('maps "Complete" to "succeeded"', () => {
    expect(mapFunraiseStatus('Complete')).toBe('succeeded')
  })

  it('maps "completed" (lowercase) to "succeeded"', () => {
    expect(mapFunraiseStatus('completed')).toBe('succeeded')
  })

  it('maps "pending" to "pending"', () => {
    expect(mapFunraiseStatus('pending')).toBe('pending')
  })

  it('maps "failed" to "failed"', () => {
    expect(mapFunraiseStatus('failed')).toBe('failed')
  })

  it('maps "cancelled" to "cancelled"', () => {
    expect(mapFunraiseStatus('cancelled')).toBe('cancelled')
  })

  it('maps "canceled" (American spelling) to "cancelled"', () => {
    expect(mapFunraiseStatus('canceled')).toBe('cancelled')
  })

  it('maps "refunded" to "refunded"', () => {
    expect(mapFunraiseStatus('refunded')).toBe('refunded')
  })

  it('maps unknown status to "succeeded"', () => {
    expect(mapFunraiseStatus('unknown')).toBe('succeeded')
  })

  it('handles whitespace around status', () => {
    expect(mapFunraiseStatus('  Complete  ')).toBe('succeeded')
  })
})

describe('parseFunraiseDateToISO', () => {
  it('parses Funraise date format with timezone bracket', () => {
    const result = parseFunraiseDateToISO(
      '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('2026-01-24T08:05:47.440Z')
    }
  })

  it('parses date without timezone bracket', () => {
    const result = parseFunraiseDateToISO('2026-01-24T00:05:47-08:00')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('2026-01-24T08:05:47.000Z')
    }
  })

  it('parses date with microseconds', () => {
    const result = parseFunraiseDateToISO(
      '2025-11-01T00:22:50.832-07:00[US/Pacific]',
    )
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('2025-11-01T07:22:50.832Z')
    }
  })

  it('returns error for invalid date', () => {
    const result = parseFunraiseDateToISO('not-a-date')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.field).toBe('Transaction Date')
    }
  })
})

describe('parseAmountToCents', () => {
  it('converts dollar amount to cents', () => {
    const result = parseAmountToCents('107.70')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(10770)
    }
  })

  it('handles amounts with commas', () => {
    const result = parseAmountToCents('1,234.56')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(123456)
    }
  })

  it('handles amounts with dollar sign', () => {
    const result = parseAmountToCents('$50.00')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(5000)
    }
  })

  it('handles whole dollar amounts', () => {
    const result = parseAmountToCents('100')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(10000)
    }
  })

  it('handles amounts with whitespace', () => {
    const result = parseAmountToCents('  49.50  ')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(4950)
    }
  })

  it('returns error for invalid amount', () => {
    const result = parseAmountToCents('not-a-number')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.field).toBe('Amount')
    }
  })
})

describe('formatDonorName', () => {
  it('combines first and last name', () => {
    expect(formatDonorName('John', 'Doe')).toBe('John Doe')
  })

  it('returns first name only when last name is empty', () => {
    expect(formatDonorName('John', '')).toBe('John')
  })

  it('returns last name only when first name is empty', () => {
    expect(formatDonorName('', 'Doe')).toBe('Doe')
  })

  it('returns empty string when both are empty', () => {
    expect(formatDonorName('', '')).toBe('')
  })

  it('trims whitespace', () => {
    expect(formatDonorName('  John  ', '  Doe  ')).toBe('John Doe')
  })
})

describe('extractDonorAddress', () => {
  const createRow = (overrides: Partial<FunraiseCsvRow>): FunraiseCsvRow => ({
    Id: '123',
    Amount: '100',
    'Transaction Date': '2026-01-01T00:00:00-08:00',
    'Supporter Id': '',
    'First Name': '',
    'Last Name': '',
    'Institution Name': '',
    'Institution Category': '',
    Address: '',
    City: '',
    'State/Province': '',
    'Postal Code': '',
    Country: '',
    Phone: '',
    Email: '',
    Status: 'Complete',
    'Payment Method': '',
    'Card Type': '',
    Currency: 'USD',
    'Platform Fee Amount': '0',
    'Platform Fee Percent': '0',
    'Tax Deductible Amount': '',
    'Source Amount': '',
    Form: '',
    'Form Id': '',
    'Campaign Goal Id': '',
    'Campaign Page URL': '',
    'Campaign Page Id': '',
    'UTM Source': '',
    'UTM Medium': '',
    'UTM Content': '',
    'UTM Term': '',
    'UTM Campaign': '',
    Dedication: '',
    'Dedication Email': '',
    'Dedication Name': '',
    'Dedication Type': '',
    'Dedication Message': '',
    Recurring: '',
    'Recurring Id': '',
    Sequence: '',
    Frequency: '',
    'Prospecting | Real Estate Value': '',
    'Soft Credit Supporter Id': '',
    'Soft Credit Supporter Name': '',
    'Soft Credit Supporter Email': '',
    'Operations Tip Amount': '',
    Match: '',
    Anonymous: '',
    Comment: '',
    'Expiration Date': '',
    Offline: '',
    'Last Four': '',
    'Gateway Response': '',
    'Gateway Transaction Id': '',
    'Import External Id': '',
    Name: '',
    'Check Number': '',
    Memo: '',
    Note: '',
    Tags: '',
    Allocations: '',
    URL: '',
    'Household Id': '',
    'Household Name': '',
    ...overrides,
  })

  it('returns null when all address fields are empty', () => {
    const row = createRow({})
    expect(extractDonorAddress(row)).toBeNull()
  })

  it('extracts full address', () => {
    const row = createRow({
      Address: '123 Main St',
      City: 'San Francisco',
      'State/Province': 'California',
      'Postal Code': '94102',
      Country: 'United States',
    })

    expect(extractDonorAddress(row)).toEqual({
      line1: '123 Main St',
      line2: null,
      city: 'San Francisco',
      state: 'California',
      postal_code: '94102',
      country: 'US',
    })
  })

  it('maps common country names to ISO codes', () => {
    expect(
      extractDonorAddress(createRow({ Country: 'United States' }))?.country,
    ).toBe('US')
    expect(extractDonorAddress(createRow({ Country: 'USA' }))?.country).toBe(
      'US',
    )
    expect(extractDonorAddress(createRow({ Country: 'Canada' }))?.country).toBe(
      'CA',
    )
    expect(extractDonorAddress(createRow({ Country: 'Norway' }))?.country).toBe(
      'NO',
    )
    expect(extractDonorAddress(createRow({ Country: 'Sweden' }))?.country).toBe(
      'SE',
    )
    expect(extractDonorAddress(createRow({ Country: 'Poland' }))?.country).toBe(
      'PL',
    )
    expect(
      extractDonorAddress(createRow({ Country: 'United Kingdom' }))?.country,
    ).toBe('GB')
    expect(extractDonorAddress(createRow({ Country: 'UK' }))?.country).toBe(
      'GB',
    )
  })

  it('preserves 2-letter ISO codes', () => {
    expect(extractDonorAddress(createRow({ Country: 'DE' }))?.country).toBe(
      'DE',
    )
    expect(extractDonorAddress(createRow({ Country: 'fr' }))?.country).toBe(
      'FR',
    )
  })

  it('returns null country for unknown country names', () => {
    expect(
      extractDonorAddress(createRow({ Country: 'Unknown Country' }))?.country,
    ).toBeNull()
  })

  it('handles partial address with only postal code', () => {
    const row = createRow({ 'Postal Code': '94102' })
    expect(extractDonorAddress(row)).toEqual({
      line1: null,
      line2: null,
      city: null,
      state: null,
      postal_code: '94102',
      country: null,
    })
  })
})

describe('extractEmail', () => {
  it('returns valid email', () => {
    expect(extractEmail('test@example.com')).toBe('test@example.com')
  })

  it('returns null for empty string', () => {
    expect(extractEmail('')).toBeNull()
  })

  it('returns null for whitespace', () => {
    expect(extractEmail('   ')).toBeNull()
  })

  it('returns null for invalid email', () => {
    expect(extractEmail('not-an-email')).toBeNull()
    expect(extractEmail('missing@tld')).toBeNull()
  })

  it('trims whitespace from valid email', () => {
    expect(extractEmail('  test@example.com  ')).toBe('test@example.com')
  })
})

describe('extractPhone', () => {
  it('returns phone number', () => {
    expect(extractPhone('+1-555-123-4567')).toBe('+1-555-123-4567')
  })

  it('returns null for empty string', () => {
    expect(extractPhone('')).toBeNull()
  })

  it('returns null for whitespace', () => {
    expect(extractPhone('   ')).toBeNull()
  })
})

describe('buildSourceMetadata', () => {
  const createRow = (overrides: Partial<FunraiseCsvRow>): FunraiseCsvRow => ({
    Id: '123',
    Amount: '100',
    'Transaction Date': '2026-01-01T00:00:00-08:00',
    'Supporter Id': '456',
    'First Name': '',
    'Last Name': '',
    'Institution Name': 'Acme Corp',
    'Institution Category': 'Corporate',
    Address: '',
    City: '',
    'State/Province': '',
    'Postal Code': '',
    Country: '',
    Phone: '',
    Email: '',
    Status: 'Complete',
    'Payment Method': '',
    'Card Type': 'VISA',
    Currency: 'USD',
    'Platform Fee Amount': '5.00',
    'Platform Fee Percent': '5.0',
    'Tax Deductible Amount': '100.00',
    'Source Amount': '100.00',
    Form: 'Website Donate',
    'Form Id': '123',
    'Campaign Goal Id': '456',
    'Campaign Page URL': 'https://example.com/campaign',
    'Campaign Page Id': '789',
    'UTM Source': 'google',
    'UTM Medium': 'cpc',
    'UTM Content': 'ad1',
    'UTM Term': 'donate',
    'UTM Campaign': 'q1-2026',
    Dedication: 'true',
    'Dedication Email': 'tribute@example.com',
    'Dedication Name': 'John Doe',
    'Dedication Type': 'in memory of',
    'Dedication Message': 'In loving memory',
    Recurring: 'true',
    'Recurring Id': '999',
    Sequence: '12',
    Frequency: 'Monthly',
    'Prospecting | Real Estate Value': '',
    'Soft Credit Supporter Id': '',
    'Soft Credit Supporter Name': '',
    'Soft Credit Supporter Email': '',
    'Operations Tip Amount': '',
    Match: 'true',
    Anonymous: 'true',
    Comment: '',
    'Expiration Date': '12/29',
    Offline: 'false',
    'Last Four': '1234',
    'Gateway Response': 'SUCCEEDED',
    'Gateway Transaction Id': 'ch_123',
    'Import External Id': '',
    Name: '',
    'Check Number': '1001',
    Memo: 'Test memo',
    Note: '',
    Tags: 'tag1,tag2',
    Allocations: 'Fund A',
    URL: 'https://example.com',
    'Household Id': '111',
    'Household Name': 'Doe Household',
    ...overrides,
  })

  it('builds metadata with all fields', () => {
    const row = createRow({})
    const metadata = buildSourceMetadata(row)

    expect(metadata.supporterId).toBe('456')
    expect(metadata.institutionName).toBe('Acme Corp')
    expect(metadata.cardType).toBe('VISA')
    expect(metadata.recurring).toBe(true)
    expect(metadata.match).toBe(true)
    expect(metadata.anonymous).toBe(true)
    expect(metadata.dedication).toBe(true)
    expect(metadata.dedicationName).toBe('John Doe')
    expect(metadata.offline).toBe(false)
  })

  it('converts boolean strings to booleans', () => {
    const row = createRow({
      Recurring: 'false',
      Match: 'false',
      Anonymous: 'false',
    })
    const metadata = buildSourceMetadata(row)

    expect(metadata.recurring).toBe(false)
    expect(metadata.match).toBe(false)
    expect(metadata.anonymous).toBe(false)
  })

  it('sets empty fields to undefined', () => {
    const row = createRow({
      'Supporter Id': '',
      'Institution Name': '',
      'Platform Fee Percent': '',
      'Tax Deductible Amount': '',
    })
    const metadata = buildSourceMetadata(row)

    expect(metadata.supporterId).toBeUndefined()
    expect(metadata.institutionName).toBeUndefined()
    expect(metadata.platformFeePercent).toBeUndefined()
    expect(metadata.taxDeductibleAmount).toBeUndefined()
  })
})

describe('mapFunraiseRecurring', () => {
  it('maps "true" to true', () => {
    expect(mapFunraiseRecurring('true')).toBe(true)
  })

  it('maps "false" to false', () => {
    expect(mapFunraiseRecurring('false')).toBe(false)
  })

  it('maps a blank or missing column to null', () => {
    expect(mapFunraiseRecurring('')).toBeNull()
    expect(mapFunraiseRecurring('yes')).toBeNull()
  })
})

describe('transformFunraiseRow', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createRow = (overrides: Partial<FunraiseCsvRow>): FunraiseCsvRow => ({
    Id: '10000001',
    Amount: '107.70',
    'Transaction Date': '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
    'Supporter Id': '20000001',
    'First Name': 'Kari',
    'Last Name': 'Nordmann',
    'Institution Name': '',
    'Institution Category': '',
    Address: 'Eksempelveien 1',
    City: 'Oslo',
    'State/Province': 'Oslo',
    'Postal Code': '0001',
    Country: 'Norway',
    Phone: '+4712345678',
    Email: 'kari.nordmann@example.com',
    Status: 'Complete',
    'Payment Method': 'Credit Card',
    'Card Type': 'AMEX',
    Currency: 'USD',
    'Platform Fee Amount': '5.00',
    'Platform Fee Percent': '5.0',
    'Tax Deductible Amount': '107.70',
    'Source Amount': '107.70',
    Form: 'Website Donate',
    'Form Id': '10001',
    'Campaign Goal Id': '',
    'Campaign Page URL': '',
    'Campaign Page Id': '',
    'UTM Source': 'website',
    'UTM Medium': '',
    'UTM Content': '',
    'UTM Term': '',
    'UTM Campaign': '',
    Dedication: 'true',
    'Dedication Email': '',
    'Dedication Name': 'Ola Nordmann',
    'Dedication Type': 'inspired by',
    'Dedication Message': '',
    Recurring: 'true',
    'Recurring Id': '900001',
    Sequence: '35',
    Frequency: 'Monthly',
    'Prospecting | Real Estate Value': '',
    'Soft Credit Supporter Id': '',
    'Soft Credit Supporter Name': '',
    'Soft Credit Supporter Email': '',
    'Operations Tip Amount': '0',
    Match: 'false',
    Anonymous: 'false',
    Comment: '',
    'Expiration Date': '12/29',
    Offline: 'false',
    'Last Four': '4242',
    'Gateway Response': 'SUCCEEDED',
    'Gateway Transaction Id': 'ch_test_0000000000000000001',
    'Import External Id': '',
    Name: '00000001',
    'Check Number': '',
    Memo: '',
    Note: '',
    Tags: '',
    Allocations: '',
    URL: '',
    'Household Id': '30000001',
    'Household Name': 'Nordmann Household',
    ...overrides,
  })

  it('marks a one-off gift as not recurring', () => {
    const result = transformFunraiseRow(
      createRow({ Recurring: 'false', 'Recurring Id': '', Frequency: '' }),
      runId,
    )
    expect(result._unsafeUnwrap().is_recurring).toBe(false)
  })

  it('leaves is_recurring null when the export has no Recurring value', () => {
    const result = transformFunraiseRow(createRow({ Recurring: '' }), runId)
    expect(result._unsafeUnwrap().is_recurring).toBeNull()
  })

  it('transforms a complete row to DonationEvent', () => {
    const row = createRow({})
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      const event = result.value

      expect(event.source).toBe('funraise')
      expect(event.external_id).toBe('10000001')
      expect(event.event_ts).toBe('2026-01-24T08:05:47.440Z')
      expect(event.amount_cents).toBe(10770)
      expect(event.fee_cents).toBe(500)
      expect(event.net_amount_cents).toBe(10270)
      expect(event.currency).toBe('USD')
      expect(event.donor_name).toBe('Kari Nordmann')
      expect(event.payer_name).toBeNull()
      expect(event.is_recurring).toBe(true)
      expect(event.donor_email).toBe('kari.nordmann@example.com')
      expect(event.donor_phone).toBe('+4712345678')
      expect(event.status).toBe('succeeded')
      expect(event.payment_method).toBe('Credit Card')
      expect(event.attribution).toBe('website')
      expect(event.attribution_human).toBe('Website Donate')
      expect(event.run_id).toBe(runId)
    }
  })

  it('extracts donor address correctly', () => {
    const row = createRow({})
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.donor_address).toEqual({
        line1: 'Eksempelveien 1',
        line2: null,
        city: 'Oslo',
        state: 'Oslo',
        postal_code: '0001',
        country: 'NO',
      })
    }
  })

  it('uses Institution Name as payer_name when present', () => {
    const row = createRow({ 'Institution Name': 'Vanguard Charitable' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.payer_name).toBe('Vanguard Charitable')
    }
  })

  it('uses Comment as description', () => {
    const row = createRow({ Comment: 'Thank you for your work!' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.description).toBe('Thank you for your work!')
    }
  })

  it('uses Note as description when Comment is empty', () => {
    const row = createRow({ Comment: '', Note: 'Internal note' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.description).toBe('Internal note')
    }
  })

  it('returns error for invalid date', () => {
    const row = createRow({ 'Transaction Date': 'invalid-date' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Transaction Date')
    }
  })

  it('returns error for invalid amount', () => {
    const row = createRow({ Amount: 'not-a-number' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Amount')
    }
  })

  it('returns error for invalid Platform Fee Amount', () => {
    const row = createRow({ 'Platform Fee Amount': 'invalid-fee' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Amount')
      expect(result.error.message).toContain('Invalid amount')
    }
  })

  it('uses 0 for fee when Platform Fee Amount is empty', () => {
    const row = createRow({ 'Platform Fee Amount': '' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.fee_cents).toBe(0)
      expect(result.value.net_amount_cents).toBe(result.value.amount_cents)
    }
  })

  it('defaults to USD when Currency is empty', () => {
    const row = createRow({ Currency: '' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.currency).toBe('USD')
    }
  })

  it('uppercases currency code', () => {
    const row = createRow({ Currency: 'eur' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.currency).toBe('EUR')
    }
  })

  it('sets donor_name to null when both names are empty', () => {
    const row = createRow({ 'First Name': '', 'Last Name': '' })
    const result = transformFunraiseRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.donor_name).toBeNull()
    }
  })

  it('sets ingested_at to current time', () => {
    const before = DateTime.utc()
    const row = createRow({})
    const result = transformFunraiseRow(row, runId)
    const after = DateTime.utc()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      const ingestedAt = DateTime.fromISO(result.value.ingested_at, {
        zone: 'utc',
      })
      expect(ingestedAt >= before).toBe(true)
      expect(ingestedAt <= after).toBe(true)
    }
  })
})

describe('transformFunraiseRows', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createRow = (id: string, amount: string): FunraiseCsvRow => ({
    Id: id,
    Amount: amount,
    'Transaction Date': '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
    'Supporter Id': '',
    'First Name': 'Test',
    'Last Name': 'User',
    'Institution Name': '',
    'Institution Category': '',
    Address: '',
    City: '',
    'State/Province': '',
    'Postal Code': '',
    Country: '',
    Phone: '',
    Email: '',
    Status: 'Complete',
    'Payment Method': '',
    'Card Type': '',
    Currency: 'USD',
    'Platform Fee Amount': '0',
    'Platform Fee Percent': '0',
    'Tax Deductible Amount': '',
    'Source Amount': '',
    Form: '',
    'Form Id': '',
    'Campaign Goal Id': '',
    'Campaign Page URL': '',
    'Campaign Page Id': '',
    'UTM Source': '',
    'UTM Medium': '',
    'UTM Content': '',
    'UTM Term': '',
    'UTM Campaign': '',
    Dedication: '',
    'Dedication Email': '',
    'Dedication Name': '',
    'Dedication Type': '',
    'Dedication Message': '',
    Recurring: '',
    'Recurring Id': '',
    Sequence: '',
    Frequency: '',
    'Prospecting | Real Estate Value': '',
    'Soft Credit Supporter Id': '',
    'Soft Credit Supporter Name': '',
    'Soft Credit Supporter Email': '',
    'Operations Tip Amount': '',
    Match: '',
    Anonymous: '',
    Comment: '',
    'Expiration Date': '',
    Offline: '',
    'Last Four': '',
    'Gateway Response': '',
    'Gateway Transaction Id': '',
    'Import External Id': '',
    Name: '',
    'Check Number': '',
    Memo: '',
    Note: '',
    Tags: '',
    Allocations: '',
    URL: '',
    'Household Id': '',
    'Household Name': '',
  })

  it('transforms multiple rows', () => {
    const rows = [
      createRow('1', '100.00'),
      createRow('2', '200.00'),
      createRow('3', '300.00'),
    ]

    const events = transformFunraiseRows(rows, runId)

    expect(events).toHaveLength(3)
    expect(events[0]?.external_id).toBe('1')
    expect(events[0]?.amount_cents).toBe(10000)
    expect(events[1]?.external_id).toBe('2')
    expect(events[1]?.amount_cents).toBe(20000)
    expect(events[2]?.external_id).toBe('3')
    expect(events[2]?.amount_cents).toBe(30000)
  })

  it('skips rows with invalid data', () => {
    const rows = [
      createRow('1', '100.00'),
      createRow('2', 'invalid-amount'),
      createRow('3', '300.00'),
    ]

    const events = transformFunraiseRows(rows, runId)

    expect(events).toHaveLength(2)
    expect(events[0]?.external_id).toBe('1')
    expect(events[1]?.external_id).toBe('3')
  })

  it('returns empty array for empty input', () => {
    const events = transformFunraiseRows([], runId)
    expect(events).toEqual([])
  })
})
