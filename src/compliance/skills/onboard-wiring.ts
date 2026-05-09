/**
 * Production wiring for the `compliance-onboard` skill.
 *
 * `runOnboardingProduction` is the function the skill (or the thin
 * `scripts/compliance-onboard.ts` adapter) calls. It:
 *
 *   1. Constructs a `BigQuery` and a `SecretManagerServiceClient` via
 *      injectable factories (defaults: real SDK constructors).
 *   2. Adapts both into the port-shaped accessors `runOnboarding` consumes.
 *   3. Calls `runOnboarding` with the validated answer bundle.
 *
 * Tests inject custom factories so no GCP credentials are needed; production
 * callers omit them and the defaults take over.
 */
import type { ResultAsync } from 'neverthrow'
import {
  runOnboarding,
  type OnboardingAnswers,
  type OnboardingError,
  type OnboardingSummary,
} from './onboard.ts'
import {
  buildCommonDeps,
  type BigQueryFactory,
  type SecretManagerFactory,
} from './wiring-common.ts'

/**
 * Wiring args for the production onboarding entry point.
 */
export interface RunOnboardingProductionArgs {
  readonly projectId: string
  readonly answers: OnboardingAnswers
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
}

/**
 * Run onboarding against real GCP services (or test-injected fakes).
 *
 * The defaults for `bqFactory` and `secretManagerFactory` construct real SDK
 * clients; `now` defaults to the system clock. Injecting any of these in a
 * test bypasses the GCP SDK entirely.
 */
export function runOnboardingProduction(
  args: RunOnboardingProductionArgs,
): ResultAsync<OnboardingSummary, OnboardingError> {
  const now = args.now ?? (() => new Date())
  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })
  return runOnboarding({
    answers: args.answers,
    identifiersAccessor: deps.identifiersAccessor,
    entityAccessor: deps.entityAccessor,
    migrationPort: deps.migrationPort,
  })
}
