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
import {
  fetchDownloadWithCache,
  type CachedDownloadMetadata,
} from '../../../sources/download-cache.ts'
import type { SourceError } from '../../../sources/errors.ts'
import { makeDownloadEvidence } from '../../../sources/evidence.ts'
import type {
  Entity,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

const REPORTS_URL = 'https://www.oag.ca.gov/charities/reports'
const REGISTRY_REPORTS_UPSTREAM_PUBLISHED_AT = '2026-04-15'

export const CA_AG_REGISTRY_LISTS = [
  {
    category: 'may_operate_or_solicit',
    url: 'https://www.oag.ca.gov/sites/all/files/agweb/pdfs/charities/reports/charities-may-operate.csv',
  },
  {
    category: 'may_not_operate_or_solicit',
    url: 'https://www.oag.ca.gov/sites/all/files/agweb/pdfs/charities/reports/charities-may-not-operate.csv',
  },
  {
    category: 'undetermined',
    url: 'https://www.oag.ca.gov/sites/all/files/agweb/pdfs/charities/reports/charities-undetermined-status.csv',
  },
  {
    category: 'not_operating_or_dissolving',
    url: 'https://www.oag.ca.gov/sites/all/files/agweb/pdfs/charities/reports/charities-not-operating.csv',
  },
] as const

type CaAgRegistryListCategory =
  (typeof CA_AG_REGISTRY_LISTS)[number]['category']

const RegistryCsvRowSchema = z
  .object({
    'Registry Status': z.string(),
    'State Charity Reg#': z.string(),
    FEIN: z.string(),
    'SOS/FTB#': z.string(),
    Name: z.string(),
    City: z.string(),
    State: z.string(),
    'Issue Date': z.string(),
    'Last Renewal': z.string(),
    'Date Status Set': z.string(),
    'As-of Date': z.string(),
  })
  .strict()
  .transform((row) => ({
    registryStatus: trimCell(row['Registry Status']),
    stateCharityRegistrationNumber: trimCell(row['State Charity Reg#']),
    fein: trimCell(row.FEIN),
    sosFtbNumber: trimCell(row['SOS/FTB#']),
    name: trimCell(row.Name),
    city: trimCell(row.City),
    state: trimCell(row.State),
    issueDate: trimCell(row['Issue Date']),
    lastRenewal: trimCell(row['Last Renewal']),
    dateStatusSet: trimCell(row['Date Status Set']),
    asOfDate: trimCell(row['As-of Date']),
  }))

export type CaAgRegistryRow = z.infer<typeof RegistryCsvRowSchema>

interface RegistryListResult {
  readonly category: CaAgRegistryListCategory
  readonly rows: readonly CaAgRegistryRow[]
  readonly downloadMetadata: CachedDownloadMetadata | null
}

interface MatchedRegistryRow {
  readonly category: CaAgRegistryListCategory
  readonly row: CaAgRegistryRow
  readonly downloadMetadata: CachedDownloadMetadata | null
}

function trimCell(value: string): string {
  return value.trim()
}

function normaliseEin(value: string): string {
  return value.replace(/-/g, '').trim()
}

function parseRegistryCsv(
  content: string,
): Result<readonly CaAgRegistryRow[], SourceError> {
  let records: unknown[]
  try {
    records = parse(content, {
      columns: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: false,
    })
  } catch (parseError) {
    return err({
      type: 'parse',
      message: `Failed to parse CA AG Registry CSV: ${String(parseError)}`,
    })
  }

  const rows: CaAgRegistryRow[] = []
  for (const record of records) {
    const parsed = RegistryCsvRowSchema.safeParse(record)
    if (!parsed.success) {
      return err({
        type: 'parse',
        message: `CA AG Registry CSV row failed schema validation: ${parsed.error.message}`,
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

function downloadRegistryList(
  ctx: SourceContext,
  list: (typeof CA_AG_REGISTRY_LISTS)[number],
): ResultAsync<RegistryListResult, SourceError> {
  if (ctx.downloadCache !== undefined) {
    return fetchDownloadWithCache({
      sourceId: 'ca-ag-registry',
      url: list.url,
      fetch: ctx.fetch,
      cache: ctx.downloadCache,
      now: ctx.now,
    }).andThen((download) => {
      const parsed = parseRegistryCsv(
        new TextDecoder().decode(download.bytes),
      ).map(
        (rows): RegistryListResult => ({
          category: list.category,
          rows,
          downloadMetadata: download.metadata,
        }),
      )
      return resultToAsync(parsed)
    })
  }

  return ResultAsync.fromPromise(ctx.fetch(list.url), toNetworkError).andThen(
    (response) => {
      if (!response.ok) {
        return errAsync<RegistryListResult, SourceError>({
          type: 'http',
          status: response.status,
          message: `CA AG Registry CSV returned HTTP ${String(response.status)} for ${list.url}`,
        })
      }
      return ResultAsync.fromPromise(response.text(), toNetworkError).andThen(
        (text) => {
          const parsed = parseRegistryCsv(text).map(
            (rows): RegistryListResult => ({
              category: list.category,
              rows,
              downloadMetadata: null,
            }),
          )
          return resultToAsync(parsed)
        },
      )
    },
  )
}

function toNetworkError(error: unknown): SourceError {
  return {
    type: 'network',
    message: `CA AG Registry download failed: ${String(error)}`,
  }
}

function findMatch(
  lists: readonly RegistryListResult[],
  ctx: SourceContext,
): MatchedRegistryRow | null {
  const ein = ctx.identifiers['us-federal']?.ein
  const caIds = ctx.identifiers['us-ca']
  const targetEin = ein === undefined ? null : normaliseEin(ein)
  const targetCharity = caIds?.agCharityNumber ?? null
  const targetSos = caIds?.sosEntityNumber ?? null

  for (const list of lists) {
    for (const row of list.rows) {
      if (targetEin !== null && normaliseEin(row.fein) === targetEin) {
        return {
          category: list.category,
          row,
          downloadMetadata: list.downloadMetadata,
        }
      }
      if (
        targetCharity !== null &&
        row.stateCharityRegistrationNumber === targetCharity
      ) {
        return {
          category: list.category,
          row,
          downloadMetadata: list.downloadMetadata,
        }
      }
      if (targetSos !== null && row.sosFtbNumber === targetSos) {
        return {
          category: list.category,
          row,
          downloadMetadata: list.downloadMetadata,
        }
      }
    }
  }
  return null
}

function hasLookupIdentifier(ctx: SourceContext): boolean {
  return (
    ctx.identifiers['us-federal']?.ein !== undefined ||
    ctx.identifiers['us-ca']?.agCharityNumber !== undefined ||
    ctx.identifiers['us-ca']?.sosEntityNumber !== undefined
  )
}

function buildOutput(
  ctx: SourceContext,
  match: MatchedRegistryRow | null,
): SourceRunOutput {
  const downloadEvidence =
    match?.downloadMetadata === null || match === null
      ? null
      : makeDownloadEvidence(match.downloadMetadata)
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'ca-ag-registry',
      fetched_at: ctx.now().toISOString(),
      payload:
        match === null
          ? { matchStatus: 'not_found' }
          : {
              matchStatus: 'found',
              listCategory: match.category,
              registryStatus: match.row.registryStatus,
              stateCharityRegistrationNumber:
                match.row.stateCharityRegistrationNumber,
              fein: match.row.fein,
              sosFtbNumber: match.row.sosFtbNumber,
              name: match.row.name,
              city: match.row.city,
              state: match.row.state,
              lastRenewal: match.row.lastRenewal,
              dateStatusSet: match.row.dateStatusSet,
              upstreamPublishedAt: REGISTRY_REPORTS_UPSTREAM_PUBLISHED_AT,
              evidence: downloadEvidence,
            },
    },
    findings: [],
  }
}

export const caAgRegistrySource: Source = {
  id: 'ca-ag-registry',
  jurisdiction: 'us-ca',
  kind: 'api',
  authRequired: false,
  description:
    'California Attorney General Registry of Charities and Fundraisers status from official Registry Reports CSV downloads.',
  accessUrl: REPORTS_URL,
  accessMethod: 'official_bulk_download',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-04-28T00:00:00.000Z',
    upstreamPublishedAt: REGISTRY_REPORTS_UPSTREAM_PUBLISHED_AT,
  },
  tosUrl: REPORTS_URL,
  run(_entity: Entity, ctx: SourceContext) {
    if (!hasLookupIdentifier(ctx)) {
      return errAsync({
        type: 'validation',
        message:
          'CA AG Registry source requires an EIN, AG charity number, or SOS entity identifier.',
      })
    }
    const downloads = CA_AG_REGISTRY_LISTS.map((list) =>
      downloadRegistryList(ctx, list),
    )
    return ResultAsync.combine(downloads).map((lists) =>
      buildOutput(ctx, findMatch(lists, ctx)),
    )
  },
}

export const _internal = {
  parseRegistryCsv,
  normaliseEin,
  findMatch,
  registryReportsUpstreamPublishedAt: REGISTRY_REPORTS_UPSTREAM_PUBLISHED_AT,
}
