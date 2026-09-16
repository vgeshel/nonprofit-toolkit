/**
 * Zod schemas and parsing primitives for Benevity Donations Reports.
 *
 * Each report is one CSV per disbursement, laid out as three sections:
 *
 *   1. A preamble of `Key,Value` pairs (charity, period, currency, IDs),
 *      fenced by `#---` comment separators.
 *   2. The donation rows, introduced by a header row starting `Company,Project`.
 *   3. A trailer carrying `Totals`, `Total Donations (Gross)`, a payment fee and
 *      `Net Total Payment`.
 *
 * Two header variants exist in the wild: current reports carry 23 columns, while
 * the oldest ones omit `Cause Support Fee` and `Merchant Fee`. Columns are
 * therefore always addressed by name, never by position.
 */
import { dollarsToCents } from '@donations-etl/types'
import { err, ok, type Result } from 'neverthrow'
import { z } from 'zod'

/**
 * Benevity writes this literal string into donor fields the donor chose not to
 * share. It appears in `Email`, `Address`, `City`, `State/Province`,
 * `Postal Code` and both name fields, and must become `null` rather than being
 * carried through as a value — `DonationEvent.donor_email` is a validated
 * email address and would reject it.
 */
export const NOT_SHARED_SENTINEL = 'Not shared by donor'

/**
 * Keys carried in the report preamble.
 */
export const REPORT_META_LABELS = [
  'Charity Name',
  'Charity ID',
  'Period Ending',
  'Currency',
  'Payment Method',
  'Disbursement ID',
] as const

/**
 * Labels that introduce a trailer line rather than a donation.
 */
const TRAILER_LABELS = new Set([
  'Totals',
  'Total Donations (Gross)',
  'Check Fee',
  'EFT Fee',
  'Wire Fee',
  'Net Total Payment',
])

/**
 * Error returned when a report cannot be parsed.
 */
export interface BenevityParseError {
  type: 'parse'
  field: string
  message: string
}

/**
 * Only digits, an optional sign and an optional decimal part, once thousands
 * separators have been removed. Guards against `parseFloat` silently accepting
 * a numeric prefix such as `12abc`.
 */
const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/

/**
 * Parse a Benevity money string into integer cents.
 *
 * Amounts are plain decimals, but larger ones carry thousands separators inside
 * a quoted field (`"10,000.00"`). Reversals are written as negative amounts and
 * are preserved as such: the report trailer counts them negatively, so dropping
 * the sign would break reconciliation.
 */
export function parseMoneyToCents(
  value: string,
): Result<number, BenevityParseError> {
  const trimmed = value.trim()
  if (trimmed === '') {
    return ok(0)
  }

  const cleaned = trimmed.replace(/,/g, '')
  if (!NUMERIC_PATTERN.test(cleaned)) {
    return err({
      type: 'parse',
      field: 'amount',
      message: `Invalid amount: ${value}`,
    })
  }

  return ok(dollarsToCents(Number(cleaned)))
}

/**
 * Normalise a donor field, collapsing withheld and empty values to `null`.
 */
export function normalizeWithheld(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '' || trimmed === NOT_SHARED_SENTINEL) {
    return null
  }
  return trimmed
}

/**
 * Whether a first cell introduces a trailer line or a comment separator.
 */
export function isTrailerLabel(label: string): boolean {
  return TRAILER_LABELS.has(label) || label.startsWith('#---')
}

/**
 * Whether a raw CSV row is the donation header row.
 */
export function isDonationHeaderRow(row: readonly string[]): boolean {
  return row[0] === 'Company' && row[1] === 'Project'
}

/**
 * A donation row, addressed by column name.
 *
 * Descriptive columns default to an empty string so the legacy 21-column
 * variant parses without special-casing, and the two fee columns it lacks
 * default to `"0"` so fee arithmetic stays total.
 */
export const BenevityCsvRowSchema = z.object({
  // Identity and amounts — required for a row to be usable.
  'Transaction ID': z.string().min(1, 'Transaction ID is required'),
  'Donation Date': z.string().min(1, 'Donation Date is required'),
  Currency: z.string().length(3, 'Currency must be a 3-letter ISO code'),
  'Total Donation to be Acknowledged': z.string(),
  'Match Amount': z.string(),

  // Fees — absent from the legacy header variant.
  'Cause Support Fee': z.string().default('0'),
  'Merchant Fee': z.string().default('0'),
  'Fee Comment': z.string().default(''),

  // Descriptive columns.
  Company: z.string().default(''),
  Project: z.string().default(''),
  'Donor First Name': z.string().default(''),
  'Donor Last Name': z.string().default(''),
  Email: z.string().default(''),
  Address: z.string().default(''),
  City: z.string().default(''),
  'State/Province': z.string().default(''),
  'Postal Code': z.string().default(''),
  Activity: z.string().default(''),
  Comment: z.string().default(''),
  'Donation Frequency': z.string().default(''),
  'Project Remote ID': z.string().default(''),
  Source: z.string().default(''),
  Reason: z.string().default(''),
})

export type BenevityCsvRow = z.infer<typeof BenevityCsvRowSchema>

/**
 * The report preamble, after the `Key,Value` pairs have been collected.
 */
export const BenevityReportMetaSchema = z.object({
  charityName: z.string().min(1, 'Charity Name is required'),
  charityId: z.string().min(1, 'Charity ID is required'),
  periodEnding: z.string().min(1, 'Period Ending is required'),
  currency: z.string().min(1, 'Currency is required'),
  paymentMethod: z.string().min(1, 'Payment Method is required'),
  disbursementId: z.string().min(1, 'Disbursement ID is required'),
})

export type BenevityReportMeta = z.infer<typeof BenevityReportMetaSchema>

/**
 * The report trailer.
 *
 * `grossCents` is the figure every transformed row must sum back to.
 * `paymentFeeCents` is the disbursement-level fee, written on a `Check Fee`
 * line in every report observed so far regardless of payment method, and is
 * distinct from the per-row cause-support and merchant fees.
 * `netCents` is what actually reached the bank:
 *
 *   net = gross - (sum of per-row fees) - paymentFee
 */
export interface BenevityReportTotals {
  grossCents: number
  paymentFeeCents: number
  netCents: number
}

/**
 * One parsed report: preamble, donation rows and trailer.
 */
export interface BenevityReport {
  filename: string
  meta: BenevityReportMeta
  rows: BenevityCsvRow[]
  totals: BenevityReportTotals
}
