/**
 * Transform Funraise CSV rows to canonical DonationEvent.
 */
import type {
  DonationEvent,
  DonationStatus,
  DonorAddress,
} from '@donations-etl/types'
import { dollarsToCents } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { err, ok, type Result } from 'neverthrow'
import pino from 'pino'
import type { FunraiseCsvRow } from './schema'

const logger = pino({ name: 'funraise-transformer' })

/**
 * Error type for transformation failures.
 */
export interface TransformError {
  type: 'parse'
  field: string
  message: string
}

/**
 * Map Funraise status to canonical status.
 */
export function mapFunraiseStatus(status: string): DonationStatus {
  const normalized = status.toLowerCase().trim()
  switch (normalized) {
    case 'complete':
    case 'completed':
    case 'succeeded':
      return 'succeeded'
    case 'pending':
      return 'pending'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'refunded':
      return 'refunded'
    default:
      // Unknown status - treat as succeeded for "Complete" which is the default
      return 'succeeded'
  }
}

/**
 * Parse Funraise date string to ISO 8601 UTC datetime.
 *
 * Funraise exports dates in ISO format with timezone, e.g.:
 * "2026-01-24T00:05:47.440049-08:00[US/Pacific]"
 *
 * We need to parse this and convert to UTC ISO string.
 */
export function parseFunraiseDateToISO(
  dateStr: string,
): Result<string, TransformError> {
  // Remove the bracketed timezone identifier (e.g., "[US/Pacific]")
  // because luxon handles the offset already
  const cleaned = dateStr.replace(/\[.+\]$/, '')

  const dt = DateTime.fromISO(cleaned)
  if (!dt.isValid) {
    return err({
      type: 'parse',
      field: 'Transaction Date',
      message: `Invalid date: ${dateStr}`,
    })
  }

  return ok(dt.toUTC().toISO())
}

/**
 * Parse a dollar amount string to cents.
 *
 * @param amount String amount in dollars, e.g., "107.70" or "1,234.56"
 * @returns Amount in cents or error
 */
export function parseAmountToCents(
  amount: string,
): Result<number, TransformError> {
  // Remove commas and any currency symbols
  const cleaned = amount.replace(/[,$]/g, '').trim()
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
 * Format donor name from first and last name fields.
 */
export function formatDonorName(firstName: string, lastName: string): string {
  const first = firstName.trim()
  const last = lastName.trim()

  if (first && last) {
    return `${first} ${last}`
  }
  return first || last || ''
}

/**
 * Extract donor address from Funraise CSV row.
 */
export function extractDonorAddress(row: FunraiseCsvRow): DonorAddress | null {
  // Zod schema guarantees these fields are always strings (possibly empty)
  const address = row.Address.trim()
  const city = row.City.trim()
  const state = row['State/Province'].trim()
  const postalCode = row['Postal Code'].trim()
  const country = row.Country.trim()

  // Return null if all address fields are empty
  if (!address && !city && !state && !postalCode && !country) {
    return null
  }

  // Country should be 2-letter ISO code, but Funraise might export full names
  // We'll store whatever they provide, normalization can happen later
  let countryCode: string | null = null
  if (country) {
    // Common mappings for full country names to ISO codes
    const countryMap: Record<string, string> = {
      'united states': 'US',
      usa: 'US',
      'united states of america': 'US',
      canada: 'CA',
      'united kingdom': 'GB',
      uk: 'GB',
      norway: 'NO',
      sweden: 'SE',
      poland: 'PL',
    }
    const mapped = countryMap[country.toLowerCase()]
    countryCode =
      mapped ?? (country.length === 2 ? country.toUpperCase() : null)
  }

  return {
    line1: address || null,
    line2: null, // Funraise doesn't have a separate line2 field
    city: city || null,
    state: state || null,
    postal_code: postalCode || null,
    country: countryCode,
  }
}

/**
 * Extract email, returning null if invalid format.
 */
export function extractEmail(email: string): string | null {
  const trimmed = email.trim()
  if (!trimmed) return null

  // Basic email validation
  if (trimmed.includes('@') && trimmed.includes('.')) {
    return trimmed
  }
  return null
}

/**
 * Extract phone, normalizing empty strings to null.
 */
export function extractPhone(phone: string): string | null {
  const trimmed = phone.trim()
  return trimmed || null
}

/**
 * Map Funraise's `Recurring` column to is_recurring. A blank value (the column
 * is missing from the export) says nothing, so it stays null.
 */
export function mapFunraiseRecurring(recurring: string): boolean | null {
  switch (recurring) {
    case 'true':
      return true
    case 'false':
      return false
    default:
      return null
  }
}

/**
 * Build source metadata from remaining CSV fields.
 */
export function buildSourceMetadata(
  row: FunraiseCsvRow,
): Record<string, unknown> {
  return {
    supporterId: row['Supporter Id'] || undefined,
    institutionName: row['Institution Name'] || undefined,
    institutionCategory: row['Institution Category'] || undefined,
    formId: row['Form Id'] || undefined,
    campaignGoalId: row['Campaign Goal Id'] || undefined,
    campaignPageUrl: row['Campaign Page URL'] || undefined,
    campaignPageId: row['Campaign Page Id'] || undefined,
    operationsTipAmount: row['Operations Tip Amount'] || undefined,
    match: row.Match === 'true',
    dedication: row.Dedication === 'true',
    dedicationEmail: row['Dedication Email'] || undefined,
    dedicationName: row['Dedication Name'] || undefined,
    dedicationType: row['Dedication Type'] || undefined,
    dedicationMessage: row['Dedication Message'] || undefined,
    anonymous: row.Anonymous === 'true',
    cardType: row['Card Type'] || undefined,
    expirationDate: row['Expiration Date'] || undefined,
    recurring: row.Recurring === 'true',
    recurringId: row['Recurring Id'] || undefined,
    sequence: row.Sequence || undefined,
    frequency: row.Frequency || undefined,
    offline: row.Offline === 'true',
    lastFour: row['Last Four'] || undefined,
    gatewayResponse: row['Gateway Response'] || undefined,
    gatewayTransactionId: row['Gateway Transaction Id'] || undefined,
    importExternalId: row['Import External Id'] || undefined,
    checkNumber: row['Check Number'] || undefined,
    memo: row.Memo || undefined,
    tags: row.Tags || undefined,
    utmMedium: row['UTM Medium'] || undefined,
    utmContent: row['UTM Content'] || undefined,
    utmTerm: row['UTM Term'] || undefined,
    utmCampaign: row['UTM Campaign'] || undefined,
    allocations: row.Allocations || undefined,
    sourceAmount: row['Source Amount'] || undefined,
    url: row.URL || undefined,
    householdId: row['Household Id'] || undefined,
    householdName: row['Household Name'] || undefined,
    platformFeePercent: row['Platform Fee Percent'] || undefined,
    taxDeductibleAmount: row['Tax Deductible Amount'] || undefined,
  }
}

/**
 * Transform a single Funraise CSV row to a DonationEvent.
 */
export function transformFunraiseRow(
  row: FunraiseCsvRow,
  runId: string,
): Result<DonationEvent, TransformError> {
  const eventTsResult = parseFunraiseDateToISO(row['Transaction Date'])
  if (eventTsResult.isErr()) {
    return err(eventTsResult.error)
  }
  const eventTs = eventTsResult.value

  const amountCentsResult = parseAmountToCents(row.Amount)
  if (amountCentsResult.isErr()) {
    return err(amountCentsResult.error)
  }
  const amountCents = amountCentsResult.value

  const feeCentsResult = row['Platform Fee Amount']
    ? parseAmountToCents(row['Platform Fee Amount'])
    : ok(0)
  if (feeCentsResult.isErr()) {
    return err(feeCentsResult.error)
  }
  const feeCents = feeCentsResult.value

  const donorName = formatDonorName(row['First Name'], row['Last Name'])

  // Use Institution Name as payer_name if it's a different entity
  const payerName = row['Institution Name']?.trim() || null

  return ok({
    source: 'funraise',
    external_id: row.Id,
    event_ts: eventTs,
    created_at: eventTs,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: amountCents - feeCents,
    currency: row.Currency?.toUpperCase() || 'USD',
    donor_name: donorName || null,
    payer_name: payerName,
    donor_email: extractEmail(row.Email),
    donor_phone: extractPhone(row.Phone),
    donor_address: extractDonorAddress(row),
    status: mapFunraiseStatus(row.Status),
    payment_method: row['Payment Method'] || null,
    description: row.Comment?.trim() || row.Note?.trim() || null,
    attribution: row['UTM Source']?.trim() || null,
    attribution_human: row.Form?.trim() || null,
    is_recurring: mapFunraiseRecurring(row.Recurring),
    source_metadata: buildSourceMetadata(row),
    run_id: runId,
  })
}

/**
 * Transform multiple Funraise CSV rows to DonationEvents.
 * Skips rows that fail to transform and logs warnings.
 */
export function transformFunraiseRows(
  rows: FunraiseCsvRow[],
  runId: string,
): DonationEvent[] {
  const events: DonationEvent[] = []
  let skipped = 0

  for (const row of rows) {
    const result = transformFunraiseRow(row, runId)
    if (result.isOk()) {
      events.push(result.value)
    } else {
      skipped++
      logger.warn(
        { id: row.Id, error: result.error },
        'Skipping row due to transform error',
      )
    }
  }

  if (skipped > 0) {
    logger.info({ transformed: events.length, skipped }, 'Transform completed')
  }

  return events
}
