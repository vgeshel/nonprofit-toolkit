/**
 * Tests for coverage report checking
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { main } from './check-coverage-report'

const metric = (total: number) => ({
  total,
  covered: total,
  skipped: 0,
  pct: 100,
})
const fileSummary = (total: number) => ({
  lines: metric(total),
  statements: metric(total),
  functions: metric(total),
  branches: metric(total),
})

// Handle unhandled rejections from process.exit mocks in entrypoint tests
beforeAll(() => {
  process.on('unhandledRejection', (reason: unknown) => {
    if (reason instanceof Error && reason.message.startsWith('process.exit(')) {
      return
    }
    throw reason
  })
})

describe('main', () => {
  let exitCalls: (string | number | null | undefined)[]
  let dir: string

  const writeSummary = (content: string): string => {
    const path = join(dir, 'coverage-summary.json')
    writeFileSync(path, content)
    return path
  }

  beforeEach(() => {
    exitCalls = []
    dir = mkdtempSync(join(tmpdir(), 'coverage-report-'))
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCalls.push(code)
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits with 0 when the report covers files', async () => {
    const path = writeSummary(
      JSON.stringify({
        total: fileSummary(30),
        '/repo/packages/a/src/a.ts': fileSummary(10),
        '/repo/packages/b/src/b.ts': fileSummary(20),
      }),
    )

    await expect(main(path)).rejects.toThrow('process.exit(0)')
    expect(exitCalls).toEqual([0])
    expect(console.log).toHaveBeenCalledWith(
      '✅ Coverage report includes 2 files (30 statements)',
    )
  })

  it('exits with 1 when the report lists no files', async () => {
    const path = writeSummary(JSON.stringify({ total: fileSummary(0) }))

    await expect(main(path)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('COMMIT BLOCKED'),
    )
    expect(console.error).toHaveBeenCalledWith(
      'Coverage measured 0 files and 0 statements, so the 100% thresholds passed without checking anything.',
    )
  })

  it('exits with 1 when files are listed but no statements were measured', async () => {
    const path = writeSummary(
      JSON.stringify({
        total: fileSummary(0),
        '/repo/packages/a/src/types.ts': fileSummary(0),
      }),
    )

    await expect(main(path)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      'Coverage measured 1 files and 0 statements, so the 100% thresholds passed without checking anything.',
    )
  })

  it('exits with 1 when the report has an unexpected shape', async () => {
    const path = writeSummary(JSON.stringify({ '/repo/a.ts': fileSummary(1) }))

    await expect(main(path)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error: Invalid coverage summary at ${path}:`),
    )
  })

  it('exits with 1 when the report is not valid JSON', async () => {
    const path = writeSummary('{not json')

    await expect(main(path)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error: Could not read ${path}:`),
    )
  })

  it('exits with 1 when the report file is missing', async () => {
    const path = join(dir, 'missing.json')

    await expect(main(path)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error: Could not read ${path}:`),
    )
  })
})

describe('entrypoint', () => {
  it('runs main when STUDIO_COVERAGE_REPORT_RUN_MAIN is true', async () => {
    const originalRunMain = process.env.STUDIO_COVERAGE_REPORT_RUN_MAIN
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    try {
      process.env.STUDIO_COVERAGE_REPORT_RUN_MAIN = 'true'
      vi.resetModules()
      await import('./check-coverage-report')
      // Keep process.exit mocked until async main() reaches it
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalled()
      })
    } finally {
      exitSpy.mockRestore()
      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      if (originalRunMain === undefined) {
        delete process.env.STUDIO_COVERAGE_REPORT_RUN_MAIN
      } else {
        process.env.STUDIO_COVERAGE_REPORT_RUN_MAIN = originalRunMain
      }
      vi.resetModules()
    }
  })
})
