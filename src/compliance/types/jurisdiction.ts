/**
 * Jurisdiction-level type definitions.
 *
 * A Jurisdiction module is the unit of pluggability: adding US-CA or any other
 * jurisdiction means adding a module that exports an object satisfying
 * `Jurisdiction`. Sources, deadline rules, and forms attach to a jurisdiction.
 *
 * Phase 1 ships only the `us-federal` jurisdiction. The `Jurisdiction` shape
 * intentionally allows empty `deadlineRules` and `forms` — those slots fill in
 * during Phase 4 and Phase 5 respectively.
 */
import { z } from 'zod'
import type { Source } from './source.ts'

/**
 * Stable identifier for a jurisdiction module.
 *
 * Lowercase, no whitespace. Conventional examples: `us-federal`, `us-ca`.
 */
export const JurisdictionIdSchema = z
  .string()
  .min(1)
  .regex(/^\S+$/, 'Jurisdiction id must not contain whitespace')

export type JurisdictionId = z.infer<typeof JurisdictionIdSchema>

/**
 * Placeholder DeadlineRule — populated in Phase 4. Phase 1 only requires the
 * type slot to exist on the Jurisdiction shape; the engine arrives later.
 */
export interface DeadlineRule {
  readonly id: string
  readonly description: string
}

/**
 * Placeholder FormDefinition — populated in Phase 5.
 */
export interface FormDefinition {
  readonly id: string
  readonly title: string
}

/**
 * A jurisdiction module.
 *
 * - `entityIdSchema` is a Zod schema for the IDs this jurisdiction needs (EIN,
 *   SOS entity number, etc.) and is used by onboarding flows.
 * - `sources` is the list of discovery sources for this jurisdiction.
 * - `deadlineRules` and `forms` are reserved for later phases.
 */
export interface Jurisdiction {
  readonly id: JurisdictionId
  readonly entityIdSchema: z.ZodType<unknown>
  readonly sources: readonly Source[]
  readonly deadlineRules: readonly DeadlineRule[]
  readonly forms: readonly FormDefinition[]
}
