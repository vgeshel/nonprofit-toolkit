/**
 * Tests for Benevity schema primitives.
 */
import { describe, expect, it } from 'vitest'
import {
  BenevityCsvRowSchema,
  BenevityReportMetaSchema,
  isDonationHeaderRow,
  isTrailerLabel,
  normalizeWithheld,
  NOT_SHARED_SENTINEL,
  parseMoneyToCents,
  REPORT_META_LABELS,
} from '../../src/benevity/schema'

/**
 * A realistic row from a current-format (23 column) report.
 */
const CURRENT_ROW = {
  Company: 'Google',
  Project: 'LELEKA FOUNDATION',
  'Donation Date': '2026-07-27T16:51:41Z',
  'Donor First Name': 'Artem',
  'Donor Last Name': 'Kalchenko',
  Email: 'artem@example.com',
  Address: '1 Main St',
  City: 'Paris',
  'State/Province': 'IDF',
  'Postal Code': '75009',
  Activity: 'Continued Support for Ukraine',
  Comment: 'Slava',
  'Transaction ID': '7JMB73R4QH',
  'Donation Frequency': 'Recurring',
  Currency: 'EUR',
  'Project Remote ID': '',
  Source: 'Payroll',
  Reason: 'User Portfolio Donation',
  'Total Donation to be Acknowledged': '16.67',
  'Match Amount': '16.67',
  'Cause Support Fee': '0.00',
  'Merchant Fee': '0.00',
  'Fee Comment': '',
}

describe('parseMoneyToCents', () => {
  it('parses a plain decimal amount', () => {
    const result = parseMoneyToCents('16.67')
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe(1667)
  })

  it('strips thousands separators', () => {
    expect(parseMoneyToCents('10,000.00')._unsafeUnwrap()).toBe(1000000)
    expect(parseMoneyToCents('1,066.66')._unsafeUnwrap()).toBe(106666)
  })

  it('parses negative amounts for reversals', () => {
    expect(parseMoneyToCents('-1,900.00')._unsafeUnwrap()).toBe(-190000)
  })

  it('treats empty and whitespace as zero', () => {
    expect(parseMoneyToCents('')._unsafeUnwrap()).toBe(0)
    expect(parseMoneyToCents('   ')._unsafeUnwrap()).toBe(0)
  })

  it('is exact for amounts that float multiplication would skew', () => {
    // 0.07 * 100 is 7.000000000000001 and 1.15 * 100 is 114.99999999999999
    // in IEEE 754; both must land on an exact cent.
    expect(parseMoneyToCents('0.07')._unsafeUnwrap()).toBe(7)
    expect(parseMoneyToCents('1.15')._unsafeUnwrap()).toBe(115)
    expect(parseMoneyToCents('1,234.56')._unsafeUnwrap()).toBe(123456)
  })

  it('returns an error for a non-numeric amount', () => {
    const result = parseMoneyToCents('not a number')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'parse',
      field: 'amount',
      message: 'Invalid amount: not a number',
    })
  })

  it('returns an error for a partially numeric amount', () => {
    // parseFloat would happily return 12 here; the connector must not.
    const result = parseMoneyToCents('12abc')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toBe('Invalid amount: 12abc')
  })
})

describe('normalizeWithheld', () => {
  it('maps the withheld sentinel to null', () => {
    expect(normalizeWithheld(NOT_SHARED_SENTINEL)).toBeNull()
  })

  it('ignores surrounding whitespace on the sentinel', () => {
    expect(normalizeWithheld('  Not shared by donor  ')).toBeNull()
  })

  it('maps empty and whitespace-only values to null', () => {
    expect(normalizeWithheld('')).toBeNull()
    expect(normalizeWithheld('   ')).toBeNull()
  })

  it('maps undefined to null', () => {
    expect(normalizeWithheld(undefined)).toBeNull()
  })

  it('returns a trimmed real value', () => {
    expect(normalizeWithheld('  Kyiv ')).toBe('Kyiv')
  })
})

describe('isTrailerLabel', () => {
  it('recognises every known trailer label', () => {
    expect(isTrailerLabel('Totals')).toBe(true)
    expect(isTrailerLabel('Total Donations (Gross)')).toBe(true)
    expect(isTrailerLabel('Check Fee')).toBe(true)
    expect(isTrailerLabel('EFT Fee')).toBe(true)
    expect(isTrailerLabel('Wire Fee')).toBe(true)
    expect(isTrailerLabel('Net Total Payment')).toBe(true)
  })

  it('recognises the comment separator', () => {
    expect(isTrailerLabel('#-------------------------------------------')).toBe(
      true,
    )
  })

  it('does not treat a company name as a trailer label', () => {
    expect(isTrailerLabel('Google')).toBe(false)
    expect(isTrailerLabel('')).toBe(false)
  })
})

describe('isDonationHeaderRow', () => {
  it('matches the donation header row', () => {
    expect(isDonationHeaderRow(['Company', 'Project', 'Donation Date'])).toBe(
      true,
    )
  })

  it('rejects a data row', () => {
    expect(isDonationHeaderRow(['Google', 'LELEKA FOUNDATION'])).toBe(false)
  })

  it('rejects a metadata row', () => {
    expect(isDonationHeaderRow(['Charity Name', 'LELEKA FOUNDATION'])).toBe(
      false,
    )
  })

  it('rejects a single-column row', () => {
    expect(isDonationHeaderRow(['Company'])).toBe(false)
  })

  it('rejects an empty row', () => {
    expect(isDonationHeaderRow([])).toBe(false)
  })
})

describe('REPORT_META_LABELS', () => {
  it('lists the metadata keys carried in the report preamble', () => {
    expect(REPORT_META_LABELS).toEqual([
      'Charity Name',
      'Charity ID',
      'Period Ending',
      'Currency',
      'Payment Method',
      'Disbursement ID',
    ])
  })
})

describe('BenevityCsvRowSchema', () => {
  it('accepts a current-format row', () => {
    const result = BenevityCsvRowSchema.safeParse(CURRENT_ROW)
    expect(result.success).toBe(true)
    expect(result.data?.['Transaction ID']).toBe('7JMB73R4QH')
    expect(result.data?.['Match Amount']).toBe('16.67')
  })

  it('accepts a legacy row missing the two fee columns', () => {
    const legacy: Record<string, string> = { ...CURRENT_ROW }
    delete legacy['Cause Support Fee']
    delete legacy['Merchant Fee']

    const result = BenevityCsvRowSchema.safeParse(legacy)
    expect(result.success).toBe(true)
    // Missing fee columns default to "0" so downstream arithmetic is total.
    expect(result.data?.['Cause Support Fee']).toBe('0')
    expect(result.data?.['Merchant Fee']).toBe('0')
  })

  it('rejects a row without a Transaction ID', () => {
    const result = BenevityCsvRowSchema.safeParse({
      ...CURRENT_ROW,
      'Transaction ID': '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a row without a Donation Date', () => {
    const result = BenevityCsvRowSchema.safeParse({
      ...CURRENT_ROW,
      'Donation Date': '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a row whose currency is not a 3-letter code', () => {
    const result = BenevityCsvRowSchema.safeParse({
      ...CURRENT_ROW,
      Currency: 'EURO',
    })
    expect(result.success).toBe(false)
  })

  it('defaults every optional descriptive field to an empty string', () => {
    const result = BenevityCsvRowSchema.safeParse({
      'Donation Date': '2026-07-27T16:51:41Z',
      'Transaction ID': '7JMB73R4QH',
      Currency: 'USD',
      'Total Donation to be Acknowledged': '5.00',
      'Match Amount': '0.00',
    })
    expect(result.success).toBe(true)
    expect(result.data?.Company).toBe('')
    expect(result.data?.Activity).toBe('')
    expect(result.data?.Reason).toBe('')
    expect(result.data?.Comment).toBe('')
  })
})

describe('BenevityReportMetaSchema', () => {
  it('accepts a complete preamble', () => {
    const result = BenevityReportMetaSchema.safeParse({
      charityName: 'LELEKA FOUNDATION',
      charityId: '840-472377309',
      periodEnding: 'Mon 7 Sep 2026 0:00:00',
      currency: 'USD',
      paymentMethod: 'EFT',
      disbursementId: '1WLFLKD5A8',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a preamble missing the disbursement id', () => {
    const result = BenevityReportMetaSchema.safeParse({
      charityName: 'LELEKA FOUNDATION',
      charityId: '840-472377309',
      periodEnding: 'Mon 7 Sep 2026 0:00:00',
      currency: 'USD',
      paymentMethod: 'EFT',
      disbursementId: '',
    })
    expect(result.success).toBe(false)
  })
})
