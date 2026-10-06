/**
 * Transform Wise API transactions to canonical DonationEvent.
 */
import type { DonationEvent, DonationStatus } from '@donations-etl/types'
import { dollarsToCents } from '@donations-etl/types'
import { DateTime } from 'luxon'
import pino from 'pino'
import { isDeposit, type WiseTransaction } from './schema'

const logger = pino({ name: 'wise-transformer' })

/**
 * Map Wise transaction type to donation status.
 * Wise statements only contain completed transactions.
 */
export function mapWiseStatus(): DonationStatus {
  // Wise balance statements only show completed transactions
  return 'succeeded'
}

/**
 * Determine payment method from transaction details.
 */
export function mapWisePaymentMethod(tx: WiseTransaction): string {
  const detailType = tx.details.type.toLowerCase()

  switch (detailType) {
    case 'deposit':
      return 'bank_transfer'
    case 'card':
      return 'card'
    case 'transfer':
      return 'transfer'
    case 'conversion':
      return 'conversion'
    case 'direct_debit':
      return 'direct_debit'
    default:
      return detailType
  }
}

/**
 * Transform a single Wise transaction to a DonationEvent.
 *
 * Note: Wise transactions represent bank transfers.
 * We filter for DEPOSIT type transactions which are incoming payments.
 */
export function transformWiseTransaction(
  tx: WiseTransaction,
  runId: string,
): DonationEvent {
  // Wise amounts are in the statement currency
  const amountCents = dollarsToCents(Math.abs(tx.amount.value))
  const feeCents = dollarsToCents(Math.abs(tx.totalFees.value))

  return {
    source: 'wise',
    external_id: tx.referenceNumber,
    event_ts: tx.date,
    created_at: tx.date,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: amountCents - feeCents,
    currency: tx.amount.currency,
    donor_name: tx.details.senderName ?? null,
    payer_name: null, // Wise doesn't track payer separately
    donor_email: null, // Wise doesn't provide email
    donor_phone: null, // Wise doesn't provide phone
    donor_address: null, // Wise doesn't provide sender address in statement
    status: mapWiseStatus(),
    payment_method: mapWisePaymentMethod(tx),
    description: tx.details.description ?? tx.details.paymentReference ?? null,
    attribution: null, // Wise doesn't have campaign/attribution info
    attribution_human: null,
    is_recurring: null, // No recurrence signal in this source
    source_metadata: {
      senderAccount: tx.details.senderAccount,
      paymentReference: tx.details.paymentReference,
      detailsType: tx.details.type,
      transactionType: tx.type,
      exchangeDetails: tx.exchangeDetails,
      runningBalance: tx.runningBalance,
    },
    run_id: runId,
  }
}

/**
 * Transform multiple Wise transactions to DonationEvents.
 * By default, only includes deposit transactions (incoming donations).
 *
 * @param transactions Wise transactions to transform
 * @param runId UUID for the ETL run
 * @param includeAll Whether to include all transactions (default: false, only deposits)
 */
export function transformWiseTransactions(
  transactions: WiseTransaction[],
  runId: string,
  includeAll = false,
): DonationEvent[] {
  const filtered = includeAll
    ? transactions
    : transactions.filter((tx) => isDeposit(tx))

  const events: DonationEvent[] = []
  let skipped = 0

  for (const tx of filtered) {
    try {
      events.push(transformWiseTransaction(tx, runId))
    } catch (error) {
      /* istanbul ignore next -- @preserve defensive error handling for unexpected transform failures */
      skipped++
      /* istanbul ignore next -- @preserve */
      logger.warn(
        {
          referenceNumber: tx.referenceNumber,
          error:
            error instanceof Error
              ? { message: error.message }
              : { message: String(error) },
        },
        'Skipping transaction due to transform error',
      )
    }
  }

  /* istanbul ignore if -- @preserve only logs when there are skipped transactions */
  if (skipped > 0) {
    logger.info(
      { transformed: events.length, skipped },
      'Transform completed with skipped transactions',
    )
  }

  return events
}
