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
    return [authRequiredFinding(run, outcome.message)]
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

function authRequiredFinding(run: DiscoveryRun, message: string): FindingDraft {
  return {
    code: 'source.auth_required',
    jurisdictionId: run.jurisdictionId,
    sourceId: run.sourceId,
    severity: 'warn',
    title: `Authentication required: ${run.description}`,
    detail: message,
    evidence: {
      code: 'source.auth_required',
      accessMethod: run.accessMethod,
    },
  }
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
      title: 'Entity not found in CA AG Registry reports',
      detail:
        'The CA AG Registry report downloads did not contain a matching EIN, charity number, or SOS/FTB number.',
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
        'The entity appears in the CA AG Registry report for charities that may not operate or solicit.',
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
        'The entity appears in the CA AG Registry report for charities with undetermined status.',
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
      title: 'CA AG Registry reports not operating or dissolving status',
      detail:
        'The entity appears in the CA AG Registry report for charities not operating or in dissolution.',
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
        'The CA AG Registry report matched the entity but did not include a last-renewal date.',
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
