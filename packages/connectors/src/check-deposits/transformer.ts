/**
 * Transform check deposit rows to DonationEvent format.
 *
 * Pure functions for parsing and transforming spreadsheet data.
 */
import type { DonationEvent, DonorAddress } from '@donations-etl/types'
import { DateTime } from 'luxon'

import type { CheckDepositRow } from './schema'

/**
 * Parse amount string like "$2,000" or "$500" to cents.
 */
export function parseAmountToCents(amountStr: string): number {
  // Remove $ and commas, parse as float, convert to cents
  const cleaned = amountStr.replace(/[$,]/g, '').trim()
  const dollars = parseFloat(cleaned)
  if (isNaN(dollars)) {
    return 0
  }
  return Math.round(dollars * 100)
}

/**
 * Parse date string like "9/18/2023", "11/5/2023", or "2023-09-18" to ISO datetime.
 *
 * Supports M/D/YYYY, MM/DD/YYYY, and YYYY-MM-DD formats.
 */
export function parseDateToISO(dateStr: string): string {
  const trimmed = dateStr.trim()

  // Try M/D/YYYY format (most common in the spreadsheet)
  const dt = DateTime.fromFormat(trimmed, 'M/d/yyyy', { zone: 'utc' })
  if (dt.isValid) {
    return dt.toISO()
  }

  // Try YYYY-MM-DD format (ISO date, used by some deposit date entries)
  const dt2 = DateTime.fromFormat(trimmed, 'yyyy-MM-dd', { zone: 'utc' })
  if (dt2.isValid) {
    return dt2.toISO()
  }

  /* istanbul ignore next -- @preserve defensive fallback for edge case date formats */
  // Fallback: try MM/DD/YYYY format
  const dt3 = DateTime.fromFormat(trimmed, 'MM/dd/yyyy', { zone: 'utc' })
  /* istanbul ignore next -- @preserve */
  if (dt3.isValid) {
    return dt3.toISO()
  }

  // Last resort: return current time if parsing fails
  return DateTime.utc().toISO()
}

/**
 * Parse free-form address string into structured address.
 *
 * Example input: "200 Myrtle Ave, Mill Valley CA 94941-1040"
 *
 * For now, puts the whole address in line1. Could be enhanced
 * with address parsing library later if needed.
 */
export function parseAddress(addressStr: string): DonorAddress | null {
  const trimmed = addressStr.trim()
  if (!trimmed) {
    return null
  }

  return {
    line1: trimmed,
    line2: null,
    city: null,
    state: null,
    postal_code: null,
    country: 'US', // Assume US for checks
  }
}

/**
 * Generate a unique external ID for a check deposit.
 *
 * Uses payer_name + check_number as the unique key, hashed to create
 * a stable ID across ETL runs. This is critical for MERGE deduplication.
 */
export function generateExternalId(row: CheckDepositRow): string {
  // Unique key: payer_name + check_number
  const key = `${row.payer_name}|${row.check_number}`

  // Simple djb2 hash for deterministic ID generation
  let hash = 5381
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33) ^ key.charCodeAt(i)
  }

  return `check_${(hash >>> 0).toString(16)}`
}

/**
 * Transform a single check deposit row to DonationEvent.
 */
export function transformCheckDepositRow(
  row: CheckDepositRow,
  runId: string,
): DonationEvent {
  const amountCents = parseAmountToCents(row.amount)
  const depositDateIso = parseDateToISO(row.deposit_date)
  const checkDateIso = parseDateToISO(row.check_date)

  // Parse donor_email - validate it's a proper email or set to null
  let donorEmail: string | null = null
  if (row.donor_email.trim()) {
    // Basic email validation - contains @ and has text before/after
    const email = row.donor_email.trim()
    if (
      email.includes('@') &&
      email.indexOf('@') > 0 &&
      email.indexOf('@') < email.length - 1
    ) {
      donorEmail = email
    }
  }

  return {
    source: 'check_deposits',
    external_id: generateExternalId(row),
    event_ts: depositDateIso, // Use deposit_date as event_ts
    created_at: checkDateIso, // Use check_date as created_at
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: 0, // No fees for checks
    net_amount_cents: amountCents,
    currency: 'USD',
    donor_name: row.donor_name || null,
    payer_name: row.payer_name || null,
    donor_email: donorEmail,
    donor_phone: null,
    donor_address: parseAddress(row.donor_address),
    status: 'succeeded', // All deposited checks are succeeded
    payment_method: 'check',
    description: null,
    attribution: null,
    attribution_human: null,
    is_recurring: null, // No recurrence signal in this source
    source_metadata: {
      check_number: row.check_number,
      check_date: row.check_date,
      bank_contact_info: row.bank_contact_info,
      file_name: row.file_name || null,
    },
    run_id: runId,
  }
}

/**
 * Transform multiple check deposit rows.
 */
export function transformCheckDepositRows(
  rows: CheckDepositRow[],
  runId: string,
): DonationEvent[] {
  return rows.map((row) => transformCheckDepositRow(row, runId))
}
