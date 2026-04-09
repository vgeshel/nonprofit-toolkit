/**
 * Transform Patreon API V2 pledge events to canonical DonationEvent.
 *
 * Patreon's V2 API does not expose a direct transactions endpoint. The
 * closest equivalent is the `pledge_history` relationship on Member
 * resources, which contains pledge_event records (subscription charges
 * and pledge state changes). We extract those events from the JSON:API
 * response, look up the donor identity from the parent Member, and
 * filter to only events with positive amounts (i.e., real money flow).
 *
 * Patreon does not support server-side date filtering, so date-range
 * filtering is applied here client-side.
 */
import type {
  DonationEvent,
  DonationStatus,
  Source,
} from '@donations-etl/types'
import { DateTime } from 'luxon'
import pino from 'pino'
import {
  PatreonPledgeEventAttributesSchema,
  type PatreonGenericResource,
  type PatreonMemberResource,
  type PatreonMembersResponse,
  type PatreonPledgeEventAttributes,
} from './schema'

const logger = pino({ name: 'patreon-transformer' })

const PATREON_SOURCE: Source = 'patreon'

/**
 * Resource type names for pledge events as they appear in Patreon's
 * `included` array. The JSON:API spec uses hyphens, but we accept
 * the underscore variant defensively as well.
 */
const PLEDGE_EVENT_TYPES = new Set(['pledge-event', 'pledge_event'])

/**
 * The only pledge-event `type` value that represents actual money flow.
 *
 * The other types (`pledge_start`, `pledge_upgrade`, `pledge_downgrade`,
 * `pledge_delete`) are pledge-lifecycle state changes — their
 * `amount_cents` reflects the pledge amount at that lifecycle moment,
 * not a charge that occurred. Live API inspection confirmed that the
 * lifecycle events for one pledge share an integer id, while each
 * recurring charge gets its own distinct `subscription:N` id.
 */
const SUBSCRIPTION_EVENT_TYPE = 'subscription'

/**
 * Map a Patreon `payment_status` value to the canonical DonationStatus.
 *
 * Patreon documents Paid, Declined, Pending, Refunded, Fraud, Other.
 * Live API inspection also surfaced `Deleted`, which represents a
 * recurring charge that was attempted but later marked deleted (e.g.
 * the patron left or their payment method was removed). No money was
 * collected, so we map it to `failed`.
 *
 * Unknown values default to `failed` (not `succeeded`) so that any
 * future unrecognized status is excluded from donation totals until
 * we explicitly classify it.
 */
export function mapPatreonPaymentStatus(
  status: string | null | undefined,
): DonationStatus {
  if (status === null || status === undefined) {
    return 'succeeded'
  }
  switch (status) {
    case 'Paid':
      return 'succeeded'
    case 'Pending':
      return 'pending'
    case 'Declined':
    case 'Fraud':
    case 'Other':
    case 'Deleted':
      return 'failed'
    case 'Refunded':
      return 'refunded'
    default:
      logger.warn(
        { status },
        'Unknown Patreon payment_status, defaulting to failed',
      )
      return 'failed'
  }
}

/**
 * Build a lookup of pledge_event_id -> owning member by walking each
 * member's `pledge_history` relationship.
 */
export function buildPledgeEventOwnerMap(
  members: PatreonMemberResource[],
): Map<string, PatreonMemberResource> {
  const map = new Map<string, PatreonMemberResource>()
  for (const member of members) {
    const pledgeIds = member.relationships?.pledge_history?.data ?? []
    for (const ref of pledgeIds) {
      map.set(ref.id, member)
    }
  }
  return map
}

/**
 * Extract pledge event resources from the `included` array.
 *
 * Each element is reparsed against the strict pledge-event attribute
 * schema; entries that fail validation are skipped with a warning.
 */
export function extractPledgeEvents(
  included: PatreonGenericResource[] | undefined,
): { id: string; attributes: PatreonPledgeEventAttributes }[] {
  if (!included) return []
  const events: { id: string; attributes: PatreonPledgeEventAttributes }[] = []
  for (const resource of included) {
    if (!PLEDGE_EVENT_TYPES.has(resource.type)) continue
    const result = PatreonPledgeEventAttributesSchema.safeParse(
      resource.attributes,
    )
    if (!result.success) {
      logger.warn(
        { id: resource.id, error: result.error.message },
        'Skipping pledge event with invalid attributes',
      )
      continue
    }
    events.push({ id: resource.id, attributes: result.data })
  }
  return events
}

/**
 * Determine whether a pledge event falls inside the inclusive `from` /
 * exclusive `to` window. Invalid date strings are excluded.
 */
export function isWithinDateRange(
  date: string,
  from: DateTime,
  to: DateTime,
): boolean {
  const eventDate = DateTime.fromISO(date, { zone: 'utc' })
  if (!eventDate.isValid) {
    logger.warn({ date }, 'Skipping pledge event with invalid date')
    return false
  }
  return eventDate >= from && eventDate < to
}

/**
 * Transform a single pledge event + its owning member into a DonationEvent.
 */
export function transformPatreonPledgeEvent(
  pledgeEventId: string,
  attrs: PatreonPledgeEventAttributes,
  member: PatreonMemberResource | undefined,
  runId: string,
): DonationEvent {
  const amountCents = attrs.amount_cents
  const currency = (attrs.currency_code ?? 'USD').toUpperCase()
  const memberAttrs = member?.attributes ?? {}

  return {
    source: PATREON_SOURCE,
    external_id: pledgeEventId,
    event_ts: attrs.date,
    created_at: attrs.date,
    ingested_at: DateTime.utc().toISO(),
    amount_cents: amountCents,
    fee_cents: 0, // Patreon charges 5-12% platform fees but V2 API does not expose per-transaction fees
    net_amount_cents: amountCents,
    currency,
    donor_name: memberAttrs.full_name ?? null,
    payer_name: null,
    donor_email: memberAttrs.email ?? null,
    donor_phone: null,
    donor_address: null,
    status: mapPatreonPaymentStatus(attrs.payment_status),
    payment_method: 'patreon',
    description: attrs.type ?? null,
    attribution: null,
    attribution_human: null,
    source_metadata: {
      pledge_event_type: attrs.type ?? null,
      payment_status: attrs.payment_status ?? null,
      currency_code: attrs.currency_code ?? null,
      tier_id: attrs.tier_id ?? null,
      tier_title: attrs.tier_title ?? null,
      member_id: member?.id ?? null,
      patron_status: memberAttrs.patron_status ?? null,
      lifetime_support_cents: memberAttrs.lifetime_support_cents ?? null,
    },
    run_id: runId,
  }
}

/**
 * Transform a full Patreon members response into DonationEvents.
 *
 * Steps:
 *  1. Build the pledge_event -> member lookup map.
 *  2. Extract pledge events from the `included` array.
 *  3. Keep only `type === 'subscription'` events (the only ones that
 *     represent actual money flow — see SUBSCRIPTION_EVENT_TYPE).
 *  4. Drop zero-amount events defensively.
 *  5. Filter by the date range (Patreon does not filter server-side).
 *  6. Transform each remaining event.
 */
export function transformPatreonMembersResponse(
  response: PatreonMembersResponse,
  runId: string,
  from: DateTime,
  to: DateTime,
): DonationEvent[] {
  const ownerMap = buildPledgeEventOwnerMap(response.data)
  const events = extractPledgeEvents(response.included)

  return events
    .filter((e) => e.attributes.type === SUBSCRIPTION_EVENT_TYPE)
    .filter((e) => e.attributes.amount_cents > 0)
    .filter((e) => isWithinDateRange(e.attributes.date, from, to))
    .map((e) =>
      transformPatreonPledgeEvent(
        e.id,
        e.attributes,
        ownerMap.get(e.id),
        runId,
      ),
    )
}
