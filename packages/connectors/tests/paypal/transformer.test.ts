/**
 * Tests for PayPal transformer functions.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { PayPalTransactionDetail } from '../../src/paypal/schema'
import {
  buildDonorName,
  buildDonorPhone,
  extractAttribution,
  extractAttributionHuman,
  extractDonorAddress,
  isIncomingPayment,
  mapPayPalPaymentMethod,
  mapPayPalStatus,
  parsePayPalMoney,
  transformPayPalTransaction,
  transformPayPalTransactions,
} from '../../src/paypal/transformer'

describe('mapPayPalStatus', () => {
  it('maps "S" to "succeeded"', () => {
    expect(mapPayPalStatus('S')).toBe('succeeded')
  })

  it('maps "P" to "pending"', () => {
    expect(mapPayPalStatus('P')).toBe('pending')
  })

  it('maps "D" to "failed"', () => {
    expect(mapPayPalStatus('D')).toBe('failed')
  })

  it('maps "V" to "refunded"', () => {
    expect(mapPayPalStatus('V')).toBe('refunded')
  })

  it('maps undefined to "pending"', () => {
    expect(mapPayPalStatus(undefined)).toBe('pending')
  })
})

describe('parsePayPalMoney', () => {
  it('parses a valid money amount', () => {
    expect(parsePayPalMoney({ currency_code: 'USD', value: '100.00' })).toBe(
      10000,
    )
  })

  it('handles decimal amounts', () => {
    expect(parsePayPalMoney({ currency_code: 'USD', value: '99.99' })).toBe(
      9999,
    )
  })

  it('handles negative amounts (fees)', () => {
    expect(parsePayPalMoney({ currency_code: 'USD', value: '-2.90' })).toBe(
      -290,
    )
  })

  it('handles large amounts', () => {
    expect(parsePayPalMoney({ currency_code: 'USD', value: '10000.50' })).toBe(
      1000050,
    )
  })

  it('returns 0 for undefined', () => {
    expect(parsePayPalMoney(undefined)).toBe(0)
  })

  it('returns 0 for empty value', () => {
    expect(parsePayPalMoney({ currency_code: 'USD', value: '' })).toBe(0)
  })

  it('returns 0 for NaN value', () => {
    expect(parsePayPalMoney({ currency_code: 'USD', value: 'invalid' })).toBe(0)
  })
})

describe('buildDonorName', () => {
  it('builds name from given_name and surname', () => {
    const payerInfo = {
      payer_name: { given_name: 'John', surname: 'Doe' },
    }
    expect(buildDonorName(payerInfo)).toBe('John Doe')
  })

  it('prefers alternate_full_name when available', () => {
    const payerInfo = {
      payer_name: {
        given_name: 'John',
        surname: 'Doe',
        alternate_full_name: 'John Q. Public',
      },
    }
    expect(buildDonorName(payerInfo)).toBe('John Q. Public')
  })

  it('handles only given_name', () => {
    const payerInfo = { payer_name: { given_name: 'John' } }
    expect(buildDonorName(payerInfo)).toBe('John')
  })

  it('handles only surname', () => {
    const payerInfo = { payer_name: { surname: 'Doe' } }
    expect(buildDonorName(payerInfo)).toBe('Doe')
  })

  it('returns null for undefined payer info', () => {
    expect(buildDonorName(undefined)).toBeNull()
  })

  it('returns null for missing payer_name', () => {
    expect(buildDonorName({})).toBeNull()
  })

  it('returns null for empty payer_name', () => {
    expect(buildDonorName({ payer_name: {} })).toBeNull()
  })
})

describe('buildDonorPhone', () => {
  it('builds phone with country code', () => {
    const payerInfo = {
      phone_number: { country_code: '1', national_number: '5551234567' },
    }
    expect(buildDonorPhone(payerInfo)).toBe('+15551234567')
  })

  it('builds phone without country code', () => {
    const payerInfo = {
      phone_number: { national_number: '5551234567' },
    }
    expect(buildDonorPhone(payerInfo)).toBe('5551234567')
  })

  it('returns null for undefined payer info', () => {
    expect(buildDonorPhone(undefined)).toBeNull()
  })

  it('returns null for missing phone_number', () => {
    expect(buildDonorPhone({})).toBeNull()
  })

  it('returns null for missing national_number', () => {
    expect(buildDonorPhone({ phone_number: {} })).toBeNull()
  })
})

describe('extractDonorAddress', () => {
  it('extracts complete address', () => {
    const payerInfo = {
      address: {
        line1: '123 Main St',
        line2: 'Apt 4',
        city: 'San Francisco',
        state: 'CA',
        country_code: 'US',
        postal_code: '94102',
      },
    }

    expect(extractDonorAddress(payerInfo)).toEqual({
      line1: '123 Main St',
      line2: 'Apt 4',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: 'US',
    })
  })

  it('extracts partial address', () => {
    const payerInfo = {
      address: { line1: '123 Main St', city: 'Boston' },
    }

    expect(extractDonorAddress(payerInfo)).toEqual({
      line1: '123 Main St',
      line2: null,
      city: 'Boston',
      state: null,
      postal_code: null,
      country: null,
    })
  })

  it('returns null for undefined payer info', () => {
    expect(extractDonorAddress(undefined)).toBeNull()
  })

  it('returns null for missing address', () => {
    expect(extractDonorAddress({})).toBeNull()
  })

  it('returns null for empty address', () => {
    expect(extractDonorAddress({ address: {} })).toBeNull()
  })
})

describe('mapPayPalPaymentMethod', () => {
  it('returns "paypal" for undefined', () => {
    expect(mapPayPalPaymentMethod(undefined)).toBe('paypal')
  })

  it('returns "paypal" for Express Checkout (T0006) and Standard web checkout (T0007)', () => {
    expect(mapPayPalPaymentMethod('T0006')).toBe('paypal')
    expect(mapPayPalPaymentMethod('T0007')).toBe('paypal')
  })

  it('returns "credit_card" for credit card payment (T0005)', () => {
    expect(mapPayPalPaymentMethod('T0005')).toBe('credit_card')
  })

  it('returns "credit_card" for Virtual Terminal payment (T0012)', () => {
    expect(mapPayPalPaymentMethod('T0012')).toBe('credit_card')
  })

  it('returns "paypal" for other payment codes', () => {
    expect(mapPayPalPaymentMethod('T0000')).toBe('paypal')
    expect(mapPayPalPaymentMethod('T0001')).toBe('paypal')
    expect(mapPayPalPaymentMethod('T0002')).toBe('paypal')
    expect(mapPayPalPaymentMethod('T0011')).toBe('paypal')
    expect(mapPayPalPaymentMethod('T0013')).toBe('paypal')
  })

  it('does not treat T05xx/T06xx account-funding codes as card payments', () => {
    expect(mapPayPalPaymentMethod('T0500')).toBe('paypal')
    expect(mapPayPalPaymentMethod('T0600')).toBe('paypal')
  })
})

describe('extractAttribution', () => {
  it('returns item_name from first cart item', () => {
    const cartInfo = {
      item_details: [
        {
          item_name: 'Annual Gala 2024',
          item_description: 'Ticket for annual gala',
        },
      ],
    }
    expect(extractAttribution(cartInfo)).toBe('Annual Gala 2024')
  })

  it('returns first item name when multiple items exist', () => {
    const cartInfo = {
      item_details: [
        { item_name: 'First Item', item_description: 'First description' },
        { item_name: 'Second Item', item_description: 'Second description' },
      ],
    }
    expect(extractAttribution(cartInfo)).toBe('First Item')
  })

  it('returns null for undefined cart info', () => {
    expect(extractAttribution(undefined)).toBeNull()
  })

  it('returns null for empty item_details array', () => {
    const cartInfo = { item_details: [] }
    expect(extractAttribution(cartInfo)).toBeNull()
  })

  it('returns null for missing item_details', () => {
    const cartInfo = {}
    expect(extractAttribution(cartInfo)).toBeNull()
  })

  it('returns null when first item has no item_name', () => {
    const cartInfo = {
      item_details: [{ item_description: 'Only description' }],
    }
    expect(extractAttribution(cartInfo)).toBeNull()
  })
})

describe('extractAttributionHuman', () => {
  it('prefers item_description over item_name', () => {
    const cartInfo = {
      item_details: [
        {
          item_name: 'GALA2024',
          item_description: 'Ticket for Annual Gala 2024',
        },
      ],
    }
    expect(extractAttributionHuman(cartInfo)).toBe(
      'Ticket for Annual Gala 2024',
    )
  })

  it('falls back to item_name when no description', () => {
    const cartInfo = {
      item_details: [{ item_name: 'Annual Gala 2024' }],
    }
    expect(extractAttributionHuman(cartInfo)).toBe('Annual Gala 2024')
  })

  it('returns first item description when multiple items exist', () => {
    const cartInfo = {
      item_details: [
        { item_name: 'First', item_description: 'First Human-Readable' },
        { item_name: 'Second', item_description: 'Second Human-Readable' },
      ],
    }
    expect(extractAttributionHuman(cartInfo)).toBe('First Human-Readable')
  })

  it('returns null for undefined cart info', () => {
    expect(extractAttributionHuman(undefined)).toBeNull()
  })

  it('returns null for empty item_details array', () => {
    const cartInfo = { item_details: [] }
    expect(extractAttributionHuman(cartInfo)).toBeNull()
  })

  it('returns null for missing item_details', () => {
    const cartInfo = {}
    expect(extractAttributionHuman(cartInfo)).toBeNull()
  })

  it('returns null when first item has no name or description', () => {
    const cartInfo = {
      item_details: [{}],
    }
    expect(extractAttributionHuman(cartInfo)).toBeNull()
  })
})

describe('isIncomingPayment', () => {
  const createTx = (
    eventCode: string | undefined,
    value: string | undefined,
  ): PayPalTransactionDetail => ({
    transaction_info: {
      transaction_id: 'TX1',
      transaction_event_code: eventCode,
      transaction_amount:
        value === undefined ? undefined : { currency_code: 'USD', value },
    },
  })

  it('returns true for positive payment-category (T00xx) transactions', () => {
    for (const code of ['T0000', 'T0001', 'T0002', 'T0007', 'T0011', 'T0013']) {
      expect(isIncomingPayment(createTx(code, '100.00'))).toBe(true)
    }
  })

  it('returns false for negative amounts', () => {
    expect(isIncomingPayment(createTx('T0000', '-50.00'))).toBe(false)
  })

  it('returns false for zero amounts', () => {
    expect(isIncomingPayment(createTx('T0013', '0.00'))).toBe(false)
  })

  it('returns false for missing amount', () => {
    expect(isIncomingPayment(createTx('T0013', undefined))).toBe(false)
  })

  it('returns false for unparseable amount', () => {
    expect(isIncomingPayment(createTx('T0013', 'abc'))).toBe(false)
  })

  it('returns false when the event code is missing', () => {
    expect(isIncomingPayment(createTx(undefined, '100.00'))).toBe(false)
  })

  it('returns false for positive non-payment codes', () => {
    // Currency conversion, bank deposit, credit card deposit, payment refund,
    // dispute hold release, account correction
    for (const code of ['T0200', 'T0300', 'T0700', 'T1107', 'T1111', 'T1900']) {
      expect(isIncomingPayment(createTx(code, '100.00'))).toBe(false)
    }
  })
})

describe('transformPayPalTransaction', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createBaseTx = (
    overrides?: Partial<PayPalTransactionDetail>,
  ): PayPalTransactionDetail => ({
    transaction_info: {
      paypal_account_id: 'MERCHANT123',
      transaction_id: 'TX12345678',
      transaction_event_code: 'T0005',
      transaction_initiation_date: '2024-01-15T10:30:00Z',
      transaction_updated_date: '2024-01-15T10:35:00Z',
      transaction_amount: { currency_code: 'USD', value: '100.00' },
      fee_amount: { currency_code: 'USD', value: '-2.90' },
      transaction_status: 'S',
      transaction_subject: 'Monthly Donation',
      invoice_id: 'INV-001',
      custom_field: 'CAMPAIGN-2024',
      protection_eligibility: 'ELIGIBLE',
    },
    payer_info: {
      account_id: 'PAYER456',
      email_address: 'donor@example.com',
      phone_number: { country_code: '1', national_number: '5551234567' },
      payer_name: { given_name: 'Jane', surname: 'Donor' },
      address: {
        line1: '456 Elm St',
        city: 'Boston',
        state: 'MA',
        country_code: 'US',
        postal_code: '02101',
      },
    },
    ...overrides,
  })

  it('transforms a complete transaction', () => {
    const tx = createBaseTx()
    const result = transformPayPalTransaction(tx, runId)

    expect(result.source).toBe('paypal')
    expect(result.external_id).toBe('TX12345678')
    expect(result.event_ts).toBe('2024-01-15T10:30:00Z')
    expect(result.created_at).toBe('2024-01-15T10:30:00Z')
    expect(result.amount_cents).toBe(10000)
    expect(result.fee_cents).toBe(290) // Absolute value
    expect(result.net_amount_cents).toBe(9710) // 10000 - 290
    expect(result.currency).toBe('USD')
    expect(result.donor_name).toBe('Jane Donor')
    expect(result.donor_email).toBe('donor@example.com')
    expect(result.donor_phone).toBe('+15551234567')
    expect(result.status).toBe('succeeded')
    expect(result.payment_method).toBe('credit_card')
    expect(result.description).toBe('Monthly Donation')
    expect(result.run_id).toBe(runId)
  })

  it('extracts donor address correctly', () => {
    const tx = createBaseTx()
    const result = transformPayPalTransaction(tx, runId)

    expect(result.donor_address).toEqual({
      line1: '456 Elm St',
      line2: null,
      city: 'Boston',
      state: 'MA',
      postal_code: '02101',
      country: 'US',
    })
  })

  it('includes comprehensive source_metadata', () => {
    const tx = createBaseTx()
    const result = transformPayPalTransaction(tx, runId)

    expect(result.source_metadata).toMatchObject({
      paypal_account_id: 'MERCHANT123',
      payer_account_id: 'PAYER456',
      transaction_event_code: 'T0005',
      invoice_id: 'INV-001',
      custom_field: 'CAMPAIGN-2024',
      protection_eligibility: 'ELIGIBLE',
    })
  })

  it('handles transaction without payer info', () => {
    const tx = createBaseTx({ payer_info: undefined })
    const result = transformPayPalTransaction(tx, runId)

    expect(result.donor_name).toBeNull()
    expect(result.donor_email).toBeNull()
    expect(result.donor_phone).toBeNull()
    expect(result.donor_address).toBeNull()
  })

  it('handles transaction without fees', () => {
    const tx = createBaseTx()
    tx.transaction_info.fee_amount = undefined
    const result = transformPayPalTransaction(tx, runId)

    expect(result.fee_cents).toBe(0)
    expect(result.net_amount_cents).toBe(10000)
  })

  it('uses transaction_note as fallback description', () => {
    const tx = createBaseTx()
    tx.transaction_info.transaction_subject = undefined
    tx.transaction_info.transaction_note = 'Note from payer'
    const result = transformPayPalTransaction(tx, runId)

    expect(result.description).toBe('Note from payer')
  })

  it('sets ingested_at to current time', () => {
    const before = DateTime.utc()
    const tx = createBaseTx()
    const result = transformPayPalTransaction(tx, runId)
    const after = DateTime.utc()

    const ingestedAt = DateTime.fromISO(result.ingested_at, { zone: 'utc' })
    expect(ingestedAt >= before).toBe(true)
    expect(ingestedAt <= after).toBe(true)
  })

  it('handles all transaction statuses', () => {
    const statuses: ['D' | 'P' | 'S' | 'V', string][] = [
      ['S', 'succeeded'],
      ['P', 'pending'],
      ['D', 'failed'],
      ['V', 'refunded'],
    ]

    for (const [ppStatus, expectedStatus] of statuses) {
      const tx = createBaseTx()
      tx.transaction_info.transaction_status = ppStatus
      const result = transformPayPalTransaction(tx, runId)
      expect(result.status).toBe(expectedStatus)
    }
  })

  it('extracts attribution from cart_info', () => {
    const tx = createBaseTx({
      cart_info: {
        item_details: [
          {
            item_name: 'GALA2024',
            item_description: 'Annual Gala 2024 Ticket',
          },
        ],
      },
    })
    const result = transformPayPalTransaction(tx, runId)

    expect(result.attribution).toBe('GALA2024')
    expect(result.attribution_human).toBe('Annual Gala 2024 Ticket')
  })

  it('sets attribution to null when no cart_info', () => {
    const tx = createBaseTx()
    const result = transformPayPalTransaction(tx, runId)

    expect(result.attribution).toBeNull()
    expect(result.attribution_human).toBeNull()
  })
})

describe('transformPayPalTransactions', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createTx = (
    id: string,
    amount: string,
    eventCode = 'T0013',
  ): PayPalTransactionDetail => ({
    transaction_info: {
      transaction_id: id,
      transaction_event_code: eventCode,
      transaction_amount: { currency_code: 'USD', value: amount },
      transaction_status: 'S',
    },
  })

  it('transforms multiple transactions', () => {
    const transactions = [createTx('TX1', '100.00'), createTx('TX2', '200.00')]
    const result = transformPayPalTransactions(transactions, runId)

    expect(result.map((e) => [e.external_id, e.amount_cents])).toEqual([
      ['TX1', 10000],
      ['TX2', 20000],
    ])
  })

  it('filters out outgoing payments', () => {
    const transactions = [
      createTx('TX_IN', '100.00'),
      createTx('TX_OUT', '-50.00'),
      createTx('TX_IN2', '75.00'),
    ]

    const result = transformPayPalTransactions(transactions, runId)

    expect(result.map((e) => e.external_id)).toEqual(['TX_IN', 'TX_IN2'])
  })

  it('filters out non-payment credits that duplicate or are not donations', () => {
    // A EUR donation produces a T0011 EUR credit and a T0200 USD conversion
    // credit for the same money; only the donation must be kept.
    const transactions = [
      createTx('DONATION_EUR', '50.00', 'T0011'),
      createTx('FX_USD', '54.12', 'T0200'),
      createTx('BANK_DEPOSIT', '1000.00', 'T0300'),
      createTx('CARD_DEPOSIT', '110.00', 'T0700'),
      createTx('REFUND_FROM_MERCHANT', '44.78', 'T1107'),
      createTx('HOLD_RELEASE', '30.78', 'T1111'),
      createTx('CORRECTION', '38.47', 'T1900'),
      createTx('PPGF_PAYOUT', '5000.00', 'T0001'),
    ]

    const result = transformPayPalTransactions(transactions, runId)

    expect(result.map((e) => e.external_id)).toEqual([
      'DONATION_EUR',
      'PPGF_PAYOUT',
    ])
  })

  it('returns empty array for empty input', () => {
    const result = transformPayPalTransactions([], runId)
    expect(result).toEqual([])
  })

  it('returns empty array when all transactions are outgoing', () => {
    const transactions = [
      createTx('TX1', '-100.00'),
      createTx('TX2', '-200.00'),
    ]
    const result = transformPayPalTransactions(transactions, runId)
    expect(result).toEqual([])
  })
})
