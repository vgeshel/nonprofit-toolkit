/**
 * Tests for Funraise connector.
 */
import type { ConnectorError } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { IFunraiseClient } from '../../src/funraise/client'
import { FunraiseConnector } from '../../src/funraise/connector'
import type { FunraiseCsvRow } from '../../src/funraise/schema'

/**
 * Create a mock Funraise client for testing.
 */
function createMockClient(
  rows: FunraiseCsvRow[] = [],
  healthError?: ConnectorError,
  readError?: ConnectorError,
): IFunraiseClient {
  return {
    healthCheck: vi.fn(() =>
      healthError ? errAsync(healthError) : okAsync(undefined),
    ),
    readCsv: vi.fn(() => (readError ? errAsync(readError) : okAsync(rows))),
  }
}

/**
 * Create a sample CSV row for testing.
 */
function createSampleRow(id: string, amount: string): FunraiseCsvRow {
  return {
    Id: id,
    Amount: amount,
    'Transaction Date': '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
    'Supporter Id': '20000001',
    'First Name': 'Test',
    'Last Name': 'User',
    'Institution Name': '',
    'Institution Category': '',
    Address: '',
    City: '',
    'State/Province': '',
    'Postal Code': '',
    Country: '',
    Phone: '',
    Email: 'test@example.com',
    Status: 'Complete',
    'Payment Method': 'Credit Card',
    'Card Type': '',
    Currency: 'USD',
    'Platform Fee Amount': '5.00',
    'Platform Fee Percent': '5.0',
    'Tax Deductible Amount': '',
    'Source Amount': '',
    Form: 'Website Donate',
    'Form Id': '',
    'Campaign Goal Id': '',
    'Campaign Page URL': '',
    'Campaign Page Id': '',
    'UTM Source': 'website',
    'UTM Medium': '',
    'UTM Content': '',
    'UTM Term': '',
    'UTM Campaign': '',
    Dedication: '',
    'Dedication Email': '',
    'Dedication Name': '',
    'Dedication Type': '',
    'Dedication Message': '',
    Recurring: '',
    'Recurring Id': '',
    Sequence: '',
    Frequency: '',
    'Prospecting | Real Estate Value': '',
    'Soft Credit Supporter Id': '',
    'Soft Credit Supporter Name': '',
    'Soft Credit Supporter Email': '',
    'Operations Tip Amount': '',
    Match: '',
    Anonymous: '',
    Comment: '',
    'Expiration Date': '',
    Offline: '',
    'Last Four': '',
    'Gateway Response': '',
    'Gateway Transaction Id': '',
    'Import External Id': '',
    Name: '',
    'Check Number': '',
    Memo: '',
    Note: '',
    Tags: '',
    Allocations: '',
    URL: '',
    'Household Id': '',
    'Household Name': '',
  }
}

describe('FunraiseConnector', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000'

  describe('constructor', () => {
    it('creates connector with config', () => {
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: createMockClient(),
      })

      expect(connector.source).toBe('funraise')
    })
  })

  describe('healthCheck', () => {
    it('returns ok when file is accessible', async () => {
      const mockClient = createMockClient()
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.healthCheck()

      expect(result.isOk()).toBe(true)
      expect(mockClient.healthCheck).toHaveBeenCalled()
    })

    it('returns error when file is not accessible', async () => {
      const error: ConnectorError = {
        type: 'network',
        source: 'funraise',
        message: 'Cannot access CSV file',
        retryable: false,
      }
      const mockClient = createMockClient([], error)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/nonexistent/file.csv' },
        client: mockClient,
      })

      const result = await connector.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
      }
    })
  })

  describe('fetchPage', () => {
    it('returns all events in a single page', async () => {
      const rows = [
        createSampleRow('1', '100.00'),
        createSampleRow('2', '200.00'),
        createSampleRow('3', '300.00'),
      ]
      const mockClient = createMockClient(rows)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchPage({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(3)
        expect(result.value.hasMore).toBe(false)
        expect(result.value.nextCursor).toBeUndefined()
      }
    })

    it('transforms rows to DonationEvents', async () => {
      const rows = [createSampleRow('123', '107.70')]
      const mockClient = createMockClient(rows)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchPage({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        const event = result.value.events[0]
        expect(event?.source).toBe('funraise')
        expect(event?.external_id).toBe('123')
        expect(event?.amount_cents).toBe(10770)
        expect(event?.fee_cents).toBe(500)
        expect(event?.run_id).toBe(runId)
      }
    })

    it('returns error when CSV read fails', async () => {
      const error: ConnectorError = {
        type: 'network',
        source: 'funraise',
        message: 'Failed to read CSV file',
        retryable: false,
      }
      const mockClient = createMockClient([], undefined, error)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchPage({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
      }
    })

    it('returns empty events for empty CSV', async () => {
      const mockClient = createMockClient([])
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchPage({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(0)
        expect(result.value.hasMore).toBe(false)
      }
    })

    it('ignores cursor parameter (no pagination for CSV)', async () => {
      const rows = [createSampleRow('1', '100.00')]
      const mockClient = createMockClient(rows)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchPage(
        {
          from: DateTime.utc(),
          to: DateTime.utc(),
          runId,
        },
        'some-cursor',
      )

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.events).toHaveLength(1)
      }
    })
  })

  describe('fetchAll', () => {
    it('returns all events', async () => {
      const rows = [
        createSampleRow('1', '100.00'),
        createSampleRow('2', '200.00'),
      ]
      const mockClient = createMockClient(rows)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchAll({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(2)
        expect(result.value[0]?.external_id).toBe('1')
        expect(result.value[1]?.external_id).toBe('2')
      }
    })

    it('returns error when CSV read fails', async () => {
      const error: ConnectorError = {
        type: 'validation',
        source: 'funraise',
        message: 'Failed to parse CSV',
        retryable: false,
      }
      const mockClient = createMockClient([], undefined, error)
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchAll({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('validation')
      }
    })

    it('returns empty array for empty CSV', async () => {
      const mockClient = createMockClient([])
      const connector = new FunraiseConnector({
        config: { csvFilePath: '/path/to/file.csv' },
        client: mockClient,
      })

      const result = await connector.fetchAll({
        from: DateTime.utc(),
        to: DateTime.utc(),
        runId,
      })

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(0)
      }
    })
  })
})
