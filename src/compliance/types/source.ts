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
import type { DownloadCacheStore } from '../sources/download-cache.ts'
import type { SourceError } from '../sources/errors.ts'
import type { Entity, EntityIdentifiers } from './entity.ts'
import { FindingSchema, type Finding } from './finding.ts'
import type { JurisdictionId } from './jurisdiction.ts'

/**
 * The kind of source — drives which runner adapter is used.
 */
export const SourceKindSchema = z.enum(['api', 'playwright', 'manual'])
export type SourceKind = z.infer<typeof SourceKindSchema>

/**
 * How the source is accessed. This is policy metadata, not runner dispatch:
 * an `api` source can use an official bulk download or public read-only page,
 * and a `manual` source can point to a public search page that cannot be
 * automated under current terms.
 */
export const SourceAccessMethodSchema = z.enum([
  'official_api',
  'official_bulk_download',
  'official_public_page',
  'playwright_readonly',
  'manual',
])
export type SourceAccessMethod = z.infer<typeof SourceAccessMethodSchema>

export const SourceCredentialModeSchema = z.enum([
  'secret_manager',
  'user_entered_session',
])
export type SourceCredentialMode = z.infer<typeof SourceCredentialModeSchema>

export const SourceMfaModeSchema = z.enum(['none', 'user_assisted'])
export type SourceMfaMode = z.infer<typeof SourceMfaModeSchema>

/**
 * Source freshness metadata. `observedAt` is when we checked or fetched the
 * source. `upstreamPublishedAt` is whatever posting date the authority gives
 * us, if any; many official pages publish a date rather than a timestamp.
 */
export const SourceFreshnessSchema = z.object({
  observedAt: z.iso.datetime(),
  upstreamPublishedAt: z.string().min(1).optional(),
})

export type SourceFreshness = z.infer<typeof SourceFreshnessSchema>

export const SourceManualEvidenceFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
})

export type SourceManualEvidenceField = z.infer<
  typeof SourceManualEvidenceFieldSchema
>

export const SourceCredentialFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  secret: z.boolean(),
})

export type SourceCredentialField = z.infer<typeof SourceCredentialFieldSchema>

export const SourceAuthRequirementSchema = z.object({
  loginUrl: z.string().url(),
  credentialMode: SourceCredentialModeSchema,
  credentialSecretName: z.string().min(1).optional(),
  credentialFields: z.array(SourceCredentialFieldSchema).min(1),
  mfa: SourceMfaModeSchema,
  instructions: z.array(z.string().min(1)).min(1),
  evidenceFields: z.array(SourceManualEvidenceFieldSchema).min(1),
  forbiddenActions: z.array(z.string().min(1)).min(1),
})

export type SourceAuthRequirement = z.infer<typeof SourceAuthRequirementSchema>

const SourceMetadataBaseSchema = z.object({
  accessUrl: z.string().url(),
  tosUrl: z.string().url(),
  accessMethod: SourceAccessMethodSchema,
  sourceFreshness: SourceFreshnessSchema.optional(),
  auth: SourceAuthRequirementSchema.optional(),
})

const AutomatedSourceMetadataSchema = SourceMetadataBaseSchema.extend({
  automationAllowed: z.literal(true),
  manualOnlyReason: z.never().optional(),
})

const ManualOnlySourceMetadataSchema = SourceMetadataBaseSchema.extend({
  automationAllowed: z.literal(false),
  manualOnlyReason: z.string().min(1),
})

/**
 * Declarative source metadata required before a source can be registered.
 * Runtime schemas enforce the policy fields even though TypeScript already
 * catches most missing-field mistakes for in-repo source definitions.
 */
export const SourceMetadataSchema = z.discriminatedUnion('automationAllowed', [
  AutomatedSourceMetadataSchema,
  ManualOnlySourceMetadataSchema,
])

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>

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
 * Runtime schema for source outputs. Source bodies validate upstream payloads
 * before producing a record; this schema validates the runner-facing envelope.
 */
export const SourceRunOutputSchema = z.object({
  record: SourceRecordSchema,
  findings: z.array(FindingSchema),
})

/**
 * Typed source outcomes used by Phase 2 orchestration and reporting.
 *
 * `runSource` still returns `ResultAsync<SourceRunOutput, SourceError>` for
 * backwards-compatible Phase 1 behavior; this union is the shared vocabulary
 * for manual-required, policy-blocked, and auth-required cases added in Phase 2.
 */
export const SourceRunOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    output: SourceRunOutputSchema,
  }),
  z.object({
    status: z.literal('source_failure'),
    source_id: z.string().min(1),
    error_type: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    status: z.literal('manual_required'),
    source_id: z.string().min(1),
    instructions: z.array(z.string().min(1)).min(1),
    evidenceFields: z.array(SourceManualEvidenceFieldSchema).min(1),
  }),
  z.object({
    status: z.literal('policy_blocked'),
    source_id: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal('auth_required'),
    source_id: z.string().min(1),
    message: z.string().min(1),
    loginUrl: z.string().url().optional(),
    credentialMode: SourceCredentialModeSchema.optional(),
    credentialFields: z.array(SourceCredentialFieldSchema).optional(),
    mfa: SourceMfaModeSchema.optional(),
    instructions: z.array(z.string().min(1)).optional(),
    evidenceFields: z.array(SourceManualEvidenceFieldSchema).optional(),
    forbiddenActions: z.array(z.string().min(1)).optional(),
  }),
])

export type SourceRunOutcome = z.infer<typeof SourceRunOutcomeSchema>

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

export interface BrowserLocator {
  filter(options: { readonly hasText: string | RegExp }): BrowserLocator
  first(): BrowserLocator
  count(): Promise<number>
  click(options?: { readonly force?: boolean }): Promise<unknown>
  innerText(): Promise<string>
  inputValue(): Promise<string>
}

export interface BrowserResponse {
  url(): string
  status(): number
  json(): Promise<unknown>
}

export interface BrowserPage {
  setDefaultTimeout(timeoutMs: number): void
  goto(
    url: string,
    options?: {
      readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
      readonly timeout?: number
    },
  ): Promise<unknown>
  waitForSelector(
    selector: string,
    options?: { readonly timeout?: number },
  ): Promise<unknown>
  selectOption(
    selector: string,
    values: { readonly label: string },
  ): Promise<unknown>
  fill(selector: string, value: string): Promise<unknown>
  click(selector: string): Promise<unknown>
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { readonly timeout?: number },
  ): Promise<unknown>
  waitForResponse(
    predicate: (response: BrowserResponse) => boolean,
    options?: { readonly timeout?: number },
  ): Promise<BrowserResponse>
  locator(selector: string): BrowserLocator
}

export interface BrowserPageSession {
  readonly page: BrowserPage
  readonly close: () => Promise<void>
}

export type BrowserPageFactory = () => ResultAsync<
  BrowserPageSession,
  SourceError
>

/**
 * Context passed to a source's `run` function.
 *
 * The runner provides:
 *   - `now`         clock — tests inject a fixed time
 *   - `fetch`       HTTP client — tests inject a fake
 *   - `browserPageFactory` optional browser-page factory for public pages that
 *                          require a real browser but no user auth
 *   - `downloadCache` optional shared cache for official bulk downloads
 *   - `identifiers` per-jurisdiction IDs (EIN, SOS number, etc.) — the
 *                   orchestrator reads these from Secret Manager once before
 *                   dispatching, so each source receives them by reference
 *                   instead of fetching them itself.
 */
export interface SourceContext {
  readonly now: () => Date
  readonly fetch: FetchImpl
  readonly browserPageFactory?: BrowserPageFactory
  readonly downloadCache?: DownloadCacheStore
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
interface SourceBase {
  readonly id: string
  readonly jurisdiction: JurisdictionId
  readonly kind: SourceKind
  readonly authRequired: boolean
  readonly description: string
  readonly tosUrl: string
  readonly accessUrl: string
  readonly accessMethod: SourceAccessMethod
  readonly sourceFreshness?: SourceFreshness
  readonly auth?: SourceAuthRequirement
  readonly run: (
    entity: Entity,
    ctx: SourceContext,
  ) => ResultAsync<SourceRunOutput, SourceError>
}

export type Source =
  | (SourceBase & {
      readonly automationAllowed: true
      readonly manualOnlyReason?: never
    })
  | (SourceBase & {
      readonly automationAllowed: false
      readonly manualOnlyReason: string
      readonly manualInstructions: readonly string[]
      readonly manualEvidenceFields: readonly SourceManualEvidenceField[]
    })
