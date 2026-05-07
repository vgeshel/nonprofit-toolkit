import {
  err,
  errAsync,
  ok,
  okAsync,
  ResultAsync,
  type Result,
} from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { openDefaultBrowserPage } from '../../../sources/browser-page.ts'
import type { SourceError } from '../../../sources/errors.ts'
import type {
  BrowserPage,
  BrowserPageFactory,
  BrowserResponse,
  Entity,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

const ACCESS_URL = 'https://bizfileonline.sos.ca.gov/search/business'
const SEARCH_API_PATH = '/api/Records/businesssearch'
const TERMS_URL =
  'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use'
const BROWSER_TIMEOUT_MS = 120_000
const SEARCH_RESPONSE_TIMEOUT_MS = 45_000

const BusinessSearchRowSchema = z.object({
  SORT_INDEX: z.number().default(0),
  TITLE: z.array(z.string().min(1)),
  ID: z.number().optional(),
  FILING_DATE: z.string().optional(),
  STATUS: z.string().optional(),
  ENTITY_TYPE: z.string().optional(),
  FORMED_IN: z.string().optional(),
  AGENT: z.string().optional(),
  STANDING: z.string().optional(),
})

const BusinessSearchResponseSchema = z.object({
  template: z.array(z.object({ label: z.string(), id: z.string() })),
  rows: z.record(z.string(), BusinessSearchRowSchema),
})

const RequiredBusinessSearchRowFieldsSchema = z.object({
  FILING_DATE: z.string().trim().min(1),
  STATUS: z.string().trim().min(1),
  ENTITY_TYPE: z.string().trim().min(1),
  FORMED_IN: z.string().trim().min(1),
  AGENT: z.string().trim().min(1),
})

type BusinessSearchRow = z.infer<typeof BusinessSearchRowSchema>
type BusinessSearchResponse = z.infer<typeof BusinessSearchResponseSchema>

type SearchQuery =
  | {
      readonly field: 'SOS Entity Number'
      readonly value: string
      readonly configuredValue?: string
    }
  | {
      readonly field: 'Entity Name'
      readonly value: string
    }

interface BizfileSummary {
  readonly entityName: string
  readonly sosEntityNumber: string
  readonly initialFilingDate: string
  readonly entityStatus: string
  readonly entityType: string
  readonly formedIn: string
  readonly agent: string
  readonly standing: string | null
  readonly stateRecordId: number | null
}

function chooseSearchQuery(entity: Entity, ctx: SourceContext): SearchQuery {
  const configuredValue = ctx.identifiers['us-ca']?.sosEntityNumber
  if (configuredValue !== undefined) {
    const value = normalizeSosNumberForSearch(configuredValue)
    return value === configuredValue
      ? { field: 'SOS Entity Number', value }
      : { field: 'SOS Entity Number', value, configuredValue }
  }
  return { field: 'Entity Name', value: entity.legal_name }
}

function normalizeSosNumberForSearch(value: string): string {
  return /^C\d{7}$/i.test(value) ? value.slice(1) : value
}

function getBrowserPageFactory(ctx: SourceContext): BrowserPageFactory {
  return ctx.browserPageFactory ?? openDefaultBrowserPage
}

function runBrowserFlow(
  entity: Entity,
  ctx: SourceContext,
): ResultAsync<SourceRunOutput, SourceError> {
  const query = chooseSearchQuery(entity, ctx)
  return getBrowserPageFactory(ctx)().andThen((session) =>
    ResultAsync.fromPromise(
      inspectBizfileSearch(session, entity, ctx, query).finally(() =>
        session.close(),
      ),
      toBrowserSourceError,
    ).andThen(resultToAsync),
  )
}

async function inspectBizfileSearch(
  session: { readonly page: BrowserPage },
  entity: Entity,
  ctx: SourceContext,
  query: SearchQuery,
): Promise<Result<SourceRunOutput, SourceError>> {
  const page = session.page
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS)
  await page.goto(ACCESS_URL, { waitUntil: 'domcontentloaded' })
  const searchSelector = 'input[placeholder="Search by name or file number"]'
  await page.waitForSelector(searchSelector)
  await page.fill(searchSelector, query.value)
  const responsePromise = page.waitForResponse(isBusinessSearchResponse, {
    timeout: SEARCH_RESPONSE_TIMEOUT_MS,
  })
  await page
    .locator('button[aria-label="Execute search"], button.search-button')
    .first()
    .click({ force: true })
  const response = await responsePromise
  return readBusinessSearchResponse(response).andThen((searchResponse) =>
    buildSearchOutput(entity, ctx, query, searchResponse),
  )
}

function isBusinessSearchResponse(response: BrowserResponse): boolean {
  return response.url().includes(SEARCH_API_PATH)
}

function readBusinessSearchResponse(
  response: BrowserResponse,
): ResultAsync<BusinessSearchResponse, SourceError> {
  if (response.status() !== 200) {
    return errAsync<BusinessSearchResponse, SourceError>({
      type: 'parse',
      message: `CA SOS bizfile public search returned status ${String(
        response.status(),
      )}.`,
    })
  }
  return ResultAsync.fromPromise(response.json(), toJsonSourceError).andThen(
    (body) => {
      const parsed = BusinessSearchResponseSchema.safeParse(body)
      if (!parsed.success) {
        return errAsync<BusinessSearchResponse, SourceError>({
          type: 'parse',
          message: 'CA SOS bizfile public search response schema changed.',
        })
      }
      return okAsync<BusinessSearchResponse, SourceError>(parsed.data)
    },
  )
}

function buildSearchOutput(
  entity: Entity,
  ctx: SourceContext,
  query: SearchQuery,
  searchResponse: BusinessSearchResponse,
): Result<SourceRunOutput, SourceError> {
  const selected = selectMatchingRow(entity, query, searchResponse)
  if (selected.isErr()) {
    return err(selected.error)
  }
  if (selected.value === null) {
    return ok(buildNotFoundOutput(ctx, query, searchResponse))
  }
  return buildFoundOutput(ctx, query, selected.value)
}

function selectMatchingRow(
  entity: Entity,
  query: SearchQuery,
  searchResponse: BusinessSearchResponse,
): Result<BusinessSearchRow | null, SourceError> {
  const rows = sortedRows(searchResponse)
  if (rows.length === 0) {
    return ok(null)
  }
  for (const row of rows) {
    const title = parseTitle(row.TITLE[0])
    if (title.isErr()) {
      return err(title.error)
    }
    if (query.field === 'SOS Entity Number') {
      if (sameSosNumber(title.value.sosEntityNumber, query.value)) {
        return ok(row)
      }
    } else if (sameName(title.value.entityName, entity.legal_name)) {
      return ok(row)
    }
  }
  return ok(null)
}

function sortedRows(
  searchResponse: BusinessSearchResponse,
): readonly BusinessSearchRow[] {
  return Object.values(searchResponse.rows).sort(
    (left, right) => left.SORT_INDEX - right.SORT_INDEX,
  )
}

function parseTitle(
  title: string | undefined,
): Result<
  { readonly entityName: string; readonly sosEntityNumber: string },
  SourceError
> {
  if (title === undefined) {
    return err({
      type: 'parse',
      message:
        'CA SOS bizfile public search row is missing the expected entity title and number.',
    })
  }
  const trimmed = title.trim()
  const openParenIndex = trimmed.lastIndexOf('(')
  const closeParenIndex = trimmed.endsWith(')') ? trimmed.length - 1 : -1
  if (openParenIndex <= 0 || closeParenIndex <= openParenIndex + 1) {
    return err({
      type: 'parse',
      message:
        'CA SOS bizfile public search row is missing the expected entity title and number.',
    })
  }
  return ok({
    entityName: trimmed.slice(0, openParenIndex).trim(),
    sosEntityNumber: trimmed.slice(openParenIndex + 1, closeParenIndex).trim(),
  })
}

function sameSosNumber(left: string, right: string): boolean {
  return (
    normalizeSosNumberForSearch(left).toLocaleUpperCase() ===
    normalizeSosNumberForSearch(right).toLocaleUpperCase()
  )
}

function sameName(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right)
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase()
}

function buildFoundOutput(
  ctx: SourceContext,
  query: SearchQuery,
  row: BusinessSearchRow,
): Result<SourceRunOutput, SourceError> {
  const summary = summarizeRow(row)
  if (summary.isErr()) {
    return err(summary.error)
  }
  return ok({
    record: {
      record_id: uuidv4(),
      source_id: 'ca-sos-bizfile',
      fetched_at: ctx.now().toISOString(),
      payload: {
        matchStatus: 'found',
        sourceType: 'public_bizfile_business_search',
        search: searchPayload(query),
        entity_name: summary.value.entityName,
        sos_entity_number: summary.value.sosEntityNumber,
        initial_filing_date: summary.value.initialFilingDate,
        entity_status: summary.value.entityStatus,
        entity_type: summary.value.entityType,
        formed_in: summary.value.formedIn,
        agent: summary.value.agent,
        standing: summary.value.standing,
        ca_record_id: summary.value.stateRecordId,
        evidence: {
          kind: 'structured_public_search_row',
          sourceId: 'ca-sos-bizfile',
          sourceUrl: ACCESS_URL,
          observedAt: ctx.now().toISOString(),
          label: 'CA SOS public bizfile business-search row',
          row,
        },
      },
    },
    findings: [],
  })
}

function summarizeRow(
  row: BusinessSearchRow,
): Result<BizfileSummary, SourceError> {
  const title = parseTitle(row.TITLE[0])
  if (title.isErr()) {
    return err(title.error)
  }
  const required = RequiredBusinessSearchRowFieldsSchema.safeParse(row)
  if (!required.success) {
    const missing = listMissingRequiredRowLabels(row)
    return err({
      type: 'parse',
      message: `CA SOS bizfile public search row is missing required field(s): ${missing.join(
        ', ',
      )}.`,
    })
  }
  return ok({
    entityName: title.value.entityName,
    sosEntityNumber: title.value.sosEntityNumber,
    initialFilingDate: required.data.FILING_DATE,
    entityStatus: required.data.STATUS,
    entityType: required.data.ENTITY_TYPE,
    formedIn: required.data.FORMED_IN,
    agent: required.data.AGENT,
    standing: readOptionalString(row.STANDING),
    stateRecordId: row.ID ?? null,
  })
}

function listMissingRequiredRowLabels(row: BusinessSearchRow): string[] {
  const fields: readonly (readonly [string, string | undefined])[] = [
    ['Initial Filing Date', row.FILING_DATE],
    ['Status', row.STATUS],
    ['Entity Type', row.ENTITY_TYPE],
    ['Formed In', row.FORMED_IN],
    ['Agent', row.AGENT],
  ]
  const missing: string[] = []
  for (const [label, value] of fields) {
    if (readOptionalString(value) === null) {
      missing.push(label)
    }
  }
  return missing
}

function readOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function buildNotFoundOutput(
  ctx: SourceContext,
  query: SearchQuery,
  searchResponse: BusinessSearchResponse,
): SourceRunOutput {
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'ca-sos-bizfile',
      fetched_at: ctx.now().toISOString(),
      payload: {
        matchStatus: 'not_found',
        sourceType: 'public_bizfile_business_search',
        search: searchPayload(query),
        resultCount: Object.keys(searchResponse.rows).length,
      },
    },
    findings: [],
  }
}

function searchPayload(query: SearchQuery): Record<string, string> {
  if ('configuredValue' in query && query.configuredValue !== undefined) {
    return {
      field: query.field,
      value: query.value,
      configuredValue: query.configuredValue,
    }
  }
  return { field: query.field, value: query.value }
}

function toJsonSourceError(error: unknown): SourceError {
  return {
    type: 'parse',
    message: `CA SOS bizfile public search response could not be read as JSON: ${
      error instanceof Error ? error.message : String(error)
    }`,
  }
}

function toBrowserSourceError(error: unknown): SourceError {
  return {
    type: 'network',
    message: `CA SOS bizfile browser flow failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  }
}

function resultToAsync<T>(
  result: Result<T, SourceError>,
): ResultAsync<T, SourceError> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error)
}

export const caSosBizfileSource: Source = {
  id: 'ca-sos-bizfile',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: false,
  description:
    'California Secretary of State bizfile business status from the public unauthenticated search.',
  accessUrl: ACCESS_URL,
  accessMethod: 'official_public_page',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-05-07T00:00:00.000Z',
  },
  tosUrl: TERMS_URL,
  run: runBrowserFlow,
}

export const _internal = {
  chooseSearchQuery,
  normalizeSosNumberForSearch,
  getBrowserPageFactory,
  parseTitle,
  summarizeRow,
  toBrowserSourceError,
  toJsonSourceError,
}
