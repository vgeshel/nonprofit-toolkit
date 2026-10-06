/**
 * Tests for the Benevity report client.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BenevityClient,
  getErrorMessage,
  parseBenevityReport,
} from '../../src/benevity/client'
import type { BenevityReport } from '../../src/benevity/schema'

/**
 * A complete report in the current 23-column format, matching the byte layout
 * Benevity actually serves: preamble, comment fences, a Note line, the donation
 * header, rows, then the four trailer lines.
 */
const CURRENT_REPORT = `Donations Report,
"#-------------------------------------------",
Charity Name,LELEKA FOUNDATION
Charity ID,840-472377309
Period Ending,Mon 1 May 2023 0:00:00
Currency,USD
Payment Method,EFT
Disbursement ID,AA7RTXAPHV
Note,Rounding may be applied to some values in this report.
"#-------------------------------------------",

Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment
Google,LELEKA FOUNDATION,2023-04-01T01:10:39Z,Sergey,Volk,servolk@example.com,Not shared by donor,Not shared by donor,Not shared by donor,94086,,,4EX805TUGH,Unspecified,USD,,Donation,Match,0.00,599.88,0.00,0.00,
N1234,LELEKA FOUNDATION,2023-04-02T05:53:48Z,Svitlana,Kostylova,sk@example.com,Not shared by donor,Not shared by donor,Not shared by donor,92656,,,4EXJNE8R8M,Unspecified,USD,,Donation,Match,0.00,"1,000.00",29.00,0.00,
Totals,,,,,,,,,,,,,,,,,,0.00,"1,599.88",29.00,0.00
Total Donations (Gross),"1,599.88"
Check Fee,0.00
Net Total Payment,"1,570.88"
`

/**
 * The legacy 21-column variant: no Cause Support Fee, no Merchant Fee.
 */
const LEGACY_REPORT = `Donations Report,
"#-------------------------------------------",
Charity Name,LELEKA FOUNDATION
Charity ID,840-472377309
Period Ending,Sat 31 Oct 2015 0:00:00
Currency,USD
Payment Method,CHECK
Disbursement ID,4J7P4KVZ8W
"#-------------------------------------------",

Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Fee Comment
Apple,LELEKA FOUNDATION,2015-10-06T00:00:00Z,Ada,Lovelace,ada@example.com,1 Main St,Cupertino,CA,95014,,,OLD1,One Time,USD,,Payroll,User Donation,50.00,50.00,
Totals,,,,,,,,,,,,,,,,,,50.00,50.00
Total Donations (Gross),100.00
Check Fee,2.00
Net Total Payment,98.00
`

describe('getErrorMessage', () => {
  it('uses the message of an Error', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error throw', () => {
    expect(getErrorMessage('plain string')).toBe('plain string')
    expect(getErrorMessage(42)).toBe('42')
    expect(getErrorMessage(null)).toBe('null')
  })
})

describe('parseBenevityReport', () => {
  it('parses the preamble into report metadata', () => {
    const result = parseBenevityReport(CURRENT_REPORT, 'AA7RTXAPHV.csv')
    expect(result.isOk()).toBe(true)

    const report = result._unsafeUnwrap()
    expect(report.filename).toBe('AA7RTXAPHV.csv')
    expect(report.meta).toEqual({
      charityName: 'LELEKA FOUNDATION',
      charityId: '840-472377309',
      periodEnding: 'Mon 1 May 2023 0:00:00',
      currency: 'USD',
      paymentMethod: 'EFT',
      disbursementId: 'AA7RTXAPHV',
    })
  })

  it('parses donation rows and skips the trailer', () => {
    const report = parseBenevityReport(
      CURRENT_REPORT,
      'AA7RTXAPHV.csv',
    )._unsafeUnwrap()

    expect(report.rows).toHaveLength(2)
    expect(report.rows[0]?.['Transaction ID']).toBe('4EX805TUGH')
    expect(report.rows[1]?.['Match Amount']).toBe('1,000.00')
  })

  it('parses the trailer totals', () => {
    const report = parseBenevityReport(
      CURRENT_REPORT,
      'AA7RTXAPHV.csv',
    )._unsafeUnwrap()

    expect(report.totals).toEqual({
      grossCents: 159988,
      paymentFeeCents: 0,
      netCents: 157088,
    })
  })

  it('parses the legacy variant, defaulting its missing fee columns', () => {
    const report = parseBenevityReport(
      LEGACY_REPORT,
      '4J7P4KVZ8W.csv',
    )._unsafeUnwrap()

    expect(report.meta.paymentMethod).toBe('CHECK')
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]?.['Cause Support Fee']).toBe('0')
    expect(report.rows[0]?.['Merchant Fee']).toBe('0')
    expect(report.totals).toEqual({
      grossCents: 10000,
      paymentFeeCents: 200,
      netCents: 9800,
    })
  })

  it('accepts a report with no donation rows', () => {
    const empty = `Donations Report,
Charity Name,LELEKA FOUNDATION
Charity ID,840-472377309
Period Ending,Mon 1 May 2023 0:00:00
Currency,USD
Payment Method,EFT
Disbursement ID,EMPTY1
Company,Project,Donation Date,Transaction ID,Currency,Total Donation to be Acknowledged,Match Amount
Total Donations (Gross),0.00
Check Fee,0.00
Net Total Payment,0.00
`
    const report = parseBenevityReport(empty, 'EMPTY1.csv')._unsafeUnwrap()
    expect(report.rows).toEqual([])
    expect(report.totals.grossCents).toBe(0)
  })

  it('tolerates a preamble line with no value', () => {
    // A `Key` line with no comma parses to a single-cell record.
    const truncated = CURRENT_REPORT.replace(
      'Payment Method,EFT',
      'Payment Method,EFT\nSome Label',
    )
    const report = parseBenevityReport(
      truncated,
      'AA7RTXAPHV.csv',
    )._unsafeUnwrap()
    expect(report.meta.paymentMethod).toBe('EFT')
  })

  it('treats a valueless preamble field as missing', () => {
    const blankCharityId = CURRENT_REPORT.replace(
      'Charity ID,840-472377309',
      'Charity ID',
    )
    const result = parseBenevityReport(blankCharityId, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'invalid report metadata',
    )
  })

  it('treats a valueless trailer fee line as zero', () => {
    const noFeeValue = CURRENT_REPORT.replace('Check Fee,0.00', 'Check Fee')
    const report = parseBenevityReport(
      noFeeValue,
      'AA7RTXAPHV.csv',
    )._unsafeUnwrap()
    expect(report.totals.paymentFeeCents).toBe(0)
  })

  it('errors when the donation header row is absent', () => {
    const noHeader = `Donations Report,
Charity Name,LELEKA FOUNDATION
Charity ID,840-472377309
Period Ending,Mon 1 May 2023 0:00:00
Currency,USD
Payment Method,EFT
Disbursement ID,AA7RTXAPHV
`
    const result = parseBenevityReport(noHeader, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'broken.csv: no donation header row',
    )
  })

  it('errors when the preamble is missing a required field', () => {
    const noDisbursement = CURRENT_REPORT.replace(
      'Disbursement ID,AA7RTXAPHV\n',
      '',
    )
    const result = parseBenevityReport(noDisbursement, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'broken.csv: invalid report metadata',
    )
  })

  it('errors when the trailer omits the gross total', () => {
    const noGross = CURRENT_REPORT.replace(
      'Total Donations (Gross),"1,599.88"\n',
      '',
    )
    const result = parseBenevityReport(noGross, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'broken.csv: report trailer is missing Total Donations (Gross)',
    )
  })

  it('errors when the trailer omits the net payment', () => {
    const noNet = CURRENT_REPORT.replace('Net Total Payment,"1,570.88"\n', '')
    const result = parseBenevityReport(noNet, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'broken.csv: report trailer is missing Net Total Payment',
    )
  })

  it('errors on an unparseable trailer amount', () => {
    const badGross = CURRENT_REPORT.replace(
      'Total Donations (Gross),"1,599.88"',
      'Total Donations (Gross),lots',
    )
    const result = parseBenevityReport(badGross, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain('Invalid amount: lots')
  })

  it('errors on a donation row with the wrong column count', () => {
    const shortRow = CURRENT_REPORT.replace(
      'Google,LELEKA FOUNDATION,2023-04-01T01:10:39Z,Sergey,Volk,servolk@example.com,Not shared by donor,Not shared by donor,Not shared by donor,94086,,,4EX805TUGH,Unspecified,USD,,Donation,Match,0.00,599.88,0.00,0.00,',
      'Google,LELEKA FOUNDATION,2023-04-01T01:10:39Z',
    )
    const result = parseBenevityReport(shortRow, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'broken.csv: donation row 1 has 3 fields but the header declares 23',
    )
  })

  it('errors on a donation row that fails schema validation', () => {
    const noTxId = CURRENT_REPORT.replace(',4EX805TUGH,', ',,')
    const result = parseBenevityReport(noTxId, 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'broken.csv: invalid donation row 1',
    )
  })

  it('errors on malformed CSV', () => {
    const result = parseBenevityReport('a,"unterminated\n', 'broken.csv')
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(
      'Failed to parse broken.csv',
    )
  })
})

describe('BenevityClient', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(
      tmpdir(),
      `benevity-test-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    )
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('healthCheck', () => {
    it('succeeds when the directory exists', async () => {
      const result = await new BenevityClient(dir).healthCheck()
      expect(result.isOk()).toBe(true)
    })

    it('fails when the path does not exist', async () => {
      const result = await new BenevityClient(join(dir, 'nope')).healthCheck()
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toContain(
        'Cannot access Benevity report directory',
      )
    })

    it('fails when the path is a file rather than a directory', async () => {
      const filePath = join(dir, 'a-file.csv')
      await writeFile(filePath, CURRENT_REPORT)

      const result = await new BenevityClient(filePath).healthCheck()
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toContain(
        'Path is not a directory',
      )
    })
  })

  describe('readAllReports', () => {
    it('reads every CSV in the directory', async () => {
      await writeFile(join(dir, 'AA7RTXAPHV.csv'), CURRENT_REPORT)
      await writeFile(join(dir, '4J7P4KVZ8W.csv'), LEGACY_REPORT)

      const result = await new BenevityClient(dir).readAllReports()
      expect(result.isOk()).toBe(true)

      const reports = result._unsafeUnwrap()
      expect(reports).toHaveLength(2)
      expect(
        reports
          .map((report: BenevityReport) => report.meta.disbursementId)
          .sort(),
      ).toEqual(['4J7P4KVZ8W', 'AA7RTXAPHV'])
    })

    it('ignores non-CSV files such as a manifest', async () => {
      await writeFile(join(dir, 'AA7RTXAPHV.csv'), CURRENT_REPORT)
      await writeFile(join(dir, 'manifest.json'), '{"count":1}')

      const reports = (
        await new BenevityClient(dir).readAllReports()
      )._unsafeUnwrap()
      expect(reports).toHaveLength(1)
    })

    it('returns an empty list when the directory has no CSVs', async () => {
      const reports = (
        await new BenevityClient(dir).readAllReports()
      )._unsafeUnwrap()
      expect(reports).toEqual([])
    })

    it('fails when the directory cannot be read', async () => {
      const result = await new BenevityClient(
        join(dir, 'missing'),
      ).readAllReports()
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toContain(
        'Failed to read Benevity report directory',
      )
    })

    it('fails when a listed CSV cannot be read', async () => {
      // A directory named like a report: readdir lists it, readFile rejects.
      await mkdir(join(dir, 'not-a-file.csv'))

      const result = await new BenevityClient(dir).readAllReports()
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toContain(
        'Failed to read not-a-file.csv',
      )
    })

    it('fails loudly when one report is malformed', async () => {
      await writeFile(join(dir, 'AA7RTXAPHV.csv'), CURRENT_REPORT)
      await writeFile(join(dir, 'broken.csv'), 'Donations Report,\n')

      const result = await new BenevityClient(dir).readAllReports()
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toContain(
        'no donation header row',
      )
    })
  })
})
