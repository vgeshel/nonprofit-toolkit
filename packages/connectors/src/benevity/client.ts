/**
 * Benevity report client.
 *
 * Reads Donations Reports — one CSV per disbursement — from a directory
 * populated by `scripts/benevity-download.ts`, and parses each into its three
 * sections: preamble, donation rows, trailer.
 *
 * Unlike the other CSV connectors, a malformed row is an error rather than a
 * skip. Each report states its own totals, so a dropped row would be caught by
 * reconciliation anyway; failing at the point of damage gives a far better
 * message than an arithmetic mismatch reported later.
 */
import { createConnectorError, type ConnectorError } from '@donations-etl/types'
import { parse } from 'csv-parse/sync'
import {
  err,
  errAsync,
  ok,
  okAsync,
  ResultAsync,
  type Result,
} from 'neverthrow'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import {
  BenevityCsvRowSchema,
  BenevityReportMetaSchema,
  isDonationHeaderRow,
  isTrailerLabel,
  parseMoneyToCents,
  type BenevityCsvRow,
  type BenevityReport,
  type BenevityReportTotals,
} from './schema'

const logger = pino({ name: 'benevity-client' })

/**
 * Maps a preamble label to its key on the parsed metadata object. Preamble
 * lines that are not in this map (`Donations Report`, `Note`) are ignored.
 */
const META_KEYS = new Map<string, string>([
  ['Charity Name', 'charityName'],
  ['Charity ID', 'charityId'],
  ['Period Ending', 'periodEnding'],
  ['Currency', 'currency'],
  ['Payment Method', 'paymentMethod'],
  ['Disbursement ID', 'disbursementId'],
])

const GROSS_LABEL = 'Total Donations (Gross)'
const NET_LABEL = 'Net Total Payment'

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function benevityError(
  type: 'validation' | 'network',
  message: string,
): ConnectorError {
  return createConnectorError(type, 'benevity', message)
}

function resultToResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error)
}

/**
 * Split raw CSV records into the report's three sections.
 */
interface ReportSections {
  meta: Record<string, string>
  header: string[] | null
  dataRows: string[][]
  trailer: [string, string][]
}

function splitSections(records: string[][]): ReportSections {
  const meta: Record<string, string> = {}
  const dataRows: string[][] = []
  const trailer: [string, string][] = []
  let header: string[] | null = null

  for (const record of records) {
    /* istanbul ignore next -- @preserve csv-parse never emits a zero-length record; TypeScript needs the guard */
    const label = record[0] ?? ''

    if (header === null) {
      if (isDonationHeaderRow(record)) {
        header = record
        continue
      }
      const metaKey = META_KEYS.get(label)
      if (metaKey !== undefined) {
        meta[metaKey] = record[1] ?? ''
      }
      continue
    }

    if (isTrailerLabel(label)) {
      trailer.push([label, record[1] ?? ''])
      continue
    }
    dataRows.push(record)
  }

  return { meta, header, dataRows, trailer }
}

/**
 * Build the trailer totals, requiring the two figures used for reconciliation.
 */
function buildTotals(
  trailer: readonly (readonly [string, string])[],
  filename: string,
): Result<BenevityReportTotals, ConnectorError> {
  let grossCents: number | null = null
  let netCents: number | null = null
  let paymentFeeCents = 0

  for (const [label, rawValue] of trailer) {
    if (
      label !== GROSS_LABEL &&
      label !== NET_LABEL &&
      !label.endsWith('Fee')
    ) {
      // `Totals` repeats the per-column sums and `#---` fences the sections;
      // neither carries a figure this reconciliation needs.
      continue
    }

    const parsed = parseMoneyToCents(rawValue)
    if (parsed.isErr()) {
      return err(
        benevityError(
          'validation',
          `${filename}: ${parsed.error.message} in trailer line ${label}`,
        ),
      )
    }

    if (label === GROSS_LABEL) grossCents = parsed.value
    else if (label === NET_LABEL) netCents = parsed.value
    else paymentFeeCents += parsed.value
  }

  if (grossCents === null) {
    return err(
      benevityError(
        'validation',
        `${filename}: report trailer is missing ${GROSS_LABEL}`,
      ),
    )
  }
  if (netCents === null) {
    return err(
      benevityError(
        'validation',
        `${filename}: report trailer is missing ${NET_LABEL}`,
      ),
    )
  }

  return ok({ grossCents, paymentFeeCents, netCents })
}

/**
 * Map a positional data row onto its header columns and validate it.
 */
function buildRows(
  header: readonly string[],
  dataRows: readonly string[][],
  filename: string,
): Result<BenevityCsvRow[], ConnectorError> {
  const rows: BenevityCsvRow[] = []

  for (const [index, record] of dataRows.entries()) {
    const position = index + 1

    if (record.length !== header.length) {
      return err(
        benevityError(
          'validation',
          `${filename}: donation row ${String(position)} has ${String(
            record.length,
          )} fields but the header declares ${String(header.length)}`,
        ),
      )
    }

    const candidate: Record<string, string> = {}
    header.forEach((column, columnIndex) => {
      /* istanbul ignore next -- @preserve record length is checked against the header above; TypeScript needs the guard */
      candidate[column] = record[columnIndex] ?? ''
    })

    const parsed = BenevityCsvRowSchema.safeParse(candidate)
    if (!parsed.success) {
      return err(
        benevityError(
          'validation',
          `${filename}: invalid donation row ${String(position)}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
        ),
      )
    }

    rows.push(parsed.data)
  }

  return ok(rows)
}

/**
 * Parse one Donations Report.
 */
export function parseBenevityReport(
  content: string,
  filename: string,
): Result<BenevityReport, ConnectorError> {
  let records: string[][]
  try {
    records = parse(content, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    })
  } catch (error) {
    return err(
      benevityError(
        'validation',
        `Failed to parse ${filename}: ${getErrorMessage(error)}`,
      ),
    )
  }

  const sections = splitSections(records)
  if (sections.header === null) {
    return err(
      benevityError(
        'validation',
        `${filename}: no donation header row (expected a row starting "Company,Project")`,
      ),
    )
  }

  const meta = BenevityReportMetaSchema.safeParse(sections.meta)
  if (!meta.success) {
    return err(
      benevityError(
        'validation',
        `${filename}: invalid report metadata: ${meta.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      ),
    )
  }

  return buildRows(sections.header, sections.dataRows, filename).andThen(
    (rows) =>
      buildTotals(sections.trailer, filename).map((totals) => ({
        filename,
        meta: meta.data,
        rows,
        totals,
      })),
  )
}

/**
 * Interface for the Benevity client, to allow injection in tests.
 */
export interface IBenevityClient {
  readAllReports(): ResultAsync<BenevityReport[], ConnectorError>
  healthCheck(): ResultAsync<void, ConnectorError>
}

/**
 * Reads Benevity Donations Reports from a directory.
 */
export class BenevityClient implements IBenevityClient {
  private readonly reportDirPath: string

  constructor(reportDirPath: string) {
    this.reportDirPath = reportDirPath
  }

  healthCheck(): ResultAsync<void, ConnectorError> {
    return ResultAsync.fromPromise(stat(this.reportDirPath), (error) =>
      benevityError(
        'network',
        `Cannot access Benevity report directory: ${getErrorMessage(error)}`,
      ),
    ).andThen((stats) => {
      if (!stats.isDirectory()) {
        return errAsync(
          benevityError(
            'validation',
            `Path is not a directory: ${this.reportDirPath}`,
          ),
        )
      }
      return okAsync(undefined)
    })
  }

  readAllReports(): ResultAsync<BenevityReport[], ConnectorError> {
    return ResultAsync.fromPromise(readdir(this.reportDirPath), (error) =>
      benevityError(
        'network',
        `Failed to read Benevity report directory: ${getErrorMessage(error)}`,
      ),
    ).andThen((files) => {
      const csvFiles = files.filter((file) =>
        file.toLowerCase().endsWith('.csv'),
      )

      if (csvFiles.length === 0) {
        return okAsync([])
      }

      logger.info(
        { count: csvFiles.length, dir: this.reportDirPath },
        'Found Benevity reports',
      )

      return ResultAsync.combine(
        csvFiles.map((filename) => this.readSingleReport(filename)),
      )
    })
  }

  private readSingleReport(
    filename: string,
  ): ResultAsync<BenevityReport, ConnectorError> {
    return ResultAsync.fromPromise(
      readFile(join(this.reportDirPath, filename), 'utf-8'),
      (error) =>
        benevityError(
          'network',
          `Failed to read ${filename}: ${getErrorMessage(error)}`,
        ),
    ).andThen((content) =>
      resultToResultAsync(parseBenevityReport(content, filename)),
    )
  }
}
