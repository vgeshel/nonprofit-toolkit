/**
 * Tests for Patreon transformer functions.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type {
  PatreonGenericResource,
  PatreonMemberResource,
  PatreonMembersResponse,
} from '../../src/patreon/schema'
import {
  buildPledgeEventOwnerMap,
  extractPledgeEvents,
  isWithinDateRange,
  mapPatreonPaymentStatus,
  transformPatreonMembersResponse,
  transformPatreonPledgeEvent,
} from '../../src/patreon/transformer'

const RUN_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('mapPatreonPaymentStatus', () => {
  it('maps "Paid" to "succeeded"', () => {
    expect(mapPatreonPaymentStatus('Paid')).toBe('succeeded')
  })

  it('maps "Pending" to "pending"', () => {
    expect(mapPatreonPaymentStatus('Pending')).toBe('pending')
  })

  it('maps "Declined" to "failed"', () => {
    expect(mapPatreonPaymentStatus('Declined')).toBe('failed')
  })

  it('maps "Fraud" to "failed"', () => {
    expect(mapPatreonPaymentStatus('Fraud')).toBe('failed')
  })

  it('maps "Other" to "failed"', () => {
    expect(mapPatreonPaymentStatus('Other')).toBe('failed')
  })

  it('maps "Deleted" to "failed" (subscription record cleaned up by Patreon)', () => {
    expect(mapPatreonPaymentStatus('Deleted')).toBe('failed')
  })

  it('maps "Refunded" to "refunded"', () => {
    expect(mapPatreonPaymentStatus('Refunded')).toBe('refunded')
  })

  it('defaults null to "succeeded"', () => {
    expect(mapPatreonPaymentStatus(null)).toBe('succeeded')
  })

  it('defaults undefined to "succeeded"', () => {
    expect(mapPatreonPaymentStatus(undefined)).toBe('succeeded')
  })

  it('defaults unknown values to "failed" (conservative — exclude from totals)', () => {
    expect(mapPatreonPaymentStatus('SomethingNew')).toBe('failed')
  })
})

describe('buildPledgeEventOwnerMap', () => {
  it('maps each pledge_event id to its owning member', () => {
    const members: PatreonMemberResource[] = [
      {
        type: 'member',
        id: 'mem_1',
        attributes: {},
        relationships: {
          pledge_history: {
            data: [
              { type: 'pledge-event', id: 'evt_1' },
              { type: 'pledge-event', id: 'evt_2' },
            ],
          },
        },
      },
      {
        type: 'member',
        id: 'mem_2',
        attributes: {},
        relationships: {
          pledge_history: {
            data: [{ type: 'pledge-event', id: 'evt_3' }],
          },
        },
      },
    ]

    const map = buildPledgeEventOwnerMap(members)
    expect(map.size).toBe(3)
    expect(map.get('evt_1')?.id).toBe('mem_1')
    expect(map.get('evt_2')?.id).toBe('mem_1')
    expect(map.get('evt_3')?.id).toBe('mem_2')
  })

  it('handles members with no relationships', () => {
    const members: PatreonMemberResource[] = [
      { type: 'member', id: 'mem_1', attributes: {} },
    ]
    const map = buildPledgeEventOwnerMap(members)
    expect(map.size).toBe(0)
  })

  it('handles members with empty pledge_history', () => {
    const members: PatreonMemberResource[] = [
      {
        type: 'member',
        id: 'mem_1',
        attributes: {},
        relationships: { pledge_history: { data: [] } },
      },
    ]
    const map = buildPledgeEventOwnerMap(members)
    expect(map.size).toBe(0)
  })

  it('returns empty map for empty member list', () => {
    expect(buildPledgeEventOwnerMap([]).size).toBe(0)
  })
})

describe('extractPledgeEvents', () => {
  it('extracts pledge-event resources from included', () => {
    const included: PatreonGenericResource[] = [
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
        attributes: { first_name: 'Jane' },
      },
    ]
    const result = extractPledgeEvents(included)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('evt_1')
    expect(result[0]?.attributes.amount_cents).toBe(500)
  })

  it('also accepts pledge_event with underscore type', () => {
    const included: PatreonGenericResource[] = [
      {
        type: 'pledge_event',
        id: 'evt_1',
        attributes: { date: '2024-03-01T00:00:00Z', amount_cents: 500 },
      },
    ]
    const result = extractPledgeEvents(included)
    expect(result).toHaveLength(1)
  })

  it('skips events whose attributes fail validation', () => {
    const included: PatreonGenericResource[] = [
      {
        type: 'pledge-event',
        id: 'evt_bad',
        attributes: { amount_cents: 500 }, // missing date
      },
      {
        type: 'pledge-event',
        id: 'evt_good',
        attributes: { date: '2024-03-01T00:00:00Z', amount_cents: 500 },
      },
    ]
    const result = extractPledgeEvents(included)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('evt_good')
  })

  it('returns empty when included is undefined', () => {
    expect(extractPledgeEvents(undefined)).toEqual([])
  })

  it('returns empty when included is empty', () => {
    expect(extractPledgeEvents([])).toEqual([])
  })
})

describe('isWithinDateRange', () => {
  const from = DateTime.fromISO('2024-03-01T00:00:00Z', { zone: 'utc' })
  const to = DateTime.fromISO('2024-04-01T00:00:00Z', { zone: 'utc' })

  it('includes a date inside the range', () => {
    expect(isWithinDateRange('2024-03-15T10:00:00Z', from, to)).toBe(true)
  })

  it('includes the inclusive lower bound', () => {
    expect(isWithinDateRange('2024-03-01T00:00:00Z', from, to)).toBe(true)
  })

  it('excludes the exclusive upper bound', () => {
    expect(isWithinDateRange('2024-04-01T00:00:00Z', from, to)).toBe(false)
  })

  it('excludes a date before the range', () => {
    expect(isWithinDateRange('2024-02-28T23:59:59Z', from, to)).toBe(false)
  })

  it('excludes a date after the range', () => {
    expect(isWithinDateRange('2024-05-01T00:00:00Z', from, to)).toBe(false)
  })

  it('excludes invalid date strings', () => {
    expect(isWithinDateRange('not-a-date', from, to)).toBe(false)
  })
})

describe('transformPatreonPledgeEvent', () => {
  const baseAttrs = {
    date: '2024-03-15T10:30:00Z',
    amount_cents: 500,
    currency_code: 'usd',
    payment_status: 'Paid',
    type: 'subscription',
    tier_id: '8770500',
    tier_title: 'One tourniquet per month',
  }

  const baseMember: PatreonMemberResource = {
    type: 'member',
    id: 'mem_42',
    attributes: {
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      patron_status: 'active_patron',
      lifetime_support_cents: 12000,
    },
  }

  it('transforms a typical subscription charge', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      baseAttrs,
      baseMember,
      RUN_ID,
    )

    expect(result.source).toBe('patreon')
    expect(result.external_id).toBe('evt_1')
    expect(result.event_ts).toBe('2024-03-15T10:30:00Z')
    expect(result.created_at).toBe('2024-03-15T10:30:00Z')
    expect(result.amount_cents).toBe(500)
    expect(result.fee_cents).toBe(0)
    expect(result.net_amount_cents).toBe(500)
    expect(result.currency).toBe('USD')
    expect(result.donor_name).toBe('Jane Doe')
    expect(result.donor_email).toBe('jane@example.com')
    expect(result.donor_phone).toBeNull()
    expect(result.donor_address).toBeNull()
    expect(result.payer_name).toBeNull()
    expect(result.status).toBe('succeeded')
    expect(result.payment_method).toBe('patreon')
    expect(result.description).toBe('subscription')
    expect(result.attribution).toBeNull()
    expect(result.attribution_human).toBeNull()
    expect(result.run_id).toBe(RUN_ID)
  })

  it('defaults missing currency to USD', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      { ...baseAttrs, currency_code: null },
      baseMember,
      RUN_ID,
    )
    expect(result.currency).toBe('USD')
  })

  it('upcases lowercase currency codes', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      { ...baseAttrs, currency_code: 'eur' },
      baseMember,
      RUN_ID,
    )
    expect(result.currency).toBe('EUR')
  })

  it('handles missing donor info from member', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      baseAttrs,
      { type: 'member', id: 'mem_42', attributes: {} },
      RUN_ID,
    )
    expect(result.donor_name).toBeNull()
    expect(result.donor_email).toBeNull()
  })

  it('handles a missing member entirely (orphan event)', () => {
    const result = transformPatreonPledgeEvent(
      'evt_orphan',
      baseAttrs,
      undefined,
      RUN_ID,
    )
    expect(result.donor_name).toBeNull()
    expect(result.donor_email).toBeNull()
    expect(result.source_metadata.member_id).toBeNull()
    expect(result.source_metadata.patron_status).toBeNull()
    expect(result.source_metadata.lifetime_support_cents).toBeNull()
    expect(result.source_metadata.tier_id).toBe('8770500')
  })

  it('passes through pledge_event_type and tier info to source_metadata', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      baseAttrs,
      baseMember,
      RUN_ID,
    )
    expect(result.source_metadata).toEqual({
      pledge_event_type: 'subscription',
      payment_status: 'Paid',
      currency_code: 'usd',
      tier_id: '8770500',
      tier_title: 'One tourniquet per month',
      member_id: 'mem_42',
      patron_status: 'active_patron',
      lifetime_support_cents: 12000,
    })
  })

  it('emits null tier fields in source_metadata when missing', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      { ...baseAttrs, tier_id: null, tier_title: null },
      baseMember,
      RUN_ID,
    )
    expect(result.source_metadata.tier_id).toBeNull()
    expect(result.source_metadata.tier_title).toBeNull()
  })

  it('uses null description when type is missing', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      { ...baseAttrs, type: null },
      baseMember,
      RUN_ID,
    )
    expect(result.description).toBeNull()
  })

  it('emits null payment_status in source_metadata when missing', () => {
    const result = transformPatreonPledgeEvent(
      'evt_1',
      { ...baseAttrs, payment_status: null },
      baseMember,
      RUN_ID,
    )
    expect(result.source_metadata.payment_status).toBeNull()
  })

  it('reflects payment status mapping', () => {
    const declined = transformPatreonPledgeEvent(
      'evt_2',
      { ...baseAttrs, payment_status: 'Declined' },
      baseMember,
      RUN_ID,
    )
    expect(declined.status).toBe('failed')

    const refunded = transformPatreonPledgeEvent(
      'evt_3',
      { ...baseAttrs, payment_status: 'Refunded' },
      baseMember,
      RUN_ID,
    )
    expect(refunded.status).toBe('refunded')
  })

  it('sets ingested_at to current time', () => {
    const before = DateTime.utc()
    const result = transformPatreonPledgeEvent(
      'evt_1',
      baseAttrs,
      baseMember,
      RUN_ID,
    )
    const after = DateTime.utc()
    const ingestedAt = DateTime.fromISO(result.ingested_at, { zone: 'utc' })
    expect(ingestedAt >= before).toBe(true)
    expect(ingestedAt <= after).toBe(true)
  })
})

describe('transformPatreonMembersResponse', () => {
  const from = DateTime.fromISO('2024-03-01T00:00:00Z', { zone: 'utc' })
  const to = DateTime.fromISO('2024-04-01T00:00:00Z', { zone: 'utc' })

  function makeResponse(): PatreonMembersResponse {
    return {
      data: [
        {
          type: 'member',
          id: 'mem_1',
          attributes: { full_name: 'Jane Doe', email: 'jane@example.com' },
          relationships: {
            pledge_history: {
              data: [
                { type: 'pledge-event', id: 'subscription:in_range' },
                { type: 'pledge-event', id: 'subscription:before_range' },
                { type: 'pledge-event', id: 'pledge_delete:state_change' },
                { type: 'pledge-event', id: 'pledge_start:another_change' },
                { type: 'pledge-event', id: 'pledge_upgrade:up' },
                { type: 'pledge-event', id: 'pledge_downgrade:down' },
              ],
            },
          },
        },
        {
          type: 'member',
          id: 'mem_2',
          attributes: { full_name: 'John Roe' },
          relationships: {
            pledge_history: {
              data: [{ type: 'pledge-event', id: 'subscription:other_member' }],
            },
          },
        },
      ],
      included: [
        {
          type: 'pledge-event',
          id: 'subscription:in_range',
          attributes: {
            date: '2024-03-15T10:00:00Z',
            amount_cents: 500,
            currency_code: 'USD',
            payment_status: 'Paid',
            type: 'subscription',
          },
        },
        {
          type: 'pledge-event',
          id: 'subscription:before_range',
          attributes: {
            date: '2024-02-15T10:00:00Z',
            amount_cents: 500,
            currency_code: 'USD',
            payment_status: 'Paid',
            type: 'subscription',
          },
        },
        // pledge_delete inside the date range with non-zero amount —
        // must be filtered out (state-change metadata, not money).
        {
          type: 'pledge-event',
          id: 'pledge_delete:state_change',
          attributes: {
            date: '2024-03-20T10:00:00Z',
            amount_cents: 3000,
            currency_code: 'USD',
            payment_status: null,
            pledge_payment_status: 'valid',
            type: 'pledge_delete',
          },
        },
        {
          type: 'pledge-event',
          id: 'pledge_start:another_change',
          attributes: {
            date: '2024-03-21T10:00:00Z',
            amount_cents: 5000,
            currency_code: 'USD',
            payment_status: null,
            pledge_payment_status: 'valid',
            type: 'pledge_start',
          },
        },
        {
          type: 'pledge-event',
          id: 'pledge_upgrade:up',
          attributes: {
            date: '2024-03-22T10:00:00Z',
            amount_cents: 7000,
            currency_code: 'USD',
            payment_status: null,
            pledge_payment_status: 'valid',
            type: 'pledge_upgrade',
          },
        },
        {
          type: 'pledge-event',
          id: 'pledge_downgrade:down',
          attributes: {
            date: '2024-03-23T10:00:00Z',
            amount_cents: 4000,
            currency_code: 'USD',
            payment_status: null,
            pledge_payment_status: 'valid',
            type: 'pledge_downgrade',
          },
        },
        {
          type: 'pledge-event',
          id: 'subscription:other_member',
          attributes: {
            date: '2024-03-25T10:00:00Z',
            amount_cents: 1000,
            currency_code: 'USD',
            payment_status: 'Paid',
            type: 'subscription',
          },
        },
      ],
    }
  }

  it('returns only in-range subscription events, dropping state changes', () => {
    const events = transformPatreonMembersResponse(
      makeResponse(),
      RUN_ID,
      from,
      to,
    )
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.external_id).sort()).toEqual([
      'subscription:in_range',
      'subscription:other_member',
    ])
  })

  it('drops pledge_delete events even with non-zero amounts', () => {
    const events = transformPatreonMembersResponse(
      makeResponse(),
      RUN_ID,
      from,
      to,
    )
    expect(
      events.find((e) => e.external_id === 'pledge_delete:state_change'),
    ).toBeUndefined()
  })

  it('drops pledge_start, pledge_upgrade, pledge_downgrade events', () => {
    const events = transformPatreonMembersResponse(
      makeResponse(),
      RUN_ID,
      from,
      to,
    )
    const droppedIds = events.map((e) => e.external_id)
    expect(droppedIds).not.toContain('pledge_start:another_change')
    expect(droppedIds).not.toContain('pledge_upgrade:up')
    expect(droppedIds).not.toContain('pledge_downgrade:down')
  })

  it('attaches the correct donor info to each event', () => {
    const events = transformPatreonMembersResponse(
      makeResponse(),
      RUN_ID,
      from,
      to,
    )
    const inRange = events.find(
      (e) => e.external_id === 'subscription:in_range',
    )
    const otherMember = events.find(
      (e) => e.external_id === 'subscription:other_member',
    )
    expect(inRange?.donor_name).toBe('Jane Doe')
    expect(inRange?.donor_email).toBe('jane@example.com')
    expect(otherMember?.donor_name).toBe('John Roe')
    expect(otherMember?.donor_email).toBeNull()
  })

  it('returns empty when there are no members', () => {
    const events = transformPatreonMembersResponse(
      { data: [] },
      RUN_ID,
      from,
      to,
    )
    expect(events).toEqual([])
  })

  it('returns empty when included is missing', () => {
    const events = transformPatreonMembersResponse(
      {
        data: [
          {
            type: 'member',
            id: 'mem_1',
            attributes: {},
            relationships: {
              pledge_history: {
                data: [{ type: 'pledge-event', id: 'evt_1' }],
              },
            },
          },
        ],
      },
      RUN_ID,
      from,
      to,
    )
    expect(events).toEqual([])
  })

  it('handles events whose member is not in this page (orphan)', () => {
    const events = transformPatreonMembersResponse(
      {
        data: [], // No members but pledge events still included
        included: [
          {
            type: 'pledge-event',
            id: 'evt_orphan',
            attributes: {
              date: '2024-03-15T10:00:00Z',
              amount_cents: 500,
              currency_code: 'USD',
              payment_status: 'Paid',
              type: 'subscription',
            },
          },
        ],
      },
      RUN_ID,
      from,
      to,
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.donor_name).toBeNull()
    expect(events[0]?.source_metadata.member_id).toBeNull()
  })
})
