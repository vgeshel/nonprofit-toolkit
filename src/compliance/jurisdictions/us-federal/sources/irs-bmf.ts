import { parse } from 'csv-parse/sync'
import {
  ResultAsync,
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
} from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { fetchDownloadWithCache } from '../../../sources/download-cache.ts'
import type { SourceError } from '../../../sources/errors.ts'
import type {
  Entity,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

const BMF_PAGE_URL =
  'https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf'

export const IRS_EO_BMF_CALIFORNIA_URL =
  'https://www.irs.gov/pub/irs-soi/eo_ca.csv'

const UPDATED_POSTING_DATE = '2026-04-14'

const STATE_CSV_CODES: Readonly<Record<string, string>> = {
  AL: 'al',
  AK: 'ak',
  AZ: 'az',
  AR: 'ar',
  CA: 'ca',
  CO: 'co',
  CT: 'ct',
  DE: 'de',
  DC: 'dc',
  FL: 'fl',
  GA: 'ga',
  HI: 'hi',
  ID: 'id',
  IL: 'il',
  IN: 'in',
  IA: 'ia',
  KS: 'ks',
  KY: 'ky',
  LA: 'la',
  ME: 'me',
  MD: 'md',
  MA: 'ma',
  MI: 'mi',
  MN: 'mn',
  MS: 'ms',
  MO: 'mo',
  MT: 'mt',
  NE: 'ne',
  NV: 'nv',
  NH: 'nh',
  NJ: 'nj',
  NM: 'nm',
  NY: 'ny',
  NC: 'nc',
  ND: 'nd',
  OH: 'oh',
  OK: 'ok',
  OR: 'or',
  PA: 'pa',
  RI: 'ri',
  SC: 'sc',
  SD: 'sd',
  TN: 'tn',
  TX: 'tx',
  UT: 'ut',
  VT: 'vt',
  VA: 'va',
  WA: 'wa',
  WV: 'wv',
  WI: 'wi',
  WY: 'wy',
  PR: 'pr',
}

const BmfCsvRowSchema = z
  .object({
    EIN: z.string(),
    NAME: z.string(),
    ICO: z.string(),
    STREET: z.string(),
    CITY: z.string(),
    STATE: z.string(),
    ZIP: z.string(),
    GROUP: z.string(),
    SUBSECTION: z.string(),
    AFFILIATION: z.string(),
    CLASSIFICATION: z.string(),
    RULING: z.string(),
    DEDUCTIBILITY: z.string(),
    FOUNDATION: z.string(),
    ACTIVITY: z.string(),
    ORGANIZATION: z.string(),
    STATUS: z.string(),
    TAX_PERIOD: z.string(),
    ASSET_CD: z.string(),
    INCOME_CD: z.string(),
    FILING_REQ_CD: z.string(),
    PF_FILING_REQ_CD: z.string(),
    ACCT_PD: z.string(),
    ASSET_AMT: z.string(),
    INCOME_AMT: z.string(),
    REVENUE_AMT: z.string(),
    NTEE_CD: z.string(),
    SORT_NAME: z.string(),
  })
  .strict()
  .transform((row) => ({
    ein: trimCell(row.EIN),
    name: trimCell(row.NAME),
    inCareOf: trimCell(row.ICO),
    street: trimCell(row.STREET),
    city: trimCell(row.CITY),
    state: trimCell(row.STATE),
    zip: trimCell(row.ZIP),
    group: trimCell(row.GROUP),
    subsection: trimCell(row.SUBSECTION),
    affiliation: trimCell(row.AFFILIATION),
    classification: trimCell(row.CLASSIFICATION),
    ruling: trimCell(row.RULING),
    deductibility: trimCell(row.DEDUCTIBILITY),
    foundation: trimCell(row.FOUNDATION),
    activity: trimCell(row.ACTIVITY),
    organization: trimCell(row.ORGANIZATION),
    status: trimCell(row.STATUS),
    taxPeriod: trimCell(row.TAX_PERIOD),
    assetCode: trimCell(row.ASSET_CD),
    incomeCode: trimCell(row.INCOME_CD),
    filingRequirementCode: trimCell(row.FILING_REQ_CD),
    privateFoundationFilingRequirementCode: trimCell(row.PF_FILING_REQ_CD),
    accountingPeriod: trimCell(row.ACCT_PD),
    assetAmount: trimCell(row.ASSET_AMT),
    incomeAmount: trimCell(row.INCOME_AMT),
    revenueAmount: trimCell(row.REVENUE_AMT),
    nteeCode: trimCell(row.NTEE_CD),
    sortName: trimCell(row.SORT_NAME),
  }))

export type IrsEoBmfRow = z.infer<typeof BmfCsvRowSchema>

function trimCell(value: string): string {
  return value.trim()
}

function normaliseEin(value: string): string {
  return value.replace(/-/g, '').trim()
}

function parseBmfCsv(
  content: string,
): Result<readonly IrsEoBmfRow[], SourceError> {
  let records: unknown[]
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: false,
    })
  } catch (parseError) {
    return err({
      type: 'parse',
      message: `Failed to parse IRS EO BMF CSV: ${String(parseError)}`,
    })
  }

  const rows: IrsEoBmfRow[] = []
  for (const record of records) {
    const parsed = BmfCsvRowSchema.safeParse(record)
    if (!parsed.success) {
      return err({
        type: 'parse',
        message: `IRS EO BMF CSV row failed schema validation: ${parsed.error.message}`,
      })
    }
    rows.push(parsed.data)
  }
  return ok(rows)
}

function resultToAsync<T>(
  result: Result<T, SourceError>,
): ResultAsync<T, SourceError> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error)
}

function selectBmfCsvUrl(entity: Entity): Result<string, SourceError> {
  const code = STATE_CSV_CODES[entity.mailing_address_region.toUpperCase()]
  if (code === undefined) {
    return err({
      type: 'validation',
      message: `IRS EO BMF source cannot select a state CSV for ${entity.mailing_address_region}`,
    })
  }
  return ok(`https://www.irs.gov/pub/irs-soi/eo_${code}.csv`)
}

function downloadBmfCsv(
  entity: Entity,
  ctx: SourceContext,
): ResultAsync<readonly IrsEoBmfRow[], SourceError> {
  const urlResult = selectBmfCsvUrl(entity)
  if (urlResult.isErr()) {
    return errAsync(urlResult.error)
  }
  const url = urlResult.value
  if (ctx.downloadCache !== undefined) {
    return fetchDownloadWithCache({
      sourceId: 'irs-eo-bmf',
      url,
      fetch: ctx.fetch,
      cache: ctx.downloadCache,
      now: ctx.now,
    }).andThen((download) =>
      resultToAsync(parseBmfCsv(new TextDecoder().decode(download.bytes))),
    )
  }

  return ResultAsync.fromPromise(
    ctx.fetch(url, { headers: {} }),
    toNetworkError,
  ).andThen((response) => {
    if (!response.ok) {
      return errAsync<readonly IrsEoBmfRow[], SourceError>({
        type: 'http',
        status: response.status,
        message: `IRS EO BMF CSV returned HTTP ${String(response.status)} for ${url}`,
      })
    }
    return ResultAsync.fromPromise(response.text(), toNetworkError).andThen(
      (text) => resultToAsync(parseBmfCsv(text)),
    )
  })
}

function toNetworkError(error: unknown): SourceError {
  return {
    type: 'network',
    message: `IRS EO BMF download failed: ${String(error)}`,
  }
}

function findBmfRow(
  rows: readonly IrsEoBmfRow[],
  ein: string,
): IrsEoBmfRow | null {
  const target = normaliseEin(ein)
  return rows.find((row) => normaliseEin(row.ein) === target) ?? null
}

function decodeBmfCodes(row: IrsEoBmfRow): Record<string, string> {
  return {
    subsection: decodeSubsection(row.subsection),
    affiliation: decodeAffiliation(row.affiliation),
    deductibility: decodeDeductibility(row.deductibility),
    foundation: decodeFoundation(row.foundation),
    status: decodeStatus(row.status),
  }
}

function decodeSubsection(code: string): string {
  return code === '03' ? '501(c)(3)' : `Unknown subsection code ${code}`
}

function decodeAffiliation(code: string): string {
  return code === '3' ? 'Independent' : `Unknown affiliation code ${code}`
}

function decodeDeductibility(code: string): string {
  return code === '1'
    ? 'Contributions are deductible'
    : `Unknown deductibility code ${code}`
}

function decodeFoundation(code: string): string {
  return code === '15'
    ? 'Public charity: substantial public/government support'
    : `Unknown foundation code ${code}`
}

function decodeStatus(code: string): string {
  return code === '01'
    ? 'Unconditional Exemption'
    : `Unknown status code ${code}`
}

function buildOutput(
  ctx: SourceContext,
  row: IrsEoBmfRow | null,
): SourceRunOutput {
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'irs-eo-bmf',
      fetched_at: ctx.now().toISOString(),
      payload:
        row === null
          ? {
              matchStatus: 'not_found',
              upstreamPublishedAt: UPDATED_POSTING_DATE,
            }
          : {
              matchStatus: 'found',
              upstreamPublishedAt: UPDATED_POSTING_DATE,
              row,
              decoded: decodeBmfCodes(row),
            },
    },
    findings: [],
  }
}

export const irsEoBmfSource: Source = {
  id: 'irs-eo-bmf',
  jurisdiction: 'us-federal',
  kind: 'api',
  authRequired: false,
  description:
    'Looks up an EIN in the IRS Exempt Organizations Business Master File official CSV extract.',
  accessUrl: BMF_PAGE_URL,
  accessMethod: 'official_bulk_download',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-04-28T00:00:00.000Z',
    upstreamPublishedAt: UPDATED_POSTING_DATE,
  },
  tosUrl: BMF_PAGE_URL,
  run(entity, ctx) {
    const ein = ctx.identifiers['us-federal']?.ein
    if (ein === undefined) {
      return errAsync({
        type: 'validation',
        message: 'IRS EO BMF source requires a us-federal EIN identifier.',
      })
    }
    return downloadBmfCsv(entity, ctx).map((rows) =>
      buildOutput(ctx, findBmfRow(rows, ein)),
    )
  },
}

export const _internal = {
  parseBmfCsv,
  selectBmfCsvUrl,
  normaliseEin,
  decodeBmfCodes,
}
