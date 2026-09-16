/**
 * Server-side rendering for compliance-status.
 *
 * Why this exists at the MCP boundary (not in the pure backend):
 * compliance-status returns rich structured JSON, but the host LLM
 * receives only a single text block in the tool result. Without a
 * server-rendered narrative, the model decides on its own which fields
 * to surface, often skipping links, skipping date arithmetic, and
 * issuing vague action items like "provide authenticated sessions"
 * without telling the user *how*. We render the narrative here so the
 * model can emit it verbatim and the user gets a consistent,
 * linkable, date-aware report.
 *
 * MCP prompts (compliance-overview) are user-invoked and not loaded by
 * default when a client just calls the tool — so prompt-side rendering
 * instructions have no effect on what the user sees. The fix has to
 * live in the tool response.
 */
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { Finding } from '../../../../../src/compliance/types/index.ts'
import type {
  ComplianceStatusSourceMeta,
  EnrichedComplianceStatusReport,
} from './status'

const SEVERITY_EMOJI: Record<Finding['severity'], string> = {
  warn: '⚠️',
  error: '🛑',
  info: 'ℹ️',
}

const OVERALL_LABEL: Record<EnrichedComplianceStatusReport['overall'], string> =
  {
    clear: '✅ Clear',
    attention_required: '⚠️ Attention Required',
    unknown: '❓ Unknown',
  }

const STATUS_TAG: Record<'succeeded' | 'failed', string> = {
  succeeded: '✅',
  failed: '❌',
}

/**
 * Index sources by id so we can dereference per-finding / per-run
 * lookups in O(1).
 */
function indexSources(
  sources: readonly ComplianceStatusSourceMeta[],
): ReadonlyMap<string, ComplianceStatusSourceMeta> {
  const m = new Map<string, ComplianceStatusSourceMeta>()
  for (const s of sources) {
    m.set(s.sourceId, s)
  }
  return m
}

/**
 * The link we surface for each source. Some payloads (notably the CA
 * AG registry detail page) carry a `detailUrl` that looks per-entity
 * but is actually session-bound on the server — following it from a
 * fresh browser redirects to /ErrorPage.html. So we always use the
 * stable accessUrl. Per-entity identifiers (RCT #, SOS #, account #)
 * are surfaced in renderPayloadSummary so the user can paste them
 * into the search themselves.
 */
function pickPrimaryLink(
  source: ComplianceStatusSourceMeta | undefined,
): string | undefined {
  return source?.accessUrl
}

/**
 * Parse a date string into a Luxon DateTime. Supports both ISO-8601
 * (most timestamps in the system) and US-style "M/D/YYYY" (the CA AG
 * registry returns dates in this format on the public detail page).
 * Returns null if neither parse works — caller skips relative
 * formatting in that case.
 */
function parseDate(input: string): DateTime | null {
  const iso = DateTime.fromISO(input, { zone: 'utc' })
  if (iso.isValid) return iso
  // Luxon's M/d/yyyy parser accepts both "5/15/2026" and "05/15/2026"
  // — covers both the loose and zero-padded forms the CA AG registry
  // emits.
  const us = DateTime.fromFormat(input, 'M/d/yyyy', { zone: 'utc' })
  if (us.isValid) return us
  return null
}

/**
 * Render an observation date relative to `now`:
 *   "2026-05-21 — 12 minutes ago" / "2 hours ago" / "5 days ago".
 * Returns just the original input if we can't parse it. Used for
 * "checked" / "completed" framings; deadline math (overdue / due in)
 * is handled inline in deriveActionItems because deadlines need
 * day-boundary semantics, not millisecond-precision elapsed time.
 */
function renderRelativeDate(input: string, now: DateTime): string {
  const dt = parseDate(input)
  if (dt === null) return input
  const diffMs = dt.toMillis() - now.toMillis()
  const absMs = Math.abs(diffMs)
  const minutes = Math.floor(absMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const display = dt.toFormat('yyyy-LL-dd')
  const phrase = (() => {
    if (diffMs > 0) {
      // future observation is unusual; fall back to absolute date
      return display
    }
    if (days > 0) return `${String(days)} days ago`
    if (hours > 0) return `${String(hours)} hours ago`
    if (minutes > 0) return `${String(minutes)} minutes ago`
    return 'just now'
  })()
  return `${display} — **${phrase}**`
}

/**
 * Per-source payload summaries.
 *
 * Each source persists its own payload shape. To surface the
 * substantive findings (501(c)(3) status, FTB exempt status, sellers
 * permit validity, etc.) we declare a permissive Zod schema for just
 * the fields we want to render, and project them into 1-3 short bullet
 * lines. If safeParse fails (schema change upstream), we skip the
 * summary rather than render a partial fact — the user still sees the
 * row's status + link.
 *
 * Adding a new source: define a Zod schema for the payload fields you
 * want surfaced, write a summariseFoo(payload) -> string[], and wire it
 * into renderPayloadSummary's switch.
 */

const IrsTeosPayloadSchema = z
  .object({
    pub78: z
      .object({
        deductibilityCode: z.string().optional(),
        organizationName: z.string().optional(),
      })
      .partial()
      .optional(),
    autoRevocation: z.unknown().nullable().optional(),
  })
  .partial()

function summariseIrsTeos(payload: unknown): readonly string[] {
  const parsed = IrsTeosPayloadSchema.safeParse(payload)
  if (!parsed.success) return []
  const lines: string[] = []
  const code = parsed.data.pub78?.deductibilityCode
  if (code !== undefined) {
    lines.push(`Listed in IRS Pub. 78 — deductibility code **${code}**`)
  }
  if (parsed.data.autoRevocation === null) {
    lines.push('No automatic revocation on record')
  }
  return lines
}

const IrsBmfPayloadSchema = z
  .object({
    decoded: z
      .object({
        subsection: z.string().optional(),
        status: z.string().optional(),
        foundation: z.string().optional(),
        deductibility: z.string().optional(),
        affiliation: z.string().optional(),
      })
      .partial()
      .optional(),
    row: z
      .object({
        revenueAmount: z.string().optional(),
        assetAmount: z.string().optional(),
        taxPeriod: z.string().optional(),
      })
      .partial()
      .optional(),
    upstreamPublishedAt: z.string().optional(),
  })
  .partial()

function formatUsd(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return `$${n.toLocaleString('en-US')}`
}

function summariseIrsEoBmf(payload: unknown): readonly string[] {
  const parsed = IrsBmfPayloadSchema.safeParse(payload)
  if (!parsed.success) return []
  const lines: string[] = []
  const d = parsed.data.decoded
  if (d !== undefined) {
    const fields = [d.subsection, d.status, d.foundation, d.deductibility]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' · ')
    if (fields.length > 0) {
      lines.push(fields)
    }
  }
  const r = parsed.data.row
  if (r?.taxPeriod !== undefined) {
    const year = r.taxPeriod.slice(0, 4)
    const month = r.taxPeriod.slice(4, 6)
    const revenue = formatUsd(r.revenueAmount)
    const assets = formatUsd(r.assetAmount)
    const parts: string[] = []
    if (revenue !== undefined) parts.push(`revenue ${revenue}`)
    if (assets !== undefined) parts.push(`assets ${assets}`)
    if (parts.length > 0) {
      lines.push(`Tax period ${year}-${month}: ${parts.join(', ')}`)
    }
  }
  return lines
}

const CaSosBizfilePayloadSchema = z
  .object({
    entity_name: z.string().optional(),
    entity_status: z.string().optional(),
    standing: z.string().optional(),
    entity_type: z.string().optional(),
    formed_in: z.string().optional(),
    sos_entity_number: z.string().optional(),
    initial_filing_date: z.string().optional(),
  })
  .partial()

function summariseCaSosBizfile(payload: unknown): readonly string[] {
  const parsed = CaSosBizfilePayloadSchema.safeParse(payload)
  if (!parsed.success) return []
  const d = parsed.data
  const lines: string[] = []
  const statusBits = [d.entity_status, d.standing, d.entity_type]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' · ')
  if (statusBits.length > 0) {
    const formed =
      d.formed_in !== undefined && d.formed_in.length > 0
        ? ` (formed in ${d.formed_in})`
        : ''
    lines.push(`${statusBits}${formed}`)
  }
  if (
    d.sos_entity_number !== undefined &&
    d.initial_filing_date !== undefined
  ) {
    lines.push(
      `Entity #${d.sos_entity_number}, initial filing ${d.initial_filing_date}`,
    )
  }
  return lines
}

const CaAgRegistryPayloadSchema = z
  .object({
    name: z.string().optional(),
    registryStatus: z.string().optional(),
    stateCharityRegistrationNumber: z.string().optional(),
    renewalDueDate: z.string().optional(),
    lastRenewal: z.string().optional(),
    listCategory: z.string().optional(),
  })
  .partial()

function summariseCaAgRegistry(
  payload: unknown,
  now: DateTime,
): readonly string[] {
  const parsed = CaAgRegistryPayloadSchema.safeParse(payload)
  if (!parsed.success) return []
  const d = parsed.data
  const lines: string[] = []
  if (
    d.registryStatus !== undefined &&
    d.stateCharityRegistrationNumber !== undefined
  ) {
    lines.push(
      `Registry status: **${d.registryStatus}** (RCT #${d.stateCharityRegistrationNumber})`,
    )
  } else if (d.registryStatus !== undefined) {
    lines.push(`Registry status: **${d.registryStatus}**`)
  }
  if (d.renewalDueDate !== undefined) {
    const due = parseDate(d.renewalDueDate)
    if (due !== null) {
      const diffDays = Math.round(
        (due.startOf('day').toMillis() - now.startOf('day').toMillis()) /
          86_400_000,
      )
      const relative =
        diffDays < 0
          ? `**Overdue by ${String(-diffDays)} days**`
          : diffDays === 0
            ? '**due today**'
            : `**due in ${String(diffDays)} days**`
      lines.push(`Next renewal: ${d.renewalDueDate} — ${relative}`)
    } else {
      lines.push(`Next renewal: ${d.renewalDueDate}`)
    }
  }
  if (d.lastRenewal !== undefined) {
    lines.push(`Last renewal filed: ${d.lastRenewal}`)
  }
  return lines
}

const CaFtbEsLetterPayloadSchema = z
  .object({
    entity_id: z.string().optional(),
    entity_name: z.string().optional(),
    ftb_status: z.string().optional(),
    exempt_status_verified: z.string().optional(),
  })
  .partial()

function summariseCaFtbEntityStatusLetter(payload: unknown): readonly string[] {
  const parsed = CaFtbEsLetterPayloadSchema.safeParse(payload)
  if (!parsed.success) return []
  const d = parsed.data
  const lines: string[] = []
  if (d.ftb_status !== undefined) {
    lines.push(`Entity status: **${d.ftb_status}**`)
  }
  if (d.exempt_status_verified !== undefined) {
    const flag =
      d.exempt_status_verified.toUpperCase().includes('NOT') ||
      d.exempt_status_verified.toUpperCase().includes('NO') ||
      d.exempt_status_verified.toUpperCase().includes('UNVERIFIED')
        ? '⚠️ '
        : ''
    lines.push(`Exempt status: ${flag}**${d.exempt_status_verified}**`)
  }
  return lines
}

const CaCdtfaPayloadSchema = z
  .object({
    account_number: z.string().optional(),
    account_type: z.string().optional(),
    owner_name: z.string().nullable().optional(),
    verification_status: z.string().optional(),
    start_date: z.string().nullable().optional(),
    is_valid: z.boolean().optional(),
  })
  .partial()

function summariseCaCdtfaVerification(payload: unknown): readonly string[] {
  const parsed = CaCdtfaPayloadSchema.safeParse(payload)
  if (!parsed.success) return []
  const d = parsed.data
  const lines: string[] = []
  if (d.account_type !== undefined && d.account_number !== undefined) {
    const validTag = d.is_valid === true ? '**Valid** ' : ''
    lines.push(`${validTag}${d.account_type} #${d.account_number}`)
  }
  if (d.owner_name !== undefined && d.owner_name !== null) {
    lines.push(`Owner: ${d.owner_name}`)
  }
  if (d.start_date !== undefined && d.start_date !== null) {
    lines.push(`Start date: ${d.start_date}`)
  }
  return lines
}

function renderPayloadSummary(
  sourceId: string,
  payload: unknown,
  now: DateTime,
): readonly string[] {
  if (payload === null) return []
  switch (sourceId) {
    case 'irs-teos':
      return summariseIrsTeos(payload)
    case 'irs-eo-bmf':
      return summariseIrsEoBmf(payload)
    case 'ca-sos-bizfile':
      return summariseCaSosBizfile(payload)
    case 'ca-ag-registry':
      return summariseCaAgRegistry(payload, now)
    case 'ca-ftb-entity-status-letter':
      return summariseCaFtbEntityStatusLetter(payload)
    case 'ca-cdtfa-permit-license-verification':
      return summariseCaCdtfaVerification(payload)
    default:
      return []
  }
}

/**
 * Render one per-source row in the results table.
 *
 * Format constraints (learned from observing what survives client-side
 * paraphrasing in claude.ai-class clients):
 *
 * - **The agency name itself IS the markdown link.** A trailing
 *   `— [source-id](url)` tag gets stripped because the model
 *   classifies it as a technical artifact secondary to the agency
 *   name. Wrapping the agency name in the link forces the model to
 *   either keep the link or drop the agency name entirely.
 * - **One-line summaries survive; multi-bullet sub-lists do not.**
 *   The model compresses sub-bullets into one summary line and
 *   picks whichever bullet it considers most representative, dropping
 *   the rest. We previously saw the FTB "Exempt status: NOT EXEMPT"
 *   being dropped while "Entity status: ACTIVE" survived. Inline
 *   everything separated by ` · ` so the model can't drop half.
 * - **Auth-required: collapse to one line with the loginUrl + first
 *   instruction.** Multi-line "Authentication required" blocks were
 *   getting compressed too. A single line with the link survives.
 */
function renderSourceRow(
  run: EnrichedComplianceStatusReport['latestRuns'][number],
  sources: ReadonlyMap<string, ComplianceStatusSourceMeta>,
  now: DateTime,
): string {
  const meta = sources.get(run.source_id)
  const tag = STATUS_TAG[run.status]
  const agency = meta?.agency ?? '(unknown agency)'
  const link = pickPrimaryLink(meta)
  const heading =
    link === undefined
      ? `**${agency}** (${run.source_id})`
      : `[**${agency}**](${link}) (${run.source_id})`
  const summary = renderPayloadSummary(run.source_id, run.payload, now).join(
    ' · ',
  )
  const summaryInline = summary === '' ? '' : ` — ${summary}`
  const checked = renderRelativeDate(run.completed_at, now)
  const failureSummary = (() => {
    if (run.status !== 'failed') return ''
    if (run.error_type === 'auth_required') {
      const auth = meta?.auth
      if (auth === undefined) return ' — auth required'
      const firstInstruction =
        auth.instructions[0] ?? 'Sign in and complete MFA.'
      return ` — 🔐 sign in at [${auth.loginUrl}](${auth.loginUrl}). ${firstInstruction} Then run \`compliance-record-evidence\` with \`sourceId: ${run.source_id}\`.`
    }
    const errType = run.error_type ?? 'failed'
    const errMsg =
      run.error_message === null ? '' : `: ${run.error_message.slice(0, 200)}`
    return ` — ❌ ${errType}${errMsg}`
  })()
  return `- ${tag} ${heading}${summaryInline}${failureSummary} _(checked ${checked})_`
}

/**
 * Render one open finding. Severity emoji + title + linked source +
 * one-line "what / why".
 */
function renderFinding(
  finding: Finding,
  sources: ReadonlyMap<string, ComplianceStatusSourceMeta>,
): string {
  const meta = sources.get(finding.source_id)
  const emoji = SEVERITY_EMOJI[finding.severity]
  // Wrap the title in the link (same pattern as source rows) so
  // client-side paraphrasers keep the link. Detail stays inline on
  // the same line — multi-line sub-bullets get compressed.
  const titleAndLink =
    meta === undefined
      ? `**${finding.title}**`
      : `[**${finding.title}**](${meta.accessUrl})`
  return `- ${emoji} ${titleAndLink} (${finding.source_id}) — ${finding.detail}`
}

/**
 * Action items are derived heuristically from open findings + a few
 * payload-level signals (renewal due dates). Sorted by urgency:
 *   overdue deadlines → blockers → imminent deadlines → substantive
 *   warnings → later deadlines → auth_required → info.
 *
 * The split point for deadlines is IMMINENT_DEADLINE_DAYS: a renewal
 * due within that window outranks substantive warnings (a deadline a
 * few days out is more pressing than a soft "investigate"); a deadline
 * further out is shown after warnings.
 */
interface ActionItem {
  readonly urgency: number // lower = more urgent
  readonly text: string
}

// Urgency bands for action-item sorting (lower = more urgent). Overdue
// deadlines use their (negative) day count directly, so they always
// sort ahead of everything below.
const URGENCY_BLOCKER = 10
const URGENCY_IMMINENT_DEADLINE_BASE = 100 // + days until due
const URGENCY_WARNING = 200
const URGENCY_LATER_DEADLINE_BASE = 300 // + days until due
const URGENCY_AUTH_REQUIRED = 5000
// A renewal due within this many days outranks substantive warnings;
// beyond it, the warning is shown first.
const IMMINENT_DEADLINE_DAYS = 14

function deriveActionItems(
  report: EnrichedComplianceStatusReport,
  now: DateTime,
  sources: ReadonlyMap<string, ComplianceStatusSourceMeta>,
): readonly string[] {
  const items: ActionItem[] = []

  // ── Payload-derived deadlines ──────────────────────────────────
  // Anything with a renewalDueDate (today: CA AG registry) gets
  // sorted by how close the deadline is.
  for (const run of report.latestRuns) {
    const p = run.payload
    if (p === null || typeof p !== 'object' || !('renewalDueDate' in p)) {
      continue
    }
    const due = p.renewalDueDate
    if (typeof due !== 'string') continue
    const dt = parseDate(due)
    if (dt === null) continue
    // Compare on day boundaries (both in UTC). 5/15 vs 5/21 should
    // read as "6 days" — not 7 because `now` happens to be at noon
    // UTC, which is what millisecond-floor arithmetic would give.
    const diffDays = Math.round(
      (dt.startOf('day').toMillis() - now.startOf('day').toMillis()) /
        86_400_000,
    )
    const meta = sources.get(run.source_id)
    const link = pickPrimaryLink(meta)
    // Per-entity identifier hint — appears in the link text so the
    // model can't strip it without dropping the link.
    const idHint =
      run.source_id === 'ca-ag-registry' &&
      'stateCharityRegistrationNumber' in p &&
      typeof p.stateCharityRegistrationNumber === 'string'
        ? ` (RCT #${p.stateCharityRegistrationNumber})`
        : ''
    const agency = meta?.agency ?? run.source_id
    // Make the renewal action itself the link. The model strips
    // trailing "[Open X](url)" tags as decorative; making the verb
    // phrase the link keeps it.
    const renewLink =
      link === undefined
        ? `Renew ${agency} registration${idHint}`
        : `[Renew ${agency} registration${idHint}](${link})`
    if (diffDays < 0) {
      items.push({
        urgency: diffDays, // negative — most overdue → most urgent
        text: `**🚨 Overdue by ${String(-diffDays)} days** — ${renewLink}. Was due ${due} (today is ${now.toFormat('yyyy-LL-dd')}).`,
      })
    } else if (diffDays <= 60) {
      // Imminent deadlines outrank substantive warnings; later ones
      // fall below warnings. Adding diffDays keeps nearer deadlines
      // ahead of further ones within each band.
      const base =
        diffDays <= IMMINENT_DEADLINE_DAYS
          ? URGENCY_IMMINENT_DEADLINE_BASE
          : URGENCY_LATER_DEADLINE_BASE
      items.push({
        urgency: base + diffDays,
        text: `**Due in ${String(diffDays)} days** — ${renewLink}. Due ${due}.`,
      })
    }
  }

  // ── Findings-derived items ─────────────────────────────────────
  for (const finding of report.openFindings) {
    if (finding.severity === 'info') continue // covered in findings list, not an action
    const meta = sources.get(finding.source_id)
    const isAuthRequired = finding.evidence?.code === 'source.auth_required'

    if (isAuthRequired) {
      const auth = meta?.auth
      if (meta !== undefined && auth !== undefined) {
        const firstInstruction = auth.instructions[0]
        const instructionSuffix =
          firstInstruction === undefined ? '' : ` ${firstInstruction}`
        // The verb itself is the link — same pattern as overdue
        // items above. This survives client-side paraphrasing better
        // than a trailing "[Sign in](url)" tag.
        items.push({
          urgency: URGENCY_AUTH_REQUIRED,
          text: `**🔐 Auth required** — [Sign in to ${meta.agency}](${auth.loginUrl}).${instructionSuffix} Then run \`compliance-record-evidence\` with \`sourceId: ${finding.source_id}\`.`,
        })
      }
    } else {
      // Substantive finding (e.g. ca.ftb.exempt_status_not_verified).
      // Error severity is a blocker (most urgent non-overdue item);
      // warn severity is an investigate. Wrap the finding title in the
      // link so the action keeps it.
      const isError = finding.severity === 'error'
      const titleWithLink =
        meta === undefined
          ? finding.title
          : `[${finding.title}](${meta.accessUrl})`
      items.push({
        urgency: isError ? URGENCY_BLOCKER : URGENCY_WARNING,
        text: `**${isError ? '🛑 Blocker' : '⚠️ Investigate'}** — ${titleWithLink}. ${finding.detail}`,
      })
    }
  }

  if (items.length === 0) {
    return ['No action items — everything that can be automated is clear.']
  }
  items.sort((a, b) => a.urgency - b.urgency)
  return items.map((i) => i.text)
}

/**
 * Render the full Markdown report. This is what the MCP tool returns
 * as its primary `content[0].text`; the model is expected to emit it
 * largely as-is.
 */
export function renderComplianceStatusMarkdown(
  report: EnrichedComplianceStatusReport,
): string {
  const sources = indexSources(report.sources)
  const now = DateTime.fromISO(report.now, { zone: 'utc' })

  const lines: string[] = []
  lines.push(`# Compliance Status: ${report.entity.legal_name}`)
  lines.push('')
  lines.push(
    `**Overall:** ${OVERALL_LABEL[report.overall]} · _checked ${now.toFormat('yyyy-LL-dd HH:mm')} UTC_`,
  )
  lines.push('')

  lines.push('## Entity')
  lines.push(`- **Legal name:** ${report.entity.legal_name}`)
  lines.push(
    `- **State of incorporation:** ${report.entity.state_of_incorporation}`,
  )
  lines.push(`- **Formation:** ${report.entity.formation_date}`)
  lines.push(
    `- **Fiscal year end:** ${String(report.entity.fiscal_year_end_month).padStart(2, '0')}-${String(report.entity.fiscal_year_end_day).padStart(2, '0')}`,
  )
  lines.push(
    `- **Mailing address:** ${[report.entity.mailing_address_line1, report.entity.mailing_address_line2, report.entity.mailing_address_city, report.entity.mailing_address_region, report.entity.mailing_address_postal_code].filter((v) => v !== null && v !== '').join(', ')}`,
  )
  lines.push('')

  lines.push('## Per-source results')
  for (const run of report.latestRuns) {
    lines.push(renderSourceRow(run, sources, now))
  }
  lines.push('')

  if (report.openFindings.length > 0) {
    lines.push(`## Open findings (${String(report.openFindings.length)})`)
    for (const f of report.openFindings) {
      lines.push(renderFinding(f, sources))
    }
    lines.push('')
  }

  lines.push('## Action items')
  const items = deriveActionItems(report, now, sources)
  items.forEach((text, i) => {
    lines.push(`${String(i + 1)}. ${text}`)
  })
  lines.push('')

  return lines.join('\n')
}
