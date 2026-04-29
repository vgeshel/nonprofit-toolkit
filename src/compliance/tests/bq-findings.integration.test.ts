/**
 * Real BigQuery integration coverage for append-only findings history and the
 * current-open-findings view.
 *
 * Run manually with:
 *   COMPLIANCE_BQ_INTEGRATION=1 COMPLIANCE_BQ_INTEGRATION_PROJECT=<project> bun test:run -- src/compliance/tests/bq-findings.integration.test.ts
 */
/* eslint-disable n/no-process-env */
import { BigQuery } from '@google-cloud/bigquery'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  COMPLIANCE_TABLES,
  currentOpenFindingsViewQuery,
  type TableSchemaField,
} from '../state/bq-rows.ts'

const RUN_INTEGRATION = process.env.COMPLIANCE_BQ_INTEGRATION === '1'
const PROJECT_ID =
  process.env.COMPLIANCE_BQ_INTEGRATION_PROJECT ??
  process.env.PROJECT_ID ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  ''

const describeBigQuery =
  RUN_INTEGRATION && PROJECT_ID.length > 0 ? describe : describe.skip

const CountRowSchema = z.object({ count: z.coerce.number().int() })
const CountRowsSchema = z.tuple([z.array(CountRowSchema)]).rest(z.unknown())

const CurrentFindingRowSchema = z.object({
  finding_id: z.string().uuid(),
  detail: z.string(),
  opened_at: z.preprocess((value) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'value' in value &&
      typeof value.value === 'string'
    ) {
      return value.value
    }
    return value
  }, z.string().min(1)),
})
const CurrentFindingRowsSchema = z
  .tuple([z.array(CurrentFindingRowSchema)])
  .rest(z.unknown())

function tableDefinition(name: string): {
  readonly fields: readonly TableSchemaField[]
  readonly description: string
} {
  const definition = COMPLIANCE_TABLES.find((table) => table.name === name)
  if (definition === undefined) {
    throw new Error(`Missing compliance table definition: ${name}`)
  }
  return definition
}

function schemaFields(fields: readonly TableSchemaField[]): TableSchemaField[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    mode: field.mode,
  }))
}

describeBigQuery('compliance findings BigQuery integration', () => {
  const bq = new BigQuery({ projectId: PROJECT_ID })
  let datasetId = ''

  beforeEach(async () => {
    datasetId = `compliance_test_${randomUUID().replaceAll('-', '_')}`
    const dataset = bq.dataset(datasetId)
    await dataset.create()

    for (const tableName of ['discovery_runs', 'findings']) {
      const definition = tableDefinition(tableName)
      await dataset.createTable(tableName, {
        schema: { fields: schemaFields(definition.fields) },
        description: definition.description,
      })
    }

    await bq.query({
      query:
        `CREATE OR REPLACE VIEW \`${PROJECT_ID}.${datasetId}.current_open_findings\` AS ` +
        currentOpenFindingsViewQuery(`${PROJECT_ID}.${datasetId}`),
    })
  })

  afterEach(async () => {
    if (datasetId.length === 0) {
      return
    }
    await bq
      .dataset(datasetId)
      .delete({ force: true })
      .catch(() => undefined)
    datasetId = ''
  })

  it('keeps every raw finding row while the current view returns the latest semantic finding', async () => {
    await insertDiscoveryRun({
      runId: randomUUID(),
      sourceId: 'irs-eo-bmf',
      status: 'failed',
      completedAt: '2026-04-29T00:00:00.000Z',
    })
    await insertFinding({
      findingId: randomUUID(),
      sourceId: 'irs-eo-bmf',
      detail: 'Original source failure detail.',
      openedAt: '2026-04-29T00:00:00.000Z',
      evidence: '{"code":"source.failed"}',
    })
    await insertFinding({
      findingId: randomUUID(),
      sourceId: 'irs-eo-bmf',
      detail: 'Original source failure detail.',
      openedAt: '2026-04-29T00:05:00.000Z',
      evidence: '{"code":"source.failed"}',
    })
    await insertFinding({
      findingId: randomUUID(),
      sourceId: 'irs-eo-bmf',
      detail: 'Current source failure detail.',
      openedAt: '2026-04-29T00:10:00.000Z',
      evidence: '{"code":"source.failed","attempt":2}',
    })
    await insertDiscoveryRun({
      runId: randomUUID(),
      sourceId: 'irs-teos',
      status: 'succeeded',
      completedAt: '2026-04-29T00:12:00.000Z',
    })
    await insertFinding({
      findingId: randomUUID(),
      sourceId: 'irs-teos',
      severity: 'info',
      title: 'EIN listed in IRS Pub. 78',
      detail: 'IRS Publication 78 lists this EIN with deductibility code "PC".',
      openedAt: '2026-04-29T00:12:00.000Z',
      evidence: '{"deductibilityCode":"PC"}',
    })

    const rawCount = await queryCount(
      `SELECT COUNT(*) AS count FROM \`${PROJECT_ID}.${datasetId}.findings\``,
    )
    expect(rawCount).toBe(4)

    const currentBeforeSuccess = await queryCurrentFindings()
    expect(currentBeforeSuccess.map((row) => row.detail).sort()).toEqual([
      'Current source failure detail.',
      'IRS Publication 78 lists this EIN with deductibility code "PC".',
      'Original source failure detail.',
    ])

    await insertDiscoveryRun({
      runId: randomUUID(),
      sourceId: 'irs-eo-bmf',
      status: 'succeeded',
      completedAt: '2026-04-29T00:15:00.000Z',
    })

    const currentAfterSuccess = await queryCurrentFindings()
    expect(currentAfterSuccess.map((row) => row.detail)).toEqual([
      'IRS Publication 78 lists this EIN with deductibility code "PC".',
    ])
    expect(
      await queryCount(
        `SELECT COUNT(*) AS count FROM \`${PROJECT_ID}.${datasetId}.findings\``,
      ),
    ).toBe(4)
  })

  async function insertDiscoveryRun(args: {
    readonly runId: string
    readonly sourceId: string
    readonly status: 'failed' | 'succeeded'
    readonly completedAt: string
  }): Promise<void> {
    await bq.query({
      query: `
        INSERT INTO \`${PROJECT_ID}.${datasetId}.discovery_runs\` (
          run_id,
          source_id,
          jurisdiction_id,
          status,
          started_at,
          completed_at,
          duration_ms,
          error_type,
          error_message,
          payload
        )
        VALUES (
          @run_id,
          @source_id,
          'us-federal',
          @status,
          @started_at,
          @completed_at,
          1000,
          @error_type,
          @error_message,
          PARSE_JSON(@payload)
        )
      `,
      params: {
        run_id: args.runId,
        source_id: args.sourceId,
        status: args.status,
        started_at: new Date(args.completedAt),
        completed_at: new Date(args.completedAt),
        error_type: args.status === 'failed' ? 'parse' : null,
        error_message: args.status === 'failed' ? 'source failed' : null,
        payload: args.status === 'succeeded' ? '{"ok":true}' : null,
      },
      types: {
        started_at: 'TIMESTAMP',
        completed_at: 'TIMESTAMP',
        error_type: 'STRING',
        error_message: 'STRING',
        payload: 'STRING',
      },
    })
  }

  async function insertFinding(args: {
    readonly findingId: string
    readonly sourceId: string
    readonly severity?: 'error' | 'info' | 'warn'
    readonly title?: string
    readonly detail: string
    readonly openedAt: string
    readonly evidence: string
  }): Promise<void> {
    await bq.query({
      query: `
        INSERT INTO \`${PROJECT_ID}.${datasetId}.findings\` (
          finding_id,
          jurisdiction_id,
          source_id,
          severity,
          status,
          title,
          detail,
          evidence,
          opened_at,
          resolved_at
        )
        VALUES (
          @finding_id,
          'us-federal',
          @source_id,
          @severity,
          'open',
          @title,
          @detail,
          PARSE_JSON(@evidence),
          @opened_at,
          @resolved_at
        )
      `,
      params: {
        finding_id: args.findingId,
        source_id: args.sourceId,
        severity: args.severity ?? 'error',
        title: args.title ?? 'Source failed: IRS EO BMF',
        detail: args.detail,
        evidence: args.evidence,
        opened_at: new Date(args.openedAt),
        resolved_at: null,
      },
      types: {
        opened_at: 'TIMESTAMP',
        resolved_at: 'TIMESTAMP',
      },
    })
  }

  async function queryCount(sql: string): Promise<number> {
    const response: unknown = await bq.query({ query: sql })
    const [rows] = CountRowsSchema.parse(response)
    const first = rows[0]
    if (first === undefined) {
      throw new Error('Count query returned no rows')
    }
    return CountRowSchema.parse(first).count
  }

  async function queryCurrentFindings(): Promise<
    readonly z.infer<typeof CurrentFindingRowSchema>[]
  > {
    const response: unknown = await bq.query({
      query: `
        SELECT finding_id, detail, opened_at
        FROM \`${PROJECT_ID}.${datasetId}.current_open_findings\`
        ORDER BY detail
      `,
    })
    const [rows] = CurrentFindingRowsSchema.parse(response)
    return rows
  }
})
