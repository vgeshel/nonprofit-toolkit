/**
 * Backend for the `compliance-onboard` skill.
 *
 * The skill markdown describes the conversational flow; this module is the
 * pure logic the skill calls once it has collected user answers. Splitting
 * "ask the user" from "do the work" keeps the work testable.
 */
import type { Result, ResultAsync } from 'neverthrow'
import { err, errAsync, ok } from 'neverthrow'
import { z } from 'zod'
import type { EntityAccessor, EntityInput } from '../state/bq-entity.ts'
import { ensureComplianceSchema } from '../state/ensure-schema.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import {
  EntityIdentifiersSchema,
  type EntityIdentifiers,
} from '../types/index.ts'
import type { ComplianceMigrationPort, MigrationReport } from './migrate.ts'

/**
 * Onboarding answer set. Each field corresponds to a question in the
 * interview list. `caSosEntityNumber` is required (a single-tenant CA
 * nonprofit toolkit assumes CA SOS registration); `caAgCharityNumber` is
 * optional in Phase 1 since it's added later when registering with the
 * Attorney General. Address line 2 is optional too.
 */
export interface OnboardingAnswers {
  readonly legalName: string
  readonly ein: string
  readonly stateOfIncorporation: string
  readonly caSosEntityNumber: string
  readonly caAgCharityNumber: string | null
  readonly caFtbEntityId?: string | null
  readonly caFtbEntityName?: string | null
  readonly cdtfaSellerPermitNumber?: string | null
  readonly cdtfaUseTaxAccountNumber?: string | null
  readonly cdtfaSpecialTaxAccountNumber?: string | null
  readonly fiscalYearEndMonth: number
  readonly fiscalYearEndDay: number
  readonly formationDate: string
  readonly mailingAddressLine1: string
  readonly mailingAddressLine2: string | null
  readonly mailingAddressCity: string
  readonly mailingAddressRegion: string
  readonly mailingAddressPostalCode: string
  readonly mailingAddressCountry: string
}

/**
 * Description of an interview question. The skill markdown reads these to
 * build the question list shown to the user. Keeping them in code here
 * means new fields show up automatically.
 */
export interface InterviewQuestion {
  readonly field: keyof OnboardingAnswers
  readonly prompt: string
  readonly kind: 'string' | 'number'
  readonly optional: boolean
}

export const ONBOARD_INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  {
    field: 'legalName',
    prompt: 'Legal name of the nonprofit (as registered with the IRS)',
    kind: 'string',
    optional: false,
  },
  {
    field: 'ein',
    prompt: 'Federal EIN (9 digits, optional dash NN-NNNNNNN)',
    kind: 'string',
    optional: false,
  },
  {
    field: 'stateOfIncorporation',
    prompt: 'State of incorporation (2-letter code)',
    kind: 'string',
    optional: false,
  },
  {
    field: 'caSosEntityNumber',
    prompt: 'California Secretary of State entity number',
    kind: 'string',
    optional: false,
  },
  {
    field: 'caAgCharityNumber',
    prompt:
      'California AG Registry of Charitable Trusts charity number (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'caFtbEntityId',
    prompt: 'California Franchise Tax Board entity ID (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'caFtbEntityName',
    prompt: 'California Franchise Tax Board entity name (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'cdtfaSellerPermitNumber',
    prompt: 'California CDTFA seller permit number (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'cdtfaUseTaxAccountNumber',
    prompt: 'California CDTFA use-tax account number (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'cdtfaSpecialTaxAccountNumber',
    prompt: 'California CDTFA special tax or fee account number (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'fiscalYearEndMonth',
    prompt: 'Fiscal year end month (1-12)',
    kind: 'number',
    optional: false,
  },
  {
    field: 'fiscalYearEndDay',
    prompt: 'Fiscal year end day (1-31)',
    kind: 'number',
    optional: false,
  },
  {
    field: 'formationDate',
    prompt: 'Date of formation (YYYY-MM-DD)',
    kind: 'string',
    optional: false,
  },
  {
    field: 'mailingAddressLine1',
    prompt: 'Mailing address — line 1',
    kind: 'string',
    optional: false,
  },
  {
    field: 'mailingAddressLine2',
    prompt: 'Mailing address — line 2 (optional)',
    kind: 'string',
    optional: true,
  },
  {
    field: 'mailingAddressCity',
    prompt: 'Mailing address — city',
    kind: 'string',
    optional: false,
  },
  {
    field: 'mailingAddressRegion',
    prompt: 'Mailing address — state/region (2-letter code)',
    kind: 'string',
    optional: false,
  },
  {
    field: 'mailingAddressPostalCode',
    prompt: 'Mailing address — postal code',
    kind: 'string',
    optional: false,
  },
  {
    field: 'mailingAddressCountry',
    prompt: 'Mailing address — country (2-letter code)',
    kind: 'string',
    optional: false,
  },
]

/**
 * Failure modes for the onboarding flow.
 */
export type OnboardingError =
  | { type: 'validation'; message: string }
  | { type: 'storage'; message: string }

/**
 * Confirmation returned on success. `migration` reflects what
 * `ensureComplianceSchema` did — usually a silent no-op (empty arrays);
 * non-empty only on the very first onboarding run in a fresh GCP project.
 */
export interface OnboardingSummary {
  readonly legalName: string
  readonly identifiers: EntityIdentifiers
  readonly entityRow: EntityInput
  readonly migration: MigrationReport
}

/**
 * Wiring.
 */
export interface RunOnboardingArgs {
  readonly answers: OnboardingAnswers
  readonly identifiersAccessor: EntityIdsAccessor
  readonly entityAccessor: EntityAccessor
  readonly migrationPort: ComplianceMigrationPort
}

/**
 * Schema that validates the user-provided answer bundle. Producing this
 * schema from the runtime types keeps the failure modes specific (per-field
 * Zod errors), and the resulting `parsed.data` is the canonical shape the
 * downstream accessors expect.
 */
const OnboardingAnswersSchema = z.object({
  legalName: z.string().min(1),
  ein: z.string().regex(/^\d{2}-?\d{7}$/),
  stateOfIncorporation: z.string().length(2),
  caSosEntityNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/),
  caAgCharityNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/)
    .nullable(),
  caFtbEntityId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/)
    .nullable()
    .optional(),
  caFtbEntityName: z.string().min(1).nullable().optional(),
  cdtfaSellerPermitNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/)
    .nullable()
    .optional(),
  cdtfaUseTaxAccountNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/)
    .nullable()
    .optional(),
  cdtfaSpecialTaxAccountNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/)
    .nullable()
    .optional(),
  fiscalYearEndMonth: z.number().int().min(1).max(12),
  fiscalYearEndDay: z.number().int().min(1).max(31),
  formationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mailingAddressLine1: z.string().min(1),
  mailingAddressLine2: z.string().min(1).nullable(),
  mailingAddressCity: z.string().min(1),
  mailingAddressRegion: z.string().length(2),
  mailingAddressPostalCode: z.string().min(1),
  mailingAddressCountry: z.string().length(2),
})

function buildIdentifiers(
  answers: z.infer<typeof OnboardingAnswersSchema>,
): Result<EntityIdentifiers, OnboardingError> {
  const caInner: {
    sosEntityNumber: string
    agCharityNumber?: string
    ftbEntityId?: string
    ftbEntityName?: string
    cdtfaSellerPermitNumber?: string
    cdtfaUseTaxAccountNumber?: string
    cdtfaSpecialTaxAccountNumber?: string
  } = {
    sosEntityNumber: answers.caSosEntityNumber,
  }
  if (answers.caAgCharityNumber !== null) {
    caInner.agCharityNumber = answers.caAgCharityNumber
  }
  if (answers.caFtbEntityId !== undefined && answers.caFtbEntityId !== null) {
    caInner.ftbEntityId = answers.caFtbEntityId
  }
  if (
    answers.caFtbEntityName !== undefined &&
    answers.caFtbEntityName !== null
  ) {
    caInner.ftbEntityName = answers.caFtbEntityName
  }
  if (
    answers.cdtfaSellerPermitNumber !== undefined &&
    answers.cdtfaSellerPermitNumber !== null
  ) {
    caInner.cdtfaSellerPermitNumber = answers.cdtfaSellerPermitNumber
  }
  if (
    answers.cdtfaUseTaxAccountNumber !== undefined &&
    answers.cdtfaUseTaxAccountNumber !== null
  ) {
    caInner.cdtfaUseTaxAccountNumber = answers.cdtfaUseTaxAccountNumber
  }
  if (
    answers.cdtfaSpecialTaxAccountNumber !== undefined &&
    answers.cdtfaSpecialTaxAccountNumber !== null
  ) {
    caInner.cdtfaSpecialTaxAccountNumber = answers.cdtfaSpecialTaxAccountNumber
  }
  const parsed = EntityIdentifiersSchema.safeParse({
    'us-federal': { ein: answers.ein },
    'us-ca': caInner,
  })
  if (!parsed.success) {
    return err({ type: 'validation', message: parsed.error.message })
  }
  return ok(parsed.data)
}

function buildEntityRow(
  answers: z.infer<typeof OnboardingAnswersSchema>,
): EntityInput {
  return {
    legal_name: answers.legalName,
    state_of_incorporation: answers.stateOfIncorporation,
    fiscal_year_end_month: answers.fiscalYearEndMonth,
    fiscal_year_end_day: answers.fiscalYearEndDay,
    formation_date: answers.formationDate,
    mailing_address_line1: answers.mailingAddressLine1,
    mailing_address_line2: answers.mailingAddressLine2,
    mailing_address_city: answers.mailingAddressCity,
    mailing_address_region: answers.mailingAddressRegion,
    mailing_address_postal_code: answers.mailingAddressPostalCode,
    mailing_address_country: answers.mailingAddressCountry,
  }
}

/**
 * Persist onboarding answers. Returns a summary on success or a typed error.
 *
 * Order matters:
 *   1. Validate answers (fail fast, no I/O).
 *   2. Ensure the compliance schema exists (idempotent; no-op on re-runs).
 *      Doing this before any write means a first onboarding on a fresh GCP
 *      project succeeds without the user pre-running a CLI migration.
 *   3. Write secrets — if BQ later fails, IDs are still safely stored.
 *   4. Write BQ row.
 *
 * If BQ fails after secrets are stored, the user can re-run onboarding to
 * complete the BQ side; the secret write is idempotent.
 */
export function runOnboarding(
  args: RunOnboardingArgs,
): ResultAsync<OnboardingSummary, OnboardingError> {
  const validation = OnboardingAnswersSchema.safeParse(args.answers)
  if (!validation.success) {
    return errAsync({
      type: 'validation',
      message: validation.error.message,
    })
  }
  const valid = validation.data
  const identifiersResult = buildIdentifiers(valid)
  if (identifiersResult.isErr()) {
    return errAsync(identifiersResult.error)
  }
  const identifiers = identifiersResult.value
  const entityRow = buildEntityRow(valid)

  return ensureComplianceSchema(args.migrationPort)
    .mapErr<OnboardingError>((err) => ({
      type: 'storage',
      message: `Compliance schema migration failed: ${err.message}`,
    }))
    .andThen((migration) =>
      args.identifiersAccessor
        .write(identifiers)
        .mapErr<OnboardingError>((err) => ({
          type: 'storage',
          message: `Secret Manager write failed: ${err.message}`,
        }))
        .andThen(() =>
          args.entityAccessor
            .upsertEntity(entityRow)
            .mapErr<OnboardingError>((err) => ({
              type: 'storage',
              message: `BigQuery upsert failed: ${err.message}`,
            })),
        )
        .map<OnboardingSummary>(() => ({
          legalName: valid.legalName,
          identifiers,
          entityRow,
          migration,
        })),
    )
}
