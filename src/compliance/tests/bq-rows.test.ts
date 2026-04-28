/**
 * Tests for BigQuery row schemas: entity, discovery_runs, findings, sources.
 *
 * Each schema must:
 *   - parse a complete, valid row
 *   - reject missing/required-field violations
 *   - coerce BigQueryTimestamp `{ value }` wrappers into strings
 */
import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_DATASET,
  COMPLIANCE_TABLES,
  ComplianceDiscoveryRunRowSchema,
  ComplianceEntityRowSchema,
  ComplianceFindingRowSchema,
  ComplianceSourceRowSchema,
  buildTableSchema,
  type TableSchemaField,
} from '../state/bq-rows.ts'

describe('COMPLIANCE_DATASET / COMPLIANCE_TABLES', () => {
  it('uses the documented dataset name', () => {
    expect(COMPLIANCE_DATASET).toBe('compliance')
  })

  it('lists the four Phase 1 tables', () => {
    expect(COMPLIANCE_TABLES.map((t) => t.name).sort()).toEqual([
      'discovery_runs',
      'entity',
      'findings',
      'sources',
    ])
  })

  it('each table has at least one REQUIRED field', () => {
    for (const t of COMPLIANCE_TABLES) {
      expect(t.fields.some((f) => f.mode === 'REQUIRED')).toBe(true)
    }
  })
})

describe('buildTableSchema', () => {
  it('produces a BigQuery-shaped schema with fields preserved', () => {
    const fields: TableSchemaField[] = [
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'detail', type: 'JSON', mode: 'NULLABLE' },
    ]
    const schema = buildTableSchema(fields)
    expect(schema).toEqual({ fields })
  })

  it('returns a fresh array (independent from the input)', () => {
    const fields: TableSchemaField[] = [
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
    ]
    const schema = buildTableSchema(fields)
    expect(schema.fields).not.toBe(fields)
    expect(schema.fields).toEqual(fields)
  })
})

describe('ComplianceEntityRowSchema', () => {
  const valid = {
    legal_name: 'Foo Foundation',
    state_of_incorporation: 'CA',
    fiscal_year_end_month: 12,
    fiscal_year_end_day: 31,
    formation_date: '2010-01-15',
    mailing_address_line1: '1 Mission St',
    mailing_address_line2: null,
    mailing_address_city: 'San Francisco',
    mailing_address_region: 'CA',
    mailing_address_postal_code: '94105',
    mailing_address_country: 'US',
    updated_at: '2024-01-01T00:00:00Z',
  }

  it('parses a valid row', () => {
    expect(ComplianceEntityRowSchema.parse(valid).legal_name).toBe(
      'Foo Foundation',
    )
  })

  it('extracts BigQueryTimestamp value for updated_at', () => {
    const parsed = ComplianceEntityRowSchema.parse({
      ...valid,
      updated_at: { value: '2024-02-02T00:00:00.000Z' },
    })
    expect(parsed.updated_at).toBe('2024-02-02T00:00:00.000Z')
  })

  it('rejects missing legal_name', () => {
    const broken: Record<string, unknown> = { ...valid }
    delete broken.legal_name
    expect(() => ComplianceEntityRowSchema.parse(broken)).toThrow()
  })
})

describe('ComplianceDiscoveryRunRowSchema', () => {
  const valid = {
    run_id: '550e8400-e29b-41d4-a716-446655440000',
    source_id: 'irs-teos',
    jurisdiction_id: 'us-federal',
    status: 'succeeded',
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:00:01Z',
    duration_ms: 1234,
    error_type: null,
    error_message: null,
    payload: { kind: 'pub78-hit', deductibilityCode: 'PC' },
  }

  it('parses a succeeded run', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse(valid)
    expect(parsed.status).toBe('succeeded')
    expect(parsed.payload).toEqual(valid.payload)
  })

  it('parses a failed run', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      status: 'failed',
      error_type: 'http',
      error_message: 'Bad Gateway',
      payload: null,
    })
    expect(parsed.error_type).toBe('http')
    expect(parsed.payload).toBeNull()
  })

  it('rejects an invalid status', () => {
    expect(() =>
      ComplianceDiscoveryRunRowSchema.parse({ ...valid, status: 'in-flight' }),
    ).toThrow()
  })

  it('rejects negative duration_ms', () => {
    expect(() =>
      ComplianceDiscoveryRunRowSchema.parse({ ...valid, duration_ms: -1 }),
    ).toThrow()
  })

  it('coerces duration_ms from string', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      duration_ms: '500',
    })
    expect(parsed.duration_ms).toBe(500)
  })

  it('extracts BigQueryTimestamp .value for started_at', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      started_at: { value: '2024-01-01T00:00:00.000Z' },
    })
    expect(parsed.started_at).toBe('2024-01-01T00:00:00.000Z')
  })

  it('rejects an empty source_id', () => {
    expect(() =>
      ComplianceDiscoveryRunRowSchema.parse({ ...valid, source_id: '' }),
    ).toThrow()
  })
})

describe('ComplianceFindingRowSchema', () => {
  const valid = {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: 'us-federal',
    source_id: 'irs-teos',
    severity: 'warn',
    status: 'open',
    title: 'Auto-revoked',
    detail: 'EIN appears on the auto-revocation list.',
    evidence: { revocationDate: '2022-05-15' },
    opened_at: '2024-03-01T00:00:00Z',
    resolved_at: null,
  }

  it('parses an open finding', () => {
    expect(ComplianceFindingRowSchema.parse(valid).severity).toBe('warn')
  })

  it('parses a resolved finding', () => {
    const parsed = ComplianceFindingRowSchema.parse({
      ...valid,
      status: 'resolved',
      resolved_at: '2024-04-01T00:00:00Z',
    })
    expect(parsed.status).toBe('resolved')
  })

  it('rejects unknown severity', () => {
    expect(() =>
      ComplianceFindingRowSchema.parse({ ...valid, severity: 'critical' }),
    ).toThrow()
  })
})

describe('ComplianceSourceRowSchema', () => {
  const valid = {
    source_id: 'irs-teos',
    jurisdiction_id: 'us-federal',
    kind: 'api',
    auth_required: false,
    description: 'IRS Pub 78 + Auto Revocation lookup by EIN.',
    tos_url:
      'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
    updated_at: '2024-01-01T00:00:00Z',
  }

  it('parses a valid source registry row', () => {
    expect(ComplianceSourceRowSchema.parse(valid).source_id).toBe('irs-teos')
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      ComplianceSourceRowSchema.parse({ ...valid, kind: 'graphql' }),
    ).toThrow()
  })

  it('rejects a tos_url that is not a URL', () => {
    expect(() =>
      ComplianceSourceRowSchema.parse({ ...valid, tos_url: 'not-a-url' }),
    ).toThrow()
  })

  it('extracts BigQueryTimestamp value for updated_at', () => {
    const parsed = ComplianceSourceRowSchema.parse({
      ...valid,
      updated_at: { value: '2024-02-02T00:00:00.000Z' },
    })
    expect(parsed.updated_at).toBe('2024-02-02T00:00:00.000Z')
  })
})
