/**
 * Transform Mercury API transactions to canonical DonationEvent.
 */
import type {
  DonationEvent,
  DonationStatus,
  DonorAddress,
} from '@donations-etl/types'
import { dollarsToCents } from '@donations-etl/types'
import { DateTime } from 'luxon'
import pino from 'pino'
import type { MercuryTransaction } from './schema'

const logger = pino({ name: 'mercury-transformer' })

/**
 * Map Mercury transaction status to canonical status.
 */
export function mapMercuryStatus(
  status: MercuryTransaction['status'],
): DonationStatus {
  switch (status) {
    case 'sent':
    case 'completed': // Mercury may use 'completed' for finished transactions
      return 'succeeded'
    case 'pending':
      return 'pending'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      // Unknown status - log for visibility, treat as succeeded if not explicitly failed
      logger.warn({ status }, 'Unknown Mercury status, treating as succeeded')
      return 'succeeded'
  }
}

/**
 * Map Mercury transaction kind to payment method.
 */
export function mapMercuryKind(kind: string): string {
  const kindLower = kind.toLowerCase()
  if (kindLower.includes('wire')) return 'wire'
  if (kindLower.includes('ach') || kindLower === 'externaltransfer')
    return 'ach'
  if (kindLower.includes('check')) return 'check'
  if (kindLower.includes('internal')) return 'internal'
  return kind
}

/**
 * Extract donor address from Mercury transaction details.
 */
export function extractDonorAddress(
  details: MercuryTransaction['details'],
): DonorAddress | null {
  if (!details) return null

  // Try to extract address from various routing info locations
  const address =
    details.address ?? details.domesticWireRoutingInfo?.address ?? null

  if (!address) return null

  /* istanbul ignore next -- @preserve optional address fields have simple nullish defaults */
  return {
    line1: address.address1 ?? null,
    line2: address.address2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postal_code: address.postalCode ?? null,
    country: null, // Mercury doesn't provide country in address
  }
}

/**
 * Transform a single Mercury transaction to a DonationEvent.
 *
 * Note: Mercury transactions represent bank transfers, not direct donations.
 * We treat positive amounts (credits) as incoming donations.
 * The counterparty name is used as the donor name.
 */
export function transformMercuryTransaction(
  tx: MercuryTransaction,
  runId: string,
  accountName?: string,
): DonationEvent {
  // Mercury amounts are in dollars (negative for debits, positive for credits)
  // We take absolute value and convert to cents
  const amountCents = dollarsToCents(Math.abs(tx.amount))

  return {
    source: 'mercury',
    external_id: tx.id,
    event_ts: tx.createdAt,
    created_at: tx.createdAt,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: 0, // Mercury doesn't report fees on transactions
    net_amount_cents: amountCents,
    currency: 'USD', // Mercury is US-only
    donor_name: tx.counterpartyName,
    payer_name: null, // Mercury doesn't track payer separately from donor
    donor_email: null, // Mercury doesn't provide email
    donor_phone: null, // Mercury doesn't provide phone
    donor_address: extractDonorAddress(tx.details),
    status: mapMercuryStatus(tx.status),
    payment_method: mapMercuryKind(tx.kind),
    description: tx.bankDescription ?? tx.note ?? tx.externalMemo ?? null,
    attribution: null, // Mercury doesn't have campaign/attribution info
    attribution_human: null,
    is_recurring: null, // No recurrence signal in this source
    source_metadata: {
      accountName, // For filtering during staging-to-final load
      counterpartyId: tx.counterpartyId,
      counterpartyNickname: tx.counterpartyNickname,
      kind: tx.kind,
      trackingNumber: tx.trackingNumber,
      dashboardLink: tx.dashboardLink,
      details: tx.details,
      isCredit: tx.amount > 0,
    },
    run_id: runId,
  }
}

/**
 * Check if a transaction is an internal transfer between Mercury accounts.
 */
export function isInternalTransfer(tx: MercuryTransaction): boolean {
  return tx.kind.toLowerCase() === 'internaltransfer'
}

/**
 * Transform multiple Mercury transactions to DonationEvents.
 * Loads all transactions to staging; filtering (account name, internal transfers)
 * is applied during the staging-to-final table transformation.
 *
 * @param transactions Mercury transactions to transform
 * @param runId UUID for the ETL run
 * @param includeDebits Whether to include debit transactions (default: false)
 * @param includeInternalTransfers Whether to include internal transfers (default: false)
 * @param accountName Name of the account these transactions belong to
 */
export function transformMercuryTransactions(
  transactions: MercuryTransaction[],
  runId: string,
  includeDebits = false,
  includeInternalTransfers = false,
  accountName?: string,
): DonationEvent[] {
  return transactions
    .filter((tx) => includeDebits || tx.amount > 0) // Only credits by default
    .filter((tx) => includeInternalTransfers || !isInternalTransfer(tx)) // Exclude internal transfers
    .map((tx) => transformMercuryTransaction(tx, runId, accountName))
}
