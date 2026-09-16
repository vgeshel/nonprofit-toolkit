/**
 * Transform Benevity donation rows into canonical DonationEvents.
 *
 * Amount model, verified against the `Total Donations (Gross)` and
 * `Net Total Payment` trailers on every report:
 *
 *   amount = Total Donation to be Acknowledged + Match Amount
 *   fee    = Cause Support Fee + Merchant Fee
 *   net    = amount - fee
 *
 * `Match Amount` is additive rather than a component of the donor total: a pure
 * match row carries `Total = 0.00` with the whole figure under `Match Amount`.
 */
import type {
  DonationEvent,
  DonationStatus,
  DonorAddress,
} from '@donations-etl/types'
import { DateTime } from 'luxon'
import { err, ok, type Result } from 'neverthrow'
import pino from 'pino'
import {
  normalizeWithheld,
  parseMoneyToCents,
  type BenevityCsvRow,
  type BenevityParseError,
  type BenevityReport,
  type BenevityReportMeta,
} from './schema'

const logger = pino({ name: 'benevity-transformer' })

/**
 * Extract a usable email address, discarding withheld and malformed values.
 */
export function extractEmail(email: string): string | null {
  const normalized = normalizeWithheld(email)
  if (normalized === null) {
    return null
  }
  return normalized.includes('@') && normalized.includes('.')
    ? normalized
    : null
}

/**
 * Join the donor's name parts, tolerating either half being withheld.
 */
export function buildDonorName(
  firstName: string,
  lastName: string,
): string | null {
  const parts = [normalizeWithheld(firstName), normalizeWithheld(lastName)]
  const present = parts.filter((part): part is string => part !== null)
  return present.length > 0 ? present.join(' ') : null
}

/**
 * Build a donor address, returning null when the donor withheld all of it.
 *
 * Benevity reports carry no country column, so `country` is always null rather
 * than being guessed from the currency.
 */
export function buildDonorAddress(row: BenevityCsvRow): DonorAddress | null {
  const address: DonorAddress = {
    line1: normalizeWithheld(row.Address),
    line2: null,
    city: normalizeWithheld(row.City),
    state: normalizeWithheld(row['State/Province']),
    postal_code: normalizeWithheld(row['Postal Code']),
    country: null,
  }

  const hasAnyField =
    address.line1 !== null ||
    address.city !== null ||
    address.state !== null ||
    address.postal_code !== null

  return hasAnyField ? address : null
}

/**
 * Capture the Benevity-specific columns that have no home on DonationEvent.
 */
export function buildSourceMetadata(
  row: BenevityCsvRow,
  meta: BenevityReportMeta,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    disbursement_id: meta.disbursementId,
    disbursement_period_ending: meta.periodEnding,
    disbursement_payment_method: meta.paymentMethod,
    charity_id: meta.charityId,
    match_amount_cents: parseMoneyToCents(row['Match Amount']).unwrapOr(0),
    cause_support_fee_cents: parseMoneyToCents(
      row['Cause Support Fee'],
    ).unwrapOr(0),
    merchant_fee_cents: parseMoneyToCents(row['Merchant Fee']).unwrapOr(0),
  }

  const addIfPresent = (key: string, value: string) => {
    const normalized = normalizeWithheld(value)
    if (normalized !== null) {
      metadata[key] = normalized
    }
  }

  addIfPresent('company', row.Company)
  addIfPresent('project', row.Project)
  addIfPresent('project_remote_id', row['Project Remote ID'])
  addIfPresent('activity', row.Activity)
  addIfPresent('reason', row.Reason)
  addIfPresent('donation_source', row.Source)
  addIfPresent('donation_frequency', row['Donation Frequency'])
  addIfPresent('fee_comment', row['Fee Comment'])

  return metadata
}

/**
 * Reversals arrive as negative amounts; everything else in these reports has
 * already settled and been disbursed.
 */
function mapStatus(amountCents: number): DonationStatus {
  return amountCents < 0 ? 'refunded' : 'succeeded'
}

/**
 * Transform one donation row into a DonationEvent.
 */
export function transformBenevityRow(
  row: BenevityCsvRow,
  meta: BenevityReportMeta,
  runId: string,
): Result<DonationEvent, BenevityParseError> {
  const donationDate = DateTime.fromISO(row['Donation Date'], { zone: 'utc' })
  if (!donationDate.isValid) {
    return err({
      type: 'parse',
      field: 'Donation Date',
      message: `Invalid donation date: ${row['Donation Date']}`,
    })
  }
  const eventTs = donationDate.toUTC().toISO()

  const total = parseMoneyToCents(row['Total Donation to be Acknowledged'])
  if (total.isErr()) {
    return err(total.error)
  }
  const match = parseMoneyToCents(row['Match Amount'])
  if (match.isErr()) {
    return err(match.error)
  }
  const causeSupportFee = parseMoneyToCents(row['Cause Support Fee'])
  if (causeSupportFee.isErr()) {
    return err(causeSupportFee.error)
  }
  const merchantFee = parseMoneyToCents(row['Merchant Fee'])
  if (merchantFee.isErr()) {
    return err(merchantFee.error)
  }

  const amountCents = total.value + match.value
  const feeCents = causeSupportFee.value + merchantFee.value

  return ok({
    source: 'benevity',
    external_id: row['Transaction ID'],
    event_ts: eventTs,
    created_at: eventTs,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: amountCents - feeCents,
    currency: row.Currency,
    donor_name: buildDonorName(row['Donor First Name'], row['Donor Last Name']),
    // These are corporate giving programs: the employer remits the money.
    payer_name: normalizeWithheld(row.Company),
    donor_email: extractEmail(row.Email),
    // Benevity reports carry no phone column.
    donor_phone: null,
    donor_address: buildDonorAddress(row),
    status: mapStatus(amountCents),
    payment_method: normalizeWithheld(row.Source),
    description: normalizeWithheld(row.Comment),
    attribution: normalizeWithheld(row.Activity),
    attribution_human: normalizeWithheld(row.Activity),
    source_metadata: buildSourceMetadata(row, meta),
    run_id: runId,
  })
}

/**
 * Transform a whole report and reconcile it against its own trailer.
 *
 * Every report states its gross in a `Total Donations (Gross)` line. Checking
 * the transformed rows against it turns each run into an arithmetic proof that
 * no row was dropped and no amount was misread — a silent mismatch here is
 * exactly the class of bug that a row count alone would not catch.
 */
export function transformBenevityReport(
  report: BenevityReport,
  runId: string,
): Result<DonationEvent[], BenevityParseError> {
  const events: DonationEvent[] = []

  for (const row of report.rows) {
    const result = transformBenevityRow(row, report.meta, runId)
    if (result.isErr()) {
      return err(result.error)
    }
    events.push(result.value)
  }

  const summed = events.reduce((total, event) => total + event.amount_cents, 0)
  if (summed !== report.totals.grossCents) {
    return err({
      type: 'parse',
      field: 'Total Donations (Gross)',
      message: `${report.filename}: donation rows sum to ${String(
        summed,
      )} cents but the report trailer reports ${String(
        report.totals.grossCents,
      )} cents`,
    })
  }

  // The trailer states the net separately, so the fee side can be checked too:
  // gross - rowFees - paymentFee should land on the stated net.
  //
  // Unlike the gross, this one does not land exactly. Every report carries the
  // note "Rounding may be applied to some values in this report", and across
  // 569 real reports 28 were off by between -6 and +5 cents, with the drift
  // growing alongside the row count — accumulated per-row rounding, not a
  // misread. The allowance is therefore one cent per row, which still catches a
  // genuine fee misread by orders of magnitude. Any drift at all is logged, so
  // a slow change in Benevity's rounding stays visible rather than silent.
  const rowFees = events.reduce((total, event) => total + event.fee_cents, 0)
  const derivedNet =
    report.totals.grossCents - rowFees - report.totals.paymentFeeCents
  const netDrift = derivedNet - report.totals.netCents

  if (netDrift !== 0) {
    const allowance = Math.max(1, events.length)
    if (Math.abs(netDrift) > allowance) {
      return err({
        type: 'parse',
        field: 'Net Total Payment',
        message: `${report.filename}: gross minus fees is ${String(
          derivedNet,
        )} cents but the report trailer reports a net of ${String(
          report.totals.netCents,
        )} cents, a drift of ${String(
          netDrift,
        )} cents beyond the ${String(allowance)} cent rounding allowance`,
      })
    }

    logger.warn(
      {
        file: report.filename,
        disbursementId: report.meta.disbursementId,
        driftCents: netDrift,
        allowanceCents: allowance,
      },
      'Report net differs from gross minus fees within the rounding allowance',
    )
  }

  return ok(events)
}
