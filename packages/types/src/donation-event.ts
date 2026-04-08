/**
 * Canonical DonationEvent schema and types.
 *
 * This is the normalized schema that all donation sources are transformed into.
 * The MERGE key is (source, external_id) which uniquely identifies a donation.
 */
import { z } from 'zod'

/**
 * Supported donation sources (Milestone 1).
 */
export const SourceEnum = z.enum([
  'mercury',
  'paypal',
  'givebutter',
  'check_deposits',
  'funraise',
  'venmo',
  'wise',
  'patreon',
])
export type Source = z.infer<typeof SourceEnum>

/**
 * Donation transaction status.
 */
export const DonationStatusEnum = z.enum([
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
])
export type DonationStatus = z.infer<typeof DonationStatusEnum>

/**
 * Donor address structure.
 * All fields are nullable since address info may be incomplete.
 */
export const DonorAddressSchema = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().length(2).nullable(), // ISO 3166-1 alpha-2
})
export type DonorAddress = z.infer<typeof DonorAddressSchema>

/**
 * ISO 8601 datetime string validator.
 * Uses Zod v4's iso.datetime() for proper validation.
 */
const isoDatetime = z.iso.datetime({ message: 'must be ISO 8601 datetime' })

/**
 * Canonical donation event schema.
 *
 * Design decisions:
 * - Amounts in cents (integers) to avoid floating-point precision issues
 * - MERGE key: (source, external_id) for deduplication
 * - Nullable strings for donor info (not all sources provide all fields)
 * - source_metadata captures source-specific fields as JSONB
 */
export const DonationEventSchema = z.object({
  // === Identity (MERGE key) ===
  source: SourceEnum,
  external_id: z.string().min(1, 'external_id is required'),

  // === Timestamps (all UTC ISO 8601) ===
  event_ts: isoDatetime,
  created_at: isoDatetime,
  ingested_at: isoDatetime,

  // === Amounts (cents to avoid floating point) ===
  amount_cents: z.int({ message: 'amount_cents must be an integer' }),
  fee_cents: z.int({ message: 'fee_cents must be an integer' }).default(0),
  net_amount_cents: z.int({ message: 'net_amount_cents must be an integer' }),
  currency: z
    .string()
    .length(3, 'currency must be 3-letter ISO code')
    .default('USD'),

  // === Donor Information ===
  donor_name: z.string().nullable(),
  payer_name: z.string().nullable(), // e.g., "Vanguard", "Schwab Charitable" for DAF checks
  donor_email: z
    .email({ message: 'donor_email must be valid email' })
    .nullable(),
  donor_phone: z.string().nullable(),
  donor_address: DonorAddressSchema.nullable(),

  // === Transaction Metadata ===
  status: DonationStatusEnum,
  payment_method: z.string().nullable(), // card, ach, wire, check, venmo, etc.
  description: z.string().nullable(),
  attribution: z.string().nullable(),
  attribution_human: z.string().nullable(),

  // === Source-Specific Data ===
  source_metadata: z.record(z.string(), z.unknown()),

  // === ETL Metadata ===
  run_id: z.uuid({ message: 'run_id must be a valid UUID' }),
})

export type DonationEvent = z.infer<typeof DonationEventSchema>

/**
 * Input type for creating a DonationEvent.
 * ingested_at is optional (defaults to current time).
 */
export type DonationEventInput = Omit<
  DonationEvent,
  'ingested_at' | 'fee_cents' | 'currency'
> & {
  ingested_at?: string
  fee_cents?: number
  currency?: string
}

/**
 * Parse and validate a donation event.
 * Returns the validated event or throws a ZodError.
 */
export function parseDonationEvent(input: unknown): DonationEvent {
  return DonationEventSchema.parse(input)
}

/**
 * Safely parse a donation event without throwing.
 * Returns a Zod parse result with success/error.
 */
export function safeParseDonationEvent(input: unknown) {
  return DonationEventSchema.safeParse(input)
}

/**
 * Convert dollars to cents.
 * Rounds to nearest integer to handle floating-point precision.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

/**
 * Convert cents to dollars.
 */
export function centsToDollars(cents: number): number {
  return cents / 100
}
