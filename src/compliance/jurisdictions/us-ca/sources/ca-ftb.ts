import {
  err,
  errAsync,
  ok,
  okAsync,
  ResultAsync,
  type Result,
} from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import { openDefaultBrowserPage } from '../../../sources/browser-page.ts'
import type { SourceError } from '../../../sources/errors.ts'
import type {
  BrowserLocator,
  BrowserPage,
  BrowserPageFactory,
  Entity,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

const ACCESS_URL = 'https://webapp.ftb.ca.gov/eletter/'
const TERMS_URL =
  'https://www.ftb.ca.gov/help/business/entity-status-letter.asp'
const TEXT_EVIDENCE_MAX_CHARS = 4000
const BROWSER_TIMEOUT_MS = 120_000
const PAGE_UPDATE_TIMEOUT_MS = 45_000
const PAGE_UPDATE_POLL_INTERVAL_MS = 250
/**
 * FTB fronts the Entity Status Letter with a bot challenge that swallows the
 * first search submission: it renders a blank challenge page for ~25 seconds,
 * then returns the empty search form instead of the results. Re-submitting
 * once the challenge has cleared succeeds, so the search is retried rather
 * than reported as a site-shape change.
 */
const MAX_SEARCH_SUBMIT_ATTEMPTS = 3

type SearchQuery =
  | {
      readonly field: 'Entity ID'
      readonly value: string
      readonly selector: '#EntityId'
    }
  | {
      readonly field: 'Entity Name'
      readonly value: string
      readonly selector: '#EntityName'
    }

interface EntityStatusSummary {
  readonly entityId: string
  readonly entityName: string
  readonly address: string
  readonly ftbStatus: string
  readonly exemptStatus: string
  readonly evidenceText: string
}

function chooseSearchQuery(entity: Entity, ctx: SourceContext): SearchQuery {
  const caIdentifiers = ctx.identifiers['us-ca']
  if (caIdentifiers?.ftbEntityId !== undefined) {
    return {
      field: 'Entity ID',
      value: caIdentifiers.ftbEntityId,
      selector: '#EntityId',
    }
  }
  if (caIdentifiers?.sosEntityNumber !== undefined) {
    return {
      field: 'Entity ID',
      value: caIdentifiers.sosEntityNumber,
      selector: '#EntityId',
    }
  }
  return {
    field: 'Entity Name',
    value: caIdentifiers?.ftbEntityName ?? entity.legal_name,
    selector: '#EntityName',
  }
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
      inspectEntityStatusLetter(session, ctx, query).finally(() =>
        session.close(),
      ),
      toBrowserSourceError,
    ).andThen(resultToAsync),
  )
}

async function inspectEntityStatusLetter(
  session: { readonly page: BrowserPage },
  ctx: SourceContext,
  query: SearchQuery,
): Promise<Result<SourceRunOutput, SourceError>> {
  const page = session.page
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS)
  await page.goto(ACCESS_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#EntityId')

  const search = await submitSearchWithRetry(page, query)
  if (search.isErr()) {
    return err(search.error)
  }
  const resultText = search.value
  if (isChallengePage(resultText)) {
    return err({
      type: 'parse',
      message:
        'CA FTB Entity Status Letter returned a browser challenge instead of public search results.',
    })
  }
  if (isNotFoundResult(resultText)) {
    return ok(buildNotFoundOutput(ctx, query))
  }
  if (!isSearchResultPage(resultText)) {
    return err({
      type: 'parse',
      message:
        'CA FTB Entity Status Letter search did not return the expected result page.',
    })
  }

  const resultButton = resultButtonLocator(page, query)
  const resultButtonCount = await resultButton.count()
  if (resultButtonCount === 0) {
    return err({
      type: 'parse',
      message:
        'CA FTB Entity Status Letter result page did not contain an entity result button.',
    })
  }
  await clickAndWait(page, () => resultButton.click({ force: true }))

  const summaryText = await readBodyTextAfterPageUpdate(
    page,
    isSearchResultPage,
  )
  if (isChallengePage(summaryText)) {
    return err({
      type: 'parse',
      message:
        'CA FTB Entity Status Letter returned a browser challenge instead of the public summary.',
    })
  }
  const summary = parseSummary(summaryText)
  if (summary.isErr()) {
    return err(summary.error)
  }
  return ok(buildFoundOutput(ctx, query, summary.value))
}

/**
 * Submits the entity search, retrying whenever the bot challenge discards the
 * submission and hands back the empty search form.
 */
async function submitSearchWithRetry(
  page: BrowserPage,
  query: SearchQuery,
): Promise<Result<string, SourceError>> {
  for (let attempt = 1; attempt <= MAX_SEARCH_SUBMIT_ATTEMPTS; attempt += 1) {
    const text = await submitSearch(page, query)
    if (text.trim().length === 0) {
      return err({
        type: 'parse',
        message: `CA FTB Entity Status Letter returned a blank page for ${String(
          PAGE_UPDATE_TIMEOUT_MS / 1000,
        )}s after the search, which is how its bot challenge presents. Complete the search manually at ${ACCESS_URL}.`,
      })
    }
    if (!isEntitySearchFormPage(text)) {
      return ok(text)
    }
  }
  return err({
    type: 'parse',
    message: `CA FTB Entity Status Letter discarded ${String(
      MAX_SEARCH_SUBMIT_ATTEMPTS,
    )} search submissions and returned the empty search form each time, which is how its bot challenge presents. Complete the search manually at ${ACCESS_URL}.`,
  })
}

async function submitSearch(
  page: BrowserPage,
  query: SearchQuery,
): Promise<string> {
  await page.fill(query.selector, query.value)
  await clickAndWait(page, () =>
    page
      .locator('button[title="Search for an Entity."]')
      .first()
      .click({ force: true }),
  )
  return readBodyTextAfterPageUpdate(page, isEntitySearchFormPage, () =>
    isSearchFieldCleared(page, query),
  )
}

/**
 * A reloaded, empty search field means the challenge discarded the submission,
 * as opposed to the results simply not having rendered yet.
 */
async function isSearchFieldCleared(
  page: BrowserPage,
  query: SearchQuery,
): Promise<boolean> {
  const value = await page.locator(query.selector).inputValue()
  return value.trim().length === 0
}

async function clickAndWait(
  page: BrowserPage,
  action: () => Promise<unknown>,
): Promise<void> {
  await Promise.all([
    page
      .waitForLoadState('domcontentloaded', { timeout: BROWSER_TIMEOUT_MS })
      .catch(() => undefined),
    action(),
  ])
}

function resultButtonLocator(
  page: BrowserPage,
  query: SearchQuery,
): BrowserLocator {
  if (query.field === 'Entity ID') {
    return page.locator('button').filter({ hasText: query.value }).first()
  }
  return page.locator('table button').first()
}

function isSearchResultPage(text: string): boolean {
  return normalizeText(text).includes('Entity Search Result')
}

function isEntitySearchFormPage(text: string): boolean {
  const normalized = normalizeText(text)
  return (
    normalized.includes('Self Serve Entity Status Letter') &&
    normalized.includes('Entity Search') &&
    normalized.includes('Perform Search') &&
    !normalized.includes('Entity Search Result')
  )
}

function isNotFoundResult(text: string): boolean {
  const normalized = normalizeText(text).toLocaleLowerCase()
  return (
    normalized.includes('no entities matching') ||
    normalized.includes('no matching entities')
  )
}

function isChallengePage(text: string): boolean {
  return normalizeText(text).includes('Challenge Validation')
}

async function readBodyTextAfterPageUpdate(
  page: BrowserPage,
  isPreviousPage: (text: string) => boolean,
  isSubmissionDiscarded?: () => Promise<boolean>,
): Promise<string> {
  let text = await page.locator('body').innerText()
  const deadline = Date.now() + PAGE_UPDATE_TIMEOUT_MS
  while (
    (await shouldWaitForPageUpdate(
      text,
      isPreviousPage,
      isSubmissionDiscarded,
    )) &&
    Date.now() < deadline
  ) {
    await sleep(PAGE_UPDATE_POLL_INTERVAL_MS)
    text = await page.locator('body').innerText()
  }
  return text
}

async function shouldWaitForPageUpdate(
  text: string,
  isPreviousPage: (text: string) => boolean,
  isSubmissionDiscarded?: () => Promise<boolean>,
): Promise<boolean> {
  if (text.trim().length === 0) {
    return true
  }
  if (!isPreviousPage(text)) {
    return false
  }
  // The previous page is still showing: keep waiting unless the submission was
  // discarded, in which case waiting can only time out.
  return isSubmissionDiscarded === undefined
    ? true
    : !(await isSubmissionDiscarded())
}

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

function parseSummary(text: string): Result<EntityStatusSummary, SourceError> {
  const entityId = readLabel(text, 'Entity ID')
  const entityName = readLabel(text, 'Entity Name')
  const address = readLabel(text, 'Address')
  const ftbStatus = readLabel(text, 'Entity Status')
  const exemptStatus = readLabel(text, 'Exempt Status')
  const missing = [
    ['Entity ID', entityId],
    ['Entity Name', entityName],
    ['Address', address],
    ['Entity Status', ftbStatus],
    ['Exempt Status', exemptStatus],
  ]
    .filter(([, value]) => value === null)
    .map(([label]) => label)
  if (
    entityId === null ||
    entityName === null ||
    address === null ||
    ftbStatus === null ||
    exemptStatus === null
  ) {
    return err({
      type: 'parse',
      message: `CA FTB Entity Status Letter summary is missing required field(s): ${missing.join(', ')}.`,
    })
  }
  return ok({
    entityId,
    entityName,
    address,
    ftbStatus,
    exemptStatus,
    evidenceText: normalizeText(text),
  })
}

function readLabel(text: string, label: string): string | null {
  const prefix = `${label}:`
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) {
      const value = trimmed.slice(prefix.length).trim()
      return value.length === 0 ? null : value
    }
  }
  return null
}

function buildFoundOutput(
  ctx: SourceContext,
  query: SearchQuery,
  summary: EntityStatusSummary,
): SourceRunOutput {
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'ca-ftb-entity-status-letter',
      fetched_at: ctx.now().toISOString(),
      payload: {
        matchStatus: 'found',
        sourceType: 'public_entity_status_letter',
        search: {
          field: query.field,
          value: query.value,
        },
        entity_id: summary.entityId,
        entity_name: summary.entityName,
        address: summary.address,
        ftb_status: summary.ftbStatus,
        exempt_status_verified: summary.exemptStatus,
        evidence: {
          kind: 'text_excerpt',
          sourceId: 'ca-ftb-entity-status-letter',
          sourceUrl: ACCESS_URL,
          observedAt: ctx.now().toISOString(),
          label: 'CA FTB public Entity Status Letter summary',
          text: summary.evidenceText.slice(0, TEXT_EVIDENCE_MAX_CHARS),
        },
      },
    },
    findings: [],
  }
}

function buildNotFoundOutput(
  ctx: SourceContext,
  query: SearchQuery,
): SourceRunOutput {
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'ca-ftb-entity-status-letter',
      fetched_at: ctx.now().toISOString(),
      payload: {
        matchStatus: 'not_found',
        sourceType: 'public_entity_status_letter',
        search: {
          field: query.field,
          value: query.value,
        },
      },
    },
    findings: [],
  }
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

function toBrowserSourceError(error: unknown): SourceError {
  return {
    type: 'network',
    message: `CA FTB Entity Status Letter browser flow failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  }
}

function resultToAsync<T>(
  result: Result<T, SourceError>,
): ResultAsync<T, SourceError> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error)
}

export const caFtbEntityStatusLetterSource: Source = {
  id: 'ca-ftb-entity-status-letter',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: false,
  description:
    'California Franchise Tax Board Entity Status Letter from the public unauthenticated lookup.',
  accessUrl: ACCESS_URL,
  accessMethod: 'official_public_page',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-05-03T00:00:00.000Z',
  },
  tosUrl: TERMS_URL,
  run: runBrowserFlow,
}

export const _internal = {
  parseSummary,
  chooseSearchQuery,
}
