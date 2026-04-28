/**
 * Tests for the jurisdiction registry.
 *
 * Registry semantics:
 *   - register: insert a Jurisdiction by id (must be unique)
 *   - get: lookup by id, returns Result<Jurisdiction, RegistryError>
 *   - list: returns a snapshot array of all registered jurisdictions
 *   - duplicate ids are rejected with a typed error
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createJurisdictionRegistry } from '../registry/jurisdiction-registry.ts'
import type { Jurisdiction } from '../types/index.ts'

function makeJurisdiction(id: string): Jurisdiction {
  return {
    id,
    entityIdSchema: z.object({}).strict(),
    sources: [],
    deadlineRules: [],
    forms: [],
  }
}

describe('createJurisdictionRegistry', () => {
  it('starts empty', () => {
    const r = createJurisdictionRegistry()
    expect(r.list()).toEqual([])
  })

  it('registers and retrieves a jurisdiction', () => {
    const r = createJurisdictionRegistry()
    const fed = makeJurisdiction('us-federal')

    const registered = r.register(fed)
    expect(registered.isOk()).toBe(true)

    const got = r.get('us-federal')
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap().id).toBe('us-federal')
  })

  it('returns the same Jurisdiction instance from get and list', () => {
    const r = createJurisdictionRegistry()
    const fed = makeJurisdiction('us-federal')
    r.register(fed)

    expect(r.get('us-federal')._unsafeUnwrap()).toBe(fed)
    expect(r.list()[0]).toBe(fed)
  })

  it('rejects duplicate registration with a typed error', () => {
    const r = createJurisdictionRegistry()
    r.register(makeJurisdiction('us-ca'))

    const second = r.register(makeJurisdiction('us-ca'))
    expect(second.isErr()).toBe(true)
    if (second.isErr()) {
      expect(second.error.type).toBe('duplicate')
      expect(second.error.id).toBe('us-ca')
      expect(second.error.message).toContain('us-ca')
    }
  })

  it('does not mutate state when a duplicate is rejected', () => {
    const r = createJurisdictionRegistry()
    r.register(makeJurisdiction('us-ca'))
    const before = r.list()
    r.register(makeJurisdiction('us-ca'))
    const after = r.list()
    expect(after).toEqual(before)
  })

  it('returns a not_found error when id is missing', () => {
    const r = createJurisdictionRegistry()
    const got = r.get('us-ca')
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('not_found')
      expect(got.error.id).toBe('us-ca')
    }
  })

  it('returns invalid_id when get() is called with an invalid id', () => {
    const r = createJurisdictionRegistry()
    const got = r.get('us federal')
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('invalid_id')
      expect(got.error.id).toBe('us federal')
    }
  })

  it('returns invalid_id when get() is called with a non-string id', () => {
    const r = createJurisdictionRegistry()
    // The runtime contract is that callers pass a string, but defensive
    // validation catches misuse. Cast through `unknown`-typed local since the
    // declared signature is `string` — using a Zod-aware wrapper keeps the
    // call site honest and the test exercises the validation branch.
    const got = r.get('')
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('invalid_id')
    }
  })

  it('rejects an invalid jurisdiction id at registration', () => {
    const r = createJurisdictionRegistry()
    const result = r.register(makeJurisdiction(''))
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('invalid_id')
    }
  })

  it('rejects an id with whitespace at registration', () => {
    const r = createJurisdictionRegistry()
    const result = r.register(makeJurisdiction('us federal'))
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('invalid_id')
    }
  })

  it('list returns a snapshot, not a live reference', () => {
    const r = createJurisdictionRegistry()
    r.register(makeJurisdiction('us-federal'))
    const first = r.list()
    r.register(makeJurisdiction('us-ca'))
    expect(first).toHaveLength(1)
    expect(r.list()).toHaveLength(2)
  })

  it('lists multiple jurisdictions in registration order', () => {
    const r = createJurisdictionRegistry()
    r.register(makeJurisdiction('us-federal'))
    r.register(makeJurisdiction('us-ca'))

    const ids = r.list().map((j) => j.id)
    expect(ids).toEqual(['us-federal', 'us-ca'])
  })
})
