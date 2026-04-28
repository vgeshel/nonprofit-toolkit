/**
 * Entity types: the nonprofit being managed and its per-jurisdiction IDs.
 *
 * `EntityIdentifiers` carries the IDs that go into Secret Manager (one logical
 * record). `Entity` carries the non-secret attributes that go into the
 * `compliance.entity` BigQuery table.
 */
import { z } from 'zod'

/**
 * Strip `{ value: string }` BigQueryTimestamp wrappers down to a string.
 *
 * BigQuery returns TIMESTAMP columns as `{ value: '...' }` objects. Schemas
 * that read entity rows back from BQ run timestamps through this preprocess
 * helper so consumers get a plain ISO string.
 */
const extractTimestampValue = (val: unknown): unknown => {
  if (
    val !== null &&
    typeof val === 'object' &&
    'value' in val &&
    typeof val.value === 'string'
  ) {
    return val.value
  }
  return val
}

/**
 * EIN: 9 digits with an optional dash after the first two (canonical IRS form).
 */
const EinSchema = z
  .string()
  .regex(
    /^\d{2}-?\d{7}$/,
    'EIN must be 9 digits with optional dash (NN-NNNNNNN)',
  )

/**
 * California Secretary of State entity number. Preserve the printed string:
 * legacy corporations commonly use `C` + seven digits, older LLC/LP records
 * use numeric identifiers, and newly registered entities can use a 12-character
 * `B...` identifier.
 */
const CaSosEntityNumberSchema = z
  .string()
  .regex(
    /^(?:C\d{7}|\d{7,12}|B[A-Za-z0-9]{11})$/,
    'CA SOS entity number must be C + 7 digits, 7-12 digits, or a 12-character B-prefixed id',
  )

/**
 * California Attorney General Registry of Charitable Trusts charity number.
 *
 * Conventionally `CTNNNNNNN`; older records may be six-digit numbers with
 * leading zeroes. Optional during Phase 1 onboarding.
 */
const CaAgCharityNumberSchema = z
  .string()
  .regex(
    /^(?:CT\d{6,7}|\d{6})$/,
    'CA AG charity number must be CT + digits or an older six-digit number',
  )

const CaFtbEntityIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9-]+$/, 'CA FTB entity id must be alphanumeric')

/**
 * Per-jurisdiction identifiers. Jurisdictions added in later phases plug new
 * keys in here. Unknown keys are rejected so typos surface immediately.
 */
export const EntityIdentifiersSchema = z
  .object({
    'us-federal': z.object({ ein: EinSchema }).optional(),
    'us-ca': z
      .object({
        sosEntityNumber: CaSosEntityNumberSchema,
        agCharityNumber: CaAgCharityNumberSchema.optional(),
        ftbEntityId: CaFtbEntityIdSchema.optional(),
        ftbEntityName: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict()

export type EntityIdentifiers = z.infer<typeof EntityIdentifiersSchema>

/**
 * Non-secret entity attributes — the row stored in `compliance.entity`.
 */
export const EntitySchema = z.object({
  legal_name: z.string().min(1),
  state_of_incorporation: z.string().length(2),
  fiscal_year_end_month: z.coerce.number().int().min(1).max(12),
  fiscal_year_end_day: z.coerce.number().int().min(1).max(31),
  formation_date: z.preprocess(
    extractTimestampValue,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'formation_date must be YYYY-MM-DD'),
  ),
  mailing_address_line1: z.string().min(1),
  mailing_address_line2: z.string().nullable(),
  mailing_address_city: z.string().min(1),
  mailing_address_region: z.string().length(2),
  mailing_address_postal_code: z.string().min(1),
  mailing_address_country: z.string().length(2),
  updated_at: z.preprocess(extractTimestampValue, z.string().min(1)),
})

export type Entity = z.infer<typeof EntitySchema>

/**
 * Helper exposed for storage-layer conversions / testing.
 */
export const _internal = { extractTimestampValue }
