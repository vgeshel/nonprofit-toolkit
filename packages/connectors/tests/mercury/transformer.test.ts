/**
 * Tests for Mercury transformer functions.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { MercuryTransaction } from '../../src/mercury/schema'
import {
  extractDonorAddress,
  isInternalTransfer,
  mapMercuryKind,
  mapMercuryStatus,
  transformMercuryTransaction,
  transformMercuryTransactions,
} from '../../src/mercury/transformer'

describe('mapMercuryStatus', () => {
  it('maps "sent" to "succeeded"', () => {
    expect(mapMercuryStatus('sent')).toBe('succeeded')
  })

  it('maps "pending" to "pending"', () => {
    expect(mapMercuryStatus('pending')).toBe('pending')
  })

  it('maps "failed" to "failed"', () => {
    expect(mapMercuryStatus('failed')).toBe('failed')
  })

  it('maps "cancelled" to "cancelled"', () => {
    expect(mapMercuryStatus('cancelled')).toBe('cancelled')
  })

  it('maps "completed" to "succeeded"', () => {
    expect(mapMercuryStatus('completed')).toBe('succeeded')
  })

  it('maps unknown status to "succeeded"', () => {
    // Unknown statuses are treated as succeeded
    expect(mapMercuryStatus('some_unknown_status')).toBe('succeeded')
  })
})

describe('mapMercuryKind', () => {
  it('maps wire transfers', () => {
    expect(mapMercuryKind('domesticWire')).toBe('wire')
    expect(mapMercuryKind('internationalWire')).toBe('wire')
    expect(mapMercuryKind('WIRE_TRANSFER')).toBe('wire')
  })

  it('maps ACH transfers', () => {
    expect(mapMercuryKind('ach')).toBe('ach')
    expect(mapMercuryKind('ACH_TRANSFER')).toBe('ach')
    expect(mapMercuryKind('externalTransfer')).toBe('ach')
  })

  it('maps check payments', () => {
    expect(mapMercuryKind('check')).toBe('check')
    expect(mapMercuryKind('CHECK_DEPOSIT')).toBe('check')
  })

  it('maps internal transfers', () => {
    expect(mapMercuryKind('internalTransfer')).toBe('internal')
    expect(mapMercuryKind('INTERNAL')).toBe('internal')
  })

  it('returns original kind for unknown types', () => {
    expect(mapMercuryKind('unknownType')).toBe('unknownType')
    expect(mapMercuryKind('cardPayment')).toBe('cardPayment')
  })
})

describe('isInternalTransfer', () => {
  const baseTx: MercuryTransaction = {
    id: 'tx_1',
    amount: 1000,
    bankDescription: null,
    counterpartyId: 'cp_1',
    counterpartyName: 'Test Counterparty',
    createdAt: '2024-01-15T10:00:00Z',
    status: 'sent',
    kind: 'domesticWire',
    details: null,
    note: null,
    externalMemo: null,
    failedAt: null,
    postedAt: null,
    reasonForFailure: null,
    trackingNumber: null,
    counterpartyNickname: null,
  }

  it('returns true for internalTransfer kind', () => {
    expect(isInternalTransfer({ ...baseTx, kind: 'internalTransfer' })).toBe(
      true,
    )
  })

  it('returns true for INTERNALTRANSFER (case insensitive)', () => {
    expect(isInternalTransfer({ ...baseTx, kind: 'INTERNALTRANSFER' })).toBe(
      true,
    )
  })

  it('returns true for InternalTransfer (mixed case)', () => {
    expect(isInternalTransfer({ ...baseTx, kind: 'InternalTransfer' })).toBe(
      true,
    )
  })

  it('returns false for domesticWire', () => {
    expect(isInternalTransfer({ ...baseTx, kind: 'domesticWire' })).toBe(false)
  })

  it('returns false for externalTransfer', () => {
    expect(isInternalTransfer({ ...baseTx, kind: 'externalTransfer' })).toBe(
      false,
    )
  })

  it('returns false for check', () => {
    expect(isInternalTransfer({ ...baseTx, kind: 'check' })).toBe(false)
  })
})

describe('extractDonorAddress', () => {
  it('returns null when details is null', () => {
    expect(extractDonorAddress(null)).toBeNull()
  })

  it('returns null when details is undefined', () => {
    expect(extractDonorAddress(undefined)).toBeNull()
  })

  it('returns null when no address is present', () => {
    expect(extractDonorAddress({})).toBeNull()
  })

  it('extracts address from top-level address field', () => {
    const details = {
      address: {
        address1: '123 Main St',
        address2: 'Suite 100',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94102',
      },
    }

    expect(extractDonorAddress(details)).toEqual({
      line1: '123 Main St',
      line2: 'Suite 100',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: null,
    })
  })

  it('extracts address from domesticWireRoutingInfo', () => {
    const details = {
      domesticWireRoutingInfo: {
        bankName: 'Test Bank',
        routingNumber: '123456789',
        address: {
          address1: '456 Oak Ave',
          city: 'Oakland',
          state: 'CA',
          postalCode: '94601',
        },
      },
    }

    expect(extractDonorAddress(details)).toEqual({
      line1: '456 Oak Ave',
      line2: null,
      city: 'Oakland',
      state: 'CA',
      postal_code: '94601',
      country: null,
    })
  })

  it('prefers top-level address over nested routing info address', () => {
    const details = {
      address: {
        address1: 'Top Level Address',
        city: 'City1',
        state: 'ST',
        postalCode: '11111',
      },
      domesticWireRoutingInfo: {
        address: {
          address1: 'Nested Address',
          city: 'City2',
          state: 'XX',
          postalCode: '22222',
        },
      },
    }

    expect(extractDonorAddress(details)).toEqual({
      line1: 'Top Level Address',
      line2: null,
      city: 'City1',
      state: 'ST',
      postal_code: '11111',
      country: null,
    })
  })

  it('handles partial address with null fields', () => {
    const details = {
      address: {
        address1: '789 Pine St',
      },
    }

    expect(extractDonorAddress(details)).toEqual({
      line1: '789 Pine St',
      line2: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
    })
  })
})

describe('transformMercuryTransaction', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createBaseTx = (
    overrides: Partial<MercuryTransaction> = {},
  ): MercuryTransaction => ({
    id: 'tx_12345',
    amount: 1000.5,
    bankDescription: 'Wire from Acme Corp',
    counterpartyId: 'cp_67890',
    counterpartyName: 'Acme Corporation',
    counterpartyNickname: 'Acme',
    createdAt: '2024-01-15T10:30:00Z',
    dashboardLink: 'https://app.mercury.com/transactions/tx_12345',
    details: null,
    externalMemo: 'Q1 Donation',
    failedAt: null,
    kind: 'domesticWire',
    note: 'Annual contribution',
    postedAt: '2024-01-15T12:00:00Z',
    reasonForFailure: null,
    status: 'sent',
    trackingNumber: 'TRK123456',
    ...overrides,
  })

  it('transforms a basic credit transaction', () => {
    const tx = createBaseTx()
    const result = transformMercuryTransaction(tx, runId)

    expect(result.source).toBe('mercury')

    expect(result.is_recurring).toBeNull()
    expect(result.external_id).toBe('tx_12345')
    expect(result.event_ts).toBe('2024-01-15T10:30:00Z')
    expect(result.created_at).toBe('2024-01-15T10:30:00Z')
    expect(result.amount_cents).toBe(100050) // $1000.50 = 100050 cents
    expect(result.fee_cents).toBe(0)
    expect(result.net_amount_cents).toBe(100050)
    expect(result.currency).toBe('USD')
    expect(result.donor_name).toBe('Acme Corporation')
    expect(result.donor_email).toBeNull()
    expect(result.donor_phone).toBeNull()
    expect(result.donor_address).toBeNull()
    expect(result.status).toBe('succeeded')
    expect(result.payment_method).toBe('wire')
    expect(result.description).toBe('Wire from Acme Corp')
    expect(result.run_id).toBe(runId)
  })

  it('converts negative amounts (debits) to positive cents', () => {
    const tx = createBaseTx({ amount: -500.25 })
    const result = transformMercuryTransaction(tx, runId)

    expect(result.amount_cents).toBe(50025) // |-$500.25| = 50025 cents
    expect(result.net_amount_cents).toBe(50025)
  })

  it('uses note when bankDescription is null', () => {
    const tx = createBaseTx({ bankDescription: null })
    const result = transformMercuryTransaction(tx, runId)

    expect(result.description).toBe('Annual contribution')
  })

  it('uses externalMemo when bankDescription and note are null', () => {
    const tx = createBaseTx({ bankDescription: null, note: null })
    const result = transformMercuryTransaction(tx, runId)

    expect(result.description).toBe('Q1 Donation')
  })

  it('has null description when all description fields are null', () => {
    const tx = createBaseTx({
      bankDescription: null,
      note: null,
      externalMemo: null,
    })
    const result = transformMercuryTransaction(tx, runId)

    expect(result.description).toBeNull()
  })

  it('includes donor address when available', () => {
    const tx = createBaseTx({
      details: {
        address: {
          address1: '100 Donor Lane',
          city: 'Donation City',
          state: 'DC',
          postalCode: '12345',
        },
      },
    })
    const result = transformMercuryTransaction(tx, runId)

    expect(result.donor_address).toEqual({
      line1: '100 Donor Lane',
      line2: null,
      city: 'Donation City',
      state: 'DC',
      postal_code: '12345',
      country: null,
    })
  })

  it('includes comprehensive source_metadata', () => {
    const tx = createBaseTx()
    const result = transformMercuryTransaction(tx, runId)

    expect(result.source_metadata).toEqual({
      counterpartyId: 'cp_67890',
      counterpartyNickname: 'Acme',
      kind: 'domesticWire',
      trackingNumber: 'TRK123456',
      dashboardLink: 'https://app.mercury.com/transactions/tx_12345',
      details: null,
      isCredit: true,
    })
  })

  it('marks debits correctly in source_metadata', () => {
    const tx = createBaseTx({ amount: -100 })
    const result = transformMercuryTransaction(tx, runId)

    expect(result.source_metadata.isCredit).toBe(false)
  })

  it('sets ingested_at to current time', () => {
    const before = DateTime.utc()
    const tx = createBaseTx()
    const result = transformMercuryTransaction(tx, runId)
    const after = DateTime.utc()

    const ingestedAt = DateTime.fromISO(result.ingested_at, { zone: 'utc' })
    expect(ingestedAt >= before).toBe(true)
    expect(ingestedAt <= after).toBe(true)
  })

  it('handles all transaction statuses', () => {
    const statuses: [MercuryTransaction['status'], string][] = [
      ['sent', 'succeeded'],
      ['pending', 'pending'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
    ]

    for (const [mercuryStatus, expectedStatus] of statuses) {
      const tx = createBaseTx({ status: mercuryStatus })
      const result = transformMercuryTransaction(tx, runId)
      expect(result.status).toBe(expectedStatus)
    }
  })

  it('handles various payment kinds', () => {
    const kinds: [string, string][] = [
      ['domesticWire', 'wire'],
      ['externalTransfer', 'ach'],
      ['checkDeposit', 'check'],
      ['internalTransfer', 'internal'],
    ]

    for (const [mercuryKind, expectedMethod] of kinds) {
      const tx = createBaseTx({ kind: mercuryKind })
      const result = transformMercuryTransaction(tx, runId)
      expect(result.payment_method).toBe(expectedMethod)
    }
  })
})

describe('transformMercuryTransactions', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  const createTx = (id: string, amount: number): MercuryTransaction => ({
    id,
    amount,
    bankDescription: 'Test transaction',
    counterpartyId: 'cp_test',
    counterpartyName: 'Test Counterparty',
    createdAt: '2024-01-15T10:30:00Z',
    status: 'sent',
    kind: 'externalTransfer',
    details: null,
    note: null,
    externalMemo: null,
    failedAt: null,
    postedAt: null,
    reasonForFailure: null,
    trackingNumber: null,
    counterpartyNickname: null,
    dashboardLink: undefined,
  })

  it('transforms multiple transactions', () => {
    const transactions = [
      createTx('tx_1', 100),
      createTx('tx_2', 200),
      createTx('tx_3', 300),
    ]

    const result = transformMercuryTransactions(transactions, runId)

    expect(result).toHaveLength(3)
    expect(result[0]?.external_id).toBe('tx_1')
    expect(result[0]?.amount_cents).toBe(10000)
    expect(result[1]?.external_id).toBe('tx_2')
    expect(result[1]?.amount_cents).toBe(20000)
    expect(result[2]?.external_id).toBe('tx_3')
    expect(result[2]?.amount_cents).toBe(30000)
  })

  it('filters out debits by default', () => {
    const transactions = [
      createTx('credit_1', 100),
      createTx('debit_1', -50),
      createTx('credit_2', 200),
      createTx('debit_2', -75),
    ]

    const result = transformMercuryTransactions(transactions, runId)

    expect(result).toHaveLength(2)
    expect(result[0]?.external_id).toBe('credit_1')
    expect(result[1]?.external_id).toBe('credit_2')
  })

  it('includes debits when includeDebits is true', () => {
    const transactions = [
      createTx('credit_1', 100),
      createTx('debit_1', -50),
      createTx('credit_2', 200),
    ]

    const result = transformMercuryTransactions(transactions, runId, true)

    expect(result).toHaveLength(3)
    expect(result[0]?.external_id).toBe('credit_1')
    expect(result[1]?.external_id).toBe('debit_1')
    expect(result[2]?.external_id).toBe('credit_2')
  })

  it('returns empty array for empty input', () => {
    const result = transformMercuryTransactions([], runId)
    expect(result).toEqual([])
  })

  it('returns empty array when all transactions are debits', () => {
    const transactions = [createTx('debit_1', -100), createTx('debit_2', -200)]

    const result = transformMercuryTransactions(transactions, runId)

    expect(result).toEqual([])
  })

  it('filters out internal transfers by default', () => {
    const transactions = [
      createTx('credit_1', 100),
      { ...createTx('internal_1', 500), kind: 'internalTransfer' },
      createTx('credit_2', 200),
      { ...createTx('internal_2', 300), kind: 'internalTransfer' },
    ]

    const result = transformMercuryTransactions(transactions, runId)

    expect(result).toHaveLength(2)
    expect(result[0]?.external_id).toBe('credit_1')
    expect(result[1]?.external_id).toBe('credit_2')
  })

  it('includes internal transfers when includeInternalTransfers is true', () => {
    const transactions = [
      createTx('credit_1', 100),
      { ...createTx('internal_1', 500), kind: 'internalTransfer' },
      createTx('credit_2', 200),
    ]

    const result = transformMercuryTransactions(
      transactions,
      runId,
      false,
      true,
    )

    expect(result).toHaveLength(3)
    expect(result[0]?.external_id).toBe('credit_1')
    expect(result[1]?.external_id).toBe('internal_1')
    expect(result[2]?.external_id).toBe('credit_2')
  })

  it('returns empty array when all transactions are internal transfers', () => {
    const transactions = [
      { ...createTx('internal_1', 100), kind: 'internalTransfer' },
      { ...createTx('internal_2', 200), kind: 'internalTransfer' },
    ]

    const result = transformMercuryTransactions(transactions, runId)

    expect(result).toEqual([])
  })

  it('filters both debits and internal transfers by default', () => {
    const transactions = [
      createTx('credit_1', 100),
      createTx('debit_1', -50),
      { ...createTx('internal_1', 500), kind: 'internalTransfer' },
      createTx('credit_2', 200),
    ]

    const result = transformMercuryTransactions(transactions, runId)

    expect(result).toHaveLength(2)
    expect(result[0]?.external_id).toBe('credit_1')
    expect(result[1]?.external_id).toBe('credit_2')
  })
})
