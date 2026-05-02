import {
  ResultAsync,
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
} from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import type { SourceError } from '../../../sources/errors.ts'
import type {
  Entity,
  FetchImpl,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

const CA_AG_REGISTRY_SEARCH_URL =
  'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y'
const CA_AG_REGISTRY_BASE_URL = 'https://rct.doj.ca.gov/Verification/Web/'
const CA_AG_TERMS_URL = 'https://oag.ca.gov/privacy'
const TEXT_EVIDENCE_MAX_CHARS = 4000

const REQUIRED_FORM_FIELDS = [
  '__VIEWSTATE',
  '__VIEWSTATEGENERATOR',
  '__EVENTVALIDATION',
] as const

type RequiredFormField = (typeof REQUIRED_FORM_FIELDS)[number]

interface SearchForm {
  readonly fields: Record<RequiredFormField, string>
  readonly sessionCookie: string | null
}

interface SearchQuery {
  readonly field:
    | 'FEIN'
    | 'State Charity Registration Number'
    | 'SOS/FTB Number'
    | 'Legal Name'
  readonly value: string
  readonly formField: string
}

interface SearchResultRow {
  readonly organizationName: string
  readonly recordType: string
  readonly registryStatus: string
  readonly stateCharityRegistrationNumber: string
  readonly fein: string
  readonly city: string
  readonly state: string
  readonly detailUrl: string | null
}

type SearchResultCells = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  ...string[],
]

interface DetailRecord {
  readonly organizationName: string
  readonly fein: string | null
  readonly entityType: string | null
  readonly sosFtbNumber: string | null
  readonly registryStatus: string
  readonly renewalDueDate: string | null
  readonly stateCharityRegistrationNumber: string | null
  readonly issueDate: string | null
  readonly recordType: string | null
  readonly effectiveDate: string | null
  readonly lastRenewal: string | null
  readonly dba: string | null
  readonly mailingAddress: Record<string, string>
  readonly annualRenewals: readonly Record<string, string>[]
  readonly evidenceText: string
}

interface MatchedPublicRegistryRecord {
  readonly search: SearchQuery
  readonly row: SearchResultRow
  readonly detail: DetailRecord
}

function normaliseEin(value: string): string {
  return value.replace(/-/g, '').trim()
}

function chooseSearchQuery(entity: Entity, ctx: SourceContext): SearchQuery {
  const ein = ctx.identifiers['us-federal']?.ein
  if (ein !== undefined) {
    return {
      field: 'FEIN',
      value: normaliseEin(ein),
      formField: 't_web_lookup__federal_id',
    }
  }

  const caIds = ctx.identifiers['us-ca']
  if (caIds?.agCharityNumber !== undefined) {
    return {
      field: 'State Charity Registration Number',
      value: caIds.agCharityNumber,
      formField: 't_web_lookup__license_no',
    }
  }
  if (caIds?.sosEntityNumber !== undefined) {
    return {
      field: 'SOS/FTB Number',
      value: caIds.sosEntityNumber,
      formField: 't_web_lookup__charter_number',
    }
  }
  return {
    field: 'Legal Name',
    value: entity.legal_name,
    formField: 't_web_lookup__full_name',
  }
}

function fetchText(
  fetch: FetchImpl,
  url: string,
  init: RequestInit | undefined,
  label: string,
): ResultAsync<Response, SourceError> {
  return ResultAsync.fromPromise(fetch(url, init), toNetworkError).andThen(
    (response) => {
      if (!response.ok) {
        return errAsync<Response, SourceError>({
          type: 'http',
          status: response.status,
          message: `${label} returned HTTP ${String(response.status)} for ${url}`,
        })
      }
      return okAsync(response)
    },
  )
}

function toNetworkError(error: unknown): SourceError {
  return {
    type: 'network',
    message: `CA AG Registry Search Tool request failed: ${String(error)}`,
  }
}

function readResponseText(
  response: Response,
): ResultAsync<string, SourceError> {
  return ResultAsync.fromPromise(response.text(), toNetworkError)
}

function loadSearchForm(
  ctx: SourceContext,
): ResultAsync<SearchForm, SourceError> {
  return fetchText(
    ctx.fetch,
    CA_AG_REGISTRY_SEARCH_URL,
    undefined,
    'CA AG Registry Search Tool',
  )
    .andThen((response) =>
      readResponseText(response).map((html) => ({
        html,
        sessionCookie: sessionCookie(response),
      })),
    )
    .andThen(({ html, sessionCookie }) =>
      resultToAsync(parseSearchForm(html, sessionCookie)),
    )
}

function sessionCookie(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null || setCookie.trim().length === 0) {
    return null
  }
  const separatorIndex = setCookie.indexOf(';')
  return separatorIndex === -1 ? setCookie : setCookie.slice(0, separatorIndex)
}

function parseSearchForm(
  html: string,
  sessionCookieValue: string | null,
): Result<SearchForm, SourceError> {
  const viewState = readRequiredFormField(html, '__VIEWSTATE')
  if (viewState.isErr()) {
    return err(viewState.error)
  }
  const viewStateGenerator = readRequiredFormField(html, '__VIEWSTATEGENERATOR')
  if (viewStateGenerator.isErr()) {
    return err(viewStateGenerator.error)
  }
  const eventValidation = readRequiredFormField(html, '__EVENTVALIDATION')
  if (eventValidation.isErr()) {
    return err(eventValidation.error)
  }
  return ok({
    fields: {
      __VIEWSTATE: viewState.value,
      __VIEWSTATEGENERATOR: viewStateGenerator.value,
      __EVENTVALIDATION: eventValidation.value,
    },
    sessionCookie: sessionCookieValue,
  })
}

function readRequiredFormField(
  html: string,
  field: RequiredFormField,
): Result<string, SourceError> {
  const value = readInputValue(html, field)
  if (value === null) {
    return err({
      type: 'parse',
      message: `CA AG Registry Search Tool form is missing hidden field ${field}.`,
    })
  }
  return ok(value)
}

function buildSearchRequest(form: SearchForm, query: SearchQuery): RequestInit {
  const body = new URLSearchParams()
  for (const field of REQUIRED_FORM_FIELDS) {
    body.set(field, form.fields[field])
  }
  body.set('t_web_lookup__license_no', '')
  body.set('t_web_lookup__charter_number', '')
  body.set('t_web_lookup__federal_id', '')
  body.set('t_web_lookup__full_name', '')
  body.set('t_web_lookup__doing_business_as', '')
  body.set('t_web_lookup__profession_name', 'Charity')
  body.set('t_web_lookup__license_type_name', 'Charity Registration')
  body.set('t_web_lookup__license_status_name', '')
  body.set('t_web_lookup__addr_county', '')
  body.set('t_web_lookup__addr_city', '')
  body.set('t_web_lookup__addr_state', '')
  body.set('t_web_lookup__addr_zipcode', '')
  body.set(query.formField, query.value)
  body.set('sch_button', 'Search')

  return {
    method: 'POST',
    headers: headers({
      'content-type': 'application/x-www-form-urlencoded',
      cookie: form.sessionCookie,
      referer: CA_AG_REGISTRY_SEARCH_URL,
    }),
    body,
  }
}

function headers(values: Record<string, string | null>): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) {
      result.set(key, value)
    }
  }
  return result
}

function submitSearch(
  ctx: SourceContext,
  form: SearchForm,
  query: SearchQuery,
): ResultAsync<readonly SearchResultRow[], SourceError> {
  return fetchText(
    ctx.fetch,
    CA_AG_REGISTRY_SEARCH_URL,
    buildSearchRequest(form, query),
    'CA AG Registry Search Tool results',
  )
    .andThen(readResponseText)
    .andThen((html) => resultToAsync(parseSearchResults(html)))
}

function loadDetail(
  ctx: SourceContext,
  form: SearchForm,
  row: SearchResultRow,
): ResultAsync<DetailRecord, SourceError> {
  if (row.detailUrl === null) {
    return errAsync({
      type: 'parse',
      message:
        'CA AG Registry Search Tool result row did not include a public detail link.',
    })
  }
  return fetchText(
    ctx.fetch,
    row.detailUrl,
    {
      headers: headers({
        cookie: form.sessionCookie,
        referer: CA_AG_REGISTRY_SEARCH_URL,
      }),
    },
    'CA AG Registry detail page',
  )
    .andThen(readResponseText)
    .andThen((html) => resultToAsync(parseDetailPage(html)))
}

function findBestResult(
  rows: readonly SearchResultRow[],
  query: SearchQuery,
): SearchResultRow | null {
  const charityRows = rows.filter((row) =>
    sameText(row.recordType, 'Charity Registration'),
  )
  const candidates = charityRows.length === 0 ? rows : charityRows
  for (const row of candidates) {
    if (matchesQuery(row, query)) {
      return row
    }
  }
  return candidates[0] ?? null
}

function matchesQuery(row: SearchResultRow, query: SearchQuery): boolean {
  switch (query.field) {
    case 'FEIN':
      return normaliseEin(row.fein) === normaliseEin(query.value)
    case 'State Charity Registration Number':
      return sameText(row.stateCharityRegistrationNumber, query.value)
    case 'Legal Name':
      return sameText(row.organizationName, query.value)
    case 'SOS/FTB Number':
      return false
  }
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

function buildOutput(
  ctx: SourceContext,
  match: MatchedPublicRegistryRecord | null,
  search: SearchQuery,
): SourceRunOutput {
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'ca-ag-registry',
      fetched_at: ctx.now().toISOString(),
      payload:
        match === null
          ? {
              matchStatus: 'not_found',
              sourceType: 'public_registry_search',
              search: {
                field: search.field,
                value: search.value,
              },
            }
          : payloadForMatch(ctx, match),
    },
    findings: [],
  }
}

function payloadForMatch(
  ctx: SourceContext,
  match: MatchedPublicRegistryRecord,
): Record<string, unknown> {
  const detail = match.detail
  return compactRecord({
    matchStatus: 'found',
    sourceType: 'public_registry_search',
    search: {
      field: match.search.field,
      value: match.search.value,
    },
    listCategory: listCategoryFromStatus(detail.registryStatus),
    registryStatus: detail.registryStatus,
    stateCharityRegistrationNumber:
      detail.stateCharityRegistrationNumber ??
      match.row.stateCharityRegistrationNumber,
    fein: detail.fein ?? match.row.fein,
    sosFtbNumber: detail.sosFtbNumber,
    name: detail.organizationName,
    city: match.row.city,
    state: match.row.state,
    recordType: detail.recordType ?? match.row.recordType,
    entityType: detail.entityType,
    renewalDueDate: detail.renewalDueDate,
    issueDate: detail.issueDate,
    effectiveDate: detail.effectiveDate,
    lastRenewal: detail.lastRenewal,
    dba: detail.dba,
    mailingAddress: detail.mailingAddress,
    annualRenewals: detail.annualRenewals,
    detailUrl: match.row.detailUrl,
    evidence: {
      kind: 'text_excerpt',
      sourceId: 'ca-ag-registry',
      sourceUrl: match.row.detailUrl,
      observedAt: ctx.now().toISOString(),
      label: 'CA AG public Registry Search Tool detail page',
      text: detail.evidenceText.slice(0, TEXT_EVIDENCE_MAX_CHARS),
    },
  })
}

function compactRecord(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) {
      result[key] = value
    }
  }
  return result
}

function listCategoryFromStatus(status: string): string {
  const normalized = status.trim().toLocaleLowerCase()
  if (normalized.startsWith('current')) {
    return 'may_operate_or_solicit'
  }
  if (
    normalized.includes('not operating') ||
    normalized.includes('dissolving')
  ) {
    return 'not_operating_or_dissolving'
  }
  if (
    normalized.includes('delinquent') ||
    normalized.includes('suspended') ||
    normalized.includes('revoked') ||
    normalized.includes('expired')
  ) {
    return 'may_not_operate_or_solicit'
  }
  return 'undetermined'
}

function parseSearchResults(
  html: string,
): Result<readonly SearchResultRow[], SourceError> {
  const table = extractElementById(html, 'table', 'datagrid_results')
  if (table === null) {
    return err({
      type: 'parse',
      message:
        'CA AG Registry Search Tool results did not contain datagrid_results.',
    })
  }

  const rows: SearchResultRow[] = []
  for (const rowHtml of extractElements(table, 'tr')) {
    const cells = extractCells(rowHtml)
    if (
      !hasSearchResultCells(cells) ||
      sameText(cells[0], 'ORGANIZATION NAME')
    ) {
      continue
    }
    rows.push({
      organizationName: cells[0],
      recordType: cells[1],
      registryStatus: cells[2],
      stateCharityRegistrationNumber: cells[3],
      fein: cells[4],
      city: cells[5],
      state: cells[6],
      detailUrl: extractDetailUrl(rowHtml),
    })
  }
  return ok(rows)
}

function hasSearchResultCells(
  cells: readonly string[],
): cells is SearchResultCells {
  return cells.length >= 7
}

function extractCells(rowHtml: string): string[] {
  return extractElements(rowHtml, 'td').map(stripHtml)
}

function extractDetailUrl(rowHtml: string): string | null {
  const match = /href="([^"]*Details\.aspx\?result=[^"]+)"/i.exec(rowHtml)
  if (match?.[1] === undefined) {
    return null
  }
  return new URL(decodeHtml(match[1]), CA_AG_REGISTRY_BASE_URL).toString()
}

function parseDetailPage(html: string): Result<DetailRecord, SourceError> {
  const organizationName = readSpanText(html, '_ctl19__ctl1_full_name')
  const registryStatus = readSpanText(html, '_ctl23__ctl1_License_Status_code')
  if (organizationName === null || registryStatus === null) {
    return err({
      type: 'parse',
      message:
        'CA AG Registry detail page did not contain the expected organization and status fields.',
    })
  }

  return ok({
    organizationName,
    fein: readSpanText(html, '_ctl19__ctl1_fed'),
    entityType: readSpanText(html, '_ctl19__ctl1_owner_type'),
    sosFtbNumber: readSpanText(html, '_ctl19__ctl1_charternumber'),
    registryStatus,
    renewalDueDate: readSpanText(html, '_ctl23__ctl1_expiration_date'),
    stateCharityRegistrationNumber: readSpanText(
      html,
      '_ctl23__ctl1_license_no',
    ),
    issueDate: readSpanText(html, '_ctl23__ctl1_issue_date'),
    recordType: readSpanText(html, '_ctl23__ctl1_license_type'),
    effectiveDate: readSpanText(html, '_ctl23__ctl1_eff_date'),
    lastRenewal: readSpanText(html, '_ctl23__ctl1_date_last_renewal'),
    dba: readSpanText(html, '_ctl23__ctl1_lable_dba'),
    mailingAddress: compactStringRecord({
      street: readSpanText(html, '_ctl28__ctl1_addr_line_1'),
      streetLine2: readSpanText(html, '_ctl28__ctl1_addr_line_2'),
      cityStateZip: readSpanText(html, '_ctl28__ctl1_addr_line_4'),
    }),
    annualRenewals: parseAnnualRenewals(html),
    evidenceText: stripHtml(html),
  })
}

function compactStringRecord(
  values: Record<string, string | null>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) {
      result[key] = value
    }
  }
  return result
}

function parseAnnualRenewals(html: string): readonly Record<string, string>[] {
  const indices = findAnnualRenewalIndices(html)
  return indices.map((index) =>
    compactStringRecord({
      status: readSpanText(html, `RRF_repeater__ctl${index}_Status`),
      accountingPeriodBeginDate: readSpanText(
        html,
        `RRF_repeater__ctl${index}_FiscalBegin`,
      ),
      accountingPeriodEndDate: readSpanText(
        html,
        `RRF_repeater__ctl${index}_FiscalEnd`,
      ),
      filingReceivedDate: readSpanText(
        html,
        `RRF_repeater__ctl${index}_Receive_Date`,
      ),
      formRrf1RejectIncompleteReason: readSpanText(
        html,
        `RRF_repeater__ctl${index}_RRF-1_RejectIncomplete_Reason`,
      ),
      formCtTr1RejectIncompleteReason: readSpanText(
        html,
        `RRF_repeater__ctl${index}_CT-TR-1_RejectIncomplete_Reason`,
      ),
      irsForm990RejectIncompleteReason: readSpanText(
        html,
        `RRF_repeater__ctl${index}_990_RejectIncomplete_Reason`,
      ),
      registryStaffNotes: readSpanText(
        html,
        `RRF_repeater__ctl${index}_Public Message For Verif`,
      ),
    }),
  )
}

function findAnnualRenewalIndices(html: string): readonly string[] {
  const indices = new Set<string>()
  const pattern = /id="RRF_repeater__ctl(\d+)_Status"/gi
  for (const match of html.matchAll(pattern)) {
    indices.add(match[0].replace(/^.*__ctl(\d+)_Status.*$/i, '$1'))
  }
  return Array.from(indices).sort((left, right) => Number(left) - Number(right))
}

function extractElementById(
  html: string,
  tag: string,
  id: string,
): string | null {
  const pattern = new RegExp(
    `<${tag}\\b(?=[^>]*\\bid="${escapeRegExp(id)}")[^>]*>[\\s\\S]*?<\\/${tag}>`,
    'i',
  )
  return pattern.exec(html)?.[0] ?? null
}

function extractElements(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
  return Array.from(html.matchAll(pattern), (match) => match[0])
}

function readInputValue(html: string, name: string): string | null {
  const pattern = new RegExp(
    `<input\\b(?=[^>]*\\bname="${escapeRegExp(name)}")[^>]*\\bvalue="([^"]*)"[^>]*>`,
    'i',
  )
  const value = pattern.exec(html)?.[1]
  return value === undefined ? null : decodeHtml(value)
}

function readSpanText(html: string, id: string): string | null {
  const pattern = new RegExp(
    `<span\\b(?=[^>]*\\bid="${escapeRegExp(id)}")[^>]*>([\\s\\S]*?)<\\/span>`,
    'i',
  )
  const value = pattern.exec(html)?.[1]
  if (value === undefined) {
    return null
  }
  const stripped = stripHtml(value)
  return stripped.length === 0 ? null : stripped
}

function stripHtml(html: string): string {
  return decodeHtml(
    html
      .replaceAll(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replaceAll(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replaceAll(/<[^>]+>/g, ' '),
  )
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resultToAsync<T>(
  result: Result<T, SourceError>,
): ResultAsync<T, SourceError> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error)
}

export const caAgRegistrySource: Source = {
  id: 'ca-ag-registry',
  jurisdiction: 'us-ca',
  kind: 'api',
  authRequired: false,
  description:
    'California Attorney General Registry of Charities and Fundraisers status from the public Registry Search Tool and detail page.',
  accessUrl: CA_AG_REGISTRY_SEARCH_URL,
  accessMethod: 'official_public_page',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-05-02T00:00:00.000Z',
  },
  tosUrl: CA_AG_TERMS_URL,
  run(entity: Entity, ctx: SourceContext) {
    const search = chooseSearchQuery(entity, ctx)
    return loadSearchForm(ctx).andThen((form) =>
      submitSearch(ctx, form, search).andThen((rows) => {
        const row = findBestResult(rows, search)
        if (row === null) {
          return okAsync(buildOutput(ctx, null, search))
        }
        return loadDetail(ctx, form, row).map((detail) =>
          buildOutput(ctx, { search, row, detail }, search),
        )
      }),
    )
  },
}

export const _internal = {
  parseSearchForm,
  parseSearchResults,
  parseDetailPage,
  listCategoryFromStatus,
  normaliseEin,
}
