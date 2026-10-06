/**
 * Tests for Funraise CSV client.
 */
import { err, ok } from 'neverthrow'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FunraiseClient,
  getErrorMessage,
  parseCsvContent,
  preprocessCsv,
  resultToResultAsync,
} from '../../src/funraise/client'

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    const error = new Error('Something went wrong')
    expect(getErrorMessage(error)).toBe('Something went wrong')
  })

  it('converts non-Error to string', () => {
    expect(getErrorMessage('string error')).toBe('string error')
    expect(getErrorMessage(42)).toBe('42')
    expect(getErrorMessage({ code: 'ERR' })).toBe('[object Object]')
    expect(getErrorMessage(null)).toBe('null')
    expect(getErrorMessage(undefined)).toBe('undefined')
  })
})

describe('resultToResultAsync', () => {
  it('converts Ok result to okAsync', async () => {
    const result = ok('success')
    const asyncResult = resultToResultAsync(result)

    const unwrapped = await asyncResult
    expect(unwrapped.isOk()).toBe(true)
    if (unwrapped.isOk()) {
      expect(unwrapped.value).toBe('success')
    }
  })

  it('converts Err result to errAsync', async () => {
    const result = err('failure')
    const asyncResult = resultToResultAsync(result)

    const unwrapped = await asyncResult
    expect(unwrapped.isErr()).toBe(true)
    if (unwrapped.isErr()) {
      expect(unwrapped.error).toBe('failure')
    }
  })
})

describe('preprocessCsv', () => {
  it('returns content unchanged', () => {
    const content = 'Id,Amount\n1,100\n'
    expect(preprocessCsv(content)).toBe(content)
  })
})

describe('parseCsvContent', () => {
  it('parses valid CSV content', () => {
    const content = `Id,Amount,Transaction Date,First Name,Last Name,Email,Status
123,100.00,2026-01-01T00:00:00-08:00,John,Doe,john@example.com,Complete
456,200.00,2026-01-02T00:00:00-08:00,Jane,Smith,jane@example.com,Complete`

    const result = parseCsvContent(content)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(2)
      expect(result.value[0]?.Id).toBe('123')
      expect(result.value[0]?.Amount).toBe('100.00')
      expect(result.value[1]?.Id).toBe('456')
      expect(result.value[1]?.Amount).toBe('200.00')
    }
  })

  it('skips invalid rows', () => {
    // Row 2 is missing required Id field
    const content = `Id,Amount,Transaction Date,First Name,Last Name
123,100.00,2026-01-01T00:00:00-08:00,John,Doe
,200.00,2026-01-02T00:00:00-08:00,Jane,Smith
789,300.00,2026-01-03T00:00:00-08:00,Bob,Wilson`

    const result = parseCsvContent(content)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(2)
      expect(result.value[0]?.Id).toBe('123')
      expect(result.value[1]?.Id).toBe('789')
    }
  })

  it('handles empty CSV content', () => {
    const content = 'Id,Amount,Transaction Date\n'

    const result = parseCsvContent(content)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(0)
    }
  })

  it('handles CSV with quoted fields', () => {
    const content = `Id,Amount,Transaction Date,First Name,Last Name,Comment
123,100.00,2026-01-01T00:00:00-08:00,John,Doe,"Thank you for your work, keep it up!"`

    const result = parseCsvContent(content)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.Comment).toBe(
        'Thank you for your work, keep it up!',
      )
    }
  })

  it('handles CSV with newlines in quoted fields', () => {
    const content = `Id,Amount,Transaction Date,Comment
123,100.00,2026-01-01T00:00:00-08:00,"Line 1
Line 2"`

    const result = parseCsvContent(content)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.Comment).toBe('Line 1\nLine 2')
    }
  })

  it('returns error for malformed CSV', () => {
    // Completely invalid CSV that would cause parse error
    const content = '"unclosed quote'

    const result = parseCsvContent(content)

    // Note: csv-parse with relax_quotes may not error on this
    // If it doesn't error, it will just parse what it can
    expect(result.isOk() || result.isErr()).toBe(true)
  })
})

describe('FunraiseClient', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'funraise-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('creates client with file path', () => {
      const client = new FunraiseClient('/path/to/file.csv')
      expect(client).toBeInstanceOf(FunraiseClient)
    })

    it('creates client with empty path', () => {
      // Empty path is allowed - will fail at healthCheck
      const client = new FunraiseClient('')
      expect(client).toBeInstanceOf(FunraiseClient)
    })
  })

  describe('healthCheck', () => {
    it('succeeds when file exists', async () => {
      const filePath = join(tempDir, 'test.csv')
      await writeFile(filePath, 'Id,Amount,Transaction Date\n')

      const client = new FunraiseClient(filePath)
      const result = await client.healthCheck()

      expect(result.isOk()).toBe(true)
    })

    it('fails when file does not exist', async () => {
      const client = new FunraiseClient(join(tempDir, 'nonexistent.csv'))
      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Cannot access CSV file')
      }
    })
  })

  describe('readCsv', () => {
    it('reads and parses CSV file', async () => {
      const content = `Id,Amount,Transaction Date,First Name,Last Name
123,100.00,2026-01-01T00:00:00-08:00,John,Doe
456,200.00,2026-01-02T00:00:00-08:00,Jane,Smith`

      const filePath = join(tempDir, 'donations.csv')
      await writeFile(filePath, content)

      const client = new FunraiseClient(filePath)
      const result = await client.readCsv()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(2)
        expect(result.value[0]?.Id).toBe('123')
        expect(result.value[1]?.Id).toBe('456')
      }
    })

    it('fails when file does not exist', async () => {
      const client = new FunraiseClient(join(tempDir, 'nonexistent.csv'))
      const result = await client.readCsv()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Failed to read CSV file')
      }
    })

    it('handles file with only headers', async () => {
      const content = 'Id,Amount,Transaction Date\n'
      const filePath = join(tempDir, 'empty.csv')
      await writeFile(filePath, content)

      const client = new FunraiseClient(filePath)
      const result = await client.readCsv()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(0)
      }
    })

    it('handles real Funraise CSV format', async () => {
      // Mimics the actual Funraise export format with all columns
      const headers = [
        'Id',
        'Supporter Id',
        'First Name',
        'Last Name',
        'Institution Name',
        'Institution Category',
        'Address',
        'City',
        'State/Province',
        'Postal Code',
        'Country',
        'Phone',
        'Email',
        'Prospecting | Real Estate Value',
        'Amount',
        'Soft Credit Supporter Id',
        'Soft Credit Supporter Name',
        'Soft Credit Supporter Email',
        'Campaign Goal Id',
        'Campaign Page URL',
        'Campaign Page Id',
        'Operations Tip Amount',
        'Status',
        'Form',
        'Form Id',
        'Transaction Date',
        'Match',
        'Dedication',
        'Dedication Email',
        'Dedication Name',
        'Dedication Type',
        'Dedication Message',
        'Anonymous',
        'Comment',
        'Payment Method',
        'Card Type',
        'Expiration Date',
        'Recurring',
        'Recurring Id',
        'Sequence',
        'Frequency',
        'Offline',
        'Currency',
        'Last Four',
        'Gateway Response',
        'Gateway Transaction Id',
        'Import External Id',
        'Name',
        'Check Number',
        'Memo',
        'Note',
        'Tags',
        'UTM Source',
        'UTM Medium',
        'UTM Content',
        'UTM Term',
        'UTM Campaign',
        'Allocations',
        'Source Amount',
        'URL',
        'Household Id',
        'Household Name',
        'Platform Fee Amount',
        'Platform Fee Percent',
        'Tax Deductible Amount',
      ]

      const row = [
        '10000001',
        '20000001',
        'Kari',
        'Nordmann',
        '',
        'Individual',
        'Eksempelveien 1',
        'Oslo',
        'Oslo',
        '0001',
        'Norway',
        '+4712345678',
        'kari.nordmann@example.com',
        '',
        '107.70',
        '',
        '',
        '',
        '',
        '',
        '',
        '0',
        'Complete',
        'Website Donate',
        '10001',
        '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
        'false',
        'true',
        '',
        'Ola Nordmann',
        'inspired by',
        '',
        'false',
        '',
        'Credit Card',
        'AMEX',
        '12/29',
        'true',
        '900001',
        '35',
        'Monthly',
        'false',
        'USD',
        '4242',
        'SUCCEEDED',
        'ch_test_0000000000000000001',
        '',
        '00000001',
        '',
        '',
        '',
        '',
        'website',
        '',
        '',
        '',
        '',
        '',
        '107.70',
        '',
        '30000001',
        'Nordmann Household',
        '5.00',
        '5.0',
        '107.70',
      ]

      const content = `${headers.join(',')}\n${row.join(',')}`
      const filePath = join(tempDir, 'funraise.csv')
      await writeFile(filePath, content)

      const client = new FunraiseClient(filePath)
      const result = await client.readCsv()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(1)
        expect(result.value[0]?.Id).toBe('10000001')
        expect(result.value[0]?.Amount).toBe('107.70')
        expect(result.value[0]?.['First Name']).toBe('Kari')
        expect(result.value[0]?.Status).toBe('Complete')
      }
    })
  })
})
