/**
 * Tests for the entity-row BigQuery accessor.
 *
 * Accessor surface:
 *   - readEntity(): returns Result<Entity | null, ...>
 *   - upsertEntity(input): writes the entity row
 *   - rejects malformed BQ rows with a typed error
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  createEntityAccessor,
  type BqQueryRunner,
  type EntityInput,
} from '../state/bq-entity.ts'

const VALID_INPUT: EntityInput = {
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
}

function fakeRunner(
  query: ReturnType<typeof vi.fn<BqQueryRunner['query']>>,
): BqQueryRunner {
  return { query }
}

describe('createEntityAccessor.readEntity', () => {
  it('returns null when no rows exist', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'p',
      now: () => new Date('2024-05-01T00:00:00Z'),
    })

    const got = await accessor.readEntity()
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toBeNull()

    expect(query).toHaveBeenCalledTimes(1)
    const [sql] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/SELECT/i)
    expect(sql).toMatch(/`p\.compliance\.entity`/)
  })

  it('parses and returns the entity row when present', async () => {
    const row = {
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
      updated_at: { value: '2024-05-01T00:00:00.000Z' },
    }
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([row]))
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'p',
      now: () => new Date('2024-05-01T00:00:00Z'),
    })

    const got = await accessor.readEntity()
    expect(got.isOk()).toBe(true)
    const v = got._unsafeUnwrap()
    expect(v?.legal_name).toBe('Foo Foundation')
    expect(v?.updated_at).toBe('2024-05-01T00:00:00.000Z')
  })

  it('returns a parse error on malformed BQ row', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      okAsync([{ legal_name: 'incomplete' }]),
    )
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'p',
      now: () => new Date(),
    })

    const got = await accessor.readEntity()
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('parse')
    }
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ unreachable' }),
    )
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'p',
      now: () => new Date(),
    })

    const got = await accessor.readEntity()
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('query')
    }
  })
})

describe('createEntityAccessor.upsertEntity', () => {
  it('runs a MERGE-style query with the input parameters', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const fixedNow = new Date('2024-05-01T00:00:00.000Z')
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => fixedNow,
    })

    const result = await accessor.upsertEntity(VALID_INPUT)
    expect(result.isOk()).toBe(true)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/MERGE/i)
    expect(sql).toMatch(/`proj\.compliance\.entity`/)
    expect(params).toMatchObject({
      legal_name: 'Foo Foundation',
      state_of_incorporation: 'CA',
      fiscal_year_end_month: 12,
      formation_date: '2010-01-15',
      updated_at: fixedNow.toISOString(),
    })
  })

  it('passes a types map covering every nullable column', async () => {
    // BigQuery rejects null parameter values without an explicit type.
    // `mailing_address_line2` is the only nullable column on `entity`, so
    // it's the only one that needs a hint. The type is attached
    // unconditionally so a null line2 is accepted without any branching.
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => new Date('2024-05-01T00:00:00.000Z'),
    })

    await accessor.upsertEntity(VALID_INPUT)
    const [, , types] = query.mock.calls[0] ?? []
    expect(types).toEqual({ mailing_address_line2: 'STRING' })
  })

  it('returns a validation error on malformed input', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'p',
      now: () => new Date(),
    })

    const broken = { ...VALID_INPUT, fiscal_year_end_month: 99 }
    const result = await accessor.upsertEntity(broken)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates a runner error from upsert', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createEntityAccessor({
      runner: fakeRunner(query),
      projectId: 'p',
      now: () => new Date(),
    })

    const result = await accessor.upsertEntity(VALID_INPUT)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
    }
  })
})
