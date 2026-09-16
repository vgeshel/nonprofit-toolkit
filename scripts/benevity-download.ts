#!/usr/bin/env bun
/**
 * Download Benevity Donations Reports from the Causes Portal.
 *
 * The portal has no bulk export: each disbursement carries its own report,
 * reachable only from a client-side-paginated table. This script walks that
 * table, then pulls every report through the signed-in session.
 *
 * Authentication is the one step that cannot be automated — the portal signs in
 * through Okta SSO with MFA. The first run (or any `--login` run) opens a
 * visible browser for you to sign in, then saves the session so later runs are
 * headless.
 *
 *   bun scripts/benevity-download.ts --login      # sign in, save session
 *   bun scripts/benevity-download.ts              # incremental refresh
 *   bun scripts/benevity-download.ts --force      # re-download everything
 *
 * The Playwright wiring lives here; the walk and download logic it drives are
 * in `benevity-download-lib.ts`, under test.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import {
  buildManifest,
  downloadReports,
  harvestLinks,
  parseArgs,
  reportsPageUrl,
  type DisbursementLink,
  type DownloadFs,
  type PortalDriver,
} from './benevity-download-lib'

const logger = pino({ name: 'benevity-download' })

const PORTAL_ORIGIN = 'https://causes.benevity.org'
const SIGN_IN_URL = `${PORTAL_ORIGIN}/user`
const DASHBOARD_LINK = 'a[href*="/causesapp/dashboard"]'
const DOWNLOAD_LINK = 'a[href*="donations_report_download"]'
/** Client-side pagination re-renders in place, so there is no load to await. */
const PAGE_RENDER_WAIT_MS = 700

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env)

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: !options.login })

  try {
    const context = await browser.newContext(
      options.login ? {} : { storageState: options.sessionPath },
    )
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)

    if (options.login) {
      await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded' })
      logger.info(
        'Sign in to the Benevity Causes Portal in the browser window. Waiting…',
      )
      // The dashboard link only renders once a session exists.
      await page.waitForSelector(DASHBOARD_LINK, { timeout: 10 * 60_000 })
      await context.storageState({ path: options.sessionPath })
      logger.info({ sessionPath: options.sessionPath }, 'Session saved')
    }

    /** Rows of the reports table, identified by carrying a download link. */
    const reportRows = () =>
      page
        .locator('table tbody tr')
        .filter({ has: page.locator(DOWNLOAD_LINK) })

    const firstRowText = async (): Promise<string> => {
      const rows = reportRows()
      if ((await rows.count()) === 0) return ''
      return (await rows.first().innerText()).trim()
    }

    const driver: PortalDriver = {
      isSignedIn: async () => (await page.locator(DASHBOARD_LINK).count()) > 0,

      openReportsPage: async (causeId) => {
        await page.goto(reportsPageUrl(causeId), {
          waitUntil: 'domcontentloaded',
        })
        await page.waitForSelector(DOWNLOAD_LINK)
      },

      currentPageLinks: async () => {
        const rows = reportRows()
        const count = await rows.count()
        const links: DisbursementLink[] = []

        for (let index = 0; index < count; index++) {
          const row = rows.nth(index)
          const href = await row
            .locator(DOWNLOAD_LINK)
            .first()
            .getAttribute('href')
          if (href === null) continue

          const cells = await row.locator('td').allInnerTexts()
          links.push({
            disbursementId: href.slice(href.lastIndexOf('/') + 1),
            href,
            periodEndDate: cells[0]?.trim() ?? '',
            grantor: cells[1]?.trim() ?? '',
          })
        }

        return links
      },

      nextPage: async () => {
        const next = page.getByRole('link', { name: 'Next', exact: true })
        if ((await next.count()) === 0) return false

        const before = await firstRowText()
        await next.first().click()
        await page.waitForTimeout(PAGE_RENDER_WAIT_MS)

        // A click that leaves the same first row means the last page is
        // already showing; the control stays present but inert.
        return (await firstRowText()) !== before
      },

      // The context's request client shares the browser's cookie jar, so the
      // download is authenticated without going through the page.
      fetchReport: async (href) => {
        const response = await context.request.get(`${PORTAL_ORIGIN}${href}`)
        if (!response.ok()) {
          throw new Error(`HTTP ${String(response.status())} fetching ${href}`)
        }
        return response.text()
      },
    }

    if (!(await driver.isSignedIn())) {
      await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded' })
    }
    if (!(await driver.isSignedIn())) {
      logger.error(
        'Not signed in. Re-run with --login to refresh the saved session.',
      )
      process.exitCode = 1
      return
    }

    const links = await harvestLinks(driver, options.causeId, options.maxPages)
    logger.info({ count: links.length }, 'Harvested disbursement reports')

    await mkdir(options.outDir, { recursive: true })

    const fs: DownloadFs = {
      listExisting: (dir) => readdir(dir),
      writeReport: (dir, filename, body) =>
        writeFile(join(dir, filename), body, 'utf-8'),
    }

    const summary = await downloadReports(driver, fs, links, options)

    await writeFile(
      join(options.outDir, 'manifest.json'),
      buildManifest(options.causeId, links, new Date().toISOString()),
      'utf-8',
    )

    logger.info(
      {
        downloaded: summary.downloaded.length,
        skipped: summary.skipped.length,
        failed: summary.failed.length,
        outDir: options.outDir,
      },
      'Download complete',
    )

    if (summary.failed.length > 0) {
      for (const failure of summary.failed) {
        logger.error(failure, 'Report download failed')
      }
      process.exitCode = 1
    }
  } finally {
    await browser.close()
  }
}

await main()
