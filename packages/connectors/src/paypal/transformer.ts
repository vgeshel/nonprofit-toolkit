/**
 * Transform PayPal API transactions to canonical DonationEvent.
 */
import type {
  DonationEvent,
  DonationStatus,
  DonorAddress,
} from '@donations-etl/types'
import { DateTime } from 'luxon'
import type {
  PayPalCartInfo,
  PayPalMoney,
  PayPalPayerInfo,
  PayPalTransactionDetail,
  PayPalTransactionStatus,
} from './schema'

/**
 * Map PayPal transaction status to canonical status.
 *
 * PayPal uses single character codes:
 * D = Denied, P = Pending, S = Success, V = Reversed
 */
export function mapPayPalStatus(
  status: PayPalTransactionStatus | undefined,
): DonationStatus {
  switch (status) {
    case 'S':
      return 'succeeded'
    case 'P':
      return 'pending'
    case 'D':
      return 'failed'
    case 'V':
      return 'refunded'
    default:
      return 'pending'
  }
}

/**
 * Parse PayPal money string to cents.
 *
 * PayPal returns amounts as strings like "100.00".
 */
export function parsePayPalMoney(money: PayPalMoney | undefined): number {
  if (!money?.value) return 0

  const dollars = parseFloat(money.value)
  if (isNaN(dollars)) return 0

  // Convert to cents and round to avoid floating point issues
  return Math.round(dollars * 100)
}

/**
 * Build donor name from PayPal payer info.
 */
export function buildDonorName(
  payerInfo: PayPalPayerInfo | undefined,
): string | null {
  if (!payerInfo?.payer_name) return null

  const { given_name, surname, alternate_full_name } = payerInfo.payer_name

  // Prefer alternate_full_name if available
  if (alternate_full_name) return alternate_full_name

  // Otherwise construct from parts
  const parts = [given_name, surname].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Build donor phone from PayPal payer info.
 */
export function buildDonorPhone(
  payerInfo: PayPalPayerInfo | undefined,
): string | null {
  if (!payerInfo?.phone_number) return null

  const { country_code, national_number } = payerInfo.phone_number
  if (!national_number) return null

  return country_code ? `+${country_code}${national_number}` : national_number
}

/**
 * Extract donor address from PayPal payer info.
 */
export function extractDonorAddress(
  payerInfo: PayPalPayerInfo | undefined,
): DonorAddress | null {
  const address = payerInfo?.address
  if (!address) return null

  // Check if we have any address data
  if (
    !address.line1 &&
    !address.city &&
    !address.state &&
    !address.postal_code
  ) {
    return null
  }

  /* istanbul ignore next -- @preserve optional address fields have simple nullish defaults */
  return {
    line1: address.line1 ?? null,
    line2: address.line2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postal_code: address.postal_code ?? null,
    country: address.country_code ?? null,
  }
}

/**
 * Determine payment method from PayPal transaction event code.
 *
 * See https://developer.paypal.com/docs/reports/reference/tcodes/. Only two
 * payment codes identify the funding instrument: T0005 (credit card payment)
 * and T0012 (Virtual Terminal payment, a card keyed in by the merchant).
 * Checkout codes such as T0006 (Express Checkout) and T0007 (Standard web
 * checkout) can be funded by balance, bank or card, so they map to 'paypal'.
 */
export function mapPayPalPaymentMethod(eventCode: string | undefined): string {
  if (eventCode === 'T0005' || eventCode === 'T0012') return 'credit_card'
  return 'paypal'
}

/**
 * Derive is_recurring from the PayPal transaction event code.
 *
 * Per PayPal's T-code reference, T0002 is a subscription payment and T0003 a
 * preapproved payment for a recurring bill; every other T00xx code is a
 * payment with no recurring arrangement. Codes outside T00xx are not payments
 * at all (T02xx is currency conversion, T11xx reversals), so they carry no
 * signal. https://developer.paypal.com/docs/reports/reference/tcodes/
 */
export function mapPayPalRecurring(
  eventCode: string | undefined,
): boolean | null {
  if (eventCode === 'T0002' || eventCode === 'T0003') return true
  if (eventCode?.startsWith('T00')) return false
  return null
}

/**
 * Check if a transaction is an incoming payment (credit).
 *
 * Requires a positive amount and an event code in PayPal's "Payments received
 * and sent" category (T00xx). Other positive credits are not donations:
 * currency conversions (T02xx) duplicate a foreign-currency payment, bank and
 * card deposits (T03xx, T07xx) fund the balance, refunds and hold releases
 * (T11xx) return money already counted, and corrections (T19xx) adjust it.
 */
export function isIncomingPayment(tx: PayPalTransactionDetail): boolean {
  const info = tx.transaction_info
  if (!info.transaction_event_code?.startsWith('T00')) return false

  const amount = info.transaction_amount?.value
  if (!amount) return false

  const value = parseFloat(amount)
  return !isNaN(value) && value > 0
}

/**
 * Extract attribution from PayPal cart info.
 *
 * Uses the first item's name as the attribution identifier.
 * Returns null if no cart info or item details are present.
 */
export function extractAttribution(
  cartInfo: PayPalCartInfo | undefined,
): string | null {
  if (!cartInfo?.item_details?.length) return null

  const firstItem = cartInfo.item_details[0]
  return firstItem?.item_name ?? null
}

/**
 * Extract human-readable attribution from PayPal cart info.
 *
 * Uses the first item's description, falling back to item name.
 * Returns null if no cart info or item details are present.
 */
export function extractAttributionHuman(
  cartInfo: PayPalCartInfo | undefined,
): string | null {
  if (!cartInfo?.item_details?.length) return null

  const firstItem = cartInfo.item_details[0]
  // Prefer description, fall back to name
  return firstItem?.item_description ?? firstItem?.item_name ?? null
}

/**
 * Transform a single PayPal transaction to a DonationEvent.
 */
export function transformPayPalTransaction(
  tx: PayPalTransactionDetail,
  runId: string,
): DonationEvent {
  const info = tx.transaction_info
  const payerInfo = tx.payer_info

  const amountCents = parsePayPalMoney(info.transaction_amount)
  const feeCents = Math.abs(parsePayPalMoney(info.fee_amount)) // Fees are usually negative
  const netAmountCents = amountCents - feeCents

  // Use transaction_initiation_date as the primary timestamp
  const eventTs =
    info.transaction_initiation_date ?? info.transaction_updated_date
  /* istanbul ignore next -- @preserve event_ts typically exists */
  const createdAt = eventTs ?? DateTime.utc().toISO()

  /* istanbul ignore next -- @preserve optional fields have simple nullish defaults */
  return {
    source: 'paypal',
    external_id: info.transaction_id,
    event_ts: createdAt,
    created_at: createdAt,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: netAmountCents,
    currency: info.transaction_amount?.currency_code ?? 'USD',
    donor_name: buildDonorName(payerInfo),
    payer_name: null, // PayPal doesn't track payer separately from donor
    donor_email: payerInfo?.email_address ?? null,
    donor_phone: buildDonorPhone(payerInfo),
    donor_address: extractDonorAddress(payerInfo),
    status: mapPayPalStatus(info.transaction_status),
    payment_method: mapPayPalPaymentMethod(info.transaction_event_code),
    description: info.transaction_subject ?? info.transaction_note ?? null,
    // Attribution from cart item details
    attribution: extractAttribution(tx.cart_info),
    attribution_human: extractAttributionHuman(tx.cart_info),
    is_recurring: mapPayPalRecurring(info.transaction_event_code),
    source_metadata: {
      paypal_account_id: info.paypal_account_id,
      payer_account_id: payerInfo?.account_id,
      transaction_event_code: info.transaction_event_code,
      invoice_id: info.invoice_id,
      custom_field: info.custom_field,
      protection_eligibility: info.protection_eligibility,
      shipping_info: tx.shipping_info,
      cart_info: tx.cart_info,
    },
    run_id: runId,
  }
}

/**
 * Transform multiple PayPal transactions to DonationEvents.
 * Only includes incoming payments, since those are donations.
 */
export function transformPayPalTransactions(
  transactions: PayPalTransactionDetail[],
  runId: string,
): DonationEvent[] {
  return transactions
    .filter(isIncomingPayment)
    .map((tx) => transformPayPalTransaction(tx, runId))
}
