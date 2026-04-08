/**
 * Patreon API V2 response Zod schemas.
 *
 * Patreon V2 returns JSON:API formatted responses with `data`, `included`,
 * `meta`, and `links`. We model the resources we care about (member, user,
 * pledge-event) and treat `included` as a permissive generic resource list
 * since other resource types may appear that we don't use.
 *
 * Reference: https://docs.patreon.com/?javascript#apiv2
 */
import { z } from 'zod'

/**
 * JSON:API resource identifier (type + id).
 */
export const PatreonResourceIdSchema = z.object({
  type: z.string(),
  id: z.string(),
})

export type PatreonResourceId = z.infer<typeof PatreonResourceIdSchema>

/**
 * Member attributes from Patreon V2.
 *
 * Many fields are optional because they require specific scopes
 * (e.g., email requires `campaigns.members[email]`) or specific
 * `fields[member]=...` query params.
 */
export const PatreonMemberAttributesSchema = z.object({
  full_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  patron_status: z.string().nullable().optional(),
  last_charge_date: z.string().nullable().optional(),
  last_charge_status: z.string().nullable().optional(),
  lifetime_support_cents: z.number().int().nullable().optional(),
  currently_entitled_amount_cents: z.number().int().nullable().optional(),
})

export type PatreonMemberAttributes = z.infer<
  typeof PatreonMemberAttributesSchema
>

/**
 * Member relationship structure (relationship to a single resource).
 */
const SingleRelationshipSchema = z.object({
  data: PatreonResourceIdSchema.nullable(),
})

/**
 * Member relationship structure (relationship to a collection).
 */
const CollectionRelationshipSchema = z.object({
  data: z.array(PatreonResourceIdSchema),
})

/**
 * Member resource (member of a campaign).
 */
export const PatreonMemberResourceSchema = z.object({
  type: z.literal('member'),
  id: z.string(),
  attributes: PatreonMemberAttributesSchema,
  relationships: z
    .object({
      pledge_history: CollectionRelationshipSchema.optional(),
      user: SingleRelationshipSchema.optional(),
      campaign: SingleRelationshipSchema.optional(),
    })
    .optional(),
})

export type PatreonMemberResource = z.infer<typeof PatreonMemberResourceSchema>

/**
 * Pledge event attributes from Patreon V2.
 *
 * Patreon emits multiple `type` values, but only `subscription` represents
 * actual money flow. The state-change types (`pledge_start`, `pledge_upgrade`,
 * `pledge_downgrade`, `pledge_delete`) describe pledge-lifecycle metadata —
 * `amount_cents` on those events reflects the *amount of the pledge being
 * created/changed/cancelled*, not a new charge. Live API inspection
 * confirmed that lifecycle events for the same pledge share an integer id
 * (e.g. `pledge_start:124824869` and `pledge_delete:124824869` describe the
 * same underlying pledge), and that recurring charges are emitted as
 * separate `subscription:N` events.
 *
 * `payment_status` is also exclusive to `subscription` events; state-change
 * events use `pledge_payment_status` instead, which describes whether the
 * pledge was valid/declined at the time of the lifecycle event.
 *
 * The transformer filters to `type === 'subscription'`. Schema-wise we
 * accept all fields permissively so the schema does not break if Patreon
 * adds new types or status values.
 */
export const PatreonPledgeEventAttributesSchema = z.object({
  date: z.string(),
  amount_cents: z.number().int(),
  currency_code: z.string().nullable().optional(),
  payment_status: z.string().nullable().optional(),
  pledge_payment_status: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  tier_id: z.string().nullable().optional(),
  tier_title: z.string().nullable().optional(),
})

export type PatreonPledgeEventAttributes = z.infer<
  typeof PatreonPledgeEventAttributesSchema
>

/**
 * Generic JSON:API resource for the `included` array.
 *
 * The included array contains heterogeneous resource types
 * (pledge-event, user, etc.). We accept any type and parse the
 * attributes lazily in the transformer.
 */
export const PatreonGenericResourceSchema = z.object({
  type: z.string(),
  id: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})

export type PatreonGenericResource = z.infer<
  typeof PatreonGenericResourceSchema
>

/**
 * Pagination cursors object.
 */
export const PatreonPaginationCursorsSchema = z.object({
  next: z.string().nullable().optional(),
})

/**
 * Pagination metadata.
 */
export const PatreonPaginationSchema = z.object({
  cursors: PatreonPaginationCursorsSchema.optional(),
  total: z.number().int().nullable().optional(),
})

/**
 * Top-level meta object.
 */
export const PatreonMetaSchema = z.object({
  pagination: PatreonPaginationSchema.optional(),
})

/**
 * Top-level response from `/api/oauth2/v2/campaigns/{id}/members`.
 */
export const PatreonMembersResponseSchema = z.object({
  data: z.array(PatreonMemberResourceSchema),
  included: z.array(PatreonGenericResourceSchema).optional(),
  meta: PatreonMetaSchema.optional(),
})

export type PatreonMembersResponse = z.infer<
  typeof PatreonMembersResponseSchema
>
