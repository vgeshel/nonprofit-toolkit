/**
 * Production wiring for the partial-update onboarding flow.
 *
 * Mirrors `onboard-wiring.ts`: builds the GCP-backed deps and delegates to
 * the pure backend in `onboard-update.ts`.
 */
import type { ResultAsync } from 'neverthrow'
import {
  runOnboardingUpdate,
  type OnboardingUpdateError,
  type PartialOnboardingAnswers,
} from './onboard-update.ts'
import type { OnboardingSummary } from './onboard.ts'
import {
  buildCommonDeps,
  type BigQueryFactory,
  type SecretManagerFactory,
} from './wiring-common.ts'

/**
 * Wiring args for the production update entry point.
 */
export interface RunOnboardingUpdateProductionArgs {
  readonly projectId: string
  readonly partial: PartialOnboardingAnswers
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
}

/**
 * Run onboarding update against real GCP services (or test-injected fakes).
 */
export function runOnboardingUpdateProduction(
  args: RunOnboardingUpdateProductionArgs,
): ResultAsync<OnboardingSummary, OnboardingUpdateError> {
  const now = args.now ?? (() => new Date())
  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })
  return runOnboardingUpdate({
    partial: args.partial,
    identifiersAccessor: deps.identifiersAccessor,
    entityAccessor: deps.entityAccessor,
    migrationPort: deps.migrationPort,
  })
}
