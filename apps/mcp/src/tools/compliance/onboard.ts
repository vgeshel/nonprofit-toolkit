/**
 * MCP tools: compliance-onboard and compliance-onboard-update.
 *
 * Both tools mutate Secret Manager + BigQuery, so they require an
 * explicit `confirm: true` parameter to prevent accidental writes.
 *
 * `compliance-onboard` accepts a full `OnboardingAnswers` bundle (the
 * host model has already walked the user through the interview using
 * the `compliance://onboarding/interview-questions` resource).
 *
 * `compliance-onboard-update` accepts a partial bundle and merges it
 * onto the currently-stored state via `runOnboardingUpdate`.
 */
import { err, ok, type Result } from 'neverthrow'
import type { Logger } from 'pino'
import { z } from 'zod'
import { runOnboardingUpdateProduction } from '../../../../../src/compliance/skills/onboard-update-wiring.ts'
import type {
  OnboardingUpdateError,
  PartialOnboardingAnswers,
} from '../../../../../src/compliance/skills/onboard-update.ts'
import { runOnboardingProduction } from '../../../../../src/compliance/skills/onboard-wiring.ts'
import {
  type OnboardingAnswers,
  type OnboardingSummary,
} from '../../../../../src/compliance/skills/onboard.ts'
import type { Config } from '../../config'

/**
 * Shared error envelope for both write tools.
 */
export interface OnboardError {
  readonly type: 'unconfirmed' | 'validation' | 'storage' | 'not_onboarded'
  readonly message: string
}

/**
 * Reusable Zod schema for the confirmation flag. `z.literal(true)`
 * ensures `false` and missing values both reject.
 */
export const ConfirmSchema = z
  .literal(true)
  .describe(
    'Required write-confirmation flag. Must be true; tools refuse to run without it.',
  )

/**
 * Full onboarding answers — same shape as `OnboardingAnswersSchema`
 * inside the backend, replicated here as the MCP-facing input schema
 * so the tool's `inputSchema` carries field-level descriptions for the
 * host model.
 */
export const OnboardingAnswersInputSchema = z.object({
  legalName: z.string().min(1).describe('Legal name of the nonprofit.'),
  ein: z
    .string()
    .regex(/^\d{2}-?\d{7}$/)
    .describe('Federal EIN (9 digits, optional dash NN-NNNNNNN).'),
  stateOfIncorporation: z
    .string()
    .length(2)
    .describe('2-letter state-of-incorporation code.'),
  caSosEntityNumber: z
    .string()
    .min(1)
    .describe('California Secretary of State entity number.'),
  caAgCharityNumber: z
    .string()
    .min(1)
    .nullable()
    .describe('California AG Registry charity number (CTNNNNNNN) or null.'),
  caFtbEntityId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('California FTB entity id, if known.'),
  caFtbEntityName: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('California FTB entity name, if known.'),
  cdtfaSellerPermitNumber: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('California CDTFA seller permit number, if any.'),
  cdtfaUseTaxAccountNumber: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('California CDTFA use-tax account number, if any.'),
  cdtfaSpecialTaxAccountNumber: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('California CDTFA special tax / fee account number, if any.'),
  fiscalYearEndMonth: z
    .number()
    .int()
    .min(1)
    .max(12)
    .describe('Fiscal year end month (1-12).'),
  fiscalYearEndDay: z
    .number()
    .int()
    .min(1)
    .max(31)
    .describe('Fiscal year end day (1-31).'),
  formationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Formation date in YYYY-MM-DD format.'),
  mailingAddressLine1: z.string().min(1).describe('Mailing address line 1.'),
  mailingAddressLine2: z
    .string()
    .min(1)
    .nullable()
    .describe('Mailing address line 2 (or null).'),
  mailingAddressCity: z.string().min(1).describe('Mailing address city.'),
  mailingAddressRegion: z
    .string()
    .length(2)
    .describe('Mailing address 2-letter state/region.'),
  mailingAddressPostalCode: z
    .string()
    .min(1)
    .describe('Mailing address postal code.'),
  mailingAddressCountry: z
    .string()
    .length(2)
    .describe('Mailing address 2-letter country code.'),
})

/**
 * Partial schema — same fields, all optional. Used by the update tool.
 */
export const PartialOnboardingAnswersInputSchema =
  OnboardingAnswersInputSchema.partial()

/**
 * Onboarding-tool callable + dependency shapes — exported for tests.
 */
export type OnboardRunner = (args: {
  readonly projectId: string
  readonly answers: OnboardingAnswers
}) => ReturnType<typeof runOnboardingProduction>

export type OnboardUpdateRunner = (args: {
  readonly projectId: string
  readonly partial: PartialOnboardingAnswers
}) => ReturnType<typeof runOnboardingUpdateProduction>

/**
 * Resolve the production runner with optional test override.
 */
export const defaultOnboardRunner: OnboardRunner = ({ projectId, answers }) =>
  runOnboardingProduction({ projectId, answers })

export const defaultOnboardUpdateRunner: OnboardUpdateRunner = ({
  projectId,
  partial,
}) => runOnboardingUpdateProduction({ projectId, partial })

export function resolveOnboardRunner(override?: OnboardRunner): OnboardRunner {
  return override ?? defaultOnboardRunner
}

export function resolveOnboardUpdateRunner(
  override?: OnboardUpdateRunner,
): OnboardUpdateRunner {
  return override ?? defaultOnboardUpdateRunner
}

/**
 * Dependencies injected into the handlers.
 */
export interface OnboardDeps {
  readonly config: Config
  readonly logger: Logger
  readonly runOnboard?: OnboardRunner
  readonly runOnboardUpdate?: OnboardUpdateRunner
}

/**
 * Handle a full-onboard tool call.
 */
export async function handleComplianceOnboard(
  input: { readonly confirm: boolean; readonly answers: OnboardingAnswers },
  deps: OnboardDeps,
): Promise<Result<OnboardingSummary, OnboardError>> {
  deps.logger.info('compliance-onboard tool called')
  if (input.confirm !== true) {
    return err({
      type: 'unconfirmed',
      message:
        'compliance-onboard requires confirm: true. Refusing to write Secret Manager and BigQuery without an explicit confirmation.',
    })
  }
  const runner = resolveOnboardRunner(deps.runOnboard)
  const result = await runner({
    projectId: deps.config.PROJECT_ID,
    answers: input.answers,
  })
  if (result.isErr()) {
    return err({
      type: result.error.type,
      message: result.error.message,
    })
  }
  return ok(result.value)
}

/**
 * Handle a partial-onboard-update tool call.
 */
export async function handleComplianceOnboardUpdate(
  input: {
    readonly confirm: boolean
    readonly partial: PartialOnboardingAnswers
  },
  deps: OnboardDeps,
): Promise<Result<OnboardingSummary, OnboardError>> {
  deps.logger.info('compliance-onboard-update tool called')
  if (input.confirm !== true) {
    return err({
      type: 'unconfirmed',
      message:
        'compliance-onboard-update requires confirm: true. Refusing to write Secret Manager and BigQuery without an explicit confirmation.',
    })
  }
  const runner = resolveOnboardUpdateRunner(deps.runOnboardUpdate)
  const result = await runner({
    projectId: deps.config.PROJECT_ID,
    partial: input.partial,
  })
  if (result.isErr()) {
    return err(translateUpdateError(result.error))
  }
  return ok(result.value)
}

/**
 * Map `OnboardingUpdateError` to the tool's `OnboardError` envelope.
 * Exported for direct test coverage.
 */
export function translateUpdateError(e: OnboardingUpdateError): OnboardError {
  if (e.type === 'not_onboarded') {
    return { type: 'not_onboarded', message: e.message }
  }
  if (e.type === 'validation') {
    return { type: 'validation', message: e.message }
  }
  return { type: 'storage', message: e.message }
}
