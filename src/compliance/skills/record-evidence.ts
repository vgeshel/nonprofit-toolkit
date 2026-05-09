import { errAsync, type ResultAsync } from 'neverthrow'
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid'
import { z } from 'zod'
import type { JurisdictionRegistry } from '../registry/jurisdiction-registry.ts'
import type { RunRecorder } from '../sources/runner.ts'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { ComplianceDiscoveryRunRow } from '../state/bq-rows.ts'
import { ensureComplianceSchema } from '../state/ensure-schema.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type {
  Finding,
  FindingSeverity,
  Source,
  SourceManualEvidenceField,
} from '../types/index.ts'
import type { ComplianceMigrationPort } from './migrate.ts'

const USER_EVIDENCE_FINDING_NAMESPACE = '9fb5d675-53d0-53d4-b9e6-8784d57d62cc'

export const ComplianceEvidenceInputSchema = z.object({
  sourceId: z.string().min(1),
  observedAt: z.iso.datetime().optional(),
  evidence: z.record(z.string(), z.unknown()),
})

export type ComplianceEvidenceInput = z.infer<
  typeof ComplianceEvidenceInputSchema
>

export type RecordComplianceEvidenceError =
  | { readonly type: 'not_onboarded'; readonly message: string }
  | { readonly type: 'validation'; readonly message: string }
  | { readonly type: 'load'; readonly message: string }
  | { readonly type: 'persist'; readonly message: string }

export interface RecordComplianceEvidenceArgs {
  readonly registry: JurisdictionRegistry
  readonly entityAccessor: EntityAccessor
  readonly identifiersAccessor: EntityIdsAccessor
  readonly migrationPort: ComplianceMigrationPort
  readonly recorder: RunRecorder
  readonly now: () => Date
  readonly input: ComplianceEvidenceInput
}

export interface RecordComplianceEvidenceReport {
  readonly sourceId: string
  readonly jurisdictionId: string
  readonly runId: string
  readonly recordedAt: string
  readonly findings: readonly Finding[]
}

interface EvidenceRequirement {
  readonly source: Source
  readonly fields: readonly SourceManualEvidenceField[]
  readonly collectionMethod: 'manual' | 'user_assisted_authenticated'
}

interface FindingDraft {
  readonly code: string
  readonly jurisdictionId: string
  readonly sourceId: string
  readonly severity: FindingSeverity
  readonly title: string
  readonly detail: string
  readonly evidence: Record<string, unknown>
}

type PrepareEvidenceResult =
  | { readonly kind: 'ok'; readonly value: EvidenceRequirement }
  | { readonly kind: 'err'; readonly error: RecordComplianceEvidenceError }

/**
 * Persist user-provided manual/authenticated evidence as a successful source
 * run. Raw discovery tables stay append-only; current-state views decide which
 * source-gap findings are still open after this later successful run.
 */
export function recordComplianceEvidence(
  args: RecordComplianceEvidenceArgs,
): ResultAsync<RecordComplianceEvidenceReport, RecordComplianceEvidenceError> {
  return ensureComplianceSchema(args.migrationPort)
    .mapErr<RecordComplianceEvidenceError>((err) => ({
      type: 'load',
      message: `Compliance schema migration failed: ${err.message}`,
    }))
    .andThen(() =>
      args.entityAccessor
        .readEntity()
        .mapErr<RecordComplianceEvidenceError>((err) => ({
          type: 'load',
          message: `Failed to read entity row: ${err.message}`,
        })),
    )
    .andThen((entity) =>
      args.identifiersAccessor
        .read()
        .mapErr<RecordComplianceEvidenceError>((err) => ({
          type: 'load',
          message: `Failed to read entity identifiers: ${err.message}`,
        }))
        .andThen((identifiers) => {
          if (entity === null || identifiers === null) {
            return errAsync<
              RecordComplianceEvidenceReport,
              RecordComplianceEvidenceError
            >({
              type: 'not_onboarded',
              message:
                'No entity record found. Run the compliance-onboard skill first.',
            })
          }
          return recordValidatedEvidence(args)
        }),
    )
}

function recordValidatedEvidence(
  args: RecordComplianceEvidenceArgs,
): ResultAsync<RecordComplianceEvidenceReport, RecordComplianceEvidenceError> {
  const prepared = prepareEvidenceRequirement(args.registry, args.input)
  if (prepared.kind === 'err') {
    return errAsync(prepared.error)
  }

  const recordedAt = args.now().toISOString()
  const row = makeEvidenceRunRow({
    input: args.input,
    requirement: prepared.value,
    recordedAt,
  })
  const findings = deriveEvidenceFindings({
    source: prepared.value.source,
    evidence: args.input.evidence,
    openedAt: recordedAt,
  })

  return args.recorder
    .recordRun(row)
    .mapErr<RecordComplianceEvidenceError>((err) => ({
      type: 'persist',
      message: `Failed to persist discovery_runs row: ${err.message}`,
    }))
    .andThen(() =>
      args.recorder
        .recordFindings(findings)
        .mapErr<RecordComplianceEvidenceError>((err) => ({
          type: 'persist',
          message: `Failed to persist evidence findings: ${err.message}`,
        })),
    )
    .map(() => ({
      sourceId: row.source_id,
      jurisdictionId: row.jurisdiction_id,
      runId: row.run_id,
      recordedAt,
      findings,
    }))
}

function prepareEvidenceRequirement(
  registry: JurisdictionRegistry,
  input: ComplianceEvidenceInput,
): PrepareEvidenceResult {
  const source = findSource(registry, input.sourceId)
  if (source === null) {
    return {
      kind: 'err',
      error: {
        type: 'validation',
        message: `Unknown compliance source "${input.sourceId}".`,
      },
    }
  }

  const requirement = getEvidenceRequirement(source)
  if (requirement.kind === 'err') {
    return requirement
  }

  const missingFields = listMissingRequiredFields(
    requirement.value.fields,
    input.evidence,
  )
  if (missingFields.length > 0) {
    return {
      kind: 'err',
      error: {
        type: 'validation',
        message: `Missing required evidence for ${source.id}: ${missingFields.join(', ')}.`,
      },
    }
  }

  return requirement
}

function findSource(
  registry: JurisdictionRegistry,
  sourceId: string,
): Source | null {
  for (const jurisdiction of registry.list()) {
    for (const source of jurisdiction.sources) {
      if (source.id === sourceId) {
        return source
      }
    }
  }
  return null
}

function getEvidenceRequirement(source: Source): PrepareEvidenceResult {
  if (!source.automationAllowed) {
    return {
      kind: 'ok',
      value: {
        source,
        fields: source.manualEvidenceFields,
        collectionMethod: 'manual',
      },
    }
  }

  if (source.authRequired && source.auth !== undefined) {
    return {
      kind: 'ok',
      value: {
        source,
        fields: source.auth.evidenceFields,
        collectionMethod: 'user_assisted_authenticated',
      },
    }
  }

  return {
    kind: 'err',
    error: {
      type: 'validation',
      message: `Source "${source.id}" does not declare manual or authenticated evidence fields.`,
    },
  }
}

function listMissingRequiredFields(
  fields: readonly SourceManualEvidenceField[],
  evidence: Record<string, unknown>,
): readonly string[] {
  const missing: string[] = []
  for (const field of fields) {
    if (field.required && !hasPresentValue(evidence, field.key)) {
      missing.push(field.label)
    }
  }
  return missing
}

function hasPresentValue(
  evidence: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.hasOwn(evidence, key)) {
    return false
  }
  const value = evidence[key]
  if (value === null || value === undefined) {
    return false
  }
  if (typeof value === 'string') {
    return value.trim().length > 0
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return true
}

interface MakeEvidenceRunRowArgs {
  readonly input: ComplianceEvidenceInput
  readonly requirement: EvidenceRequirement
  readonly recordedAt: string
}

function makeEvidenceRunRow(
  args: MakeEvidenceRunRowArgs,
): ComplianceDiscoveryRunRow {
  const payload: Record<string, unknown> = {
    ...args.input.evidence,
    sourceId: args.requirement.source.id,
    evidenceSource: 'user_provided',
    collectionMethod: args.requirement.collectionMethod,
    recordedAt: args.recordedAt,
  }
  if (args.input.observedAt !== undefined) {
    payload.observedAt = args.input.observedAt
  }

  return {
    run_id: uuidv4(),
    source_id: args.requirement.source.id,
    jurisdiction_id: args.requirement.source.jurisdiction,
    status: 'succeeded',
    started_at: args.recordedAt,
    completed_at: args.recordedAt,
    duration_ms: 0,
    error_type: null,
    error_message: null,
    payload,
  }
}

interface DeriveEvidenceFindingsArgs {
  readonly source: Source
  readonly evidence: Record<string, unknown>
  readonly openedAt: string
}

function deriveEvidenceFindings(
  args: DeriveEvidenceFindingsArgs,
): readonly Finding[] {
  if (args.source.id === 'ca-cdtfa-online-services') {
    return deriveCdtfaOnlineServicesFindings(args)
  }
  if (args.source.id === 'ca-ftb-entity-status-letter') {
    return deriveFtbEntityStatusLetterFindings(args)
  }
  return []
}

function deriveCdtfaOnlineServicesFindings(
  args: DeriveEvidenceFindingsArgs,
): readonly Finding[] {
  const drafts: FindingDraft[] = []
  const filingObligations = readEvidenceText(
    args.evidence,
    'open_filing_obligations',
  )
  if (hasMeaningfulIssueText(filingObligations)) {
    drafts.push({
      code: 'ca.cdtfa.open_filing_obligations',
      jurisdictionId: args.source.jurisdiction,
      sourceId: args.source.id,
      severity: 'warn',
      title: 'CDTFA Online Services shows open filing obligations',
      detail:
        'The user-assisted CDTFA Online Services review reported open filing obligations.',
      evidence: {
        code: 'ca.cdtfa.open_filing_obligations',
        openFilingObligations: filingObligations,
      },
    })
  }

  const noticesOrBillings = readEvidenceText(
    args.evidence,
    'notices_or_billings',
  )
  if (hasMeaningfulIssueText(noticesOrBillings)) {
    drafts.push({
      code: 'ca.cdtfa.notices_or_billings',
      jurisdictionId: args.source.jurisdiction,
      sourceId: args.source.id,
      severity: 'warn',
      title: 'CDTFA Online Services shows notices or billings',
      detail:
        'The user-assisted CDTFA Online Services review reported notices or billings.',
      evidence: {
        code: 'ca.cdtfa.notices_or_billings',
        noticesOrBillings,
      },
    })
  }

  const balance = readEvidenceText(args.evidence, 'balance')
  if (hasNonzeroBalance(balance)) {
    drafts.push({
      code: 'ca.cdtfa.nonzero_balance',
      jurisdictionId: args.source.jurisdiction,
      sourceId: args.source.id,
      severity: 'warn',
      title: 'CDTFA Online Services shows a nonzero balance',
      detail:
        'The user-assisted CDTFA Online Services review reported a nonzero balance.',
      evidence: {
        code: 'ca.cdtfa.nonzero_balance',
        balance,
      },
    })
  }

  return drafts.map((draft) => toFinding(draft, args.openedAt))
}

function deriveFtbEntityStatusLetterFindings(
  args: DeriveEvidenceFindingsArgs,
): readonly Finding[] {
  const exemptStatus = readEvidenceText(args.evidence, 'exempt_status_verified')
  if (exemptStatus === null || isAffirmativeClearText(exemptStatus)) {
    return []
  }
  return [
    toFinding(
      {
        code: 'ca.ftb.exempt_status_not_verified',
        jurisdictionId: args.source.jurisdiction,
        sourceId: args.source.id,
        severity: 'warn',
        title: 'California FTB exempt status is not verified',
        detail:
          'The manual California FTB Entity Status Letter evidence did not verify California exempt status.',
        evidence: {
          code: 'ca.ftb.exempt_status_not_verified',
          exemptStatusVerified: exemptStatus,
        },
      },
      args.openedAt,
    ),
  ]
}

function readEvidenceText(
  evidence: Record<string, unknown>,
  key: string,
): string | null {
  return valueToEvidenceText(evidence[key])
}

function valueToEvidenceText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  return text.length > 0 ? text : null
}

function hasMeaningfulIssueText(text: string | null): boolean {
  if (text === null) {
    return false
  }
  return !isClearText(text)
}

function hasNonzeroBalance(text: string | null): boolean {
  if (text === null) {
    return false
  }
  const amount = Number(text.replace(/[$,]/g, '').trim())
  if (!Number.isFinite(amount)) {
    return hasMeaningfulIssueText(text)
  }
  return amount !== 0
}

function isClearText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    normalized === 'none' ||
    normalized === 'none shown' ||
    normalized === 'no' ||
    normalized === 'n/a' ||
    normalized === 'not applicable' ||
    normalized === '0' ||
    normalized === 'zero' ||
    normalized.startsWith('no ')
  )
}

function isAffirmativeClearText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    normalized === 'yes' ||
    normalized === 'true' ||
    normalized === 'verified' ||
    normalized === 'exempt' ||
    normalized === 'exempt status verified'
  )
}

function toFinding(draft: FindingDraft, openedAt: string): Finding {
  return {
    finding_id: uuidv5(
      [draft.code, draft.jurisdictionId, draft.sourceId].join('|'),
      USER_EVIDENCE_FINDING_NAMESPACE,
    ),
    jurisdiction_id: draft.jurisdictionId,
    source_id: draft.sourceId,
    severity: draft.severity,
    status: 'open',
    title: draft.title,
    detail: draft.detail,
    evidence: draft.evidence,
    opened_at: openedAt,
    resolved_at: null,
  }
}
