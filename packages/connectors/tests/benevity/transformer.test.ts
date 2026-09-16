/**
 * Tests for the Benevity transformer.
 */
import type { DonationEvent } from '@donations-etl/types'
import { describe, expect, it } from 'vitest'
import {
  BenevityCsvRowSchema,
  type BenevityReport,
  type BenevityReportMeta,
} from '../../src/benevity/schema'
import {
  buildDonorAddress,
  buildDonorName,
  buildSourceMetadata,
  extractEmail,
  transformBenevityReport,
  transformBenevityRow,
} from '../../src/benevity/transformer'

const RUN_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const META: BenevityReportMeta = {
  charityName: 'LELEKA FOUNDATION',
  charityId: '840-472377309',
  periodEnding: 'Mon 17 Aug 2026 0:00:00',
  currency: 'USD',
  paymentMethod: 'EFT',
  disbursementId: '1WAY529V7N',
}

function row(overrides: Record<string, string> = {}) {
  return BenevityCsvRowSchema.parse({
    Company: 'Google',
    Project: 'LELEKA FOUNDATION',
    'Donation Date': '2026-07-06T20:56:08Z',
    'Donor First Name': 'James',
    'Donor Last Name': 'Duke',
    Email: 'jamesduke@example.com',
    Address: '16950 Bohlman Road',
    City: 'Saratoga',
    'State/Province': 'CA',
    'Postal Code': '95070',
    Activity: 'Continued Support for Ukraine',
    Comment: 'Thank you',
    'Transaction ID': '7H9J09CK37',
    'Donation Frequency': 'Recurring',
    Currency: 'USD',
    'Project Remote ID': '',
    Source: 'Payroll',
    Reason: 'User Donation',
    'Total Donation to be Acknowledged': '25.00',
    'Match Amount': '25.00',
    'Cause Support Fee': '1.00',
    'Merchant Fee': '0.50',
    'Fee Comment': '',
    ...overrides,
  })
}

describe('extractEmail', () => {
  it('returns a real address', () => {
    expect(extractEmail('donor@example.com')).toBe('donor@example.com')
  })

  it('returns null for the withheld sentinel', () => {
    expect(extractEmail('Not shared by donor')).toBeNull()
  })

  it('returns null for an empty value', () => {
    expect(extractEmail('')).toBeNull()
  })

  it('returns null for a value that is not an address', () => {
    expect(extractEmail('anonymous')).toBeNull()
  })
})

describe('buildDonorName', () => {
  it('joins first and last name', () => {
    expect(buildDonorName('James', 'Duke')).toBe('James Duke')
  })

  it('returns whichever half is present', () => {
    expect(buildDonorName('James', '')).toBe('James')
    expect(buildDonorName('', 'Duke')).toBe('Duke')
  })

  it('returns null when both names are withheld', () => {
    expect(
      buildDonorName('Not shared by donor', 'Not shared by donor'),
    ).toBeNull()
  })

  it('returns null when both names are empty', () => {
    expect(buildDonorName('', '')).toBeNull()
  })
})

describe('buildDonorAddress', () => {
  it('builds an address from the donor columns', () => {
    expect(buildDonorAddress(row())).toEqual({
      line1: '16950 Bohlman Road',
      line2: null,
      city: 'Saratoga',
      state: 'CA',
      postal_code: '95070',
      country: null,
    })
  })

  it('returns null when every address column is withheld', () => {
    expect(
      buildDonorAddress(
        row({
          Address: 'Not shared by donor',
          City: 'Not shared by donor',
          'State/Province': 'Not shared by donor',
          'Postal Code': 'Not shared by donor',
        }),
      ),
    ).toBeNull()
  })

  it('keeps a partial address when only the postal code survives', () => {
    expect(
      buildDonorAddress(
        row({
          Address: 'Not shared by donor',
          City: 'Not shared by donor',
          'State/Province': 'Not shared by donor',
          'Postal Code': '75009',
        }),
      ),
    ).toEqual({
      line1: null,
      line2: null,
      city: null,
      state: null,
      postal_code: '75009',
      country: null,
    })
  })
})

describe('buildSourceMetadata', () => {
  it('captures Benevity-specific fields alongside the disbursement', () => {
    expect(buildSourceMetadata(row(), META)).toEqual({
      company: 'Google',
      project: 'LELEKA FOUNDATION',
      activity: 'Continued Support for Ukraine',
      reason: 'User Donation',
      donation_source: 'Payroll',
      donation_frequency: 'Recurring',
      match_amount_cents: 2500,
      cause_support_fee_cents: 100,
      merchant_fee_cents: 50,
      disbursement_id: '1WAY529V7N',
      disbursement_period_ending: 'Mon 17 Aug 2026 0:00:00',
      disbursement_payment_method: 'EFT',
      charity_id: '840-472377309',
    })
  })

  it('omits descriptive fields that are absent', () => {
    const metadata = buildSourceMetadata(
      row({ Activity: '', Reason: '', 'Project Remote ID': '' }),
      META,
    )
    expect(metadata.activity).toBeUndefined()
    expect(metadata.reason).toBeUndefined()
  })

  it('includes the project remote id when present', () => {
    const metadata = buildSourceMetadata(
      row({ 'Project Remote ID': 'RID-9' }),
      META,
    )
    expect(metadata.project_remote_id).toBe('RID-9')
  })

  it('includes a fee comment when present', () => {
    const metadata = buildSourceMetadata(
      row({ 'Fee Comment': 'waived for campaign' }),
      META,
    )
    expect(metadata.fee_comment).toBe('waived for campaign')
  })
})

describe('transformBenevityRow', () => {
  it('transforms a donation with a corporate match', () => {
    const result = transformBenevityRow(row(), META, RUN_ID)
    expect(result.isOk()).toBe(true)

    const event = result._unsafeUnwrap()
    expect(event.source).toBe('benevity')
    expect(event.external_id).toBe('7H9J09CK37')
    expect(event.event_ts).toBe('2026-07-06T20:56:08.000Z')
    expect(event.created_at).toBe('2026-07-06T20:56:08.000Z')
    // Gross is the donor's gift plus the employer match: 25.00 + 25.00.
    expect(event.amount_cents).toBe(5000)
    expect(event.fee_cents).toBe(150)
    expect(event.net_amount_cents).toBe(4850)
    expect(event.currency).toBe('USD')
    expect(event.donor_name).toBe('James Duke')
    expect(event.payer_name).toBe('Google')
    expect(event.donor_email).toBe('jamesduke@example.com')
    expect(event.status).toBe('succeeded')
    expect(event.payment_method).toBe('Payroll')
    expect(event.description).toBe('Thank you')
    expect(event.attribution).toBe('Continued Support for Ukraine')
    expect(event.attribution_human).toBe('Continued Support for Ukraine')
    expect(event.run_id).toBe(RUN_ID)
  })

  it('handles a pure match row where the donor total is zero', () => {
    const result = transformBenevityRow(
      row({
        'Total Donation to be Acknowledged': '0.00',
        'Match Amount': '10,000.00',
        Reason: 'Match',
        'Cause Support Fee': '0.00',
        'Merchant Fee': '0.00',
      }),
      META,
      RUN_ID,
    )

    const event = result._unsafeUnwrap()
    expect(event.amount_cents).toBe(1000000)
    expect(event.net_amount_cents).toBe(1000000)
    expect(event.status).toBe('succeeded')
  })

  it('marks a reversal as refunded and keeps the sign', () => {
    const result = transformBenevityRow(
      row({
        'Total Donation to be Acknowledged': '-1,900.00',
        'Match Amount': '-1,900.00',
        'Cause Support Fee': '0.00',
        'Merchant Fee': '0.00',
      }),
      META,
      RUN_ID,
    )

    const event = result._unsafeUnwrap()
    expect(event.amount_cents).toBe(-380000)
    expect(event.net_amount_cents).toBe(-380000)
    expect(event.status).toBe('refunded')
  })

  it('nulls every withheld donor field', () => {
    const result = transformBenevityRow(
      row({
        'Donor First Name': 'Not shared by donor',
        'Donor Last Name': 'Not shared by donor',
        Email: 'Not shared by donor',
        Address: 'Not shared by donor',
        City: 'Not shared by donor',
        'State/Province': 'Not shared by donor',
        'Postal Code': 'Not shared by donor',
      }),
      META,
      RUN_ID,
    )

    const event = result._unsafeUnwrap()
    expect(event.donor_name).toBeNull()
    expect(event.donor_email).toBeNull()
    expect(event.donor_address).toBeNull()
    expect(event.donor_phone).toBeNull()
  })

  it('falls back to the report currency when the row has none', () => {
    // The legacy variant always carries Currency, but the report preamble is
    // the authority if a row ever arrives blank.
    const result = transformBenevityRow(
      row({ Currency: 'EUR' }),
      { ...META, currency: 'USD' },
      RUN_ID,
    )
    expect(result._unsafeUnwrap().currency).toBe('EUR')
  })

  it('leaves optional descriptive fields null when blank', () => {
    const result = transformBenevityRow(
      row({ Comment: '', Activity: '', Source: '', Company: '' }),
      META,
      RUN_ID,
    )
    const event = result._unsafeUnwrap()
    expect(event.description).toBeNull()
    expect(event.attribution).toBeNull()
    expect(event.attribution_human).toBeNull()
    expect(event.payment_method).toBeNull()
    expect(event.payer_name).toBeNull()
  })

  it('errors on an unparseable donation amount', () => {
    const result = transformBenevityRow(
      row({ 'Total Donation to be Acknowledged': 'n/a' }),
      META,
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toBe('Invalid amount: n/a')
  })

  it('errors on an unparseable match amount', () => {
    const result = transformBenevityRow(
      row({ 'Match Amount': 'n/a' }),
      META,
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
  })

  it('errors on an unparseable cause support fee', () => {
    const result = transformBenevityRow(
      row({ 'Cause Support Fee': 'n/a' }),
      META,
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
  })

  it('errors on an unparseable merchant fee', () => {
    const result = transformBenevityRow(
      row({ 'Merchant Fee': 'n/a' }),
      META,
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
  })

  it('errors on an invalid donation date', () => {
    const result = transformBenevityRow(
      row({ 'Donation Date': 'yesterday' }),
      META,
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'parse',
      field: 'Donation Date',
      message: 'Invalid donation date: yesterday',
    })
  })
})

describe('transformBenevityReport', () => {
  function report(overrides: Partial<BenevityReport> = {}): BenevityReport {
    return {
      filename: '1WAY529V7N.csv',
      meta: META,
      rows: [
        row({
          'Transaction ID': 'A1',
          'Total Donation to be Acknowledged': '25.00',
          'Match Amount': '25.00',
          'Cause Support Fee': '1.00',
          'Merchant Fee': '0.50',
        }),
        row({
          'Transaction ID': 'A2',
          'Total Donation to be Acknowledged': '10.00',
          'Match Amount': '0.00',
          'Cause Support Fee': '0.00',
          'Merchant Fee': '0.00',
        }),
      ],
      totals: { grossCents: 6000, paymentFeeCents: 0, netCents: 5850 },
      ...overrides,
    }
  }

  it('transforms every row when the trailer reconciles', () => {
    const result = transformBenevityReport(report(), RUN_ID)
    expect(result.isOk()).toBe(true)

    const events = result._unsafeUnwrap()
    expect(events).toHaveLength(2)
    expect(events.map((event: DonationEvent) => event.external_id)).toEqual([
      'A1',
      'A2',
    ])
  })

  it('rejects a report whose rows do not sum to the trailer gross', () => {
    const result = transformBenevityReport(
      report({
        totals: { grossCents: 9999, paymentFeeCents: 0, netCents: 5850 },
      }),
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'parse',
      field: 'Total Donations (Gross)',
      message:
        '1WAY529V7N.csv: donation rows sum to 6000 cents but the report trailer reports 9999 cents',
    })
  })

  it('rejects a net drift beyond the rounding allowance', () => {
    // Gross and rows agree, but the stated net implies a different fee total
    // by far more than per-row rounding could explain.
    const result = transformBenevityReport(
      report({
        totals: { grossCents: 6000, paymentFeeCents: 0, netCents: 4000 },
      }),
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'parse',
      field: 'Net Total Payment',
      message:
        '1WAY529V7N.csv: gross minus fees is 5850 cents but the report trailer reports a net of 4000 cents, a drift of 1850 cents beyond the 2 cent rounding allowance',
    })
  })

  it('tolerates a net drift within the rounding allowance', () => {
    // Benevity states "Rounding may be applied to some values in this report";
    // 28 of 569 real reports drift by a few cents. Two rows, one cent of drift.
    const result = transformBenevityReport(
      report({
        totals: { grossCents: 6000, paymentFeeCents: 0, netCents: 5849 },
      }),
      RUN_ID,
    )
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toHaveLength(2)
  })

  it('allows at least one cent of drift on a single-row report', () => {
    const single = report({
      rows: [
        row({
          'Transaction ID': 'A1',
          'Total Donation to be Acknowledged': '10.00',
          'Match Amount': '0.00',
          'Cause Support Fee': '0.00',
          'Merchant Fee': '0.00',
        }),
      ],
      totals: { grossCents: 1000, paymentFeeCents: 0, netCents: 999 },
    })
    expect(transformBenevityReport(single, RUN_ID).isOk()).toBe(true)
  })

  it('subtracts the disbursement-level payment fee from the net', () => {
    const result = transformBenevityReport(
      report({
        totals: { grossCents: 6000, paymentFeeCents: 250, netCents: 5600 },
      }),
      RUN_ID,
    )
    expect(result.isOk()).toBe(true)
  })

  it('propagates a row-level transform error', () => {
    const result = transformBenevityReport(
      report({
        rows: [row({ 'Total Donation to be Acknowledged': 'n/a' })],
        totals: { grossCents: 0, paymentFeeCents: 0, netCents: 0 },
      }),
      RUN_ID,
    )
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toBe('Invalid amount: n/a')
  })

  it('accepts an empty report', () => {
    const result = transformBenevityReport(
      report({
        rows: [],
        totals: { grossCents: 0, paymentFeeCents: 0, netCents: 0 },
      }),
      RUN_ID,
    )
    expect(result._unsafeUnwrap()).toEqual([])
  })
})
