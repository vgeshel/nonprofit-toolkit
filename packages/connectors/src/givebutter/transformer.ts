/**
 * Givebutter transaction to DonationEvent transformer.
 *
 * Converts Givebutter API responses to canonical DonationEvent format.
 */
import type {
  DonationEvent,
  DonationStatus,
  DonorAddress,
} from '@donations-etl/types'
import { DateTime } from 'luxon'
import type {
  GivebutterTransaction,
  GivebutterTransactionStatus,
} from './schema'

/**
 * Map Givebutter transaction status to canonical donation status.
 * Unknown statuses are mapped to 'pending' since we don't know their final state.
 */
export function mapGivebutterStatus(
  status: GivebutterTransactionStatus,
): DonationStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'authorized':
      return 'pending'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'failed' // Treat cancelled as failed
    default:
      // Unknown status - treat as pending since we don't know the final state
      return 'pending'
  }
}

/**
 * Map Givebutter payment method to canonical payment method.
 */
export function mapGivebutterPaymentMethod(method: string): string {
  const normalizedMethod = method.toLowerCase()

  switch (normalizedMethod) {
    case 'card':
      return 'credit_card'
    case 'ach':
      return 'bank_transfer'
    case 'paypal':
      return 'paypal'
    case 'venmo':
      return 'venmo'
    case 'check':
      return 'check'
    case 'cash':
      return 'cash'
    default:
      return 'other'
  }
}

/**
 * Convert dollar amount to cents.
 * Givebutter amounts are in dollars (e.g., 10.50).
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

/**
 * Build donor full name from first and last name.
 */
export function buildDonorName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  const parts = [firstName, lastName].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Extract donor address from Givebutter address object.
 */
export function extractDonorAddress(
  address: GivebutterTransaction['address'],
): DonorAddress | null {
  if (!address) return null

  // Check if address has any actual data
  const hasData =
    address.address_1 ??
    address.city ??
    address.state ??
    address.zipcode ??
    address.country

  if (!hasData) return null

  return {
    line1: address.address_1,
    line2: address.address_2,
    city: address.city,
    state: address.state,
    postal_code: address.zipcode,
    country: address.country,
  }
}

/**
 * Transform a single Givebutter transaction to a DonationEvent.
 */
export function transformGivebutterTransaction(
  tx: GivebutterTransaction,
  runId: string,
): DonationEvent {
  const amountCents = dollarsToCents(tx.amount)
  const feeCents = dollarsToCents(tx.fee)

  // Calculate net amount - if fee is covered by donor, net = amount
  // Otherwise, net = amount - fee (payout value)
  const netAmountCents = tx.fee_covered
    ? amountCents
    : dollarsToCents(tx.payout)

  return {
    source: 'givebutter',
    external_id: tx.id.toString(),
    event_ts: tx.transacted_at,
    created_at: tx.created_at,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: netAmountCents,
    currency: tx.currency.toUpperCase(),
    donor_name: buildDonorName(tx.first_name, tx.last_name),
    payer_name: null, // Givebutter doesn't track payer separately from donor
    donor_email: tx.email,
    donor_phone: tx.phone,
    donor_address: extractDonorAddress(tx.address),
    status: mapGivebutterStatus(tx.status),
    payment_method: mapGivebutterPaymentMethod(tx.method),
    description: tx.campaign_code ?? null,
    // Attribution: campaign_code is the campaign identifier
    attribution: tx.campaign_code ?? null,
    // Attribution human: campaign_code is also the human-readable campaign name
    attribution_human: tx.campaign_code ?? null,
    is_recurring: tx.is_recurring,
    run_id: runId,
    source_metadata: {
      number: tx.number,
      campaign_id: tx.campaign_id,
      campaign_code: tx.campaign_code,
      method: tx.method,
      fee_covered: tx.fee_covered,
      donated: tx.donated,
      payout: tx.payout,
      is_recurring: tx.is_recurring,
      plan_id: tx.plan_id,
    },
  }
}

/**
 * Transform multiple Givebutter transactions to DonationEvents.
 *
 * By default, only includes succeeded transactions (actual donations).
 * Set includeAll=true to include all statuses.
 */
export function transformGivebutterTransactions(
  transactions: GivebutterTransaction[],
  runId: string,
  includeAll = false,
): DonationEvent[] {
  const filtered = includeAll
    ? transactions
    : transactions.filter((tx) => tx.status === 'succeeded')

  return filtered.map((tx) => transformGivebutterTransaction(tx, runId))
}
