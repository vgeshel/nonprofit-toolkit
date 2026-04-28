/**
 * Finding types: a typed observation produced by a source or rule.
 *
 * Phase 1 sources may emit findings directly (e.g. "EIN appears on the IRS
 * automatic-revocation list"). Phase 2 introduces a derivation engine that
 * consumes raw source records and emits findings; the schema here supports
 * both producers.
 */
import { z } from 'zod'

/**
 * Strip `{ value: string }` BigQueryTimestamp wrappers down to a string.
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
 * Severity ladder. `info` = informational, `warn` = action recommended,
 * `error` = action required.
 */
export const FindingSeveritySchema = z.enum(['info', 'warn', 'error'])
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>

/**
 * Lifecycle of a finding. A finding starts `open`; later runs may close it.
 * Phase 1 only writes `open`; the resolution flow lands in a later phase.
 */
export const FindingStatusSchema = z.enum(['open', 'resolved'])
export type FindingStatus = z.infer<typeof FindingStatusSchema>

/**
 * Finding row — one row in `compliance.findings`.
 *
 * `evidence` is a free-form record so each producing source can pin pointers
 * to whatever it captured (a source-record id, a URL, a snippet, etc.).
 */
export const FindingSchema = z.object({
  finding_id: z.string().uuid(),
  jurisdiction_id: z.string().min(1),
  source_id: z.string().min(1),
  severity: FindingSeveritySchema,
  status: FindingStatusSchema,
  title: z.string().min(1),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  opened_at: z.preprocess(extractTimestampValue, z.string().min(1)),
  resolved_at: z.preprocess(
    extractTimestampValue,
    z.string().min(1).nullable(),
  ),
})

export type Finding = z.infer<typeof FindingSchema>
