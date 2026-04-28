/**
 * Source type definitions.
 *
 * A Source declares one discovery operation — for example, "look up an EIN in
 * the IRS Pub. 78 dataset". Sources are kind-tagged so the runner can dispatch:
 * Phase 1 ships only `kind: 'api'`. Phase 2 adds `playwright`. `manual`
 * indicates a check that requires human action and is recorded for audit.
 */
import type { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { SourceError } from '../sources/errors.ts'
import type { Entity, EntityIdentifiers } from './entity.ts'
import type { Finding } from './finding.ts'
import type { JurisdictionId } from './jurisdiction.ts'

/**
 * The kind of source — drives which runner adapter is used.
 */
export const SourceKindSchema = z.enum(['api', 'playwright', 'manual'])
export type SourceKind = z.infer<typeof SourceKindSchema>

/**
 * Raw payload captured from a source. Persisted verbatim for audit.
 *
 * `payload` is intentionally typed as `Record<string, unknown>` because each
 * source has its own shape; the runner does not interpret it. The source
 * itself parses incoming bytes through a Zod schema before producing this
 * record.
 */
export const SourceRecordSchema = z.object({
  record_id: z.string().uuid(),
  source_id: z.string().min(1),
  fetched_at: z.string().min(1), // ISO timestamp; storage layer parses to TIMESTAMP
  payload: z.record(z.string(), z.unknown()),
})

export type SourceRecord = z.infer<typeof SourceRecordSchema>

/**
 * Output of a successful source run.
 *
 * - `record` is what gets persisted to BigQuery as the discovery payload.
 * - `findings` is a (possibly empty) list of typed findings the source
 *   already knows it can derive directly from its payload. Phase 2 adds a
 *   richer derivation engine that consumes raw records and emits findings;
 *   Phase 1 sources are allowed (but not required) to emit findings inline.
 */
export interface SourceRunOutput {
  readonly record: SourceRecord
  readonly findings: readonly Finding[]
}

/**
 * Minimal HTTP client surface a source uses. We deliberately do NOT use
 * `typeof fetch` here because Bun's global `fetch` is augmented with a
 * `preconnect` method, which would propagate the constraint to every test
 * fake. Sources only need the call signature.
 */
export type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Context passed to a source's `run` function.
 *
 * The runner provides:
 *   - `now`         clock — tests inject a fixed time
 *   - `fetch`       HTTP client — tests inject a fake
 *   - `identifiers` per-jurisdiction IDs (EIN, SOS number, etc.) — the
 *                   orchestrator reads these from Secret Manager once before
 *                   dispatching, so each source receives them by reference
 *                   instead of fetching them itself.
 */
export interface SourceContext {
  readonly now: () => Date
  readonly fetch: FetchImpl
  readonly identifiers: EntityIdentifiers
}

/**
 * A discovery source.
 *
 * `kind` drives which runner adapter is used. For Phase 1, only `kind: 'api'`
 * sources exist; the runner rejects anything else to make scope-creep loud.
 *
 * `tosUrl` documents the upstream's terms of service so reviewers can audit
 * the choice. `authRequired` is the policy bit; the runner refuses to run a
 * source that says it needs auth without authentication context (Phase 3+).
 */
export interface Source {
  readonly id: string
  readonly jurisdiction: JurisdictionId
  readonly kind: SourceKind
  readonly authRequired: boolean
  readonly description: string
  readonly tosUrl: string
  readonly run: (
    entity: Entity,
    ctx: SourceContext,
  ) => ResultAsync<SourceRunOutput, SourceError>
}
