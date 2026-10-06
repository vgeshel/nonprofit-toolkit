/**
 * Givebutter API response schemas.
 *
 * Based on: https://docs.givebutter.com/reference
 * Validates responses using Zod for type safety.
 */
import { z } from 'zod'

/**
 * Known transaction status values.
 * We accept any string to be resilient to API changes.
 */
export const KNOWN_STATUSES = [
  'succeeded',
  'authorized',
  'failed',
  'cancelled',
] as const

export type GivebutterTransactionStatus = string

/**
 * Address fields from Givebutter.
 */
export const GivebutterAddressSchema = z.object({
  address_1: z.string().nullable(),
  address_2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipcode: z.string().nullable(),
  country: z.string().nullable(),
})

export type GivebutterAddress = z.infer<typeof GivebutterAddressSchema>

/**
 * Individual transaction from Givebutter Transactions API.
 */
export const GivebutterTransactionSchema = z.object({
  // Core identifiers
  // API returns id as string or number depending on version
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  number: z.string(), // Reference number

  // Campaign info
  campaign_id: z.number().nullable(),
  campaign_code: z.string().nullable(),

  // Donor info
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: GivebutterAddressSchema.nullable(),

  // Transaction details
  // Accept any string status - handle mapping in transformer
  status: z.string(),
  method: z.string(), // card, paypal, venmo, check, cash, ach
  amount: z.number(), // In dollars (e.g., 10.50)
  fee: z.number(), // In dollars
  // API returns fee_covered as boolean or number (0/1)
  fee_covered: z.union([z.boolean(), z.number()]).transform((v) => Boolean(v)),
  donated: z.number(), // Net donation amount in dollars
  payout: z.number(), // Amount to be paid out in dollars
  currency: z.string(),

  // Recurrence: plan_id groups a donor's charges under one recurring plan and
  // is null exactly when is_recurring is false.
  is_recurring: z.boolean(),
  plan_id: z.string().nullable(),

  // Timestamps
  transacted_at: z.string(),
  created_at: z.string(),
})

export type GivebutterTransaction = z.infer<typeof GivebutterTransactionSchema>

/**
 * Pagination links from Givebutter API.
 */
export const GivebutterLinksSchema = z.object({
  first: z.string().nullable().optional(),
  last: z.string().nullable().optional(),
  prev: z.string().nullable().optional(),
  next: z.string().nullable(),
})

export type GivebutterLinks = z.infer<typeof GivebutterLinksSchema>

/**
 * Pagination metadata from Givebutter API.
 */
export const GivebutterMetaSchema = z.object({
  current_page: z.number(),
  last_page: z.number(),
  per_page: z.number(),
  total: z.number(),
  from: z.number().nullable().optional(),
  to: z.number().nullable().optional(),
  path: z.string().optional(),
})

export type GivebutterMeta = z.infer<typeof GivebutterMetaSchema>

/**
 * Full response from Givebutter Transactions API.
 */
export const GivebutterTransactionResponseSchema = z.object({
  data: z.array(GivebutterTransactionSchema),
  links: GivebutterLinksSchema,
  meta: GivebutterMetaSchema,
})

export type GivebutterTransactionResponse = z.infer<
  typeof GivebutterTransactionResponseSchema
>
