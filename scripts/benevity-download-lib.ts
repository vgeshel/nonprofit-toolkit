/**
 * Benevity Causes Portal report downloader.
 *
 * The portal offers one Donations Report per disbursement, reachable only by
 * walking the legacy reports table — 10 rows per page, ~57 pages, no bulk
 * export. This module harvests those links and pulls each report through the
 * signed-in session.
 *
 * All portal interaction goes through the `PortalDriver` interface so the walk
 * and the download loop are testable without a browser; `benevity-download.ts`
 * supplies the Playwright implementation.
 */
import { Command } from 'commander'
import { z } from 'zod'

/**
 * Message for a thrown value, which is not guaranteed to be an Error.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Where the legacy disbursement reports table lives.
 */
export function reportsPageUrl(causeId: string): string {
  return `https://causes.benevity.org/causesapp/reports/disbursements/${causeId}`
}

/**
 * A single disbursement's report link, as listed in the table.
 */
export const DisbursementLinkSchema = z.object({
  /** Benevity disbursement ID, e.g. 1WLFLKD5A8 */
  disbursementId: z.string().min(1),
  /** Path to the report download, relative to the portal origin */
  href: z.string().min(1),
  /** Period end date as rendered in the table, e.g. "Sep 6, 2026" */
  periodEndDate: z.string().default(''),
  /** Disbursing entity as rendered in the table */
  grantor: z.string().default(''),
})

export type DisbursementLink = z.infer<typeof DisbursementLinkSchema>

/**
 * The portal operations the downloader needs.
 */
export interface PortalDriver {
  /** True when the portal shows a signed-in session. */
  isSignedIn(): Promise<boolean>
  /** Navigate to the legacy disbursement reports table. */
  openReportsPage(causeId: string): Promise<void>
  /** Report links listed on the page currently displayed. */
  currentPageLinks(): Promise<unknown[]>
  /** Advance one page; false when already on the last page. */
  nextPage(): Promise<boolean>
  /** Fetch a report body through the authenticated session. */
  fetchReport(href: string): Promise<string>
}

/**
 * Filesystem operations, injected so the download loop stays testable.
 */
export interface DownloadFs {
  listExisting(dir: string): Promise<string[]>
  writeReport(dir: string, filename: string, body: string): Promise<void>
}

export interface DownloadOptions {
  causeId: string
  outDir: string
  sessionPath: string
  login: boolean
  force: boolean
  maxPages: number
  concurrency: number
}

const OptionsSchema = z.object({
  causeId: z.string().min(1, 'A Benevity cause ID is required'),
  outDir: z.string().min(1),
  sessionPath: z.string().min(1),
  login: z.boolean(),
  force: z.boolean(),
  maxPages: z.number().int().positive(),
  concurrency: z.number().int().positive().max(32),
})

const RawOptsSchema = z.object({
  cause: z.string().optional(),
  out: z.string().optional(),
  session: z.string().optional(),
  login: z.boolean().optional(),
  force: z.boolean().optional(),
  maxPages: z.string().optional(),
  concurrency: z.string().optional(),
})

/**
 * A page count high enough to cover the full history with room to grow. The
 * walk stops as soon as the portal says there is no next page; this only bounds
 * a pagination control that never reports the end.
 */
export const DEFAULT_MAX_PAGES = 200

export function parseArgs(
  args: string[],
  env: Record<string, string | undefined> = {},
): DownloadOptions {
  const program = new Command()
    .name('benevity-download')
    .description('Download Benevity Donations Reports from the Causes Portal')
    .option('--cause <id>', 'Benevity cause ID (default: $BENEVITY_CAUSE_ID)')
    .option('--out <dir>', 'Directory to write report CSVs into')
    .option('--session <path>', 'Path to the saved portal session state')
    .option('--login', 'Open a visible browser to sign in and save the session')
    .option('--force', 'Re-download reports already present in the output dir')
    .option('--max-pages <n>', 'Safety bound on pagination')
    .option('--concurrency <n>', 'Parallel report downloads')
    .exitOverride()

  program.parse(args, { from: 'user' })

  const raw = RawOptsSchema.parse(program.opts())

  return OptionsSchema.parse({
    causeId: raw.cause ?? env.BENEVITY_CAUSE_ID ?? '',
    outDir: raw.out ?? env.BENEVITY_REPORT_DIR ?? 'data/benevity',
    sessionPath:
      raw.session ?? env.BENEVITY_SESSION_PATH ?? '.benevity-session.json',
    login: raw.login ?? false,
    force: raw.force ?? false,
    maxPages:
      raw.maxPages === undefined ? DEFAULT_MAX_PAGES : Number(raw.maxPages),
    concurrency: raw.concurrency === undefined ? 8 : Number(raw.concurrency),
  })
}

/**
 * The filename a disbursement's report is stored under.
 */
export function reportFilename(disbursementId: string): string {
  return `${disbursementId}.csv`
}

/**
 * Disbursement IDs already downloaded, derived from the output directory.
 */
export function existingDisbursementIds(filenames: string[]): Set<string> {
  return new Set(
    filenames
      .filter((name) => name.toLowerCase().endsWith('.csv'))
      .map((name) => name.slice(0, -'.csv'.length)),
  )
}

/**
 * Which links still need downloading.
 */
export function selectPending(
  links: DisbursementLink[],
  existing: Set<string>,
  force: boolean,
): DisbursementLink[] {
  if (force) return links
  return links.filter((link) => !existing.has(link.disbursementId))
}

/**
 * Walk the paginated reports table, collecting every report link.
 *
 * Pagination is client-side and rows repeat if the table fails to advance, so
 * links are keyed by disbursement ID and the walk stops when a page yields
 * nothing new.
 */
export async function harvestLinks(
  driver: PortalDriver,
  causeId: string,
  maxPages: number,
): Promise<DisbursementLink[]> {
  await driver.openReportsPage(causeId)

  const byId = new Map<string, DisbursementLink>()

  for (let page = 0; page < maxPages; page++) {
    const raw = await driver.currentPageLinks()
    let added = 0

    for (const candidate of raw) {
      const parsed = DisbursementLinkSchema.safeParse(candidate)
      if (!parsed.success) continue
      if (byId.has(parsed.data.disbursementId)) continue
      byId.set(parsed.data.disbursementId, parsed.data)
      added++
    }

    // A page that adds nothing means the table stopped advancing; stop rather
    // than spinning through the remaining page budget.
    if (added === 0 && page > 0) break
    if (!(await driver.nextPage())) break
  }

  return [...byId.values()]
}

export interface DownloadSummary {
  downloaded: string[]
  skipped: string[]
  failed: { disbursementId: string; error: string }[]
}

/**
 * Fetch and write each pending report, `concurrency` at a time.
 */
export async function downloadReports(
  driver: PortalDriver,
  fs: DownloadFs,
  links: DisbursementLink[],
  options: DownloadOptions,
): Promise<DownloadSummary> {
  const existing = existingDisbursementIds(
    await fs.listExisting(options.outDir),
  )
  const pending = selectPending(links, existing, options.force)
  const skipped = links
    .filter((link) => !pending.includes(link))
    .map((link) => link.disbursementId)

  const summary: DownloadSummary = { downloaded: [], skipped, failed: [] }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const link = pending[cursor]
      cursor++
      /* istanbul ignore next -- @preserve cursor is bounded by pending.length; TypeScript needs the guard */
      if (link === undefined) continue

      try {
        const body = await driver.fetchReport(link.href)
        await fs.writeReport(
          options.outDir,
          reportFilename(link.disbursementId),
          body,
        )
        summary.downloaded.push(link.disbursementId)
      } catch (error) {
        summary.failed.push({
          disbursementId: link.disbursementId,
          error: errorMessage(error),
        })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, pending.length) }, () =>
      worker(),
    ),
  )

  return summary
}

/**
 * The manifest written alongside the reports, so the disbursement-level facts
 * shown in the portal survive outside it.
 */
export function buildManifest(
  causeId: string,
  links: DisbursementLink[],
  now: string,
): string {
  return JSON.stringify(
    {
      causeId,
      generatedAt: now,
      count: links.length,
      disbursements: [...links].sort((a, b) =>
        a.disbursementId.localeCompare(b.disbursementId),
      ),
    },
    null,
    2,
  )
}
