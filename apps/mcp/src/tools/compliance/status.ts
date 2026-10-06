/**
 * MCP tool: compliance-status
 *
 * Reads the entity row, identifiers (from Secret Manager), latest
 * per-source discovery runs, and open findings; assembles them into a
 * `ComplianceStatusReport` plus an `overall` flag the model can react to.
 *
 * The tool is read-only. No `confirm` flag is required.
 */
import type { Result } from 'neverthrow'
import { err, ok } from 'neverthrow'
import type { Logger } from 'pino'
import { usCaJurisdiction } from '../../../../../src/compliance/jurisdictions/us-ca/index.ts'
import { usFederalJurisdiction } from '../../../../../src/compliance/jurisdictions/us-federal/index.ts'
import { getComplianceStatusProduction } from '../../../../../src/compliance/skills/status-wiring.ts'
import type { ComplianceStatusReport } from '../../../../../src/compliance/skills/status.ts'
import type {
  Jurisdiction,
  SourceManualEvidenceField,
} from '../../../../../src/compliance/types/index.ts'
import type { Config } from '../../config'

/**
 * Reader callback shape. Default points at the production wiring; tests
 * inject a fake that returns canned data.
 */
export type ComplianceStatusReader = (
  projectId: string,
) => ReturnType<typeof getComplianceStatusProduction>

/**
 * Default reader — adapts the production wiring's args-object signature
 * to the single-`projectId` reader contract. Exported for direct unit
 * testing of the adapter (the wiring itself is tested under
 * `src/compliance/tests/status-wiring.test.ts`).
 */
export const defaultComplianceStatusReader: ComplianceStatusReader = (
  projectId,
) => getComplianceStatusProduction({ projectId })

/**
 * Resolve the reader to use: caller-provided or default. Extracted so
 * the `?? defaultComplianceStatusReader` branch is directly testable
 * without driving the production wiring.
 */
export function resolveStatusReader(
  override?: ComplianceStatusReader,
): ComplianceStatusReader {
  return override ?? defaultComplianceStatusReader
}

/**
 * Dependencies injected into the handler. Mirrors the other MCP tool
 * handlers in this package.
 */
export interface ComplianceStatusDeps {
  readonly config: Config
  readonly logger: Logger
  /**
   * Override the production wiring (used by tests). When omitted, the
   * handler calls the GCP-backed `getComplianceStatusProduction`.
   */
  readonly readStatus?: ComplianceStatusReader
}

/**
 * Error envelope. The MCP layer converts this into a textual `isError`
 * response; the structured shape is preserved for unit tests.
 */
export interface ComplianceStatusError {
  readonly type: 'not_onboarded' | 'load'
  readonly message: string
}

/**
 * Per-source metadata projected alongside the raw status report so the
 * host LLM can write actionable, linkable prose without having to fetch
 * the source-registry resource separately. Every URL the model might
 * want to render is here.
 */
export interface ComplianceStatusSourceMeta {
  readonly sourceId: string
  readonly agency: string
  readonly description: string
  readonly accessUrl: string
  readonly tosUrl: string
  readonly automationAllowed: boolean
  /**
   * Auth-required sources only. The model should surface `loginUrl` as
   * a clickable link and walk the user through `instructions` /
   * `evidenceFields` if the latest run was `auth_required`.
   */
  readonly auth?: {
    readonly loginUrl: string
    readonly instructions: readonly string[]
    readonly evidenceFields: readonly SourceManualEvidenceField[]
    readonly forbiddenActions: readonly string[]
  }
}

/**
 * What we return to the MCP layer. Wraps the pure backend report with
 * helpers the LLM needs to write a useful narrative:
 *   - `now`         today's ISO date so date arithmetic is deterministic
 *   - `sources`     per-source URLs + auth metadata for every registered
 *                   source, indexed by sourceId so the model can join
 *                   against latestRuns/openFindings without a second
 *                   resource read.
 */
export interface EnrichedComplianceStatusReport extends ComplianceStatusReport {
  readonly now: string
  readonly sources: readonly ComplianceStatusSourceMeta[]
}

const DEFAULT_JURISDICTIONS: readonly Jurisdiction[] = [
  usFederalJurisdiction,
  usCaJurisdiction,
]

/**
 * Project every registered source into the metadata shape the LLM
 * consumes. Pure / synchronous so the same projection is reused by
 * unit tests.
 */
export function projectSourceMetadata(
  jurisdictions: readonly Jurisdiction[] = DEFAULT_JURISDICTIONS,
): readonly ComplianceStatusSourceMeta[] {
  return jurisdictions.flatMap((j) =>
    j.sources.map((source) => {
      const meta: ComplianceStatusSourceMeta = {
        sourceId: source.id,
        agency: source.agency,
        description: source.description,
        accessUrl: source.accessUrl,
        tosUrl: source.tosUrl,
        automationAllowed: source.automationAllowed,
        ...(source.auth !== undefined && {
          auth: {
            loginUrl: source.auth.loginUrl,
            instructions: source.auth.instructions,
            evidenceFields: source.auth.evidenceFields,
            forbiddenActions: source.auth.forbiddenActions,
          },
        }),
      }
      return meta
    }),
  )
}

/**
 * Run the read and enrich the report with per-source URL/auth
 * metadata + a server-known `now` so the host LLM can render an
 * actionable, linked, date-aware status narrative without making
 * additional MCP calls.
 */
export async function handleComplianceStatus(
  deps: ComplianceStatusDeps,
): Promise<Result<EnrichedComplianceStatusReport, ComplianceStatusError>> {
  const { config, logger } = deps
  logger.info('compliance-status tool called')

  const reader = resolveStatusReader(deps.readStatus)
  const result = await reader(config.PROJECT_ID)

  if (result.isErr()) {
    return err({
      type: result.error.type,
      message: result.error.message,
    })
  }
  return ok({
    ...result.value,
    now: new Date().toISOString(),
    sources: projectSourceMetadata(),
  })
}
