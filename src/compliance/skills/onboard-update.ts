/**
 * Backend for the `compliance-onboard-update` flow.
 *
 * `runOnboardingUpdate` merges a partial `OnboardingAnswers` set onto the
 * currently-stored entity row + identifiers and persists the merged result
 * by delegating to `runOnboarding`. This is the right semantic for "we just
 * got our AG charity number, please save it" — the caller doesn't have to
 * resubmit the entire onboarding bundle.
 *
 * If no prior onboarding exists, the call is rejected. Initial onboarding
 * must go through `runOnboarding` with the full answer bundle.
 */
import type { Result, ResultAsync } from 'neverthrow'
import { err, errAsync, ok } from 'neverthrow'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type { Entity, EntityIdentifiers } from '../types/index.ts'
import type { ComplianceMigrationPort } from './migrate.ts'
import {
  runOnboarding,
  type OnboardingAnswers,
  type OnboardingError,
  type OnboardingSummary,
} from './onboard.ts'

/**
 * Partial answer set. Any field in `OnboardingAnswers` may be supplied; the
 * rest retain their current persisted value.
 */
export type PartialOnboardingAnswers = Partial<OnboardingAnswers>

/**
 * Failure modes for the update flow. Inherits everything `runOnboarding`
 * itself can emit; adds `not_onboarded` for the no-prior-state case.
 */
export type OnboardingUpdateError =
  | OnboardingError
  | { readonly type: 'not_onboarded'; readonly message: string }

/**
 * Wiring.
 */
export interface RunOnboardingUpdateArgs {
  readonly partial: PartialOnboardingAnswers
  readonly entityAccessor: EntityAccessor
  readonly identifiersAccessor: EntityIdsAccessor
  readonly migrationPort: ComplianceMigrationPort
}

/**
 * Reconstruct an `OnboardingAnswers` object from the currently-stored
 * entity row and identifiers. Used as the base for partial updates.
 *
 * Identifier fields that aren't present in storage map back to `null` (the
 * caller can clear them by passing null explicitly, or leave them as-is by
 * omitting them from the partial).
 *
 * Returns an `err` of type `not_onboarded` if either jurisdiction's
 * identifiers are missing — the caller is expected to gate on existence,
 * but this surface keeps the contract explicit.
 */
export function reconstructAnswers(
  entity: Entity,
  identifiers: EntityIdentifiers,
): Result<OnboardingAnswers, OnboardingUpdateError> {
  const federal = identifiers['us-federal']
  const ca = identifiers['us-ca']
  if (federal === undefined || ca === undefined) {
    const missing = federal === undefined ? 'us-federal' : 'us-ca'
    return err({
      type: 'not_onboarded',
      message: `Cannot reconstruct OnboardingAnswers: ${missing} identifiers are missing.`,
    })
  }
  return ok({
    legalName: entity.legal_name,
    ein: federal.ein,
    stateOfIncorporation: entity.state_of_incorporation,
    caSosEntityNumber: ca.sosEntityNumber,
    caAgCharityNumber: ca.agCharityNumber ?? null,
    caFtbEntityId: ca.ftbEntityId ?? null,
    caFtbEntityName: ca.ftbEntityName ?? null,
    cdtfaSellerPermitNumber: ca.cdtfaSellerPermitNumber ?? null,
    cdtfaUseTaxAccountNumber: ca.cdtfaUseTaxAccountNumber ?? null,
    cdtfaSpecialTaxAccountNumber: ca.cdtfaSpecialTaxAccountNumber ?? null,
    fiscalYearEndMonth: entity.fiscal_year_end_month,
    fiscalYearEndDay: entity.fiscal_year_end_day,
    formationDate: entity.formation_date,
    mailingAddressLine1: entity.mailing_address_line1,
    mailingAddressLine2: entity.mailing_address_line2,
    mailingAddressCity: entity.mailing_address_city,
    mailingAddressRegion: entity.mailing_address_region,
    mailingAddressPostalCode: entity.mailing_address_postal_code,
    mailingAddressCountry: entity.mailing_address_country,
  })
}

/**
 * Merge a partial answer set onto a base. Caller-provided fields win.
 *
 * Exported for test coverage.
 */
export function mergeAnswers(
  base: OnboardingAnswers,
  partial: PartialOnboardingAnswers,
): OnboardingAnswers {
  return { ...base, ...partial }
}

/**
 * Persist a partial update. Reads current state, merges, then delegates
 * to `runOnboarding`, which performs the schema-migration, validation,
 * and storage steps with the same semantics as a fresh onboarding.
 */
export function runOnboardingUpdate(
  args: RunOnboardingUpdateArgs,
): ResultAsync<OnboardingSummary, OnboardingUpdateError> {
  return args.entityAccessor
    .readEntity()
    .mapErr<OnboardingUpdateError>((err) => ({
      type: 'storage',
      message: `Failed to read entity row: ${err.message}`,
    }))
    .andThen((entity) =>
      args.identifiersAccessor
        .read()
        .mapErr<OnboardingUpdateError>((err) => ({
          type: 'storage',
          message: `Failed to read entity identifiers: ${err.message}`,
        }))
        .andThen((identifiers) => {
          if (entity === null || identifiers === null) {
            return errAsync<OnboardingSummary, OnboardingUpdateError>({
              type: 'not_onboarded',
              message:
                'No prior onboarding found. Use compliance-onboard for the first-time submit.',
            })
          }
          const baseResult = reconstructAnswers(entity, identifiers)
          if (baseResult.isErr()) {
            return errAsync<OnboardingSummary, OnboardingUpdateError>(
              baseResult.error,
            )
          }
          const merged = mergeAnswers(baseResult.value, args.partial)
          return runOnboarding({
            answers: merged,
            entityAccessor: args.entityAccessor,
            identifiersAccessor: args.identifiersAccessor,
            migrationPort: args.migrationPort,
          })
        }),
    )
}
