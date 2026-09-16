/**
 * MCP tool: compliance-record-evidence
 *
 * Accepts user-provided evidence for a manual or user-assisted
 * authenticated source (e.g. the result of a CA portal lookup that
 * the human pasted in) and persists it as a successful discovery run.
 *
 * Mutates BigQuery (`discovery_runs` and `findings`), so the tool
 * requires `confirm: true`.
 */
import { err, ok, type Result } from 'neverthrow'
import type { Logger } from 'pino'
import { z } from 'zod'
import {
  recordComplianceEvidenceProduction,
  type RecordComplianceEvidenceProductionError,
} from '../../../../../src/compliance/skills/record-evidence-wiring.ts'
import type {
  ComplianceEvidenceInput,
  RecordComplianceEvidenceReport,
} from '../../../../../src/compliance/skills/record-evidence.ts'
import type { Config } from '../../config'

/**
 * Tool-level error envelope.
 */
export interface RecordEvidenceError {
  readonly type:
    | 'unconfirmed'
    | 'not_onboarded'
    | 'validation'
    | 'load'
    | 'persist'
    | 'wiring'
  readonly message: string
}

/**
 * Zod schema for the tool's evidence input. Mirrors
 * `ComplianceEvidenceInputSchema` from the backend but adds tool-side
 * field descriptions.
 */
export const RecordEvidenceInputSchema = z.object({
  sourceId: z
    .string()
    .min(1)
    .describe('Source id from the registry (e.g. "ca-cdtfa-online-services").'),
  observedAt: z.iso
    .datetime()
    .optional()
    .describe(
      'Optional ISO-8601 timestamp when the user observed the evidence.',
    ),
  evidence: z
    .record(z.string(), z.unknown())
    .describe(
      "Free-form evidence object matching the source's manualEvidenceFields / auth.evidenceFields shape. Use the compliance://sources/{sourceId}/manual-evidence-instructions resource to discover the expected keys.",
    ),
})

/**
 * Production runner callable. Default points at the GCP-backed wiring;
 * tests inject a fake.
 */
export type RecordEvidenceRunner = (args: {
  readonly projectId: string
  readonly input: ComplianceEvidenceInput
}) => ReturnType<typeof recordComplianceEvidenceProduction>

export const defaultRecordEvidenceRunner: RecordEvidenceRunner = ({
  projectId,
  input,
}) => recordComplianceEvidenceProduction({ projectId, input })

export function resolveRecordEvidenceRunner(
  override?: RecordEvidenceRunner,
): RecordEvidenceRunner {
  return override ?? defaultRecordEvidenceRunner
}

/**
 * Dependencies injected into the handler.
 */
export interface RecordEvidenceDeps {
  readonly config: Config
  readonly logger: Logger
  readonly runRecordEvidence?: RecordEvidenceRunner
}

/**
 * Map the production wiring's error union to the tool's error envelope.
 * Exported so tests can validate the mapping directly.
 */
export function translateRecordEvidenceError(
  e: RecordComplianceEvidenceProductionError,
): RecordEvidenceError {
  return { type: e.type, message: e.message }
}

/**
 * Handle a compliance-record-evidence tool call.
 */
export async function handleComplianceRecordEvidence(
  input: {
    readonly confirm: boolean
    readonly sourceId: string
    readonly observedAt?: string
    readonly evidence: Record<string, unknown>
  },
  deps: RecordEvidenceDeps,
): Promise<Result<RecordComplianceEvidenceReport, RecordEvidenceError>> {
  deps.logger.info('compliance-record-evidence tool called')
  if (input.confirm !== true) {
    return err({
      type: 'unconfirmed',
      message:
        'compliance-record-evidence requires confirm: true. Refusing to persist evidence without an explicit confirmation.',
    })
  }
  const runner = resolveRecordEvidenceRunner(deps.runRecordEvidence)
  const evidenceInput: ComplianceEvidenceInput = {
    sourceId: input.sourceId,
    evidence: input.evidence,
    ...(input.observedAt !== undefined && { observedAt: input.observedAt }),
  }
  const result = await runner({
    projectId: deps.config.PROJECT_ID,
    input: evidenceInput,
  })
  if (result.isErr()) {
    return err(translateRecordEvidenceError(result.error))
  }
  return ok(result.value)
}
