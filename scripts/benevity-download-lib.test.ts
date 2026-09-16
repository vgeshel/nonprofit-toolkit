/**
 * Tests for the Benevity report downloader library.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildManifest,
  DEFAULT_MAX_PAGES,
  downloadReports,
  errorMessage,
  existingDisbursementIds,
  harvestLinks,
  parseArgs,
  reportFilename,
  reportsPageUrl,
  selectPending,
  type DisbursementLink,
  type DownloadFs,
  type DownloadOptions,
  type PortalDriver,
} from './benevity-download-lib'

const CAUSE_ID = '840-472377309'

function link(id: string): DisbursementLink {
  return {
    disbursementId: id,
    href: `/causesapp/reports/disbursements/${CAUSE_ID}/TOK/donations_report_download/${id}`,
    periodEndDate: 'Sep 6, 2026',
    grantor: 'American Online Giving Foundation, Inc',
  }
}

function options(overrides: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    causeId: CAUSE_ID,
    outDir: 'data/benevity',
    sessionPath: '.benevity-session.json',
    login: false,
    force: false,
    maxPages: DEFAULT_MAX_PAGES,
    concurrency: 4,
    ...overrides,
  }
}

/**
 * A fake portal that serves fixed pages of links.
 */
function fakeDriver(pages: unknown[][], overrides: Partial<PortalDriver> = {}) {
  let index = 0
  const driver: PortalDriver = {
    isSignedIn: () => Promise.resolve(true),
    openReportsPage: vi.fn(() => Promise.resolve()),
    currentPageLinks: () => Promise.resolve(pages[index] ?? []),
    nextPage: () => {
      if (index >= pages.length - 1) return Promise.resolve(false)
      index++
      return Promise.resolve(true)
    },
    fetchReport: (href: string) => Promise.resolve(`body for ${href}`),
    ...overrides,
  }
  return driver
}

describe('errorMessage', () => {
  it('uses the message of an Error', () => {
    expect(errorMessage(new Error('HTTP 500'))).toBe('HTTP 500')
  })

  it('stringifies a non-Error throw', () => {
    // Not every library rejects with an Error; the summary must still read.
    expect(errorMessage('just a string')).toBe('just a string')
    expect(errorMessage(404)).toBe('404')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

describe('reportsPageUrl', () => {
  it('builds the legacy reports URL for a cause', () => {
    expect(reportsPageUrl(CAUSE_ID)).toBe(
      'https://causes.benevity.org/causesapp/reports/disbursements/840-472377309',
    )
  })
})

describe('reportFilename', () => {
  it('names a report after its disbursement id', () => {
    expect(reportFilename('1WLFLKD5A8')).toBe('1WLFLKD5A8.csv')
  })
})

describe('existingDisbursementIds', () => {
  it('derives ids from CSV filenames', () => {
    expect(
      existingDisbursementIds(['A.csv', 'B.CSV', 'manifest.json', 'notes.txt']),
    ).toEqual(new Set(['A', 'B']))
  })

  it('returns an empty set for an empty directory', () => {
    expect(existingDisbursementIds([])).toEqual(new Set())
  })
})

describe('selectPending', () => {
  it('skips reports already on disk', () => {
    const pending = selectPending([link('A'), link('B')], new Set(['A']), false)
    expect(pending.map((item) => item.disbursementId)).toEqual(['B'])
  })

  it('returns everything when forced', () => {
    const pending = selectPending([link('A'), link('B')], new Set(['A']), true)
    expect(pending.map((item) => item.disbursementId)).toEqual(['A', 'B'])
  })
})

describe('parseArgs', () => {
  it('reads the cause id from a flag', () => {
    const parsed = parseArgs(['--cause', CAUSE_ID])
    expect(parsed.causeId).toBe(CAUSE_ID)
    expect(parsed.outDir).toBe('data/benevity')
    expect(parsed.sessionPath).toBe('.benevity-session.json')
    expect(parsed.login).toBe(false)
    expect(parsed.force).toBe(false)
    expect(parsed.maxPages).toBe(DEFAULT_MAX_PAGES)
    expect(parsed.concurrency).toBe(8)
  })

  it('falls back to the environment', () => {
    const parsed = parseArgs([], {
      BENEVITY_CAUSE_ID: CAUSE_ID,
      BENEVITY_REPORT_DIR: '/data/b',
      BENEVITY_SESSION_PATH: '/tmp/session.json',
    })
    expect(parsed.causeId).toBe(CAUSE_ID)
    expect(parsed.outDir).toBe('/data/b')
    expect(parsed.sessionPath).toBe('/tmp/session.json')
  })

  it('prefers flags over the environment', () => {
    const parsed = parseArgs(['--cause', 'flag-id', '--out', '/flag/dir'], {
      BENEVITY_CAUSE_ID: 'env-id',
      BENEVITY_REPORT_DIR: '/env/dir',
    })
    expect(parsed.causeId).toBe('flag-id')
    expect(parsed.outDir).toBe('/flag/dir')
  })

  it('accepts the boolean flags', () => {
    const parsed = parseArgs(['--cause', CAUSE_ID, '--login', '--force'])
    expect(parsed.login).toBe(true)
    expect(parsed.force).toBe(true)
  })

  it('accepts numeric overrides', () => {
    const parsed = parseArgs([
      '--cause',
      CAUSE_ID,
      '--max-pages',
      '5',
      '--concurrency',
      '2',
    ])
    expect(parsed.maxPages).toBe(5)
    expect(parsed.concurrency).toBe(2)
  })

  it('rejects a missing cause id', () => {
    expect(() => parseArgs([])).toThrow(/cause ID is required/)
  })

  it('rejects a non-positive concurrency', () => {
    expect(() =>
      parseArgs(['--cause', CAUSE_ID, '--concurrency', '0']),
    ).toThrow()
  })

  it('rejects an absurd concurrency', () => {
    expect(() =>
      parseArgs(['--cause', CAUSE_ID, '--concurrency', '100']),
    ).toThrow()
  })

  it('rejects a non-numeric page bound', () => {
    expect(() =>
      parseArgs(['--cause', CAUSE_ID, '--max-pages', 'lots']),
    ).toThrow()
  })
})

describe('harvestLinks', () => {
  it('collects links across every page', async () => {
    const driver = fakeDriver([[link('A'), link('B')], [link('C')]])

    const links = await harvestLinks(driver, CAUSE_ID, DEFAULT_MAX_PAGES)
    expect(links.map((item) => item.disbursementId)).toEqual(['A', 'B', 'C'])
    expect(driver.openReportsPage).toHaveBeenCalledWith(CAUSE_ID)
  })

  it('deduplicates ids repeated across pages', async () => {
    const links = await harvestLinks(
      fakeDriver([[link('A')], [link('A'), link('B')]]),
      CAUSE_ID,
      DEFAULT_MAX_PAGES,
    )
    expect(links.map((item) => item.disbursementId)).toEqual(['A', 'B'])
  })

  it('stops when a later page adds nothing new', async () => {
    // A table that silently stops advancing repeats the same rows forever.
    const repeated = [[link('A')], [link('A')], [link('A')], [link('B')]]
    const links = await harvestLinks(
      fakeDriver(repeated),
      CAUSE_ID,
      DEFAULT_MAX_PAGES,
    )
    expect(links.map((item) => item.disbursementId)).toEqual(['A'])
  })

  it('respects the page bound', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => [link(`D${String(i)}`)])
    const links = await harvestLinks(fakeDriver(pages), CAUSE_ID, 3)
    expect(links).toHaveLength(3)
  })

  it('ignores rows that are not valid links', async () => {
    const links = await harvestLinks(
      fakeDriver([[link('A'), { disbursementId: '', href: '' }, null]]),
      CAUSE_ID,
      DEFAULT_MAX_PAGES,
    )
    expect(links.map((item) => item.disbursementId)).toEqual(['A'])
  })

  it('returns nothing when the first page is empty', async () => {
    expect(
      await harvestLinks(fakeDriver([[]]), CAUSE_ID, DEFAULT_MAX_PAGES),
    ).toEqual([])
  })
})

describe('downloadReports', () => {
  function fakeFs(existing: string[] = []): DownloadFs & {
    written: Map<string, string>
  } {
    const written = new Map<string, string>()
    return {
      written,
      listExisting: () => Promise.resolve(existing),
      writeReport: (_dir, filename, body) => {
        written.set(filename, body)
        return Promise.resolve()
      },
    }
  }

  it('writes every pending report', async () => {
    const fs = fakeFs()
    const summary = await downloadReports(
      fakeDriver([]),
      fs,
      [link('A'), link('B')],
      options(),
    )

    expect(summary.downloaded.sort()).toEqual(['A', 'B'])
    expect(summary.skipped).toEqual([])
    expect(summary.failed).toEqual([])
    expect([...fs.written.keys()].sort()).toEqual(['A.csv', 'B.csv'])
    expect(fs.written.get('A.csv')).toContain('donations_report_download/A')
  })

  it('skips reports already downloaded', async () => {
    const fs = fakeFs(['A.csv'])
    const summary = await downloadReports(
      fakeDriver([]),
      fs,
      [link('A'), link('B')],
      options(),
    )

    expect(summary.downloaded).toEqual(['B'])
    expect(summary.skipped).toEqual(['A'])
    expect(fs.written.has('A.csv')).toBe(false)
  })

  it('re-downloads everything when forced', async () => {
    const fs = fakeFs(['A.csv'])
    const summary = await downloadReports(
      fakeDriver([]),
      fs,
      [link('A'), link('B')],
      options({ force: true }),
    )

    expect(summary.downloaded.sort()).toEqual(['A', 'B'])
    expect(summary.skipped).toEqual([])
  })

  it('records a failed fetch without aborting the rest', async () => {
    const fs = fakeFs()
    const driver = fakeDriver([], {
      fetchReport: (href: string) => {
        if (href.endsWith('/A')) return Promise.reject(new Error('HTTP 500'))
        return Promise.resolve('ok')
      },
    })

    const summary = await downloadReports(
      driver,
      fs,
      [link('A'), link('B')],
      options({ concurrency: 1 }),
    )

    expect(summary.downloaded).toEqual(['B'])
    expect(summary.failed).toEqual([{ disbursementId: 'A', error: 'HTTP 500' }])
  })

  it('records a failed write', async () => {
    const fs: DownloadFs = {
      listExisting: () => Promise.resolve([]),
      writeReport: () => Promise.reject(new Error('disk full')),
    }

    const summary = await downloadReports(
      fakeDriver([]),
      fs,
      [link('A')],
      options(),
    )
    expect(summary.failed).toEqual([
      { disbursementId: 'A', error: 'disk full' },
    ])
  })

  it('handles an empty link list', async () => {
    const summary = await downloadReports(
      fakeDriver([]),
      fakeFs(),
      [],
      options(),
    )
    expect(summary).toEqual({ downloaded: [], skipped: [], failed: [] })
  })

  it('downloads concurrently without losing or repeating work', async () => {
    const fs = fakeFs()
    const links = Array.from({ length: 25 }, (_, i) => link(`D${String(i)}`))

    const summary = await downloadReports(
      fakeDriver([]),
      fs,
      links,
      options({ concurrency: 8 }),
    )

    expect(summary.downloaded).toHaveLength(25)
    expect(new Set(summary.downloaded).size).toBe(25)
    expect(fs.written.size).toBe(25)
  })
})

describe('buildManifest', () => {
  it('records the cause, count and sorted disbursements', () => {
    const manifest: unknown = JSON.parse(
      buildManifest(CAUSE_ID, [link('B'), link('A')], '2026-09-15T00:00:00Z'),
    )

    expect(manifest).toEqual({
      causeId: CAUSE_ID,
      generatedAt: '2026-09-15T00:00:00Z',
      count: 2,
      disbursements: [link('A'), link('B')],
    })
  })

  it('handles an empty run', () => {
    const manifest: unknown = JSON.parse(
      buildManifest(CAUSE_ID, [], '2026-09-15T00:00:00Z'),
    )
    expect(manifest).toMatchObject({ count: 0, disbursements: [] })
  })
})
