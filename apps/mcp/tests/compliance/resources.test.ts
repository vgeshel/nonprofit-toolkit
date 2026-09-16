/**
 * Tests for the compliance MCP resource builders.
 *
 * Parsed JSON is validated through Zod schemas so the assertions stay
 * type-safe (no `expect.any(...)` patterns that propagate `any`).
 */
import { errAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  Entity,
  Jurisdiction,
  Source,
} from '../../../../src/compliance/types/index.ts'
import {
  COMPLIANCE_INTERVIEW_QUESTIONS_URI,
  COMPLIANCE_SOURCES_REGISTRY_URI,
  COMPLIANCE_STATUS_URI,
  buildInterviewQuestionsResource,
  buildManualEvidenceInstructionsResource,
  buildSourceRegistryResource,
  buildStatusResource,
  serialiseStatus,
} from '../../src/tools/compliance/resources'
import type { EnrichedComplianceStatusReport } from '../../src/tools/compliance/status'
import { parseFirstResourceJson } from './test-utils'

const STUB_REPORT: EnrichedComplianceStatusReport = {
  now: '2026-05-21T12:00:00.000Z',
  sources: [],
  entity: {
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
    updated_at: '2024-05-01T00:00:00Z',
  },
  identifiers: {
    'us-federal': { ein: '12-3456789' },
    'us-ca': { sosEntityNumber: 'C0123456' },
  },
  latestRuns: [],
  openFindings: [],
  overall: 'clear',
}

const StatusBodySchema = z.object({
  overall: z.string(),
  entity: z.object({ legal_name: z.string() }).loose(),
  identifiers: z.record(z.string(), z.unknown()),
  latestRuns: z.array(z.unknown()),
  openFindings: z.array(z.unknown()),
})

const SourceItemSchema = z.object({
  sourceId: z.string(),
  jurisdictionId: z.string(),
  agency: z.string(),
  description: z.string(),
  accessUrl: z.string(),
  accessMethod: z.string(),
  automationAllowed: z.boolean(),
  authRequired: z.boolean(),
  tosUrl: z.string(),
  manualOnlyReason: z.string().nullable(),
  manualEvidenceFieldsAvailable: z.boolean(),
})

const SourceRegistryBodySchema = z.object({
  sources: z.array(SourceItemSchema),
})

const InterviewQuestionsBodySchema = z.object({
  questions: z.array(
    z.object({
      field: z.string(),
      prompt: z.string(),
      kind: z.enum(['string', 'number']),
      optional: z.boolean(),
    }),
  ),
})

const ManualEvidenceBodySchema = z.object({
  sourceId: z.string(),
  agency: z.string(),
  description: z.string(),
  accessUrl: z.string(),
})

const AuthSchema = z.object({
  loginUrl: z.string(),
  credentialFields: z.array(z.unknown()),
  instructions: z.array(z.unknown()),
})

describe('serialiseStatus', () => {
  it('projects the report into a JSON-safe shape', () => {
    const out = serialiseStatus(STUB_REPORT)
    expect(out.overall).toBe('clear')
    expect(out.entity).toEqual(STUB_REPORT.entity)
    expect(out.identifiers).toEqual(STUB_REPORT.identifiers)
    expect(out.latestRuns).toEqual([])
    expect(out.openFindings).toEqual([])
  })
})

describe('buildStatusResource', () => {
  it('emits a single JSON content under the compliance://status URI', () => {
    const out = buildStatusResource(STUB_REPORT)
    expect(out.contents).toHaveLength(1)
    expect(out.contents[0]?.uri).toBe(COMPLIANCE_STATUS_URI)
    expect(out.contents[0]?.mimeType).toBe('application/json')
    const body = StatusBodySchema.parse(parseFirstResourceJson(out))
    expect(body.overall).toBe('clear')
    expect(body.entity.legal_name).toBe('Foo Foundation')
  })
})

describe('buildSourceRegistryResource', () => {
  it('lists every source from the default jurisdictions with policy metadata', () => {
    const out = buildSourceRegistryResource()
    expect(out.contents[0]?.uri).toBe(COMPLIANCE_SOURCES_REGISTRY_URI)
    const body = SourceRegistryBodySchema.parse(parseFirstResourceJson(out))
    expect(body.sources.length).toBeGreaterThan(0)
    for (const s of body.sources) {
      expect(s.accessUrl).toMatch(/^https?:\/\//)
    }
  })

  it('respects an explicitly provided jurisdiction list', () => {
    const out = buildSourceRegistryResource([])
    const body = SourceRegistryBodySchema.parse(parseFirstResourceJson(out))
    expect(body.sources).toEqual([])
  })

  it('projects manual-only sources with the manualOnlyReason populated', () => {
    // The production registry has no automationAllowed=false sources;
    // exercise that branch with a synthetic fixture.
    const noopRun: Source['run'] = (_entity: Entity) =>
      errAsync({ type: 'internal', message: 'unused' })
    const manualSource: Source = {
      id: 'manual-test-source',
      jurisdiction: 'us-test',
      agency: 'Test State Agency',
      kind: 'manual',
      authRequired: false,
      description: 'A manual-only test source.',
      tosUrl: 'https://example.com/tos',
      accessUrl: 'https://example.com/portal',
      accessMethod: 'manual',
      run: noopRun,
      automationAllowed: false,
      manualOnlyReason: 'Manual-only for testing.',
      manualInstructions: ['Step 1.'],
      manualEvidenceFields: [
        { key: 'accountStatus', label: 'Status', required: true },
      ],
    }
    const jurisdiction: Jurisdiction = {
      id: 'us-test',
      entityIdSchema: z.unknown(),
      sources: [manualSource],
      deadlineRules: [],
      forms: [],
    }
    const out = buildSourceRegistryResource([jurisdiction])
    const body = SourceRegistryBodySchema.parse(parseFirstResourceJson(out))
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]?.automationAllowed).toBe(false)
    expect(body.sources[0]?.manualOnlyReason).toBe('Manual-only for testing.')
    expect(body.sources[0]?.manualEvidenceFieldsAvailable).toBe(true)
  })
})

describe('buildInterviewQuestionsResource', () => {
  it('emits the full ONBOARD_INTERVIEW_QUESTIONS list', () => {
    const out = buildInterviewQuestionsResource()
    expect(out.contents[0]?.uri).toBe(COMPLIANCE_INTERVIEW_QUESTIONS_URI)
    const body = InterviewQuestionsBodySchema.parse(parseFirstResourceJson(out))
    expect(body.questions.length).toBeGreaterThan(0)
    const fields = body.questions.map((q) => q.field)
    expect(fields).toContain('legalName')
    expect(fields).toContain('ein')
    expect(fields).toContain('caSosEntityNumber')
  })
})

describe('buildManualEvidenceInstructionsResource', () => {
  it('returns the per-source body for a known source', () => {
    const registry = buildSourceRegistryResource()
    const body = SourceRegistryBodySchema.parse(
      parseFirstResourceJson(registry),
    )
    expect(body.sources.length).toBeGreaterThan(0)
    const sourceId = body.sources[0]?.sourceId
    if (sourceId === undefined) {
      throw new Error('expected at least one registered source')
    }

    const out = buildManualEvidenceInstructionsResource(sourceId)
    expect(out).not.toBeNull()
    if (out === null) return
    expect(out.contents[0]?.uri).toContain(sourceId)
    const detail = ManualEvidenceBodySchema.parse(parseFirstResourceJson(out))
    expect(detail.sourceId).toBe(sourceId)
  })

  it('returns null when no source matches', () => {
    const out = buildManualEvidenceInstructionsResource(
      'does-not-exist-anywhere',
    )
    expect(out).toBeNull()
  })

  it('includes auth metadata for sources that declare authentication requirements', () => {
    const out = buildManualEvidenceInstructionsResource(
      'ca-cdtfa-online-services',
    )
    if (out === null) {
      return
    }
    const body = parseFirstResourceJson(out)
    if (body.auth === undefined) {
      return
    }
    const auth = AuthSchema.parse(body.auth)
    expect(auth.loginUrl).toMatch(/^https?:\/\//)
    expect(auth.credentialFields.length).toBeGreaterThan(0)
    expect(auth.instructions.length).toBeGreaterThan(0)
  })

  it('exposes the manual-only branch (instructions + evidence fields) for non-automated sources', () => {
    // No source in the production registry declares automationAllowed: false
    // (all CA portal checks today are auth-required automated). Build a
    // synthetic manual-only jurisdiction so the manual-only branch in
    // buildManualEvidenceInstructionsResource is exercised.
    const noopRun: Source['run'] = (_entity: Entity) =>
      errAsync({ type: 'internal', message: 'unused' })
    const manualSource: Source = {
      id: 'manual-test-source',
      jurisdiction: 'us-test',
      agency: 'Test State Agency',
      kind: 'manual',
      authRequired: false,
      description: 'A manual-only test source.',
      tosUrl: 'https://example.com/tos',
      accessUrl: 'https://example.com/portal',
      accessMethod: 'manual',
      run: noopRun,
      automationAllowed: false,
      manualOnlyReason:
        'The upstream terms prohibit automated access; collect evidence by hand.',
      manualInstructions: [
        'Log into the portal at the provided URL.',
        'Copy the displayed account status and paste it into compliance-record-evidence.',
      ],
      manualEvidenceFields: [
        { key: 'accountStatus', label: 'Account Status', required: true },
      ],
    }
    const jurisdiction: Jurisdiction = {
      id: 'us-test',
      entityIdSchema: z.unknown(),
      sources: [manualSource],
      deadlineRules: [],
      forms: [],
    }

    const out = buildManualEvidenceInstructionsResource('manual-test-source', [
      jurisdiction,
    ])
    expect(out).not.toBeNull()
    if (out === null) return
    const detail = parseFirstResourceJson(out)
    expect(detail.automationAllowed).toBe(false)
    expect(Array.isArray(detail.instructions)).toBe(true)
    expect(Array.isArray(detail.evidenceFields)).toBe(true)
    expect(detail.manualOnlyReason).toContain('terms')
  })
})
