/**
 * IRS Tax-Exempt Organization Search source.
 *
 * Looks an EIN up in two IRS bulk-data files:
 *   - Publication 78 cumulative file (organisations eligible to receive
 *     tax-deductible contributions). Pipe-delimited fields, documented at
 *     https://www.irs.gov/pub/irs-tege/pub-78-data-dictionary.pdf
 *   - Auto Revocation list (organisations that lost exempt status for not
 *     filing). Pipe-delimited fields, documented at
 *     https://www.irs.gov/pub/irs-tege/auto-revocation-data-dictionary.pdf
 *
 * Both files are listed on the official "Tax Exempt Organization Search bulk
 * data downloads" page on irs.gov. They are the documented programmatic-
 * access surface for TEOS data — the apps.irs.gov web app does NOT expose a
 * stable public JSON API.
 *
 * Findings emitted:
 *   - `info`  EIN listed in IRS Pub. 78
 *   - `warn`  EIN not found in IRS Pub. 78
 *   - `error` EIN appears on the auto-revocation list with no reinstatement
 *   - `info`  EIN was auto-revoked but reinstated on a later date
 */
import { strFromU8, unzipSync } from 'fflate'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { type SourceError } from '../../../sources/errors.ts'
import type {
  Entity,
  Finding,
  Source,
  SourceContext,
  SourceRunOutput,
} from '../../../types/index.ts'

/**
 * Documented IRS download URLs for the two bulk files. Both are linked from
 * the "Tax Exempt Organization Search bulk data downloads" IRS page.
 */
export const IRS_TEOS_PUB78_URL =
  'https://apps.irs.gov/pub/epostcard/data-download-pub78.zip'

export const IRS_TEOS_REVOCATION_URL =
  'https://apps.irs.gov/pub/epostcard/data-download-revocation.zip'

const TOS_URL =
  'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads'

const DESCRIPTION =
  'Looks up an EIN in the IRS Publication 78 cumulative file and the IRS Automatic Revocation list. Both files are documented IRS bulk downloads.'

/**
 * Zod schema for the per-row Pub. 78 entry — used only as documentation; the
 * parser builds the value directly from the column array.
 */
const Pub78EntrySchema = z.object({
  tin: z.string(),
  organizationName: z.string(),
  city: z.string(),
  state: z.string(),
  foreignCountry: z.string(),
  deductibilityCode: z.string(),
})

type Pub78Entry = z.infer<typeof Pub78EntrySchema>

const RevocationEntrySchema = z.object({
  tin: z.string(),
  organizationName: z.string(),
  sortName: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zipCode: z.string(),
  country: z.string(),
  subSectionCode: z.string(),
  revocationDate: z.string(),
  revocationPostingDate: z.string(),
  reinstatementDate: z.string(),
})

type RevocationEntry = z.infer<typeof RevocationEntrySchema>

/**
 * Strip the optional dash from a 9-character EIN.
 */
function normaliseEin(ein: string): string {
  return ein.replace(/-/g, '')
}

/**
 * Pull the single entry out of a ZIP archive; the IRS files are always
 * single-entry, so anything else is a malformed payload.
 *
 * Iterating with `Object.entries` short-circuits both "empty zip" and
 * "named entry with no bytes" failure modes into one branch — there is no
 * way for `entry[0]` and `entry[1]` to both exist yet be undefined here.
 */
function unzipSingle(
  bytes: Uint8Array,
): { name: string; text: string } | { error: string } {
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes)
  } catch (err) {
    return { error: `Failed to unzip IRS payload: ${describeError(err)}` }
  }
  const entries = Object.entries(unzipped)
  const first = entries[0]
  if (first === undefined) {
    return { error: 'IRS zip contained no entries' }
  }
  const [name, data] = first
  return { name, text: strFromU8(data) }
}

/**
 * Parse a Pub. 78 line into a typed entry. Returns null for non-data lines
 * (so test fixtures can prepend a header without confusing the parser).
 */
/**
 * Parse a Pub. 78 line into a typed entry. Returns null for non-data lines
 * (so test fixtures can prepend a header without confusing the parser).
 *
 * Uses a Zod tuple to lock the column count and types in a single
 * validation step; success yields a fixed-length tuple where each position
 * is narrowed to `string`, which avoids the unreachable defensive branches
 * a length-then-destructure pattern would create.
 */
const Pub78TupleSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
])

function parsePub78Line(line: string): Pub78Entry | null {
  const cols = line.split('|').slice(0, 6)
  const parsed = Pub78TupleSchema.safeParse(cols)
  if (!parsed.success) {
    return null
  }
  const [
    tin,
    organizationName,
    city,
    state,
    foreignCountry,
    deductibilityCode,
  ] = parsed.data
  return {
    tin: tin.trim(),
    organizationName: organizationName.trim(),
    city: city.trim(),
    state: state.trim(),
    foreignCountry: foreignCountry.trim(),
    deductibilityCode: deductibilityCode.trim(),
  }
}

/**
 * Parse an Auto Revocation line. Returns null for malformed lines.
 *
 * Same tuple-validation strategy as `parsePub78Line`.
 */
const RevocationTupleSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
])

function parseRevocationLine(line: string): RevocationEntry | null {
  const cols = line.split('|').slice(0, 12)
  const parsed = RevocationTupleSchema.safeParse(cols)
  if (!parsed.success) {
    return null
  }
  const [
    tin,
    organizationName,
    sortName,
    address,
    city,
    state,
    zipCode,
    country,
    subSectionCode,
    revocationDate,
    revocationPostingDate,
    reinstatementDate,
  ] = parsed.data
  return {
    tin: tin.trim(),
    organizationName: organizationName.trim(),
    sortName: sortName.trim(),
    address: address.trim(),
    city: city.trim(),
    state: state.trim(),
    zipCode: zipCode.trim(),
    country: country.trim(),
    subSectionCode: subSectionCode.trim(),
    revocationDate: revocationDate.trim(),
    revocationPostingDate: revocationPostingDate.trim(),
    reinstatementDate: reinstatementDate.trim(),
  }
}

/**
 * Find the first matching row in a pipe-delimited text body.
 */
function findPub78Match(text: string, ein: string): Pub78Entry | null {
  for (const line of text.split(/\r?\n/)) {
    const entry = parsePub78Line(line)
    if (entry !== null && entry.tin === ein) {
      return entry
    }
  }
  return null
}

function findRevocationMatch(
  text: string,
  ein: string,
): RevocationEntry | null {
  for (const line of text.split(/\r?\n/)) {
    const entry = parseRevocationLine(line)
    if (entry !== null && entry.tin === ein) {
      return entry
    }
  }
  return null
}

/**
 * Translate a fetch failure into a SourceError.
 */
function toFetchError(err: unknown): SourceError {
  return {
    type: 'network',
    message: `IRS download failed: ${describeError(err)}`,
  }
}

/**
 * Render an unknown thrown value as a string. Centralised so the
 * Error-vs-not branch is in one place that's directly tested.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

/**
 * Read the raw bytes of an IRS ZIP, with typed errors for the failure modes
 * the runner cares about (rate_limit, http, network).
 */
function fetchZip(
  ctx: SourceContext,
  url: string,
): ResultAsync<Uint8Array, SourceError> {
  return ResultAsync.fromPromise(ctx.fetch(url), toFetchError).andThen<
    Uint8Array,
    SourceError
  >((response) => {
    if (response.status === 429) {
      const headerValue = response.headers.get('retry-after')
      const parsedRetry =
        headerValue === null ? Number.NaN : Number(headerValue)
      return errAsync({
        type: 'rate_limit',
        message: 'IRS rate-limited the bulk-data download',
        ...(Number.isFinite(parsedRetry)
          ? { retryAfterSeconds: parsedRetry }
          : {}),
      })
    }
    if (!response.ok) {
      return errAsync({
        type: 'http',
        status: response.status,
        message: `IRS download returned non-2xx for ${url}`,
      })
    }
    return ResultAsync.fromPromise(response.arrayBuffer(), toFetchError).map(
      (buf) => new Uint8Array(buf),
    )
  })
}

/**
 * Take raw zip bytes and return the file's text contents.
 */
function readZippedText(bytes: Uint8Array): ResultAsync<string, SourceError> {
  const result = unzipSingle(bytes)
  if ('error' in result) {
    return errAsync({ type: 'parse', message: result.error })
  }
  return okAsync(result.text)
}

interface ScanArgs {
  readonly entity: Entity
  readonly ctx: SourceContext
  readonly ein: string
}

interface ScanOutput {
  readonly pub78: Pub78Entry | null
  readonly autoRevocation: RevocationEntry | null
}

function scanIrs(args: ScanArgs): ResultAsync<ScanOutput, SourceError> {
  const { ctx, ein } = args

  return fetchZip(ctx, IRS_TEOS_PUB78_URL)
    .andThen((bytes) => readZippedText(bytes))
    .map((text) => findPub78Match(text, ein))
    .andThen((pub78) =>
      fetchZip(ctx, IRS_TEOS_REVOCATION_URL)
        .andThen((bytes) => readZippedText(bytes))
        .map((text) => ({
          pub78,
          autoRevocation: findRevocationMatch(text, ein),
        })),
    )
}

interface BuildOutputArgs {
  readonly entity: Entity
  readonly ctx: SourceContext
  readonly scan: ScanOutput
}

function makeFindings(args: BuildOutputArgs): Finding[] {
  const { ctx, scan } = args
  const openedAt = ctx.now().toISOString()
  const findings: Finding[] = []

  if (scan.pub78 !== null) {
    findings.push({
      finding_id: uuidv4(),
      jurisdiction_id: 'us-federal',
      source_id: 'irs-teos',
      severity: 'info',
      status: 'open',
      title: 'EIN listed in IRS Pub. 78',
      detail: `IRS Publication 78 lists this EIN with deductibility code "${scan.pub78.deductibilityCode}".`,
      evidence: { deductibilityCode: scan.pub78.deductibilityCode },
      opened_at: openedAt,
      resolved_at: null,
    })
  } else {
    findings.push({
      finding_id: uuidv4(),
      jurisdiction_id: 'us-federal',
      source_id: 'irs-teos',
      severity: 'warn',
      status: 'open',
      title: 'EIN not found in IRS Pub. 78',
      detail:
        'No matching row in the IRS Publication 78 cumulative file. This may mean the organisation is not currently eligible to receive tax-deductible contributions, or that Pub. 78 is out of date.',
      evidence: {},
      opened_at: openedAt,
      resolved_at: null,
    })
  }

  if (scan.autoRevocation !== null) {
    const reinstated = scan.autoRevocation.reinstatementDate.length > 0
    if (reinstated) {
      findings.push({
        finding_id: uuidv4(),
        jurisdiction_id: 'us-federal',
        source_id: 'irs-teos',
        severity: 'info',
        status: 'open',
        title: 'EIN previously auto-revoked, reinstated',
        detail: `IRS auto-revocation list shows revocation on ${scan.autoRevocation.revocationDate} with reinstatement on ${scan.autoRevocation.reinstatementDate}.`,
        evidence: {
          revocationDate: scan.autoRevocation.revocationDate,
          reinstatementDate: scan.autoRevocation.reinstatementDate,
        },
        opened_at: openedAt,
        resolved_at: null,
      })
    } else {
      findings.push({
        finding_id: uuidv4(),
        jurisdiction_id: 'us-federal',
        source_id: 'irs-teos',
        severity: 'error',
        status: 'open',
        title: 'EIN appears on IRS auto-revocation list',
        detail: `IRS automatic-revocation list shows revocation on ${scan.autoRevocation.revocationDate} with no reinstatement on record.`,
        evidence: {
          revocationDate: scan.autoRevocation.revocationDate,
          revocationPostingDate: scan.autoRevocation.revocationPostingDate,
        },
        opened_at: openedAt,
        resolved_at: null,
      })
    }
  }

  return findings
}

/**
 * The IRS TEOS source.
 */
export const irsTeosSource: Source = {
  id: 'irs-teos',
  jurisdiction: 'us-federal',
  kind: 'api',
  authRequired: false,
  description: DESCRIPTION,
  tosUrl: TOS_URL,

  run(entity, ctx): ResultAsync<SourceRunOutput, SourceError> {
    const ein = ctx.identifiers['us-federal']?.ein
    if (ein === undefined) {
      return errAsync({
        type: 'validation',
        message:
          'IRS TEOS source requires a us-federal EIN identifier in context.identifiers',
      })
    }
    const normalised = normaliseEin(ein)

    return scanIrs({ entity, ctx, ein: normalised }).map<SourceRunOutput>(
      (scan) => ({
        record: {
          record_id: uuidv4(),
          source_id: 'irs-teos',
          fetched_at: ctx.now().toISOString(),
          payload: {
            pub78: scan.pub78,
            autoRevocation: scan.autoRevocation,
          },
        },
        findings: makeFindings({ entity, ctx, scan }),
      }),
    )
  },
}

/**
 * Internal helpers exposed for unit testing parsers in isolation. Production
 * code should consume `irsTeosSource` directly.
 */
export const _internal = {
  Pub78EntrySchema,
  RevocationEntrySchema,
  describeError,
  normaliseEin,
  parsePub78Line,
  parseRevocationLine,
  findPub78Match,
  findRevocationMatch,
  unzipSingle,
}
