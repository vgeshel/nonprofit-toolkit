/**
 * Tests for Givebutter transformer functions.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { GivebutterTransaction } from '../../src/givebutter/schema'
import {
  buildDonorName,
  dollarsToCents,
  extractDonorAddress,
  mapGivebutterPaymentMethod,
  mapGivebutterStatus,
  transformGivebutterTransaction,
  transformGivebutterTransactions,
} from '../../src/givebutter/transformer'

describe('mapGivebutterStatus', () => {
  it('maps "succeeded" to "succeeded"', () => {
    expect(mapGivebutterStatus('succeeded')).toBe('succeeded')
  })

  it('maps "authorized" to "pending"', () => {
    expect(mapGivebutterStatus('authorized')).toBe('pending')
  })

  it('maps "failed" to "failed"', () => {
    expect(mapGivebutterStatus('failed')).toBe('failed')
  })

  it('maps "cancelled" to "failed"', () => {
    expect(mapGivebutterStatus('cancelled')).toBe('failed')
  })

  it('maps unknown status to "pending"', () => {
    // Unknown statuses are treated as pending since we don't know final state
    expect(mapGivebutterStatus('refunded')).toBe('pending')
    expect(mapGivebutterStatus('disputed')).toBe('pending')
    expect(mapGivebutterStatus('partial_refund')).toBe('pending')
  })
})

describe('mapGivebutterPaymentMethod', () => {
  it('maps "card" to "credit_card"', () => {
    expect(mapGivebutterPaymentMethod('card')).toBe('credit_card')
  })

  it('maps "ach" to "bank_transfer"', () => {
    expect(mapGivebutterPaymentMethod('ach')).toBe('bank_transfer')
  })

  it('maps "paypal" to "paypal"', () => {
    expect(mapGivebutterPaymentMethod('paypal')).toBe('paypal')
  })

  it('maps "venmo" to "venmo"', () => {
    expect(mapGivebutterPaymentMethod('venmo')).toBe('venmo')
  })

  it('maps "check" to "check"', () => {
    expect(mapGivebutterPaymentMethod('check')).toBe('check')
  })

  it('maps "cash" to "cash"', () => {
    expect(mapGivebutterPaymentMethod('cash')).toBe('cash')
  })

  it('maps unknown methods to "other"', () => {
    expect(mapGivebutterPaymentMethod('bitcoin')).toBe('other')
    expect(mapGivebutterPaymentMethod('wire')).toBe('other')
    expect(mapGivebutterPaymentMethod('apple_pay')).toBe('other')
  })

  it('handles case-insensitive input', () => {
    expect(mapGivebutterPaymentMethod('CARD')).toBe('credit_card')
    expect(mapGivebutterPaymentMethod('PayPal')).toBe('paypal')
    expect(mapGivebutterPaymentMethod('ACH')).toBe('bank_transfer')
  })
})

describe('dollarsToCents', () => {
  it('converts whole dollars', () => {
    expect(dollarsToCents(100)).toBe(10000)
    expect(dollarsToCents(1)).toBe(100)
    expect(dollarsToCents(0)).toBe(0)
  })

  it('converts fractional dollars', () => {
    expect(dollarsToCents(10.5)).toBe(1050)
    expect(dollarsToCents(99.99)).toBe(9999)
    expect(dollarsToCents(0.01)).toBe(1)
  })

  it('handles rounding correctly', () => {
    expect(dollarsToCents(10.005)).toBe(1001) // Rounds up
    expect(dollarsToCents(10.004)).toBe(1000) // Rounds down
  })

  it('handles large amounts', () => {
    expect(dollarsToCents(10000.0)).toBe(1000000)
    expect(dollarsToCents(999999.99)).toBe(99999999)
  })
})

describe('buildDonorName', () => {
  it('combines first and last name', () => {
    expect(buildDonorName('John', 'Doe')).toBe('John Doe')
  })

  it('returns first name only if last name is null', () => {
    expect(buildDonorName('John', null)).toBe('John')
  })

  it('returns last name only if first name is null', () => {
    expect(buildDonorName(null, 'Doe')).toBe('Doe')
  })

  it('returns null if both names are null', () => {
    expect(buildDonorName(null, null)).toBeNull()
  })

  it('handles empty strings as non-null', () => {
    // Empty strings are falsy so they get filtered out
    expect(buildDonorName('', 'Doe')).toBe('Doe')
    expect(buildDonorName('John', '')).toBe('John')
    expect(buildDonorName('', '')).toBeNull()
  })
})

describe('extractDonorAddress', () => {
  it('extracts a complete address', () => {
    const address = {
      address_1: '123 Main St',
      address_2: 'Suite 100',
      city: 'San Francisco',
      state: 'CA',
      zipcode: '94102',
      country: 'US',
    }

    expect(extractDonorAddress(address)).toEqual({
      line1: '123 Main St',
      line2: 'Suite 100',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: 'US',
    })
  })

  it('extracts a partial address', () => {
    const address = {
      address_1: '456 Oak Ave',
      address_2: null,
      city: 'Boston',
      state: null,
      zipcode: '02101',
      country: null,
    }

    expect(extractDonorAddress(address)).toEqual({
      line1: '456 Oak Ave',
      line2: null,
      city: 'Boston',
      state: null,
      postal_code: '02101',
      country: null,
    })
  })

  it('returns null for null address', () => {
    expect(extractDonorAddress(null)).toBeNull()
  })

  it('returns null for address with all null fields', () => {
    const emptyAddress = {
      address_1: null,
      address_2: null,
      city: null,
      state: null,
      zipcode: null,
      country: null,
    }

    expect(extractDonorAddress(emptyAddress)).toBeNull()
  })

  it('returns address if at least one field has data', () => {
    const minimalAddress = {
      address_1: null,
      address_2: null,
      city: 'Portland',
      state: null,
      zipcode: null,
      country: null,
    }

    const result = extractDonorAddress(minimalAddress)
    expect(result).not.toBeNull()
    expect(result?.city).toBe('Portland')
  })
})

describe('transformGivebutterTransaction', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createBaseTx = (
    overrides?: Partial<GivebutterTransaction>,
  ): GivebutterTransaction => ({
    // id is string after schema transformation
    id: '12345',
    number: 'TX-2024-001',
    campaign_id: 100,
    campaign_code: 'SPRING-DRIVE',
    first_name: 'Jane',
    last_name: 'Donor',
    email: 'jane@example.com',
    phone: '555-123-4567',
    address: {
      address_1: '789 Elm St',
      address_2: 'Apt 3C',
      city: 'Seattle',
      state: 'WA',
      zipcode: '98101',
      country: 'US',
    },
    status: 'succeeded',
    method: 'card',
    amount: 100.0,
    fee: 3.5,
    fee_covered: false,
    donated: 100.0,
    payout: 96.5,
    currency: 'usd',
    is_recurring: false,
    plan_id: null,
    transacted_at: '2024-01-15T10:30:00Z',
    created_at: '2024-01-15T10:30:00Z',
    ...overrides,
  })

  it('transforms a complete transaction', () => {
    const tx = createBaseTx()
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.source).toBe('givebutter')
    expect(result.external_id).toBe('12345')
    expect(result.event_ts).toBe('2024-01-15T10:30:00Z')
    expect(result.created_at).toBe('2024-01-15T10:30:00Z')
    expect(result.amount_cents).toBe(10000)
    expect(result.fee_cents).toBe(350)
    expect(result.net_amount_cents).toBe(9650) // payout when fee not covered
    expect(result.currency).toBe('USD')
    expect(result.donor_name).toBe('Jane Donor')
    expect(result.donor_email).toBe('jane@example.com')
    expect(result.donor_phone).toBe('555-123-4567')
    expect(result.status).toBe('succeeded')
    expect(result.payment_method).toBe('credit_card')
    expect(result.description).toBe('SPRING-DRIVE')
    expect(result.run_id).toBe(runId)
  })

  it('handles fee_covered correctly', () => {
    const tx = createBaseTx({ fee_covered: true })
    const result = transformGivebutterTransaction(tx, runId)

    // When fee is covered, net amount equals gross amount
    expect(result.amount_cents).toBe(10000)
    expect(result.net_amount_cents).toBe(10000)
  })

  it('handles fee not covered', () => {
    const tx = createBaseTx({
      fee_covered: false,
      amount: 50.0,
      fee: 1.5,
      payout: 48.5,
    })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.amount_cents).toBe(5000)
    expect(result.fee_cents).toBe(150)
    expect(result.net_amount_cents).toBe(4850) // Uses payout
  })

  it('extracts donor address correctly', () => {
    const tx = createBaseTx()
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.donor_address).toEqual({
      line1: '789 Elm St',
      line2: 'Apt 3C',
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
      country: 'US',
    })
  })

  it('handles null address', () => {
    const tx = createBaseTx({ address: null })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.donor_address).toBeNull()
  })

  it('includes source_metadata', () => {
    const tx = createBaseTx()
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.source_metadata).toMatchObject({
      number: 'TX-2024-001',
      campaign_id: 100,
      campaign_code: 'SPRING-DRIVE',
      method: 'card',
      fee_covered: false,
      donated: 100.0,
      payout: 96.5,
    })
  })

  it('marks a one-off gift as not recurring', () => {
    const result = transformGivebutterTransaction(createBaseTx(), runId)

    expect(result.is_recurring).toBe(false)
    expect(result.source_metadata).toMatchObject({
      is_recurring: false,
      plan_id: null,
    })
  })

  it('marks a plan charge as recurring and keeps its plan_id', () => {
    const tx = createBaseTx({ is_recurring: true, plan_id: 'plan_abc123' })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.is_recurring).toBe(true)
    expect(result.source_metadata).toMatchObject({
      is_recurring: true,
      plan_id: 'plan_abc123',
    })
  })

  it('handles missing donor info', () => {
    const tx = createBaseTx({
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
    })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.donor_name).toBeNull()
    expect(result.donor_email).toBeNull()
    expect(result.donor_phone).toBeNull()
  })

  it('handles missing campaign info', () => {
    const tx = createBaseTx({
      campaign_id: null,
      campaign_code: null,
    })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.description).toBeNull()
    expect(result.source_metadata).toMatchObject({
      campaign_id: null,
      campaign_code: null,
    })
  })

  it('sets attribution from campaign_code', () => {
    const tx = createBaseTx({ campaign_code: 'ANNUAL-GALA-2024' })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.attribution).toBe('ANNUAL-GALA-2024')
    expect(result.attribution_human).toBe('ANNUAL-GALA-2024')
  })

  it('sets attribution to null when no campaign_code', () => {
    const tx = createBaseTx({ campaign_code: null })
    const result = transformGivebutterTransaction(tx, runId)

    expect(result.attribution).toBeNull()
    expect(result.attribution_human).toBeNull()
  })

  it('uppercases currency code', () => {
    const tx = createBaseTx({ currency: 'eur' })
    const result = transformGivebutterTransaction(tx, runId)
    expect(result.currency).toBe('EUR')
  })

  it('handles all transaction statuses', () => {
    const statuses = [
      ['succeeded', 'succeeded'],
      ['authorized', 'pending'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
    ] as const

    for (const [gbStatus, expectedStatus] of statuses) {
      const tx = createBaseTx({ status: gbStatus })
      const result = transformGivebutterTransaction(tx, runId)
      expect(result.status).toBe(expectedStatus)
    }
  })

  it('handles all payment methods', () => {
    const methods = [
      ['card', 'credit_card'],
      ['ach', 'bank_transfer'],
      ['paypal', 'paypal'],
      ['venmo', 'venmo'],
      ['check', 'check'],
      ['cash', 'cash'],
    ] as const

    for (const [gbMethod, expectedMethod] of methods) {
      const tx = createBaseTx({ method: gbMethod })
      const result = transformGivebutterTransaction(tx, runId)
      expect(result.payment_method).toBe(expectedMethod)
    }
  })

  it('sets ingested_at to current time', () => {
    const before = DateTime.utc()
    const tx = createBaseTx()
    const result = transformGivebutterTransaction(tx, runId)
    const after = DateTime.utc()

    const ingestedAt = DateTime.fromISO(result.ingested_at, { zone: 'utc' })
    expect(ingestedAt >= before).toBe(true)
    expect(ingestedAt <= after).toBe(true)
  })
})

describe('transformGivebutterTransactions', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createTx = (
    id: number,
    status: GivebutterTransaction['status'] = 'succeeded',
  ): GivebutterTransaction => ({
    // id is string after schema transformation
    id: String(id),
    number: `TX-${id}`,
    campaign_id: null,
    campaign_code: null,
    first_name: `Donor${id}`,
    last_name: 'Test',
    email: `donor${id}@example.com`,
    phone: null,
    address: null,
    status,
    method: 'card',
    amount: id * 10,
    fee: 0.5,
    fee_covered: true,
    donated: id * 10,
    payout: id * 10 - 0.5,
    currency: 'USD',
    is_recurring: false,
    plan_id: null,
    transacted_at: '2024-01-15T10:30:00Z',
    created_at: '2024-01-15T10:30:00Z',
  })

  it('transforms multiple transactions', () => {
    const transactions = [createTx(1), createTx(2), createTx(3)]
    const result = transformGivebutterTransactions(transactions, runId)

    expect(result).toHaveLength(3)
    expect(result[0]?.external_id).toBe('1')
    expect(result[1]?.external_id).toBe('2')
    expect(result[2]?.external_id).toBe('3')
  })

  it('filters out non-succeeded by default', () => {
    const transactions = [
      createTx(1, 'succeeded'),
      createTx(2, 'authorized'),
      createTx(3, 'failed'),
      createTx(4, 'cancelled'),
      createTx(5, 'succeeded'),
    ]

    const result = transformGivebutterTransactions(transactions, runId)

    expect(result).toHaveLength(2)
    expect(result[0]?.external_id).toBe('1')
    expect(result[1]?.external_id).toBe('5')
  })

  it('includes all statuses when includeAll is true', () => {
    const transactions = [
      createTx(1, 'succeeded'),
      createTx(2, 'authorized'),
      createTx(3, 'failed'),
      createTx(4, 'cancelled'),
    ]

    const result = transformGivebutterTransactions(transactions, runId, true)

    expect(result).toHaveLength(4)
    expect(result[0]?.status).toBe('succeeded')
    expect(result[1]?.status).toBe('pending')
    expect(result[2]?.status).toBe('failed')
    expect(result[3]?.status).toBe('failed')
  })

  it('returns empty array for empty input', () => {
    const result = transformGivebutterTransactions([], runId)
    expect(result).toEqual([])
  })

  it('returns empty array when all transactions are filtered out', () => {
    const transactions = [
      createTx(1, 'failed'),
      createTx(2, 'cancelled'),
      createTx(3, 'authorized'),
    ]

    const result = transformGivebutterTransactions(transactions, runId)
    expect(result).toEqual([])
  })
})
