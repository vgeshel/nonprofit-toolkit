import { v5 as uuidv5 } from 'uuid'
import { z } from 'zod'
import type { DiscoveryRun } from '../skills/discover.ts'
import type {
  Entity,
  EntityIdentifiers,
  Finding,
  FindingSeverity,
} from '../types/index.ts'

const FINDING_NAMESPACE = '05b16a01-46c6-56dd-bd6e-c6dfb4a1427a'

const SourceNamePayloadSchema = z.object({
  name: z.string().min(1).optional(),
  taxPeriod: z.string().optional(),
})

const IrsBmfPayloadSchema = z.object({
  matchStatus: z.enum(['found', 'not_found']),
  row: SourceNamePayloadSchema.optional(),
})

const CaAgPayloadSchema = z.object({
  matchStatus: z.enum(['found', 'not_found']),
  listCategory: z.string().optional(),
  registryStatus: z.string().optional(),
  name: z.string().optional(),
  lastRenewal: z.string().optional(),
})

const CaFtbEntityStatusLetterPayloadSchema = z.object({
  matchStatus: z.enum(['found', 'not_found']),
  ftb_status: z.string().optional(),
  exempt_status_verified: z.string().optional(),
})

const CaSosBizfilePayloadSchema = z.object({
  matchStatus: z.enum(['found', 'not_found']),
  entity_name: z.string().optional(),
  entity_status: z.string().optional(),
})

const CaCdtfaPublicVerificationPayloadSchema = z.object({
  matchStatus: z.enum(['found']),
  account_type: z.string().min(1),
  account_number: z.string().min(1),
  verification_status: z.string().min(1),
  is_valid: z.boolean(),
  owner_name: z.string().nullable().optional(),
})

export interface DeriveComplianceFindingsArgs {
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
  readonly runs: readonly DiscoveryRun[]
  readonly now: () => Date
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

type SuccessDiscoveryRun = DiscoveryRun & {
  readonly outcome: Extract<
    DiscoveryRun['outcome'],
    { readonly status: 'success' }
  >
}

type AuthRequiredDiscoveryRun = DiscoveryRun & {
  readonly outcome: Extract<
    DiscoveryRun['outcome'],
    { readonly status: 'auth_required' }
  >
}

export function deriveComplianceFindings(
  args: DeriveComplianceFindingsArgs,
): Finding[] {
  const drafts: FindingDraft[] = [
    ...deriveIdentifierFindings(args),
    ...args.runs.flatMap((run) =>
      deriveRunFindings(args.entity, run, args.now()),
    ),
  ]
  const openedAt = args.now().toISOString()
  return drafts.map((draft) => toFinding(draft, openedAt))
}

function deriveIdentifierFindings(
  args: DeriveComplianceFindingsArgs,
): FindingDraft[] {
  if (
    args.entity.state_of_incorporation !== 'CA' &&
    args.entity.mailing_address_region !== 'CA'
  ) {
    return []
  }
  if (args.identifiers['us-ca']?.sosEntityNumber !== undefined) {
    return []
  }
  return [
    {
      code: 'entity.ca_sos_identifier_missing',
      jurisdictionId: 'us-ca',
      sourceId: 'entity-identifiers',
      severity: 'warn',
      title: 'California SOS entity number is not configured',
      detail:
        'California compliance discovery cannot verify SOS business standing until the SOS entity number is stored.',
      evidence: {
        code: 'entity.ca_sos_identifier_missing',
        missingIdentifier: 'us-ca.sosEntityNumber',
      },
    },
  ]
}

function deriveRunFindings(
  entity: Entity,
  run: DiscoveryRun,
  now: Date,
): readonly FindingDraft[] {
  const outcome = run.outcome
  if (outcome.status === 'manual_required') {
    return [
      manualRequiredFinding(
        run,
        outcome.evidenceFields.map((f) => f.key),
      ),
    ]
  }
  if (outcome.status === 'policy_blocked') {
    return [policyBlockedFinding(run, outcome.reason)]
  }
  if (outcome.status === 'auth_required') {
    if (run.sourceId === 'ca-ag-online-filing') {
      return []
    }
    return [authRequiredFinding({ ...run, outcome }, outcome.message)]
  }
  if (outcome.status === 'source_failure') {
    return [sourceFailureFinding(run, outcome.error_type, outcome.message)]
  }
  if (outcome.status === 'success' && run.sourceId === 'irs-eo-bmf') {
    return deriveIrsBmfFindings(entity, { ...run, outcome }, now)
  }
  if (outcome.status === 'success' && run.sourceId === 'ca-ag-registry') {
    return deriveCaAgFindings(entity, { ...run, outcome })
  }
  if (
    outcome.status === 'success' &&
    run.sourceId === 'ca-ftb-entity-status-letter'
  ) {
    return deriveCaFtbEntityStatusLetterFindings({ ...run, outcome })
  }
  if (outcome.status === 'success' && run.sourceId === 'ca-sos-bizfile') {
    return deriveCaSosBizfileFindings(entity, { ...run, outcome })
  }
  if (
    outcome.status === 'success' &&
    run.sourceId === 'ca-cdtfa-permit-license-verification'
  ) {
    return deriveCaCdtfaPublicVerificationFindings(entity, {
      ...run,
      outcome,
    })
  }
  return []
}

function manualRequiredFinding(
  run: DiscoveryRun,
  requiredFields: readonly string[],
): FindingDraft {
  return {
    code: 'source.manual_required',
    jurisdictionId: run.jurisdictionId,
    sourceId: run.sourceId,
    severity: 'warn',
    title: `Manual verification required: ${run.description}`,
    detail: `${run.sourceId} cannot be automatically checked under the current source policy. Capture the required manual evidence before treating compliance status as complete.`,
    evidence: {
      code: 'source.manual_required',
      requiredFields: requiredFields.slice(),
      accessMethod: run.accessMethod,
    },
  }
}

function policyBlockedFinding(run: DiscoveryRun, reason: string): FindingDraft {
  return {
    code: 'source.policy_blocked',
    jurisdictionId: run.jurisdictionId,
    sourceId: run.sourceId,
    severity: 'warn',
    title: `Source blocked by policy: ${run.description}`,
    detail: reason,
    evidence: {
      code: 'source.policy_blocked',
      accessMethod: run.accessMethod,
    },
  }
}

function authRequiredFinding(
  run: AuthRequiredDiscoveryRun,
  message: string,
): FindingDraft {
  return {
    code: 'source.auth_required',
    jurisdictionId: run.jurisdictionId,
    sourceId: run.sourceId,
    severity: 'warn',
    title: `Authentication required: ${run.description}`,
    detail: message,
    evidence: authRequiredEvidence(run),
  }
}

function authRequiredEvidence(
  run: AuthRequiredDiscoveryRun,
): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    code: 'source.auth_required',
    accessMethod: run.accessMethod,
  }
  if (run.outcome.loginUrl !== undefined) {
    evidence.loginUrl = run.outcome.loginUrl
  }
  if (run.outcome.credentialMode !== undefined) {
    evidence.credentialMode = run.outcome.credentialMode
  }
  if (run.outcome.evidenceFields !== undefined) {
    evidence.requiredFields = run.outcome.evidenceFields.map(
      (field) => field.key,
    )
  }
  if (run.outcome.forbiddenActions !== undefined) {
    evidence.forbiddenActions = run.outcome.forbiddenActions.slice()
  }
  return evidence
}

function sourceFailureFinding(
  run: DiscoveryRun,
  errorType: string,
  message: string,
): FindingDraft {
  return {
    code: 'source.failed',
    jurisdictionId: run.jurisdictionId,
    sourceId: run.sourceId,
    severity: 'error',
    title: `Source failed: ${run.description}`,
    detail: `${run.sourceId} could not be read: ${message}`,
    evidence: {
      code: 'source.failed',
      errorType,
    },
  }
}

function deriveIrsBmfFindings(
  entity: Entity,
  run: SuccessDiscoveryRun,
  now: Date,
): readonly FindingDraft[] {
  const parsed = IrsBmfPayloadSchema.safeParse(
    run.outcome.output.record.payload,
  )
  if (!parsed.success) {
    return []
  }
  const findings: FindingDraft[] = []
  if (parsed.data.matchStatus === 'not_found') {
    findings.push({
      code: 'federal.bmf_not_found',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'EIN not found in IRS EO BMF',
      detail:
        'The IRS Exempt Organizations Business Master File state extract did not contain the configured EIN.',
      evidence: { code: 'federal.bmf_not_found' },
    })
  }
  const sourceName = parsed.data.row?.name
  if (sourceName !== undefined && !sameName(entity.legal_name, sourceName)) {
    findings.push(nameMismatchFinding(entity, run, sourceName, 'IRS EO BMF'))
  }
  const taxPeriod = parsed.data.row?.taxPeriod
  if (taxPeriod !== undefined && isStaleTaxPeriod(taxPeriod, now)) {
    findings.push({
      code: 'federal.bmf_tax_period_stale',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'Latest IRS BMF tax period appears stale',
      detail: `IRS EO BMF lists tax period "${taxPeriod}", which is more than two tax years behind the current calendar year.`,
      evidence: { code: 'federal.bmf_tax_period_stale', taxPeriod },
    })
  }
  return findings
}

function deriveCaAgFindings(
  entity: Entity,
  run: SuccessDiscoveryRun,
): readonly FindingDraft[] {
  const parsed = CaAgPayloadSchema.safeParse(run.outcome.output.record.payload)
  if (!parsed.success) {
    return []
  }
  const findings: FindingDraft[] = []
  if (parsed.data.matchStatus === 'not_found') {
    findings.push({
      code: 'ca.ag_not_found',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'Entity not found in CA AG Registry Search Tool',
      detail:
        'The public CA AG Registry Search Tool did not return a matching EIN, charity number, SOS/FTB number, or legal name.',
      evidence: { code: 'ca.ag_not_found' },
    })
  }
  if (parsed.data.listCategory === 'may_not_operate_or_solicit') {
    findings.push({
      code: 'ca.ag_may_not_operate',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'error',
      title: 'CA AG Registry status blocks operation or solicitation',
      detail:
        'The public CA AG Registry Search Tool lists a status that blocks operation or solicitation.',
      evidence: {
        code: 'ca.ag_may_not_operate',
        listCategory: parsed.data.listCategory,
        registryStatus: parsed.data.registryStatus ?? null,
      },
    })
  }
  if (parsed.data.listCategory === 'undetermined') {
    findings.push({
      code: 'ca.ag_status_undetermined',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'CA AG Registry status is undetermined',
      detail:
        'The public CA AG Registry Search Tool lists an undetermined status.',
      evidence: {
        code: 'ca.ag_status_undetermined',
        listCategory: parsed.data.listCategory,
        registryStatus: parsed.data.registryStatus ?? null,
      },
    })
  }
  if (parsed.data.listCategory === 'not_operating_or_dissolving') {
    findings.push({
      code: 'ca.ag_not_operating_or_dissolving',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'error',
      title: 'CA AG Registry lists not operating or dissolving status',
      detail:
        'The public CA AG Registry Search Tool lists the entity as not operating or in dissolution.',
      evidence: {
        code: 'ca.ag_not_operating_or_dissolving',
        listCategory: parsed.data.listCategory,
        registryStatus: parsed.data.registryStatus ?? null,
      },
    })
  }
  if (
    parsed.data.matchStatus === 'found' &&
    parsed.data.lastRenewal?.trim().length === 0
  ) {
    findings.push({
      code: 'ca.ag_last_renewal_missing',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'CA AG Registry row has no last-renewal date',
      detail:
        'The public CA AG Registry detail page matched the entity but did not include a last-renewal date.',
      evidence: { code: 'ca.ag_last_renewal_missing' },
    })
  }
  if (
    parsed.data.name !== undefined &&
    parsed.data.name.trim().length > 0 &&
    !sameName(entity.legal_name, parsed.data.name)
  ) {
    findings.push(
      nameMismatchFinding(entity, run, parsed.data.name, 'CA AG Registry'),
    )
  }
  return findings
}

function deriveCaFtbEntityStatusLetterFindings(
  run: SuccessDiscoveryRun,
): readonly FindingDraft[] {
  const parsed = CaFtbEntityStatusLetterPayloadSchema.safeParse(
    run.outcome.output.record.payload,
  )
  if (!parsed.success) {
    return []
  }
  if (parsed.data.matchStatus === 'not_found') {
    return [
      {
        code: 'ca.ftb.entity_status_letter_not_found',
        jurisdictionId: run.jurisdictionId,
        sourceId: run.sourceId,
        severity: 'warn',
        title: 'Entity not found in CA FTB Entity Status Letter',
        detail:
          'The public California FTB Entity Status Letter lookup did not return the configured entity.',
        evidence: { code: 'ca.ftb.entity_status_letter_not_found' },
      },
    ]
  }
  const exemptStatus = parsed.data.exempt_status_verified
  if (exemptStatus === undefined || isFtbExemptStatusVerified(exemptStatus)) {
    return []
  }
  return [
    {
      code: 'ca.ftb.exempt_status_not_verified',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'California FTB exempt status is not verified',
      detail:
        'The public California FTB Entity Status Letter does not verify California exempt status.',
      evidence: {
        code: 'ca.ftb.exempt_status_not_verified',
        exemptStatusVerified: exemptStatus,
      },
    },
  ]
}

function isFtbExemptStatusVerified(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase()
  return (
    normalized === 'yes' ||
    normalized === 'true' ||
    normalized === 'verified' ||
    normalized === 'exempt' ||
    normalized === 'exempt status verified'
  )
}

function deriveCaSosBizfileFindings(
  entity: Entity,
  run: SuccessDiscoveryRun,
): readonly FindingDraft[] {
  const parsed = CaSosBizfilePayloadSchema.safeParse(
    run.outcome.output.record.payload,
  )
  if (!parsed.success) {
    return []
  }
  if (parsed.data.matchStatus === 'not_found') {
    return [
      {
        code: 'ca.sos.bizfile_not_found',
        jurisdictionId: run.jurisdictionId,
        sourceId: run.sourceId,
        severity: 'warn',
        title: 'Entity not found in CA SOS bizfile',
        detail:
          'The public California Secretary of State bizfile search did not return the configured entity.',
        evidence: { code: 'ca.sos.bizfile_not_found' },
      },
    ]
  }
  const findings: FindingDraft[] = []
  const entityStatus = parsed.data.entity_status
  if (entityStatus !== undefined && !isCaSosStatusActive(entityStatus)) {
    findings.push({
      code: 'ca.sos.bizfile_not_active',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'error',
      title: 'CA SOS bizfile status is not active',
      detail: `The public California Secretary of State bizfile search lists entity status "${entityStatus}".`,
      evidence: {
        code: 'ca.sos.bizfile_not_active',
        entityStatus,
      },
    })
  }
  const sourceName = parsed.data.entity_name
  if (sourceName !== undefined && !sameName(entity.legal_name, sourceName)) {
    findings.push(
      nameMismatchFinding(entity, run, sourceName, 'CA SOS bizfile'),
    )
  }
  return findings
}

function isCaSosStatusActive(value: string): boolean {
  return value.trim().toLocaleLowerCase() === 'active'
}

function deriveCaCdtfaPublicVerificationFindings(
  entity: Entity,
  run: SuccessDiscoveryRun,
): readonly FindingDraft[] {
  const parsed = CaCdtfaPublicVerificationPayloadSchema.safeParse(
    run.outcome.output.record.payload,
  )
  if (!parsed.success) {
    return []
  }
  const findings: FindingDraft[] = []
  if (!parsed.data.is_valid) {
    findings.push({
      code: 'ca.cdtfa.public_verification_invalid',
      jurisdictionId: run.jurisdictionId,
      sourceId: run.sourceId,
      severity: 'warn',
      title: 'CA CDTFA public verification says account is invalid',
      detail: `The public CA CDTFA permit, license, or account verification page says ${parsed.data.account_type} ${parsed.data.account_number} is invalid.`,
      evidence: {
        code: 'ca.cdtfa.public_verification_invalid',
        accountType: parsed.data.account_type,
        accountNumber: parsed.data.account_number,
        verificationStatus: parsed.data.verification_status,
      },
    })
  }
  const ownerName = parsed.data.owner_name
  if (
    ownerName !== undefined &&
    ownerName !== null &&
    !sameName(entity.legal_name, ownerName)
  ) {
    findings.push(
      nameMismatchFinding(
        entity,
        run,
        ownerName,
        'CA CDTFA public permit, license, or account verification',
      ),
    )
  }
  return findings
}

function nameMismatchFinding(
  entity: Entity,
  run: DiscoveryRun,
  sourceName: string,
  label: string,
): FindingDraft {
  return {
    code: `cross_source.legal_name_mismatch.${run.sourceId}`,
    jurisdictionId: run.jurisdictionId,
    sourceId: run.sourceId,
    severity: 'warn',
    title: `Legal name mismatch in ${label}`,
    detail: `${label} lists "${sourceName}", but the onboarded legal name is "${entity.legal_name}".`,
    evidence: {
      code: 'cross_source.legal_name_mismatch',
      entityLegalName: entity.legal_name,
      sourceLegalName: sourceName,
    },
  }
}

function sameName(left: string, right: string): boolean {
  return normaliseName(left) === normaliseName(right)
}

function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase()
}

function isStaleTaxPeriod(taxPeriod: string, now: Date): boolean {
  const yearText = taxPeriod.slice(0, 4)
  if (!/^\d{4}$/.test(yearText)) {
    return false
  }
  const year = Number(yearText)
  return now.getUTCFullYear() - year > 2
}

function toFinding(draft: FindingDraft, openedAt: string): Finding {
  return {
    finding_id: stableFindingId(draft),
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

function stableFindingId(draft: FindingDraft): string {
  return uuidv5(
    [draft.code, draft.jurisdictionId, draft.sourceId].join('|'),
    FINDING_NAMESPACE,
  )
}
