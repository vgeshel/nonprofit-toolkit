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
  BrowserPage,
  BrowserPageFactory,
  Entity,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

const CDTFA_ONLINE_SERVICES_URL = 'https://onlineservices.cdtfa.ca.gov/'
const CDTFA_TERMS_URL = 'https://www.cdtfa.ca.gov/use.htm'
const BROWSER_TIMEOUT_MS = 120_000
const PAGE_UPDATE_TIMEOUT_MS = 45_000
const PAGE_UPDATE_POLL_INTERVAL_MS = 250

type PublicVerificationQuery =
  | {
      readonly accountType: 'Sellers Permit'
      readonly identifier: string
      readonly normalizedIdentifier: string
    }
  | {
      readonly accountType: 'Certificate of Registration - Use Tax'
      readonly identifier: string
      readonly normalizedIdentifier: string
    }

interface PermitVerificationSummary {
  readonly accountType: PublicVerificationQuery['accountType']
  readonly accountNumber: string
  readonly verificationStatus: string
  readonly isValid: boolean
  readonly startDate: string | null
  readonly endDate: string | null
  readonly ownerName: string | null
  readonly dbaName: string | null
  readonly address: string | null
  readonly suspensionBegin: string | null
  readonly suspensionEnd: string | null
  readonly city: string | null
  readonly zipCode: string | null
}

function choosePublicVerificationQuery(
  ctx: SourceContext,
): Result<PublicVerificationQuery, SourceError> {
  const caIdentifiers = ctx.identifiers['us-ca']
  if (caIdentifiers?.cdtfaSellerPermitNumber !== undefined) {
    return ok({
      accountType: 'Sellers Permit',
      identifier: caIdentifiers.cdtfaSellerPermitNumber,
      normalizedIdentifier: normalizeCdtfaIdentifier(
        caIdentifiers.cdtfaSellerPermitNumber,
      ),
    })
  }
  if (caIdentifiers?.cdtfaUseTaxAccountNumber !== undefined) {
    return ok({
      accountType: 'Certificate of Registration - Use Tax',
      identifier: caIdentifiers.cdtfaUseTaxAccountNumber,
      normalizedIdentifier: normalizeCdtfaIdentifier(
        caIdentifiers.cdtfaUseTaxAccountNumber,
      ),
    })
  }
  if (caIdentifiers?.cdtfaSpecialTaxAccountNumber !== undefined) {
    return err({
      type: 'validation',
      message:
        'CDTFA special tax account verification requires the specific taxable activity type before the public page can be searched automatically.',
    })
  }
  return err({
    type: 'validation',
    message:
      'CDTFA public permit verification requires a configured seller permit or use-tax account number.',
  })
}

function normalizeCdtfaIdentifier(value: string): string {
  return value.replaceAll(/\D/g, '')
}

function getBrowserPageFactory(ctx: SourceContext): BrowserPageFactory {
  return ctx.browserPageFactory ?? openDefaultBrowserPage
}

function runPublicVerificationFlow(
  _entity: Entity,
  ctx: SourceContext,
): ResultAsync<SourceRunOutput, SourceError> {
  const query = choosePublicVerificationQuery(ctx)
  if (query.isErr()) {
    return errAsync(query.error)
  }
  if (query.value.normalizedIdentifier.length === 0) {
    return errAsync({
      type: 'validation',
      message:
        'CDTFA public permit verification requires an account identifier containing digits.',
    })
  }
  return getBrowserPageFactory(ctx)().andThen((session) =>
    ResultAsync.fromPromise(
      inspectPublicVerification(session, ctx, query.value).finally(() =>
        session.close(),
      ),
      toBrowserSourceError,
    ).andThen(resultToAsync),
  )
}

async function inspectPublicVerification(
  session: { readonly page: BrowserPage },
  ctx: SourceContext,
  query: PublicVerificationQuery,
): Promise<Result<SourceRunOutput, SourceError>> {
  const page = session.page
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS)
  await page.goto(CDTFA_ONLINE_SERVICES_URL, { waitUntil: 'networkidle' })
  await page.click('a:has-text("Verify a Permit, License or Account")')
  await page.waitForSelector('#d-3')
  await page.selectOption('#d-3', { label: query.accountType })
  await page.fill('#d-4', query.normalizedIdentifier)
  await page.click('button:has-text("Search")')

  const resultText = await readBodyTextAfterVerification(page, query)
  const summary = await parseVerificationSummary(page, query, resultText)
  if (summary.isErr()) {
    return err(summary.error)
  }
  return ok(buildVerificationOutput(ctx, query, summary.value))
}

async function readBodyTextAfterVerification(
  page: BrowserPage,
  query: PublicVerificationQuery,
): Promise<string> {
  let text = await page.locator('body').innerText()
  const deadline = Date.now() + PAGE_UPDATE_TIMEOUT_MS
  while (!hasVerificationResult(text, query) && Date.now() < deadline) {
    await sleep(PAGE_UPDATE_POLL_INTERVAL_MS)
    text = await page.locator('body').innerText()
  }
  return text
}

function hasVerificationResult(
  text: string,
  query: PublicVerificationQuery,
): boolean {
  const normalized = normalizeText(text)
  return (
    normalized.includes(validStatusText(query.accountType)) ||
    normalized.includes(invalidStatusText(query.accountType))
  )
}

async function parseVerificationSummary(
  page: BrowserPage,
  query: PublicVerificationQuery,
  resultText: string,
): Promise<Result<PermitVerificationSummary, SourceError>> {
  const verificationStatus = readVerificationStatus(resultText, query)
  if (verificationStatus.isErr()) {
    return err(verificationStatus.error)
  }
  const isValid =
    verificationStatus.value === validStatusText(query.accountType)
  const summary: PermitVerificationSummary = {
    accountType: query.accountType,
    accountNumber:
      readOptionalString(await page.locator('#d-4').inputValue()) ??
      query.identifier,
    verificationStatus: verificationStatus.value,
    isValid,
    startDate: readOptionalString(await page.locator('#f-3').inputValue()),
    endDate: readOptionalString(await page.locator('#f-4').inputValue()),
    ownerName: readOptionalString(await page.locator('#f-5').inputValue()),
    dbaName: readOptionalString(await page.locator('#f-6').inputValue()),
    address: readOptionalString(await page.locator('#f-7').inputValue()),
    suspensionBegin: readOptionalString(
      await page.locator('#f-8').inputValue(),
    ),
    suspensionEnd: readOptionalString(await page.locator('#f-9').inputValue()),
    city: readOptionalString(await page.locator('#f-a').inputValue()),
    zipCode: readOptionalString(await page.locator('#f-b').inputValue()),
  }
  if (!isValid) {
    return ok(summary)
  }
  const missing = listMissingValidResultLabels(summary)
  if (missing.length > 0) {
    return err({
      type: 'parse',
      message: `CA CDTFA public verification result is missing required field(s): ${missing.join(
        ', ',
      )}.`,
    })
  }
  return ok(summary)
}

function readVerificationStatus(
  text: string,
  query: PublicVerificationQuery,
): Result<string, SourceError> {
  const normalized = normalizeText(text)
  const valid = validStatusText(query.accountType)
  if (normalized.includes(valid)) {
    return ok(valid)
  }
  const invalid = invalidStatusText(query.accountType)
  if (normalized.includes(invalid)) {
    return ok(invalid)
  }
  return err({
    type: 'parse',
    message:
      'CA CDTFA public verification page did not show the expected verification result text.',
  })
}

function validStatusText(
  accountType: PublicVerificationQuery['accountType'],
): string {
  return `This is a valid ${accountType}.`
}

function invalidStatusText(
  accountType: PublicVerificationQuery['accountType'],
): string {
  return `This ${accountType} is invalid.`
}

function listMissingValidResultLabels(
  summary: PermitVerificationSummary,
): string[] {
  const fields: readonly (readonly [string, string | null])[] = [
    ['Account Number', summary.accountNumber],
    ['Start Date', summary.startDate],
    ['Owner Name', summary.ownerName],
  ]
  const missing: string[] = []
  for (const [label, value] of fields) {
    if (value === null || value.trim().length === 0) {
      missing.push(label)
    }
  }
  return missing
}

function buildVerificationOutput(
  ctx: SourceContext,
  query: PublicVerificationQuery,
  summary: PermitVerificationSummary,
): SourceRunOutput {
  return {
    record: {
      record_id: uuidv4(),
      source_id: 'ca-cdtfa-permit-license-verification',
      fetched_at: ctx.now().toISOString(),
      payload: {
        matchStatus: 'found',
        sourceType: 'public_permit_license_account_verification',
        search: {
          accountType: query.accountType,
          identifier: query.identifier,
          normalizedIdentifier: query.normalizedIdentifier,
        },
        account_type: summary.accountType,
        account_number: summary.accountNumber,
        verification_status: summary.verificationStatus,
        is_valid: summary.isValid,
        start_date: summary.startDate,
        end_date: summary.endDate,
        owner_name: summary.ownerName,
        dba_name: summary.dbaName,
        address: summary.address,
        suspension_begin: summary.suspensionBegin,
        suspension_end: summary.suspensionEnd,
        city: summary.city,
        zip_code: summary.zipCode,
        evidence: {
          kind: 'structured_public_verification_result',
          sourceId: 'ca-cdtfa-permit-license-verification',
          sourceUrl: CDTFA_ONLINE_SERVICES_URL,
          observedAt: ctx.now().toISOString(),
          label:
            'CA CDTFA public permit, license, or account verification result',
          accountType: summary.accountType,
          accountNumber: summary.accountNumber,
          verificationStatus: summary.verificationStatus,
          ownerName: summary.ownerName,
          startDate: summary.startDate,
        },
      },
    },
    findings: [],
  }
}

function readOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

function toBrowserSourceError(error: unknown): SourceError {
  return {
    type: 'network',
    message: `CA CDTFA public verification browser flow failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  }
}

function resultToAsync<T>(
  result: Result<T, SourceError>,
): ResultAsync<T, SourceError> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error)
}

export const caCdtfaPermitLicenseVerificationSource: Source = {
  id: 'ca-cdtfa-permit-license-verification',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: false,
  description:
    'CDTFA permit, license, or account verification from the public unauthenticated lookup.',
  accessUrl: CDTFA_ONLINE_SERVICES_URL,
  accessMethod: 'official_public_page',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-05-07T00:00:00.000Z',
  },
  tosUrl: CDTFA_TERMS_URL,
  run: runPublicVerificationFlow,
}

export const caCdtfaOnlineServicesSource: Source = {
  id: 'ca-cdtfa-online-services',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: true,
  description:
    'User-assisted CDTFA Online Services read-only account standing review.',
  accessUrl: CDTFA_ONLINE_SERVICES_URL,
  accessMethod: 'playwright_readonly',
  automationAllowed: true,
  tosUrl: CDTFA_TERMS_URL,
  auth: {
    loginUrl: CDTFA_ONLINE_SERVICES_URL,
    credentialMode: 'user_entered_session',
    credentialFields: [
      {
        key: 'username',
        label: 'CDTFA username',
        required: true,
        secret: false,
      },
      {
        key: 'password',
        label: 'CDTFA password',
        required: true,
        secret: true,
      },
    ],
    mfa: 'user_assisted',
    instructions: [
      'Use an authorized owner, employee, or delegated account with the narrowest access available for viewing account information.',
      'Sign in to CDTFA Online Services and complete MFA yourself.',
      'Open the relevant account overview without starting returns, payments, registration, closure, relief, extension, appeal, or access-management flows.',
      'Record the visible account status, permit/license/account types, filing obligations, notices, and reviewed-at date.',
    ],
    evidenceFields: [
      {
        key: 'cdtfa_accounts_present',
        label: 'Whether any CDTFA-managed account is present',
        required: true,
      },
      {
        key: 'account_statuses',
        label: 'Account statuses shown in Online Services',
        required: true,
      },
      {
        key: 'open_filing_obligations',
        label: 'Open filing obligations or none shown',
        required: false,
      },
      {
        key: 'notices_or_billings',
        label: 'Notices or billings shown, if any',
        required: false,
      },
      { key: 'reviewed_at', label: 'Reviewed-at date', required: true },
    ],
    forbiddenActions: [
      'Do not file returns or reports.',
      'Do not make payments or prepayments.',
      'Do not register, renew, close, or modify any permit, license, account, or location.',
      'Do not request relief, payment plans, filing extensions, appeals, or power of attorney.',
      'Do not add, remove, or change portal users, delegates, secondary logons, or access levels.',
      'Do not upload documents or submit forms.',
    ],
  },
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'CDTFA Online Services requires a user-assisted authenticated session before read-only discovery can run.',
    }),
}

export const _internal = {
  choosePublicVerificationQuery,
  normalizeCdtfaIdentifier,
  getBrowserPageFactory,
  hasVerificationResult,
  parseVerificationSummary,
  readOptionalString,
  readVerificationStatus,
  toBrowserSourceError,
}
