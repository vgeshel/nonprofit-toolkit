/**
 * Tests for the us-federal jurisdiction module.
 *
 * The module exports a `Jurisdiction` value with the federal public sources
 * listed. Registering it must succeed; later phases extend it with deadline
 * rules and forms.
 */
import { describe, expect, it } from 'vitest'
import { usFederalJurisdiction } from '../jurisdictions/us-federal/index.ts'
import { createJurisdictionRegistry } from '../registry/jurisdiction-registry.ts'

describe('usFederalJurisdiction', () => {
  it('uses the canonical id "us-federal"', () => {
    expect(usFederalJurisdiction.id).toBe('us-federal')
  })

  it('exposes the federal public sources', () => {
    expect(usFederalJurisdiction.sources.map((s) => s.id)).toEqual([
      'irs-teos',
      'irs-eo-bmf',
    ])
  })

  it('starts with no deadline rules in Phase 2', () => {
    expect(usFederalJurisdiction.deadlineRules).toEqual([])
  })

  it('starts with no form definitions in Phase 2', () => {
    expect(usFederalJurisdiction.forms).toEqual([])
  })

  it('exposes a Zod entity-id schema that accepts a valid EIN', () => {
    expect(
      usFederalJurisdiction.entityIdSchema.parse({ ein: '12-3456789' }),
    ).toEqual({ ein: '12-3456789' })
  })

  it('rejects an invalid EIN via the entity-id schema', () => {
    expect(() =>
      usFederalJurisdiction.entityIdSchema.parse({ ein: '12345' }),
    ).toThrow()
  })

  it('registers cleanly into a JurisdictionRegistry', () => {
    const r = createJurisdictionRegistry()
    const result = r.register(usFederalJurisdiction)
    expect(result.isOk()).toBe(true)
    expect(r.list()).toHaveLength(1)
  })
})
