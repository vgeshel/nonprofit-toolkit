/**
 * Tests for compliance type schemas.
 *
 * Covers: EntityIdentifiers, EntitySchema, FindingSchema, FindingSeveritySchema,
 *         SourceKindSchema, SourceRecordSchema, JurisdictionIdSchema.
 */
import { describe, expect, it } from 'vitest'
import {
  EntityIdentifiersSchema,
  EntitySchema,
  FindingSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  JurisdictionIdSchema,
  SourceKindSchema,
  SourceRecordSchema,
} from '../types/index.ts'

describe('JurisdictionIdSchema', () => {
  it('accepts a known jurisdiction id', () => {
    expect(JurisdictionIdSchema.parse('us-federal')).toBe('us-federal')
    expect(JurisdictionIdSchema.parse('us-ca')).toBe('us-ca')
  })

  it('rejects empty strings', () => {
    expect(() => JurisdictionIdSchema.parse('')).toThrow()
  })

  it('rejects non-string values', () => {
    expect(() => JurisdictionIdSchema.parse(42)).toThrow()
    expect(() => JurisdictionIdSchema.parse(null)).toThrow()
  })

  it('rejects ids with whitespace', () => {
    expect(() => JurisdictionIdSchema.parse('us federal')).toThrow()
  })
})

describe('SourceKindSchema', () => {
  it.each(['api', 'playwright', 'manual'])('accepts %s', (kind) => {
    expect(SourceKindSchema.parse(kind)).toBe(kind)
  })

  it('rejects unknown kinds', () => {
    expect(() => SourceKindSchema.parse('graphql')).toThrow()
  })
})

describe('FindingSeveritySchema', () => {
  it.each(['info', 'warn', 'error'])('accepts %s', (s) => {
    expect(FindingSeveritySchema.parse(s)).toBe(s)
  })

  it('rejects invalid severities', () => {
    expect(() => FindingSeveritySchema.parse('critical')).toThrow()
  })
})

describe('FindingStatusSchema', () => {
  it.each(['open', 'resolved'])('accepts %s', (s) => {
    expect(FindingStatusSchema.parse(s)).toBe(s)
  })

  it('rejects invalid statuses', () => {
    expect(() => FindingStatusSchema.parse('closed')).toThrow()
  })
})

describe('EntityIdentifiersSchema', () => {
  it('accepts an empty object (no IDs known yet)', () => {
    expect(EntityIdentifiersSchema.parse({})).toEqual({})
  })

  it('accepts a fully populated record', () => {
    const data = {
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456', agCharityNumber: 'CT0123456' },
    }
    const parsed = EntityIdentifiersSchema.parse(data)
    expect(parsed).toEqual(data)
  })

  it('strips unknown jurisdiction keys', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'martian-republic': { foo: 'bar' } }),
    ).toThrow()
  })

  it('rejects non-object payloads', () => {
    expect(() => EntityIdentifiersSchema.parse('not-an-object')).toThrow()
  })

  it('rejects malformed EIN values', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'us-federal': { ein: '123' } }),
    ).toThrow()
  })

  it('accepts a 9-digit EIN with no dash', () => {
    const parsed = EntityIdentifiersSchema.parse({
      'us-federal': { ein: '123456789' },
    })
    expect(parsed['us-federal']?.ein).toBe('123456789')
  })

  it('rejects EIN with letters', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'us-federal': { ein: '12-34A6789' } }),
    ).toThrow()
  })

  it('accepts CA SOS entity number with letter prefix', () => {
    const parsed = EntityIdentifiersSchema.parse({
      'us-ca': { sosEntityNumber: 'C0123456' },
    })
    expect(parsed['us-ca']?.sosEntityNumber).toBe('C0123456')
  })

  it('rejects empty CA SOS entity number', () => {
    expect(() =>
      EntityIdentifiersSchema.parse({ 'us-ca': { sosEntityNumber: '' } }),
    ).toThrow()
  })
})

describe('EntitySchema', () => {
  const valid = {
    legal_name: 'Foo Foundation',
    state_of_incorporation: 'CA',
    fiscal_year_end_month: 12,
    fiscal_year_end_day: 31,
    formation_date: '2010-01-15',
    mailing_address_line1: '123 Main St',
    mailing_address_line2: null,
    mailing_address_city: 'San Francisco',
    mailing_address_region: 'CA',
    mailing_address_postal_code: '94110',
    mailing_address_country: 'US',
    updated_at: '2024-01-15T00:00:00Z',
  }

  it('parses a valid entity row', () => {
    const result = EntitySchema.parse(valid)
    expect(result.legal_name).toBe('Foo Foundation')
    expect(result.fiscal_year_end_month).toBe(12)
  })

  it('coerces fiscal_year_end_month from string', () => {
    const result = EntitySchema.parse({ ...valid, fiscal_year_end_month: '6' })
    expect(result.fiscal_year_end_month).toBe(6)
  })

  it('rejects fiscal_year_end_month out of range', () => {
    expect(() =>
      EntitySchema.parse({ ...valid, fiscal_year_end_month: 13 }),
    ).toThrow()
    expect(() =>
      EntitySchema.parse({ ...valid, fiscal_year_end_month: 0 }),
    ).toThrow()
  })

  it('rejects fiscal_year_end_day out of range', () => {
    expect(() =>
      EntitySchema.parse({ ...valid, fiscal_year_end_day: 32 }),
    ).toThrow()
  })

  it('rejects malformed formation_date', () => {
    expect(() =>
      EntitySchema.parse({ ...valid, formation_date: 'last Tuesday' }),
    ).toThrow()
  })

  it('allows nullable address line 2', () => {
    const r = EntitySchema.parse(valid)
    expect(r.mailing_address_line2).toBeNull()
  })

  it('rejects missing legal_name', () => {
    const broken: Record<string, unknown> = { ...valid }
    delete broken.legal_name
    expect(() => EntitySchema.parse(broken)).toThrow()
  })

  it('extracts BigQueryTimestamp .value into updated_at', () => {
    const result = EntitySchema.parse({
      ...valid,
      updated_at: { value: '2024-02-02T00:00:00.000Z' },
    })
    expect(result.updated_at).toBe('2024-02-02T00:00:00.000Z')
  })

  it('extracts BigQueryDate .value into formation_date', () => {
    const result = EntitySchema.parse({
      ...valid,
      formation_date: { value: '2010-01-15' },
    })
    expect(result.formation_date).toBe('2010-01-15')
  })
})

describe('FindingSchema', () => {
  const valid = {
    finding_id: '550e8400-e29b-41d4-a716-446655440000',
    jurisdiction_id: 'us-federal',
    source_id: 'irs-teos',
    severity: 'warn',
    status: 'open',
    title: 'Missing latest 990 filing',
    detail: 'No Form 990 found on record for 2023.',
    evidence: { source_record_pointer: 'gs://bucket/x' },
    opened_at: '2024-03-01T00:00:00Z',
    resolved_at: null,
  }

  it('parses a valid finding', () => {
    const result = FindingSchema.parse(valid)
    expect(result.finding_id).toBe(valid.finding_id)
    expect(result.severity).toBe('warn')
  })

  it('parses a resolved finding', () => {
    const result = FindingSchema.parse({
      ...valid,
      status: 'resolved',
      resolved_at: '2024-04-01T00:00:00Z',
    })
    expect(result.status).toBe('resolved')
    expect(result.resolved_at).toBe('2024-04-01T00:00:00Z')
  })

  it('rejects invalid finding_id (not a UUID)', () => {
    expect(() =>
      FindingSchema.parse({ ...valid, finding_id: 'not-uuid' }),
    ).toThrow()
  })

  it('rejects empty title', () => {
    expect(() => FindingSchema.parse({ ...valid, title: '' })).toThrow()
  })

  it('extracts BigQueryTimestamp .value for opened_at', () => {
    const result = FindingSchema.parse({
      ...valid,
      opened_at: { value: '2024-03-02T00:00:00.000Z' },
    })
    expect(result.opened_at).toBe('2024-03-02T00:00:00.000Z')
  })

  it('rejects unknown severity', () => {
    expect(() =>
      FindingSchema.parse({ ...valid, severity: 'critical' }),
    ).toThrow()
  })
})

describe('SourceRecordSchema', () => {
  const valid = {
    record_id: '550e8400-e29b-41d4-a716-446655440000',
    source_id: 'irs-teos',
    fetched_at: '2024-03-01T00:00:00Z',
    payload: { kind: 'pub78-hit', deductibilityCode: 'PC' },
  }

  it('parses a valid record', () => {
    const result = SourceRecordSchema.parse(valid)
    expect(result.source_id).toBe('irs-teos')
    expect(result.payload).toEqual({
      kind: 'pub78-hit',
      deductibilityCode: 'PC',
    })
  })

  it('rejects empty source_id', () => {
    expect(() =>
      SourceRecordSchema.parse({ ...valid, source_id: '' }),
    ).toThrow()
  })

  it('rejects non-object payload', () => {
    expect(() =>
      SourceRecordSchema.parse({ ...valid, payload: 'foo' }),
    ).toThrow()
  })
})
