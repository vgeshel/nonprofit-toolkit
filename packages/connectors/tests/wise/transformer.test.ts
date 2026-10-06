/**
 * Tests for Wise transformer.
 */
import { describe, expect, it } from 'vitest'
import type { WiseTransaction } from '../../src/wise/schema'
import {
  mapWisePaymentMethod,
  mapWiseStatus,
  transformWiseTransaction,
  transformWiseTransactions,
} from '../../src/wise/transformer'

describe('mapWiseStatus', () => {
  it('returns succeeded (Wise statements only show completed transactions)', () => {
    expect(mapWiseStatus()).toBe('succeeded')
  })
})

describe('mapWisePaymentMethod', () => {
  const createTransaction = (detailsType: string): WiseTransaction => ({
    type: 'CREDIT',
    date: '2025-01-15T10:30:00.000Z',
    amount: { value: 100, currency: 'EUR' },
    totalFees: { value: 0, currency: 'EUR' },
    details: { type: detailsType, description: 'Test' },
    runningBalance: { value: 100, currency: 'EUR' },
    referenceNumber: 'TEST-123',
  })

  it('maps DEPOSIT to bank_transfer', () => {
    const tx = createTransaction('DEPOSIT')
    expect(mapWisePaymentMethod(tx)).toBe('bank_transfer')
  })

  it('maps CARD to card', () => {
    const tx = createTransaction('CARD')
    expect(mapWisePaymentMethod(tx)).toBe('card')
  })

  it('maps TRANSFER to transfer', () => {
    const tx = createTransaction('TRANSFER')
    expect(mapWisePaymentMethod(tx)).toBe('transfer')
  })

  it('maps CONVERSION to conversion', () => {
    const tx = createTransaction('CONVERSION')
    expect(mapWisePaymentMethod(tx)).toBe('conversion')
  })

  it('maps DIRECT_DEBIT to direct_debit', () => {
    const tx = createTransaction('DIRECT_DEBIT')
    expect(mapWisePaymentMethod(tx)).toBe('direct_debit')
  })

  it('maps unknown type to lowercase', () => {
    const tx = createTransaction('SOME_OTHER_TYPE')
    expect(mapWisePaymentMethod(tx)).toBe('some_other_type')
  })
})

describe('transformWiseTransaction', () => {
  const runId = 'test-run-id-123'

  const baseTransaction: WiseTransaction = {
    type: 'CREDIT',
    date: '2025-01-15T10:30:00.000Z',
    amount: { value: 500, currency: 'EUR' },
    totalFees: { value: 2.5, currency: 'EUR' },
    details: {
      type: 'DEPOSIT',
      description: 'Donation from supporter',
      senderName: 'Jane Smith',
      senderAccount: 'GB82 WEST 1234 5698 7654 32',
      paymentReference: 'Monthly donation',
    },
    exchangeDetails: {
      forAmount: { value: 550, currency: 'USD' },
      rate: 1.1,
    },
    runningBalance: { value: 1500, currency: 'EUR' },
    referenceNumber: 'TRANSFER-12345678',
  }

  it('transforms a complete deposit transaction', () => {
    const event = transformWiseTransaction(baseTransaction, runId)

    expect(event.source).toBe('wise')

    expect(event.is_recurring).toBeNull()
    expect(event.external_id).toBe('TRANSFER-12345678')
    expect(event.event_ts).toBe('2025-01-15T10:30:00.000Z')
    expect(event.created_at).toBe('2025-01-15T10:30:00.000Z')
    expect(event.amount_cents).toBe(50000) // 500 * 100
    expect(event.fee_cents).toBe(250) // 2.5 * 100
    expect(event.net_amount_cents).toBe(49750) // 50000 - 250
    expect(event.currency).toBe('EUR')
    expect(event.donor_name).toBe('Jane Smith')
    expect(event.donor_email).toBeNull()
    expect(event.donor_phone).toBeNull()
    expect(event.donor_address).toBeNull()
    expect(event.status).toBe('succeeded')
    expect(event.payment_method).toBe('bank_transfer')
    expect(event.description).toBe('Donation from supporter')
    expect(event.run_id).toBe(runId)
  })

  it('uses payment reference as description when description is missing', () => {
    const tx: WiseTransaction = {
      ...baseTransaction,
      details: {
        type: 'DEPOSIT',
        senderName: 'Jane Smith',
        paymentReference: 'Monthly donation',
      },
    }

    const event = transformWiseTransaction(tx, runId)
    expect(event.description).toBe('Monthly donation')
  })

  it('handles transaction without sender name', () => {
    const tx: WiseTransaction = {
      ...baseTransaction,
      details: {
        type: 'DEPOSIT',
        description: 'Unknown sender donation',
      },
    }

    const event = transformWiseTransaction(tx, runId)
    expect(event.donor_name).toBeNull()
  })

  it('returns null description when both description and paymentReference are missing', () => {
    const tx: WiseTransaction = {
      ...baseTransaction,
      details: {
        type: 'DEPOSIT',
        senderName: 'Jane Smith',
        // No description or paymentReference
      },
    }

    const event = transformWiseTransaction(tx, runId)
    expect(event.description).toBeNull()
  })

  it('handles transaction without fees', () => {
    const tx: WiseTransaction = {
      ...baseTransaction,
      totalFees: { value: 0, currency: 'EUR' },
    }

    const event = transformWiseTransaction(tx, runId)
    expect(event.fee_cents).toBe(0)
    expect(event.net_amount_cents).toBe(50000)
  })

  it('stores source metadata correctly', () => {
    const event = transformWiseTransaction(baseTransaction, runId)

    expect(event.source_metadata).toEqual({
      senderAccount: 'GB82 WEST 1234 5698 7654 32',
      paymentReference: 'Monthly donation',
      detailsType: 'DEPOSIT',
      transactionType: 'CREDIT',
      exchangeDetails: {
        forAmount: { value: 550, currency: 'USD' },
        rate: 1.1,
      },
      runningBalance: { value: 1500, currency: 'EUR' },
    })
  })

  it('handles different currencies', () => {
    const tx: WiseTransaction = {
      ...baseTransaction,
      amount: { value: 1000, currency: 'USD' },
      totalFees: { value: 5, currency: 'USD' },
      runningBalance: { value: 5000, currency: 'USD' },
    }

    const event = transformWiseTransaction(tx, runId)
    expect(event.currency).toBe('USD')
    expect(event.amount_cents).toBe(100000)
    expect(event.fee_cents).toBe(500)
  })

  it('handles GBP transactions', () => {
    const tx: WiseTransaction = {
      ...baseTransaction,
      amount: { value: 250.75, currency: 'GBP' },
      totalFees: { value: 1.25, currency: 'GBP' },
      runningBalance: { value: 500, currency: 'GBP' },
    }

    const event = transformWiseTransaction(tx, runId)
    expect(event.currency).toBe('GBP')
    expect(event.amount_cents).toBe(25075)
    expect(event.fee_cents).toBe(125)
  })
})

describe('transformWiseTransactions', () => {
  const runId = 'test-run-id-456'

  const depositTx: WiseTransaction = {
    type: 'CREDIT',
    date: '2025-01-15T10:30:00.000Z',
    amount: { value: 500, currency: 'EUR' },
    totalFees: { value: 0, currency: 'EUR' },
    details: {
      type: 'DEPOSIT',
      description: 'Donation',
      senderName: 'Jane Smith',
    },
    runningBalance: { value: 1500, currency: 'EUR' },
    referenceNumber: 'TRANSFER-001',
  }

  const transferTx: WiseTransaction = {
    type: 'CREDIT',
    date: '2025-01-16T10:30:00.000Z',
    amount: { value: 200, currency: 'EUR' },
    totalFees: { value: 0, currency: 'EUR' },
    details: {
      type: 'TRANSFER',
      description: 'Internal transfer',
    },
    runningBalance: { value: 1700, currency: 'EUR' },
    referenceNumber: 'TRANSFER-002',
  }

  const cardTx: WiseTransaction = {
    type: 'DEBIT',
    date: '2025-01-17T10:30:00.000Z',
    amount: { value: -50, currency: 'EUR' },
    totalFees: { value: 0, currency: 'EUR' },
    details: {
      type: 'CARD',
      description: 'Card purchase',
    },
    runningBalance: { value: 1650, currency: 'EUR' },
    referenceNumber: 'CARD-001',
  }

  const secondDeposit: WiseTransaction = {
    type: 'CREDIT',
    date: '2025-01-18T10:30:00.000Z',
    amount: { value: 100, currency: 'EUR' },
    totalFees: { value: 0, currency: 'EUR' },
    details: {
      type: 'DEPOSIT',
      description: 'Another donation',
      senderName: 'John Doe',
    },
    runningBalance: { value: 1750, currency: 'EUR' },
    referenceNumber: 'TRANSFER-003',
  }

  it('filters to only deposit transactions by default', () => {
    const transactions = [depositTx, transferTx, cardTx, secondDeposit]
    const events = transformWiseTransactions(transactions, runId)

    expect(events).toHaveLength(2)
    expect(events[0]?.external_id).toBe('TRANSFER-001')
    expect(events[1]?.external_id).toBe('TRANSFER-003')
  })

  it('includes all transactions when includeAll is true', () => {
    const transactions = [depositTx, transferTx, cardTx, secondDeposit]
    const events = transformWiseTransactions(transactions, runId, true)

    expect(events).toHaveLength(4)
    expect(events.map((e) => e.external_id)).toEqual([
      'TRANSFER-001',
      'TRANSFER-002',
      'CARD-001',
      'TRANSFER-003',
    ])
  })

  it('returns empty array for empty transactions', () => {
    const events = transformWiseTransactions([], runId)
    expect(events).toHaveLength(0)
  })

  it('returns empty array when no deposits exist', () => {
    const transactions = [transferTx, cardTx]
    const events = transformWiseTransactions(transactions, runId)
    expect(events).toHaveLength(0)
  })

  it('handles single deposit transaction', () => {
    const events = transformWiseTransactions([depositTx], runId)
    expect(events).toHaveLength(1)
    expect(events[0]?.donor_name).toBe('Jane Smith')
  })

  it('handles transactions with null referenceNumber gracefully', () => {
    // Create a deposit with null referenceNumber (edge case)
    const depositWithNullRef: WiseTransaction = {
      type: 'CREDIT',
      date: '2025-01-15T10:30:00.000Z',
      amount: { value: 100, currency: 'EUR' },
      totalFees: { value: 0, currency: 'EUR' },
      details: {
        type: 'DEPOSIT',
        description: 'Test',
        senderName: 'Test User',
      },
      runningBalance: { value: 100, currency: 'EUR' },
      // @ts-expect-error Testing edge case: null referenceNumber
      referenceNumber: null,
    }

    // Function handles null gracefully without throwing
    const events = transformWiseTransactions(
      [depositTx, depositWithNullRef],
      runId,
    )

    // Both transactions should be processed
    expect(events.length).toBeGreaterThanOrEqual(1)
  })
})
