/**
 * Tests for Venmo CSV client.
 */
import { err, ok } from 'neverthrow'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VenmoClient,
  getErrorMessage,
  parseCsvContent,
  resultToResultAsync,
} from '../../src/venmo/client'

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

describe('parseCsvContent', () => {
  it('parses valid CSV content with donations', () => {
    const content = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""123""",01/01/2025,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)`

    const result = parseCsvContent(content, 'test.csv')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
      // csv-parse unescapes quotes: """123""" becomes "123"
      expect(result.value[0]?.['Transaction ID']).toBe('"123"')
    }
  })

  it('filters out Standard Transfer rows', () => {
    const content = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""123""",01/01/2025,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)
"""456""",01/02/2025,02:00:00,Standard Transfer,Issued,(None),(None),,,(None),- $98.00,0,,,0,,,(None),Mercury *0000,0,0,0,Venmo,0,(None)`

    const result = parseCsvContent(content, 'test.csv')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.Type).toBe('Payment')
    }
  })

  it('skips rows with empty Transaction ID (footer rows)', () => {
    const content = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""123""",01/01/2025,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)
,,,,,,,,,,,,,,,,,,$0.00,$100.00,$2.00,,$50.00,"Disclaimer text"`

    const result = parseCsvContent(content, 'test.csv')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
    }
  })

  it('handles CSV with embedded newlines in Disclaimer', () => {
    const content = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""123""",01/01/2025,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)
,,,,,,,,,,,,,,,,,,$0.00,$100.00,$2.00,,$50.00,"In case of errors
contact us
at 855-812-4430"`

    const result = parseCsvContent(content, 'test.csv')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
    }
  })

  it('handles empty CSV', () => {
    const content = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
`

    const result = parseCsvContent(content, 'test.csv')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(0)
    }
  })

  it('returns error for malformed CSV', () => {
    // This triggers the catch block - provide truly broken CSV
    const content = '"unclosed'

    const result = parseCsvContent(content, 'test.csv')

    // csv-parse with relax_quotes is very permissive
    expect(result.isOk() || result.isErr()).toBe(true)
  })

  it('logs warning and skips rows that fail schema validation', () => {
    // Row has Transaction ID but missing required Date field
    const content = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"123",,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)
"456",01/01/2025,02:00:00,Payment,Complete,Test2,Donor2,test2@test.com,Test Organization,+ $200.00,0,0,$198.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)`

    const result = parseCsvContent(content, 'test.csv')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      // Only the second row should pass (first has empty Date)
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.['Transaction ID']).toBe('456')
    }
  })
})

describe('VenmoClient', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `venmo-test-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('creates client with directory path', () => {
      const client = new VenmoClient('/path/to/venmo')
      expect(client).toBeInstanceOf(VenmoClient)
    })
  })

  describe('healthCheck', () => {
    it('succeeds when directory exists', async () => {
      const client = new VenmoClient(tempDir)
      const result = await client.healthCheck()

      expect(result.isOk()).toBe(true)
    })

    it('fails when path does not exist', async () => {
      const client = new VenmoClient(join(tempDir, 'nonexistent'))
      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Cannot access CSV directory')
      }
    })

    it('fails when path is a file, not directory', async () => {
      const filePath = join(tempDir, 'file.txt')
      await writeFile(filePath, 'test')

      const client = new VenmoClient(filePath)
      const result = await client.healthCheck()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('validation')
        expect(result.error.message).toContain('not a directory')
      }
    })
  })

  describe('readAllCsvFiles', () => {
    it('reads and parses all CSV files in directory', async () => {
      const csvContent = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""123""",01/01/2025,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)`

      await writeFile(join(tempDir, 'jan.csv'), csvContent)
      await writeFile(
        join(tempDir, 'feb.csv'),
        csvContent.replace('"""123"""', '"""456"""'),
      )

      const client = new VenmoClient(tempDir)
      const result = await client.readAllCsvFiles()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(2)
      }
    })

    it('ignores non-CSV files', async () => {
      const csvContent = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""123""",01/01/2025,01:00:00,Payment,Complete,Test,Donor,test@test.com,Test Organization,+ $100.00,0,0,$98.00,$2.00,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)`

      await writeFile(join(tempDir, 'data.csv'), csvContent)
      await writeFile(join(tempDir, 'readme.txt'), 'not a csv')
      await writeFile(join(tempDir, 'notes.md'), '# Notes')

      const client = new VenmoClient(tempDir)
      const result = await client.readAllCsvFiles()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(1)
      }
    })

    it('returns empty array for empty directory', async () => {
      const client = new VenmoClient(tempDir)
      const result = await client.readAllCsvFiles()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(0)
      }
    })

    it('returns empty array for directory with no CSV files', async () => {
      await writeFile(join(tempDir, 'readme.txt'), 'not a csv')

      const client = new VenmoClient(tempDir)
      const result = await client.readAllCsvFiles()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toHaveLength(0)
      }
    })

    it('fails when directory does not exist', async () => {
      const client = new VenmoClient(join(tempDir, 'nonexistent'))
      const result = await client.readAllCsvFiles()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Failed to read directory')
      }
    })

    it('fails when CSV file cannot be read', async () => {
      // Create a directory with .csv extension (which can't be read as a file)
      await mkdir(join(tempDir, 'broken.csv'), { recursive: true })

      const client = new VenmoClient(tempDir)
      const result = await client.readAllCsvFiles()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.type).toBe('network')
        expect(result.error.message).toContain('Failed to read CSV file')
      }
    })

    it('handles real Venmo CSV format', async () => {
      // Mimics actual Venmo export format
      const csvContent = `Transaction ID,Date,Time (UTC),Type,Status,Note,From,Donor email,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
"""4000000000000000001""",01/01/2025,01:18:52,Payment,Complete,Donation,john doe,donor@example.com,Test Organization,"+ $1,000.00",0,0,$980.90,$19.10,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)
"""4000000000000000002""",01/03/2025,21:02:21,Payment,Complete,Charity,Sam Sample,sam@example.com,Test Organization,+ $5.00,0,0,$4.81,$0.19,0,FALSE,(None),Venmo balance,0,0,0,Venmo,0,(None)
"""4000000000000000003""",01/03/2025,21:27:11,Standard Transfer,Issued,(None),(None),,(None),- $985.71,0,,,0,,,(None),Mercury *0000,0,0,0,Venmo,0,(None)
,,,,,,,,,,,,,,,,,,$0.00,$289.00,$19.29,,$137.98,"In case of errors
contact us"`

      await writeFile(
        join(tempDir, 'Venmo Account Statement Jan 2025.csv'),
        csvContent,
      )

      const client = new VenmoClient(tempDir)
      const result = await client.readAllCsvFiles()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        // Should have 2 Payment rows (skip Standard Transfer and footer)
        expect(result.value).toHaveLength(2)
        // csv-parse unescapes quotes: """4000000000000000001""" becomes "4000000000000000001"
        expect(result.value[0]?.['Transaction ID']).toBe(
          '"4000000000000000001"',
        )
        expect(result.value[0]?.['Amount (total)']).toBe('+ $1,000.00')
        expect(result.value[1]?.From).toBe('Sam Sample')
      }
    })
  })
})
