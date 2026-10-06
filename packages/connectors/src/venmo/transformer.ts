/**
 * Transform Venmo CSV rows to canonical DonationEvent.
 */
import type { DonationEvent, DonationStatus } from '@donations-etl/types'
import { dollarsToCents } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { err, ok, type Result } from 'neverthrow'
import pino from 'pino'
import { stripTransactionIdQuotes, type VenmoCsvRow } from './schema'

const logger = pino({ name: 'venmo-transformer' })

/**
 * Error type for transformation failures.
 */
export interface TransformError {
  type: 'parse'
  field: string
  message: string
}

/**
 * Map Venmo status to canonical status.
 */
export function mapVenmoStatus(status: string): DonationStatus {
  const normalized = status.toLowerCase().trim()
  switch (normalized) {
    case 'complete':
    case 'completed':
      return 'succeeded'
    case 'pending':
    case 'issued':
      return 'pending'
    case 'failed':
    case 'declined':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'refunded':
      return 'refunded'
    default:
      return 'succeeded'
  }
}

/**
 * Parse Venmo date and time to ISO 8601 UTC datetime.
 *
 * Venmo exports dates as:
 * - Date: MM/DD/YYYY
 * - Time (UTC): HH:MM:SS
 */
export function parseVenmoDateTimeToISO(
  date: string,
  time: string,
): Result<string, TransformError> {
  // Combine date and time
  const dateTimeStr = `${date} ${time}`

  // Parse as UTC (the time is already in UTC per the column name)
  const dt = DateTime.fromFormat(dateTimeStr, 'MM/dd/yyyy HH:mm:ss', {
    zone: 'UTC',
  })

  if (!dt.isValid) {
    return err({
      type: 'parse',
      field: 'Date/Time',
      message: `Invalid date/time: ${date} ${time}`,
    })
  }

  return ok(dt.toISO())
}

/**
 * Parse a Venmo amount string to cents.
 *
 * Venmo amounts are formatted as:
 * - "+ $1,000.00" for incoming
 * - "- $500.00" for outgoing
 * - "$19.10" for fees (no sign)
 * - "0" for zero values
 *
 * @param amount String amount from Venmo CSV
 * @returns Amount in cents (always positive) or error
 */
export function parseVenmoAmountToCents(
  amount: string,
): Result<number, TransformError> {
  // Handle "0" or empty
  const trimmed = amount.trim()
  if (trimmed === '0' || trimmed === '') {
    return ok(0)
  }

  // Remove +/- sign, $, commas, and spaces
  const cleaned = trimmed.replace(/[+\-$,\s]/g, '')
  const dollars = parseFloat(cleaned)

  if (isNaN(dollars)) {
    return err({
      type: 'parse',
      field: 'Amount',
      message: `Invalid amount: ${amount}`,
    })
  }

  return ok(dollarsToCents(dollars))
}

/**
 * Extract email, returning null if invalid or "(None)".
 */
export function extractEmail(email: string): string | null {
  const trimmed = email.trim()
  if (!trimmed || trimmed === '(None)') return null

  // Basic email validation
  if (trimmed.includes('@') && trimmed.includes('.')) {
    return trimmed
  }
  return null
}

/**
 * Build source metadata from remaining CSV fields.
 */
export function buildSourceMetadata(row: VenmoCsvRow): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  // Only include non-empty, non-(None) values
  const addIfPresent = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== '(None)' && trimmed !== '0') {
      result[key] = trimmed
    }
  }

  addIfPresent('to', row.To)
  addIfPresent('amountTip', row['Amount (tip)'])
  addIfPresent('amountTax', row['Amount (tax)'])
  addIfPresent('taxRate', row['Tax Rate'])
  addIfPresent('taxExempt', row['Tax Exempt'])
  addIfPresent('fundingSource', row['Funding Source'])
  addIfPresent('destination', row.Destination)
  addIfPresent('terminalLocation', row['Terminal Location'])

  return result
}

/**
 * Transform a single Venmo CSV row to a DonationEvent.
 */
export function transformVenmoRow(
  row: VenmoCsvRow,
  runId: string,
): Result<DonationEvent, TransformError> {
  // Parse date and time
  const eventTsResult = parseVenmoDateTimeToISO(row.Date, row['Time (UTC)'])
  if (eventTsResult.isErr()) {
    return err(eventTsResult.error)
  }
  const eventTs = eventTsResult.value

  // Parse amounts
  const amountCentsResult = parseVenmoAmountToCents(row['Amount (total)'])
  if (amountCentsResult.isErr()) {
    return err(amountCentsResult.error)
  }
  const amountCents = amountCentsResult.value

  const feeCentsResult = parseVenmoAmountToCents(row['Amount (fee)'])
  if (feeCentsResult.isErr()) {
    return err(feeCentsResult.error)
  }
  const feeCents = feeCentsResult.value

  // Net amount: try to parse it, or calculate from total - fee
  let netAmountCents: number
  const netResult = parseVenmoAmountToCents(row['Amount (net)'])
  if (netResult.isOk() && netResult.value > 0) {
    netAmountCents = netResult.value
  } else {
    netAmountCents = amountCents - feeCents
  }

  // Extract transaction ID (strip triple quotes)
  const externalId = stripTransactionIdQuotes(row['Transaction ID'])

  // Donor name from "From" field
  const donorName = row.From.trim() || null

  return ok({
    source: 'venmo',
    external_id: externalId,
    event_ts: eventTs,
    created_at: eventTs,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: netAmountCents,
    currency: 'USD',
    donor_name: donorName,
    payer_name: null, // Venmo donations are always direct
    donor_email: extractEmail(row['Donor email']),
    donor_phone: null, // Venmo doesn't provide phone
    donor_address: null, // Venmo doesn't provide address
    status: mapVenmoStatus(row.Status),
    payment_method: 'venmo',
    description: row.Note.trim() || null,
    attribution: null,
    attribution_human: null,
    is_recurring: null, // No recurrence signal in this source
    source_metadata: buildSourceMetadata(row),
    run_id: runId,
  })
}

/**
 * Transform multiple Venmo CSV rows to DonationEvents.
 * Skips rows that fail to transform and logs warnings.
 */
export function transformVenmoRows(
  rows: VenmoCsvRow[],
  runId: string,
): DonationEvent[] {
  const events: DonationEvent[] = []
  let skipped = 0

  for (const row of rows) {
    const result = transformVenmoRow(row, runId)
    if (result.isOk()) {
      events.push(result.value)
    } else {
      skipped++
      logger.warn(
        { id: row['Transaction ID'], error: result.error },
        'Skipping row due to transform error',
      )
    }
  }

  if (skipped > 0) {
    logger.info({ transformed: events.length, skipped }, 'Transform completed')
  }

  return events
}
