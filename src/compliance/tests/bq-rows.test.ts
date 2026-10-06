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
  ComplianceDiscoveryJobRowSchema,
  ComplianceDiscoveryRunRowSchema,
  ComplianceEntityRowSchema,
  ComplianceFindingRowSchema,
  ComplianceSourceRowSchema,
  buildTableSchema,
  currentOpenFindingsViewQuery,
  type TableSchemaField,
} from '../state/bq-rows.ts'

describe('COMPLIANCE_DATASET / COMPLIANCE_TABLES', () => {
  it('uses the documented dataset name', () => {
    expect(COMPLIANCE_DATASET).toBe('compliance')
  })

  it('lists every compliance table', () => {
    expect(COMPLIANCE_TABLES.map((t) => t.name).sort()).toEqual([
      'discovery_jobs',
      'discovery_runs',
      'entity',
      'findings',
      'sources',
    ])
  })

  it('declares job_id on discovery_runs for async-job linkage', () => {
    const runs = COMPLIANCE_TABLES.find((t) => t.name === 'discovery_runs')
    expect(runs).toBeDefined()
    const jobId = runs?.fields.find((f) => f.name === 'job_id')
    expect(jobId).toEqual({
      name: 'job_id',
      type: 'STRING',
      mode: 'NULLABLE',
    })
  })

  it('declares a status column on discovery_jobs', () => {
    const jobs = COMPLIANCE_TABLES.find((t) => t.name === 'discovery_jobs')
    expect(jobs).toBeDefined()
    const status = jobs?.fields.find((f) => f.name === 'status')
    expect(status).toEqual({
      name: 'status',
      type: 'STRING',
      mode: 'REQUIRED',
    })
  })

  it('each table has at least one REQUIRED field', () => {
    for (const t of COMPLIANCE_TABLES) {
      expect(t.fields.some((f) => f.mode === 'REQUIRED')).toBe(true)
    }
  })
})

describe('currentOpenFindingsViewQuery', () => {
  it('keeps optional CA AG Online Renewal auth findings out of current open findings', () => {
    const query = currentOpenFindingsViewQuery('project.dataset')

    expect(query).toContain("f.source_id = 'ca-ag-online-filing'")
  })

  it('closes stale source-gap findings when the latest source run succeeded', () => {
    const query = currentOpenFindingsViewQuery('project.dataset')

    expect(query).toContain("JSON_VALUE(f.evidence, '$.code') IN")
    expect(query).toContain("'source.failed'")
    expect(query).toContain("'source.auth_required'")
    expect(query).toContain("'source.manual_required'")
    expect(query).toContain("'source.policy_blocked'")
    expect(query).toContain("r.status = 'succeeded'")
  })

  it('closes stale FTB exempt-status findings when the latest FTB payload verifies exemption', () => {
    const query = currentOpenFindingsViewQuery('project.dataset')

    expect(query).toContain("'ca.ftb.exempt_status_not_verified'")
    expect(query).toContain("JSON_VALUE(r.payload, '$.exempt_status_verified')")
    expect(query).toContain("'EXEMPT'")
    expect(query).toContain("'VERIFIED'")
  })

  it('deduplicates repeated current findings by semantic finding code instead of full evidence history', () => {
    const query = currentOpenFindingsViewQuery('project.dataset')

    expect(query).toContain(
      "COALESCE(JSON_VALUE(f.evidence, '$.code'), f.title)",
    )
    expect(query).not.toContain('TO_JSON_STRING(evidence)')
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
    job_id: null,
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

  it('parses payload when BigQuery returns it as a JSON-encoded string', () => {
    // BQ's JSON column type round-trips as a string in the nodejs SDK
    // — discovery_runs.payload is JSON, so the schema's preprocess
    // parses it before downstream consumers (compliance-status,
    // discover-result, source-specific finding derivation) try to
    // index into it.
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      payload:
        '{"matchStatus":"found","detailUrl":"https://example.gov/detail/abc"}',
    })
    expect(parsed.payload).toEqual({
      matchStatus: 'found',
      detailUrl: 'https://example.gov/detail/abc',
    })
  })

  it('passes a payload object through unchanged when it is already parsed', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      payload: { matchStatus: 'found' },
    })
    expect(parsed.payload).toEqual({ matchStatus: 'found' })
  })

  it('rejects an empty source_id', () => {
    expect(() =>
      ComplianceDiscoveryRunRowSchema.parse({ ...valid, source_id: '' }),
    ).toThrow()
  })

  it('accepts a null job_id (rows without an async-job parent)', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      job_id: null,
    })
    expect(parsed.job_id).toBeNull()
  })

  it('accepts a UUID job_id', () => {
    const parsed = ComplianceDiscoveryRunRowSchema.parse({
      ...valid,
      job_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(parsed.job_id).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('rejects a non-UUID job_id', () => {
    expect(() =>
      ComplianceDiscoveryRunRowSchema.parse({
        ...valid,
        job_id: 'not-a-uuid',
      }),
    ).toThrow()
  })
})

describe('ComplianceDiscoveryJobRowSchema', () => {
  const valid = {
    job_id: '11111111-1111-4111-8111-111111111111',
    started_at: '2024-01-01T00:00:00Z',
    finished_at: null,
    status: 'running',
    requested_sources: null,
    requested_jurisdiction: null,
    error_type: null,
    error_message: null,
    result: null,
  }

  it('parses a fresh running job', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse(valid)
    expect(parsed.status).toBe('running')
    expect(parsed.finished_at).toBeNull()
  })

  it('parses a completed job', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      status: 'completed',
      finished_at: '2024-01-01T00:00:30Z',
    })
    expect(parsed.status).toBe('completed')
    expect(parsed.finished_at).toBe('2024-01-01T00:00:30Z')
  })

  it('parses a failed job with error fields', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      status: 'failed',
      finished_at: '2024-01-01T00:00:05Z',
      error_type: 'spawn',
      error_message: 'fetch unavailable',
    })
    expect(parsed.error_type).toBe('spawn')
    expect(parsed.error_message).toContain('fetch')
  })

  it('parses a job with a sources filter', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      requested_sources: ['irs-teos', 'ca-sos-bizfile'],
    })
    expect(parsed.requested_sources).toEqual(['irs-teos', 'ca-sos-bizfile'])
  })

  it('parses a job with a jurisdiction filter', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      requested_jurisdiction: 'us-ca',
    })
    expect(parsed.requested_jurisdiction).toBe('us-ca')
  })

  it('rejects an unknown status', () => {
    expect(() =>
      ComplianceDiscoveryJobRowSchema.parse({ ...valid, status: 'aborted' }),
    ).toThrow()
  })

  it('rejects a non-UUID job_id', () => {
    expect(() =>
      ComplianceDiscoveryJobRowSchema.parse({ ...valid, job_id: 'bad' }),
    ).toThrow()
  })

  it('extracts BigQueryTimestamp .value for started_at and finished_at', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      status: 'completed',
      started_at: { value: '2024-01-01T00:00:00.000Z' },
      finished_at: { value: '2024-01-01T00:00:30.000Z' },
    })
    expect(parsed.started_at).toBe('2024-01-01T00:00:00.000Z')
    expect(parsed.finished_at).toBe('2024-01-01T00:00:30.000Z')
  })

  it('accepts a null result (rows without a stored report yet)', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse(valid)
    expect(parsed.result).toBeNull()
  })

  it('preserves a completed job result payload', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      status: 'completed',
      finished_at: '2024-01-01T00:00:30Z',
      result: { runs: [], findings: [] },
    })
    expect(parsed.result).toEqual({ runs: [], findings: [] })
  })

  it('parses requested_sources when BigQuery returns it as a JSON-encoded string', () => {
    // BQ returns JSON columns as JSON-encoded strings, not as parsed
    // arrays. The schema's preprocess handles that transparently.
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      requested_sources: '["ca-sos-bizfile","ca-ftb-entity-status-letter"]',
    })
    expect(parsed.requested_sources).toEqual([
      'ca-sos-bizfile',
      'ca-ftb-entity-status-letter',
    ])
  })

  it('parses result when BigQuery returns it as a JSON-encoded string', () => {
    const parsed = ComplianceDiscoveryJobRowSchema.parse({
      ...valid,
      status: 'completed',
      finished_at: '2024-01-01T00:00:30Z',
      result: '{"runs":[],"findings":[]}',
    })
    expect(parsed.result).toEqual({ runs: [], findings: [] })
  })

  it('keeps an unparseable JSON string as-is so the downstream check fails loudly', () => {
    expect(() =>
      ComplianceDiscoveryJobRowSchema.parse({
        ...valid,
        requested_sources: 'this is not valid JSON',
      }),
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
    access_url:
      'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
    access_method: 'official_bulk_download',
    automation_allowed: true,
    manual_only_reason: null,
    source_freshness: {
      observedAt: '2026-04-28T00:00:00.000Z',
      upstreamPublishedAt: '2026-04-15',
    },
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

  it('rejects an access_url that is not a URL', () => {
    expect(() =>
      ComplianceSourceRowSchema.parse({ ...valid, access_url: 'not-a-url' }),
    ).toThrow()
  })

  it('rejects an unknown access method', () => {
    expect(() =>
      ComplianceSourceRowSchema.parse({
        ...valid,
        access_method: 'private_endpoint',
      }),
    ).toThrow()
  })

  it('requires manual_only_reason when automation is blocked', () => {
    expect(() =>
      ComplianceSourceRowSchema.parse({
        ...valid,
        automation_allowed: false,
        manual_only_reason: null,
      }),
    ).toThrow()
  })

  it('rejects manual_only_reason on automated sources', () => {
    expect(() =>
      ComplianceSourceRowSchema.parse({
        ...valid,
        manual_only_reason: 'not needed',
      }),
    ).toThrow()
  })

  it('parses a manual-only source row with a reason', () => {
    const parsed = ComplianceSourceRowSchema.parse({
      ...valid,
      access_method: 'manual',
      automation_allowed: false,
      manual_only_reason: 'Current source terms prohibit automated scraping.',
    })
    expect(parsed.manual_only_reason).toContain('scraping')
  })

  it('extracts BigQueryTimestamp value for updated_at', () => {
    const parsed = ComplianceSourceRowSchema.parse({
      ...valid,
      updated_at: { value: '2024-02-02T00:00:00.000Z' },
    })
    expect(parsed.updated_at).toBe('2024-02-02T00:00:00.000Z')
  })
})
