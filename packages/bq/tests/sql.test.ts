/**
 * Tests for SQL generation functions.
 */
import { describe, expect, it } from 'vitest'
import {
  generateGetRunSql,
  generateGetWatermarkSql,
  generateInsertRunSql,
  generateMergeSql,
  generateUpdateRunSql,
  generateUpdateSourceCoverageSql,
  generateUpsertWatermarkSql,
} from '../src/sql'
import type { BigQueryConfig } from '../src/types'

describe('SQL generation', () => {
  const config: BigQueryConfig = {
    projectId: 'test-project',
    datasetRaw: 'donations_raw',
    datasetCanon: 'donations',
  }

  describe('generateMergeSql', () => {
    it('generates valid MERGE SQL', () => {
      const sql = generateMergeSql(config)

      // Check structure
      expect(sql).toContain('MERGE')
      expect(sql).toContain('`donations.events`')
      expect(sql).toContain('`donations_raw.stg_events`')
      expect(sql).toContain('stg.run_id = @run_id')
    })

    it('includes all columns in UPDATE SET', () => {
      const sql = generateMergeSql(config)

      const updateColumns = [
        'event_ts',
        'created_at',
        'ingested_at',
        'amount_cents',
        'fee_cents',
        'net_amount_cents',
        'currency',
        'donor_name',
        'donor_email',
        'donor_phone',
        'donor_address',
        'status',
        'payment_method',
        'description',
        'attribution',
        'attribution_human',
        'source_metadata',
        '_updated_at',
      ]

      for (const col of updateColumns) {
        expect(sql).toContain(col)
      }
    })

    it('includes Mercury-specific filtering to exclude internal transfers and debits', () => {
      const sql = generateMergeSql(config)

      // Verify Mercury source filtering is present
      expect(sql).toContain("stg.source = 'mercury'")
      // Verify internal transfer exclusion
      expect(sql).toContain("stg.payment_method = 'internal'")
      // Verify debit exclusion (JSON_VALUE returns strings, so we compare against 'false')
      expect(sql).toContain(
        "JSON_VALUE(stg.source_metadata, '$.isCredit') = 'false'",
      )
    })

    it('includes all columns in INSERT', () => {
      const sql = generateMergeSql(config)

      expect(sql).toContain('WHEN NOT MATCHED THEN INSERT')
      expect(sql).toContain('source.source')
      expect(sql).toContain('source.external_id')
    })

    it('uses ON clause with source and external_id', () => {
      const sql = generateMergeSql(config)

      expect(sql).toContain(
        'ON target.source = source.source AND target.external_id = source.external_id',
      )
    })

    it('sets _updated_at to CURRENT_TIMESTAMP on update', () => {
      const sql = generateMergeSql(config)

      expect(sql).toContain('_updated_at = CURRENT_TIMESTAMP()')
    })
  })

  describe('generateGetWatermarkSql', () => {
    it('generates valid SELECT SQL', () => {
      const sql = generateGetWatermarkSql(config)

      expect(sql).toContain('SELECT')
      expect(sql).toContain('source')
      expect(sql).toContain('last_success_to_ts')
      expect(sql).toContain('updated_at')
      expect(sql).toContain('FROM `donations_raw.etl_watermarks`')
      expect(sql).toContain('WHERE source = @source')
      expect(sql).toContain('LIMIT 1')
    })
  })

  describe('generateUpsertWatermarkSql', () => {
    it('generates valid MERGE SQL for upsert', () => {
      const sql = generateUpsertWatermarkSql(config)

      expect(sql).toContain('MERGE')
      expect(sql).toContain('`donations_raw.etl_watermarks`')
      expect(sql).toContain('WHEN MATCHED THEN UPDATE')
      expect(sql).toContain('WHEN NOT MATCHED THEN INSERT')
      expect(sql).toContain('@source')
      expect(sql).toContain('@last_success_to_ts')
      expect(sql).toContain('@updated_at')
    })
  })

  describe('generateInsertRunSql', () => {
    it('generates valid INSERT SQL', () => {
      const sql = generateInsertRunSql(config)

      expect(sql).toContain('INSERT INTO')
      expect(sql).toContain('`donations_raw.etl_runs`')
      expect(sql).toContain('run_id')
      expect(sql).toContain('mode')
      expect(sql).toContain('status')
      expect(sql).toContain('started_at')
      expect(sql).toContain('completed_at')
      expect(sql).toContain('from_ts')
      expect(sql).toContain('to_ts')
      expect(sql).toContain('metrics')
      expect(sql).toContain('error_message')
    })
  })

  describe('generateUpdateRunSql', () => {
    it('generates valid UPDATE SQL', () => {
      const sql = generateUpdateRunSql(config)

      expect(sql).toContain('UPDATE')
      expect(sql).toContain('`donations_raw.etl_runs`')
      expect(sql).toContain('SET status = @status')
      expect(sql).toContain('completed_at = @completed_at')
      expect(sql).toContain('metrics = @metrics')
      expect(sql).toContain('error_message = @error_message')
      expect(sql).toContain('WHERE run_id = @run_id')
    })
  })

  describe('generateGetRunSql', () => {
    it('generates valid SELECT SQL', () => {
      const sql = generateGetRunSql(config)

      expect(sql).toContain('SELECT')
      expect(sql).toContain('run_id')
      expect(sql).toContain('mode')
      expect(sql).toContain('status')
      expect(sql).toContain('FROM `donations_raw.etl_runs`')
      expect(sql).toContain('WHERE run_id = @run_id')
      expect(sql).toContain('LIMIT 1')
    })
  })

  describe('custom dataset names', () => {
    it('uses custom dataset names from config', () => {
      const customConfig: BigQueryConfig = {
        projectId: 'custom-project',
        datasetRaw: 'my_raw_data',
        datasetCanon: 'my_canonical',
      }

      const mergeSql = generateMergeSql(customConfig)
      expect(mergeSql).toContain('`my_canonical.events`')
      expect(mergeSql).toContain('`my_raw_data.stg_events`')

      const watermarkSql = generateGetWatermarkSql(customConfig)
      expect(watermarkSql).toContain('`my_raw_data.etl_watermarks`')

      const runSql = generateInsertRunSql(customConfig)
      expect(runSql).toContain('`my_raw_data.etl_runs`')
    })
  })

  describe('generateMergeSql - disbursement deduplication', () => {
    it('LEFT JOINs source_coverage for disbursement filtering', () => {
      const sql = generateMergeSql(config)
      expect(sql).toContain('LEFT JOIN')
      expect(sql).toContain('source_coverage')
      expect(sql).toContain('sc.source IS NOT NULL')
      // Verify explicit stg.* to avoid ambiguous columns from JOIN
      expect(sql).toContain('stg.*')
    })

    it('filters disbursements based on covers_from date', () => {
      const sql = generateMergeSql(config)
      expect(sql).toContain('sc.covers_from')
    })

    it('matches Mercury description against source names in JOIN', () => {
      const sql = generateMergeSql(config)
      expect(sql).toContain(
        "LOWER(stg.description) LIKE CONCAT(LOWER(sc.source), ';%')",
      )
    })

    it('uses correct dataset for source_coverage', () => {
      const sql = generateMergeSql(config)
      expect(sql).toContain('`donations_raw.source_coverage`')
    })

    it('uses stg alias for staging table', () => {
      const sql = generateMergeSql(config)
      expect(sql).toContain('AS stg')
      expect(sql).toContain('stg.run_id')
      expect(sql).toContain('stg.source')
    })
  })

  describe('generateUpdateSourceCoverageSql', () => {
    it('generates valid source coverage update SQL', () => {
      const sql = generateUpdateSourceCoverageSql(config)
      expect(sql).toContain('MERGE')
      expect(sql).toContain('`donations_raw.source_coverage`')
      expect(sql).toContain('MIN(event_ts)')
      expect(sql).toContain("source != 'mercury'")
    })

    it('uses canonical dataset for source data', () => {
      const sql = generateUpdateSourceCoverageSql(config)
      expect(sql).toContain('`donations.events`')
    })

    it('updates covers_from when changed', () => {
      const sql = generateUpdateSourceCoverageSql(config)
      expect(sql).toContain(
        'WHEN MATCHED AND target.covers_from != src.covers_from',
      )
    })

    it('inserts new sources', () => {
      const sql = generateUpdateSourceCoverageSql(config)
      expect(sql).toContain('WHEN NOT MATCHED THEN INSERT')
    })
  })
})
