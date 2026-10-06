/**
 * Coverage report verification for pre-commit hooks
 *
 * Vitest's 100% thresholds pass vacuously when coverage measures no files
 * (e.g. a `coverage.exclude` glob that matches the whole checkout). Run after
 * `bun test:coverage` to fail when the json-summary report is empty.
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'

const MetricSchema = z.object({ total: z.number() })

const FileSummarySchema = z.object({
  lines: MetricSchema,
  statements: MetricSchema,
  functions: MetricSchema,
  branches: MetricSchema,
})

const CoverageSummarySchema = z
  .record(z.string(), FileSummarySchema)
  .and(z.object({ total: FileSummarySchema }))

const DEFAULT_SUMMARY_PATH = 'coverage/coverage-summary.json'

function readJson(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return { ok: true, value }
  } catch (error) {
    console.error(`Error: Could not read ${path}: ${String(error)}`)
    return { ok: false }
  }
}

export async function main(
  summaryPath: string = DEFAULT_SUMMARY_PATH,
): Promise<void> {
  const exitCode = checkReport(summaryPath)
  process.exit(exitCode)
}

function checkReport(summaryPath: string): number {
  const json = readJson(summaryPath)
  if (!json.ok) {
    return 1
  }

  const parsed = CoverageSummarySchema.safeParse(json.value)
  if (!parsed.success) {
    console.error(
      `Error: Invalid coverage summary at ${summaryPath}: ${parsed.error.message}`,
    )
    return 1
  }

  const fileCount = Object.keys(parsed.data).filter(
    (key) => key !== 'total',
  ).length
  const statements = parsed.data.total.statements.total

  if (fileCount === 0 || statements === 0) {
    console.error('\n==========================================')
    console.error('  COMMIT BLOCKED: Coverage Measured Nothing')
    console.error('==========================================\n')
    console.error(
      `Coverage measured ${fileCount} files and ${statements} statements, so the 100% thresholds passed without checking anything.`,
    )
    console.error(
      'Check coverage.include/coverage.exclude in vitest.config.ts.\n',
    )
    return 1
  }

  console.log(
    `✅ Coverage report includes ${fileCount} files (${statements} statements)`,
  )
  return 0
}

/* istanbul ignore next -- @preserve entrypoint with unreliable async timing in tests */
if (
  import.meta.main ||
  process.env.STUDIO_COVERAGE_REPORT_RUN_MAIN === 'true'
) {
  main()
    .catch(
      /* istanbul ignore next -- @preserve */ (err) => {
        console.error(err)
        process.exit(1)
      },
    )
    .catch(
      /* istanbul ignore next -- @preserve */ () => {
        // Handle errors thrown by process.exit mock in test environment
      },
    )
}
