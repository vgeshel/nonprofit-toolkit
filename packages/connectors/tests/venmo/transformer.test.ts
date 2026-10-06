/**
 * Tests for Venmo transformer.
 */
import { describe, expect, it } from 'vitest'
import type { VenmoCsvRow } from '../../src/venmo/schema'
import {
  buildSourceMetadata,
  extractEmail,
  mapVenmoStatus,
  parseVenmoAmountToCents,
  parseVenmoDateTimeToISO,
  transformVenmoRow,
  transformVenmoRows,
} from '../../src/venmo/transformer'

describe('mapVenmoStatus', () => {
  it('maps Complete to succeeded', () => {
    expect(mapVenmoStatus('Complete')).toBe('succeeded')
    expect(mapVenmoStatus('complete')).toBe('succeeded')
    expect(mapVenmoStatus('completed')).toBe('succeeded')
  })

  it('maps Pending/Issued to pending', () => {
    expect(mapVenmoStatus('Pending')).toBe('pending')
    expect(mapVenmoStatus('pending')).toBe('pending')
    expect(mapVenmoStatus('Issued')).toBe('pending')
    expect(mapVenmoStatus('issued')).toBe('pending')
  })

  it('maps Failed/Declined to failed', () => {
    expect(mapVenmoStatus('Failed')).toBe('failed')
    expect(mapVenmoStatus('failed')).toBe('failed')
    expect(mapVenmoStatus('Declined')).toBe('failed')
    expect(mapVenmoStatus('declined')).toBe('failed')
  })

  it('maps Cancelled/Canceled to cancelled', () => {
    expect(mapVenmoStatus('Cancelled')).toBe('cancelled')
    expect(mapVenmoStatus('cancelled')).toBe('cancelled')
    expect(mapVenmoStatus('Canceled')).toBe('cancelled')
    expect(mapVenmoStatus('canceled')).toBe('cancelled')
  })

  it('maps Refunded to refunded', () => {
    expect(mapVenmoStatus('Refunded')).toBe('refunded')
    expect(mapVenmoStatus('refunded')).toBe('refunded')
  })

  it('defaults unknown status to succeeded', () => {
    expect(mapVenmoStatus('Unknown')).toBe('succeeded')
    expect(mapVenmoStatus('')).toBe('succeeded')
  })
})

describe('parseVenmoDateTimeToISO', () => {
  it('parses valid date and time to ISO UTC', () => {
    const result = parseVenmoDateTimeToISO('01/01/2025', '01:18:52')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('2025-01-01T01:18:52.000Z')
    }
  })

  it('handles midnight', () => {
    const result = parseVenmoDateTimeToISO('12/31/2025', '00:00:00')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('2025-12-31T00:00:00.000Z')
    }
  })

  it('handles end of day', () => {
    const result = parseVenmoDateTimeToISO('06/15/2025', '23:59:59')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('2025-06-15T23:59:59.000Z')
    }
  })

  it('returns error for invalid date', () => {
    const result = parseVenmoDateTimeToISO('invalid', '01:00:00')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Date/Time')
      expect(result.error.message).toContain('Invalid date/time')
    }
  })

  it('returns error for invalid time', () => {
    const result = parseVenmoDateTimeToISO('01/01/2025', 'invalid')
    expect(result.isErr()).toBe(true)
  })
})

describe('parseVenmoAmountToCents', () => {
  it('parses positive amount with + prefix', () => {
    const result = parseVenmoAmountToCents('+ $100.00')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(10000)
    }
  })

  it('parses amount with thousands separator', () => {
    const result = parseVenmoAmountToCents('+ $1,000.00')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(100000)
    }
  })

  it('parses negative amount with - prefix', () => {
    const result = parseVenmoAmountToCents('- $500.00')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(50000)
    }
  })

  it('parses fee amount without sign', () => {
    const result = parseVenmoAmountToCents('$19.10')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(1910)
    }
  })

  it('handles zero', () => {
    const result = parseVenmoAmountToCents('0')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(0)
    }
  })

  it('handles empty string', () => {
    const result = parseVenmoAmountToCents('')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(0)
    }
  })

  it('handles whitespace', () => {
    const result = parseVenmoAmountToCents('  ')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(0)
    }
  })

  it('returns error for invalid amount', () => {
    const result = parseVenmoAmountToCents('invalid')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Amount')
      expect(result.error.message).toContain('Invalid amount')
    }
  })

  it('handles cents correctly', () => {
    const result = parseVenmoAmountToCents('+ $5.99')
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe(599)
    }
  })
})

describe('extractEmail', () => {
  it('extracts valid email', () => {
    expect(extractEmail('test@example.com')).toBe('test@example.com')
  })

  it('trims whitespace', () => {
    expect(extractEmail('  test@example.com  ')).toBe('test@example.com')
  })

  it('returns null for empty string', () => {
    expect(extractEmail('')).toBeNull()
  })

  it('returns null for (None)', () => {
    expect(extractEmail('(None)')).toBeNull()
  })

  it('returns null for invalid email', () => {
    expect(extractEmail('notanemail')).toBeNull()
    expect(extractEmail('missing@dot')).toBeNull()
  })
})

describe('buildSourceMetadata', () => {
  it('includes non-empty fields', () => {
    const row: VenmoCsvRow = {
      'Transaction ID': '123',
      Date: '01/01/2025',
      'Time (UTC)': '01:00:00',
      Type: 'Payment',
      Status: 'Complete',
      Note: 'Test',
      From: 'Donor',
      'Donor email': 'test@test.com',
      To: 'Test Organization',
      'Amount (total)': '+ $100.00',
      'Amount (tip)': '5',
      'Amount (tax)': '2',
      'Amount (net)': '$93.00',
      'Amount (fee)': '$5.00',
      'Tax Rate': '0.05',
      'Tax Exempt': 'TRUE',
      'Funding Source': 'Bank Account',
      Destination: 'Venmo balance',
      'Beginning Balance': '100',
      'Ending Balance': '200',
      'Statement Period Venmo Fees': '10',
      'Terminal Location': 'Mobile',
      'Year to Date Venmo Fees': '50',
      Disclaimer: '(None)',
    }

    const metadata = buildSourceMetadata(row)

    expect(metadata.to).toBe('Test Organization')
    expect(metadata.amountTip).toBe('5')
    expect(metadata.amountTax).toBe('2')
    expect(metadata.taxRate).toBe('0.05')
    expect(metadata.taxExempt).toBe('TRUE')
    expect(metadata.fundingSource).toBe('Bank Account')
    expect(metadata.destination).toBe('Venmo balance')
    expect(metadata.terminalLocation).toBe('Mobile')
  })

  it('excludes (None) values', () => {
    const row: VenmoCsvRow = {
      'Transaction ID': '123',
      Date: '01/01/2025',
      'Time (UTC)': '01:00:00',
      Type: 'Payment',
      Status: 'Complete',
      Note: '',
      From: '',
      'Donor email': '',
      To: '(None)',
      'Amount (total)': '+ $100.00',
      'Amount (tip)': '0',
      'Amount (tax)': '0',
      'Amount (net)': '',
      'Amount (fee)': '0',
      'Tax Rate': '0',
      'Tax Exempt': '',
      'Funding Source': '(None)',
      Destination: '',
      'Beginning Balance': '0',
      'Ending Balance': '0',
      'Statement Period Venmo Fees': '0',
      'Terminal Location': '(None)',
      'Year to Date Venmo Fees': '0',
      Disclaimer: '',
    }

    const metadata = buildSourceMetadata(row)

    expect(metadata.to).toBeUndefined()
    expect(metadata.fundingSource).toBeUndefined()
    expect(metadata.terminalLocation).toBeUndefined()
    expect(metadata.amountTip).toBeUndefined()
  })
})

describe('transformVenmoRow', () => {
  const validRow: VenmoCsvRow = {
    'Transaction ID': '"""4235629069058725679"""',
    Date: '01/01/2025',
    'Time (UTC)': '01:18:52',
    Type: 'Payment',
    Status: 'Complete',
    Note: 'Donation',
    From: 'john doe',
    'Donor email': 'donor@example.com',
    To: 'Test Organization',
    'Amount (total)': '+ $1,000.00',
    'Amount (tip)': '0',
    'Amount (tax)': '0',
    'Amount (net)': '$980.90',
    'Amount (fee)': '$19.10',
    'Tax Rate': '0',
    'Tax Exempt': 'FALSE',
    'Funding Source': '(None)',
    Destination: 'Venmo balance',
    'Beginning Balance': '0',
    'Ending Balance': '0',
    'Statement Period Venmo Fees': '0',
    'Terminal Location': 'Venmo',
    'Year to Date Venmo Fees': '0',
    Disclaimer: '(None)',
  }

  const runId = '550e8400-e29b-41d4-a716-446655440000'

  it('transforms a valid row to DonationEvent', () => {
    const result = transformVenmoRow(validRow, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      const event = result.value
      expect(event.source).toBe('venmo')
      expect(event.is_recurring).toBeNull()
      expect(event.external_id).toBe('4235629069058725679')
      expect(event.event_ts).toBe('2025-01-01T01:18:52.000Z')
      expect(event.amount_cents).toBe(100000)
      expect(event.fee_cents).toBe(1910)
      expect(event.net_amount_cents).toBe(98090)
      expect(event.currency).toBe('USD')
      expect(event.donor_name).toBe('john doe')
      expect(event.donor_email).toBe('donor@example.com')
      expect(event.status).toBe('succeeded')
      expect(event.payment_method).toBe('venmo')
      expect(event.description).toBe('Donation')
      expect(event.run_id).toBe(runId)
    }
  })

  it('calculates net amount when not provided', () => {
    const row = { ...validRow, 'Amount (net)': '' }
    const result = transformVenmoRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      // $1000 - $19.10 = $980.90 = 98090 cents
      expect(result.value.net_amount_cents).toBe(98090)
    }
  })

  it('handles missing donor name', () => {
    const row = { ...validRow, From: '' }
    const result = transformVenmoRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.donor_name).toBeNull()
    }
  })

  it('handles missing donor email', () => {
    const row = { ...validRow, 'Donor email': '' }
    const result = transformVenmoRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.donor_email).toBeNull()
    }
  })

  it('handles empty note', () => {
    const row = { ...validRow, Note: '' }
    const result = transformVenmoRow(row, runId)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.description).toBeNull()
    }
  })

  it('returns error for invalid date', () => {
    const row = { ...validRow, Date: 'invalid' }
    const result = transformVenmoRow(row, runId)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Date/Time')
    }
  })

  it('returns error for invalid amount', () => {
    const row = { ...validRow, 'Amount (total)': 'invalid' }
    const result = transformVenmoRow(row, runId)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Amount')
    }
  })

  it('returns error for invalid fee', () => {
    const row = { ...validRow, 'Amount (fee)': 'invalid' }
    const result = transformVenmoRow(row, runId)

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.field).toBe('Amount')
    }
  })
})

describe('transformVenmoRows', () => {
  const validRow: VenmoCsvRow = {
    'Transaction ID': '"""123"""',
    Date: '01/01/2025',
    'Time (UTC)': '01:00:00',
    Type: 'Payment',
    Status: 'Complete',
    Note: 'Test',
    From: 'Donor',
    'Donor email': 'test@test.com',
    To: 'Test Organization',
    'Amount (total)': '+ $100.00',
    'Amount (tip)': '0',
    'Amount (tax)': '0',
    'Amount (net)': '$98.00',
    'Amount (fee)': '$2.00',
    'Tax Rate': '0',
    'Tax Exempt': 'FALSE',
    'Funding Source': '(None)',
    Destination: 'Venmo balance',
    'Beginning Balance': '0',
    'Ending Balance': '0',
    'Statement Period Venmo Fees': '0',
    'Terminal Location': 'Venmo',
    'Year to Date Venmo Fees': '0',
    Disclaimer: '(None)',
  }

  const runId = '550e8400-e29b-41d4-a716-446655440000'

  it('transforms multiple valid rows', () => {
    const row2 = { ...validRow, 'Transaction ID': '"""456"""' }
    const events = transformVenmoRows([validRow, row2], runId)

    expect(events).toHaveLength(2)
    expect(events[0]?.external_id).toBe('123')
    expect(events[1]?.external_id).toBe('456')
  })

  it('skips rows with invalid data', () => {
    const invalidRow = { ...validRow, 'Amount (total)': 'invalid' }
    const events = transformVenmoRows([validRow, invalidRow], runId)

    expect(events).toHaveLength(1)
    expect(events[0]?.external_id).toBe('123')
  })

  it('handles empty array', () => {
    const events = transformVenmoRows([], runId)
    expect(events).toHaveLength(0)
  })
})
