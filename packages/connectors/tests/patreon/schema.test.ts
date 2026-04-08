/**
 * Tests for Patreon API V2 schema validation.
 */
import { describe, expect, it } from 'vitest'
import {
  PatreonGenericResourceSchema,
  PatreonMemberAttributesSchema,
  PatreonMemberResourceSchema,
  PatreonMembersResponseSchema,
  PatreonMetaSchema,
  PatreonPaginationCursorsSchema,
  PatreonPaginationSchema,
  PatreonPledgeEventAttributesSchema,
  PatreonResourceIdSchema,
} from '../../src/patreon/schema'

describe('PatreonResourceIdSchema', () => {
  it('parses a valid resource id', () => {
    const result = PatreonResourceIdSchema.parse({
      type: 'pledge-event',
      id: 'evt_123',
    })
    expect(result).toEqual({ type: 'pledge-event', id: 'evt_123' })
  })

  it('rejects missing type', () => {
    expect(() => PatreonResourceIdSchema.parse({ id: 'evt_123' })).toThrow()
  })

  it('rejects missing id', () => {
    expect(() =>
      PatreonResourceIdSchema.parse({ type: 'pledge-event' }),
    ).toThrow()
  })
})

describe('PatreonMemberAttributesSchema', () => {
  it('parses a fully populated member', () => {
    const attrs = {
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      patron_status: 'active_patron',
      last_charge_date: '2024-03-01T00:00:00.000+00:00',
      last_charge_status: 'Paid',
      lifetime_support_cents: 12000,
      currently_entitled_amount_cents: 500,
    }
    const result = PatreonMemberAttributesSchema.parse(attrs)
    expect(result).toEqual(attrs)
  })

  it('parses an empty member (all optional)', () => {
    const result = PatreonMemberAttributesSchema.parse({})
    expect(result).toEqual({})
  })

  it('accepts null for nullable fields', () => {
    const result = PatreonMemberAttributesSchema.parse({
      full_name: null,
      email: null,
      patron_status: null,
      last_charge_date: null,
      last_charge_status: null,
      lifetime_support_cents: null,
      currently_entitled_amount_cents: null,
    })
    expect(result.full_name).toBeNull()
    expect(result.lifetime_support_cents).toBeNull()
  })

  it('rejects non-integer lifetime_support_cents', () => {
    expect(() =>
      PatreonMemberAttributesSchema.parse({ lifetime_support_cents: 1.5 }),
    ).toThrow()
  })
})

describe('PatreonMemberResourceSchema', () => {
  it('parses a member resource without relationships', () => {
    const member = {
      type: 'member' as const,
      id: 'mem_123',
      attributes: { full_name: 'Jane Doe', email: 'jane@example.com' },
    }
    const result = PatreonMemberResourceSchema.parse(member)
    expect(result.id).toBe('mem_123')
    expect(result.type).toBe('member')
  })

  it('parses a member with pledge_history relationship', () => {
    const member = {
      type: 'member' as const,
      id: 'mem_123',
      attributes: {},
      relationships: {
        pledge_history: {
          data: [
            { type: 'pledge-event', id: 'evt_1' },
            { type: 'pledge-event', id: 'evt_2' },
          ],
        },
      },
    }
    const result = PatreonMemberResourceSchema.parse(member)
    expect(result.relationships?.pledge_history?.data).toHaveLength(2)
    expect(result.relationships?.pledge_history?.data[0]?.id).toBe('evt_1')
  })

  it('parses a member with user and campaign relationships', () => {
    const member = {
      type: 'member' as const,
      id: 'mem_123',
      attributes: {},
      relationships: {
        user: { data: { type: 'user', id: 'usr_456' } },
        campaign: { data: { type: 'campaign', id: 'cmp_789' } },
      },
    }
    const result = PatreonMemberResourceSchema.parse(member)
    expect(result.relationships?.user?.data?.id).toBe('usr_456')
    expect(result.relationships?.campaign?.data?.id).toBe('cmp_789')
  })

  it('accepts null user relationship', () => {
    const member = {
      type: 'member' as const,
      id: 'mem_123',
      attributes: {},
      relationships: {
        user: { data: null },
      },
    }
    const result = PatreonMemberResourceSchema.parse(member)
    expect(result.relationships?.user?.data).toBeNull()
  })

  it('rejects wrong type', () => {
    expect(() =>
      PatreonMemberResourceSchema.parse({
        type: 'user',
        id: 'mem_123',
        attributes: {},
      }),
    ).toThrow()
  })
})

describe('PatreonPledgeEventAttributesSchema', () => {
  it('parses a subscription charge event', () => {
    const attrs = {
      date: '2024-03-01T00:00:00.000+00:00',
      amount_cents: 500,
      currency_code: 'USD',
      payment_status: 'Paid',
      pledge_payment_status: null,
      type: 'subscription',
      tier_id: '8770500',
      tier_title: 'One tourniquet per month',
    }
    const result = PatreonPledgeEventAttributesSchema.parse(attrs)
    expect(result).toEqual(attrs)
  })

  it('parses a state-change event (pledge_delete) with non-zero amount', () => {
    const attrs = {
      date: '2024-03-01T00:00:00.000+00:00',
      amount_cents: 3000,
      currency_code: 'USD',
      payment_status: null,
      pledge_payment_status: 'valid',
      type: 'pledge_delete',
      tier_id: '8770500',
      tier_title: 'One tourniquet per month',
    }
    const result = PatreonPledgeEventAttributesSchema.parse(attrs)
    expect(result.amount_cents).toBe(3000)
    expect(result.pledge_payment_status).toBe('valid')
    expect(result.type).toBe('pledge_delete')
  })

  it('requires date and amount_cents', () => {
    expect(() =>
      PatreonPledgeEventAttributesSchema.parse({ amount_cents: 500 }),
    ).toThrow()
    expect(() =>
      PatreonPledgeEventAttributesSchema.parse({
        date: '2024-03-01T00:00:00Z',
      }),
    ).toThrow()
  })

  it('rejects non-integer amount_cents', () => {
    expect(() =>
      PatreonPledgeEventAttributesSchema.parse({
        date: '2024-03-01T00:00:00Z',
        amount_cents: 5.5,
      }),
    ).toThrow()
  })

  it('treats new fields as optional', () => {
    const minimal = {
      date: '2024-03-01T00:00:00Z',
      amount_cents: 500,
    }
    const result = PatreonPledgeEventAttributesSchema.parse(minimal)
    expect(result.tier_id).toBeUndefined()
    expect(result.tier_title).toBeUndefined()
    expect(result.pledge_payment_status).toBeUndefined()
  })
})

describe('PatreonGenericResourceSchema', () => {
  it('parses a generic resource with attributes', () => {
    const result = PatreonGenericResourceSchema.parse({
      type: 'pledge-event',
      id: 'evt_1',
      attributes: { date: '2024-01-01T00:00:00Z', amount_cents: 500 },
    })
    expect(result.type).toBe('pledge-event')
    expect(result.attributes?.amount_cents).toBe(500)
  })

  it('parses a resource without attributes', () => {
    const result = PatreonGenericResourceSchema.parse({
      type: 'user',
      id: 'usr_1',
    })
    expect(result.attributes).toBeUndefined()
  })
})

describe('PatreonPaginationCursorsSchema', () => {
  it('parses a cursor with next', () => {
    const result = PatreonPaginationCursorsSchema.parse({
      next: 'cursor_xyz',
    })
    expect(result.next).toBe('cursor_xyz')
  })

  it('parses a null cursor', () => {
    const result = PatreonPaginationCursorsSchema.parse({ next: null })
    expect(result.next).toBeNull()
  })

  it('parses missing cursor', () => {
    const result = PatreonPaginationCursorsSchema.parse({})
    expect(result.next).toBeUndefined()
  })
})

describe('PatreonPaginationSchema', () => {
  it('parses pagination with cursors and total', () => {
    const result = PatreonPaginationSchema.parse({
      cursors: { next: 'abc' },
      total: 250,
    })
    expect(result.cursors?.next).toBe('abc')
    expect(result.total).toBe(250)
  })

  it('parses empty pagination', () => {
    expect(PatreonPaginationSchema.parse({})).toEqual({})
  })
})

describe('PatreonMetaSchema', () => {
  it('parses meta with pagination', () => {
    const result = PatreonMetaSchema.parse({
      pagination: { cursors: { next: 'abc' }, total: 100 },
    })
    expect(result.pagination?.total).toBe(100)
  })

  it('parses empty meta', () => {
    expect(PatreonMetaSchema.parse({})).toEqual({})
  })
})

describe('PatreonMembersResponseSchema', () => {
  it('parses a complete response with members, included, and meta', () => {
    const response = {
      data: [
        {
          type: 'member' as const,
          id: 'mem_1',
          attributes: { full_name: 'Jane', email: 'jane@example.com' },
          relationships: {
            pledge_history: {
              data: [{ type: 'pledge-event', id: 'evt_1' }],
            },
            user: { data: { type: 'user', id: 'usr_1' } },
          },
        },
      ],
      included: [
        {
          type: 'pledge-event',
          id: 'evt_1',
          attributes: {
            date: '2024-03-01T00:00:00Z',
            amount_cents: 500,
            currency_code: 'USD',
            payment_status: 'Paid',
            type: 'subscription',
          },
        },
        {
          type: 'user',
          id: 'usr_1',
          attributes: { first_name: 'Jane', last_name: 'Doe' },
        },
      ],
      meta: {
        pagination: {
          cursors: { next: 'cursor_next' },
          total: 1,
        },
      },
    }

    const result = PatreonMembersResponseSchema.parse(response)
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe('mem_1')
    expect(result.included).toHaveLength(2)
    expect(result.meta?.pagination?.cursors?.next).toBe('cursor_next')
  })

  it('parses a response with no members', () => {
    const result = PatreonMembersResponseSchema.parse({ data: [] })
    expect(result.data).toEqual([])
  })

  it('parses a response with no included or meta', () => {
    const result = PatreonMembersResponseSchema.parse({
      data: [
        {
          type: 'member' as const,
          id: 'mem_1',
          attributes: {},
        },
      ],
    })
    expect(result.included).toBeUndefined()
    expect(result.meta).toBeUndefined()
  })

  it('rejects missing data field', () => {
    expect(() => PatreonMembersResponseSchema.parse({})).toThrow()
  })
})
