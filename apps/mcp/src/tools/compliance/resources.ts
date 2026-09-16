/**
 * MCP resources for the compliance surface.
 *
 * Three URI-addressable read-only views the host model can pull as
 * grounding context:
 *
 *   compliance://status                              — current state
 *   compliance://sources/registry                    — available sources
 *   compliance://onboarding/interview-questions      — field metadata
 *
 * One template for per-source manual-evidence instructions:
 *
 *   compliance://sources/{sourceId}/manual-evidence-instructions
 *
 * Each builder is pure: it takes the underlying data and returns the
 * MCP-shaped `ReadResourceResult`. The MCP wiring in `index.ts` plugs
 * the reader callbacks into these.
 */
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { usCaJurisdiction } from '../../../../../src/compliance/jurisdictions/us-ca/index.ts'
import { usFederalJurisdiction } from '../../../../../src/compliance/jurisdictions/us-federal/index.ts'
import { ONBOARD_INTERVIEW_QUESTIONS } from '../../../../../src/compliance/skills/onboard.ts'
import type { Jurisdiction } from '../../../../../src/compliance/types/index.ts'
import type { EnrichedComplianceStatusReport } from './status'

/**
 * Resource URIs. Exported as constants so tests and registration code
 * share the same source of truth.
 */
export const COMPLIANCE_STATUS_URI = 'compliance://status'
export const COMPLIANCE_SOURCES_REGISTRY_URI = 'compliance://sources/registry'
export const COMPLIANCE_INTERVIEW_QUESTIONS_URI =
  'compliance://onboarding/interview-questions'
export const COMPLIANCE_MANUAL_EVIDENCE_URI_TEMPLATE =
  'compliance://sources/{sourceId}/manual-evidence-instructions'

/**
 * MCP-shaped resource read result. We re-export the SDK's exact shape so
 * the registration code can use these builders' return values directly.
 */
export type ResourceReadResult = ReadResourceResult

/**
 * Default jurisdictions used by the resource builders. Mirrors the
 * production default in `discover-wiring.ts`.
 */
export const DEFAULT_JURISDICTIONS: readonly Jurisdiction[] = [
  usFederalJurisdiction,
  usCaJurisdiction,
]

/**
 * Build the aggregated-status resource body. The caller pipes the
 * `ComplianceStatusReport` from `getComplianceStatusProduction` into
 * this; we serialise it as JSON for the host model.
 */
export function buildStatusResource(
  report: EnrichedComplianceStatusReport,
): ResourceReadResult {
  return {
    contents: [
      {
        uri: COMPLIANCE_STATUS_URI,
        mimeType: 'application/json',
        text: JSON.stringify(serialiseStatus(report), null, 2),
      },
    ],
  }
}

/**
 * Project an `EnrichedComplianceStatusReport` into a JSON-safe shape.
 * Includes `now` (server timestamp) and `sources` (per-source URL +
 * auth metadata) so the host LLM has everything it needs to render a
 * linked, date-aware status narrative without making additional MCP
 * calls.
 */
export function serialiseStatus(
  report: EnrichedComplianceStatusReport,
): Record<string, unknown> {
  return {
    overall: report.overall,
    now: report.now,
    entity: report.entity,
    identifiers: report.identifiers,
    latestRuns: report.latestRuns,
    openFindings: report.openFindings,
    sources: report.sources,
  }
}

/**
 * Build the source-registry resource body. Lists every source from the
 * supplied jurisdictions with its identifying metadata. Defaults to the
 * production-default jurisdictions.
 */
export function buildSourceRegistryResource(
  jurisdictions: readonly Jurisdiction[] = DEFAULT_JURISDICTIONS,
): ResourceReadResult {
  const items = jurisdictions.flatMap((j) =>
    j.sources.map((source) => ({
      sourceId: source.id,
      jurisdictionId: j.id,
      // Explicit agency name so downstream narrators don't conflate
      // sources from different agencies (e.g. CA FTB vs. CA AG)
      // because they share the same jurisdictionId.
      agency: source.agency,
      kind: source.kind,
      description: source.description,
      accessUrl: source.accessUrl,
      accessMethod: source.accessMethod,
      automationAllowed: source.automationAllowed,
      authRequired: source.authRequired,
      tosUrl: source.tosUrl,
      sourceFreshness: source.sourceFreshness,
      manualOnlyReason: source.automationAllowed
        ? null
        : source.manualOnlyReason,
      manualEvidenceFieldsAvailable:
        !source.automationAllowed && source.manualEvidenceFields.length > 0,
    })),
  )
  return {
    contents: [
      {
        uri: COMPLIANCE_SOURCES_REGISTRY_URI,
        mimeType: 'application/json',
        text: JSON.stringify({ sources: items }, null, 2),
      },
    ],
  }
}

/**
 * Build the onboarding-interview-questions resource body. The MCP
 * agent uses this to drive the conversational interview before calling
 * `compliance-onboard` or `compliance-onboard-update`.
 */
export function buildInterviewQuestionsResource(): ResourceReadResult {
  return {
    contents: [
      {
        uri: COMPLIANCE_INTERVIEW_QUESTIONS_URI,
        mimeType: 'application/json',
        text: JSON.stringify(
          { questions: ONBOARD_INTERVIEW_QUESTIONS },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Build the manual-evidence-instructions resource body for a single
 * source. Returns null when no source matches the supplied id (the MCP
 * wiring converts null into a structured "not found" response).
 */
export function buildManualEvidenceInstructionsResource(
  sourceId: string,
  jurisdictions: readonly Jurisdiction[] = DEFAULT_JURISDICTIONS,
): ResourceReadResult | null {
  for (const j of jurisdictions) {
    for (const source of j.sources) {
      if (source.id !== sourceId) {
        continue
      }
      const uri = COMPLIANCE_MANUAL_EVIDENCE_URI_TEMPLATE.replace(
        '{sourceId}',
        sourceId,
      )
      const auth = source.auth
      const body: Record<string, unknown> = {
        sourceId: source.id,
        jurisdictionId: j.id,
        agency: source.agency,
        description: source.description,
        accessUrl: source.accessUrl,
        tosUrl: source.tosUrl,
        automationAllowed: source.automationAllowed,
      }
      if (!source.automationAllowed) {
        body.manualOnlyReason = source.manualOnlyReason
        body.instructions = source.manualInstructions
        body.evidenceFields = source.manualEvidenceFields
      }
      if (auth !== undefined) {
        body.auth = {
          loginUrl: auth.loginUrl,
          credentialMode: auth.credentialMode,
          credentialFields: auth.credentialFields,
          mfa: auth.mfa,
          instructions: auth.instructions,
          evidenceFields: auth.evidenceFields,
          forbiddenActions: auth.forbiddenActions,
        }
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(body, null, 2),
          },
        ],
      }
    }
  }
  return null
}
