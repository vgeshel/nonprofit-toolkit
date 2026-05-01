import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import type { EntityAccessor } from '../state/bq-entity.ts'
import type { ComplianceDiscoveryRunRow } from '../state/bq-rows.ts'
import type { EntityIdsAccessor } from '../state/secret-manager.ts'
import type { Entity, EntityIdentifiers, Finding } from '../types/index.ts'

export type ComplianceStatusOverall = 'clear' | 'attention_required' | 'unknown'

export type ComplianceStatusError =
  | { type: 'not_onboarded'; message: string }
  | { type: 'load'; message: string }

interface StatusReaderError {
  readonly type: string
  readonly message: string
}

export interface RunsStatusAccessor {
  listLatestRuns(): ResultAsync<
    readonly ComplianceDiscoveryRunRow[],
    StatusReaderError
  >
}

export interface FindingsStatusAccessor {
  listOpenFindings(): ResultAsync<readonly Finding[], StatusReaderError>
}

export interface GetComplianceStatusArgs {
  readonly entityAccessor: EntityAccessor
  readonly identifiersAccessor: EntityIdsAccessor
  readonly runsAccessor: RunsStatusAccessor
  readonly findingsAccessor: FindingsStatusAccessor
}

export interface ComplianceStatusReport {
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
  readonly latestRuns: readonly ComplianceDiscoveryRunRow[]
  readonly openFindings: readonly Finding[]
  readonly overall: ComplianceStatusOverall
}

export function getComplianceStatus(
  args: GetComplianceStatusArgs,
): ResultAsync<ComplianceStatusReport, ComplianceStatusError> {
  return args.entityAccessor
    .readEntity()
    .mapErr<ComplianceStatusError>((err) => ({
      type: 'load',
      message: `Failed to read entity row: ${err.message}`,
    }))
    .andThen((entity) =>
      args.identifiersAccessor
        .read()
        .mapErr<ComplianceStatusError>((err) => ({
          type: 'load',
          message: `Failed to read entity identifiers: ${err.message}`,
        }))
        .andThen((identifiers) => {
          if (entity === null || identifiers === null) {
            return errAsync<ComplianceStatusReport, ComplianceStatusError>({
              type: 'not_onboarded',
              message:
                'No entity record found. Run the compliance-onboard skill first.',
            })
          }
          return loadStoredStatus({ ...args, entity, identifiers })
        }),
    )
}

interface LoadStoredStatusArgs extends GetComplianceStatusArgs {
  readonly entity: Entity
  readonly identifiers: EntityIdentifiers
}

function loadStoredStatus(
  args: LoadStoredStatusArgs,
): ResultAsync<ComplianceStatusReport, ComplianceStatusError> {
  return args.runsAccessor
    .listLatestRuns()
    .mapErr<ComplianceStatusError>((err) => ({
      type: 'load',
      message: `Failed to read latest discovery runs: ${err.message}`,
    }))
    .andThen((latestRuns) =>
      args.findingsAccessor
        .listOpenFindings()
        .mapErr<ComplianceStatusError>((err) => ({
          type: 'load',
          message: `Failed to read open findings: ${err.message}`,
        }))
        .andThen((openFindings) =>
          okAsync({
            entity: args.entity,
            identifiers: args.identifiers,
            latestRuns,
            openFindings,
            overall: computeOverall(latestRuns, openFindings),
          }),
        ),
    )
}

function computeOverall(
  latestRuns: readonly ComplianceDiscoveryRunRow[],
  openFindings: readonly Finding[],
): ComplianceStatusOverall {
  if (latestRuns.length === 0) {
    return 'unknown'
  }
  if (
    latestRuns.some((run) => run.status === 'failed') ||
    openFindings.some((finding) => finding.severity !== 'info')
  ) {
    return 'attention_required'
  }
  return 'clear'
}

export function formatComplianceStatusReport(
  report: ComplianceStatusReport,
): string {
  const lines: string[] = [
    `# Compliance Status: ${report.entity.legal_name}`,
    '',
    `Overall: ${report.overall}`,
    ...formatNextSteps(report),
    '',
    '## Latest Runs',
    ...formatRuns(report.latestRuns),
    '',
    '## Open Findings',
    ...formatFindings(report.openFindings),
  ]
  return `${lines.join('\n')}\n`
}

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  'ca-ag-online-filing': 'CA Attorney General Online Renewal System',
  'ca-ag-registry': 'CA Attorney General Registry Reports',
  'ca-cdtfa-online-services': 'CA CDTFA Online Services',
  'ca-cdtfa-permit-license-verification':
    'CA CDTFA Permit, License, or Account Verification',
  'ca-ftb-entity-status-letter': 'CA Franchise Tax Board Entity Status Letter',
  'ca-ftb-myftb': 'CA Franchise Tax Board MyFTB',
  'ca-sos-bizfile': 'CA Secretary of State bizfile',
  'irs-eo-bmf': 'IRS Exempt Organizations Business Master File',
  'irs-teos': 'IRS Tax Exempt Organization Search',
}

const CA_AG_REGISTRY_SEARCH_URL =
  'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y'

function formatNextSteps(report: ComplianceStatusReport): string[] {
  if (report.overall === 'clear') {
    return []
  }
  if (report.overall === 'unknown') {
    return [
      '',
      '## Next Steps',
      '- Run compliance-discover to create the first stored discovery snapshot.',
    ]
  }

  const actionSourceIds = listActionSourceIds(report)
  if (actionSourceIds.length === 0) {
    return [
      '',
      '## Next Steps',
      '- Review the open findings below, resolve the underlying compliance issue, then run compliance-discover again to refresh stored status.',
    ]
  }

  return [
    '',
    '## Next Steps',
    'Stored status needs follow-up. Address these items, then run compliance-discover again to refresh stored status.',
    'Use these exact values if a site asks:',
    ...formatOrganizationContext(report),
    ...actionSourceIds.flatMap((sourceId) =>
      formatSourceAction(report, sourceId),
    ),
  ]
}

function formatOrganizationContext(report: ComplianceStatusReport): string[] {
  const caIdentifiers = report.identifiers['us-ca']
  const caAgCharityNumber = getCaAgCharityNumber(report)
  return [
    `- Legal entity name: ${report.entity.legal_name}`,
    `- FEIN: ${report.identifiers['us-federal']?.ein ?? 'not configured'}`,
    `- State of incorporation: ${report.entity.state_of_incorporation}`,
    `- State registration or formation date: ${report.entity.formation_date}`,
    `- Mailing address: ${formatMailingAddress(report.entity)}`,
    `- California SOS entity number: ${caIdentifiers?.sosEntityNumber ?? 'not configured'}`,
    `- California AG charity registration number: ${caAgCharityNumber ?? 'not configured'}`,
    `- FTB entity ID: ${caIdentifiers?.ftbEntityId ?? 'not configured'}`,
    `- FTB entity name: ${caIdentifiers?.ftbEntityName ?? 'not configured'}`,
    `- CDTFA account identifiers: ${formatConfiguredList(
      listCdtfaAccountIdentifiers(report),
    )}`,
    `- IRS ruling or registration date from IRS EO BMF: ${extractIrsRulingDate(report) ?? 'not available in stored status'}`,
    `- CA AG registry status: ${extractPayloadString(
      report,
      'ca-ag-registry',
      'registryStatus',
    )}`,
    `- CA AG registry status date: ${extractPayloadString(
      report,
      'ca-ag-registry',
      'dateStatusSet',
    )}`,
    `- CA AG last renewal: ${extractPayloadString(
      report,
      'ca-ag-registry',
      'lastRenewal',
    )}`,
  ]
}

function getCaAgCharityNumber(report: ComplianceStatusReport): string | null {
  return (
    report.identifiers['us-ca']?.agCharityNumber ??
    readString(
      findPayload(report, 'ca-ag-registry'),
      'stateCharityRegistrationNumber',
    )
  )
}

function formatMailingAddress(entity: Entity): string {
  const street =
    entity.mailing_address_line2 === null
      ? entity.mailing_address_line1
      : `${entity.mailing_address_line1} ${entity.mailing_address_line2}`
  return `${street}, ${entity.mailing_address_city}, ${entity.mailing_address_region} ${entity.mailing_address_postal_code}, ${entity.mailing_address_country}`
}

function formatConfiguredList(values: readonly string[]): string {
  if (values.length === 0) {
    return 'not configured'
  }
  return formatList(values)
}

function extractIrsRulingDate(report: ComplianceStatusReport): string | null {
  const payload = findPayload(report, 'irs-eo-bmf')
  const row = readRecord(payload, 'row')
  const ruling = readString(row, 'ruling')
  if (ruling === null) {
    return null
  }
  return ruling.replace(/^(\d{4})(\d{2})$/, '$1-$2')
}

function extractPayloadString(
  report: ComplianceStatusReport,
  sourceId: string,
  key: string,
): string {
  return (
    readString(findPayload(report, sourceId), key) ??
    'not available in stored status'
  )
}

function findPayload(
  report: ComplianceStatusReport,
  sourceId: string,
): unknown {
  return parsePayload(
    report.latestRuns.find((run) => run.source_id === sourceId)?.payload,
  )
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return value
  }
}

function readRecord(value: unknown, key: string): object | null {
  const field = readField(value, key)
  if (field === null || typeof field !== 'object') {
    return null
  }
  return field
}

function readString(value: unknown, key: string): string | null {
  const field = readField(value, key)
  return typeof field === 'string' && field.trim().length > 0
    ? field.trim()
    : null
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const field: unknown = Reflect.get(value, key)
  return field
}

function listActionSourceIds(report: ComplianceStatusReport): string[] {
  const sourceIds = new Set<string>()
  for (const run of report.latestRuns) {
    if (run.status === 'failed') {
      sourceIds.add(run.source_id)
    }
  }
  for (const finding of report.openFindings) {
    if (finding.severity !== 'info') {
      sourceIds.add(finding.source_id)
    }
  }
  return Array.from(sourceIds).sort((left, right) =>
    formatSourceName(left).localeCompare(formatSourceName(right)),
  )
}

function formatSourceAction(
  report: ComplianceStatusReport,
  sourceId: string,
): string[] {
  switch (sourceId) {
    case 'ca-ag-online-filing':
      return formatCaAgOnlineRenewalAction(report)
    case 'ca-cdtfa-online-services':
      return formatCaCdtfaOnlineServicesAction(report)
    case 'ca-cdtfa-permit-license-verification':
      return formatCaCdtfaPermitVerificationAction(report)
    case 'ca-ftb-entity-status-letter':
      return formatCaFtbEntityStatusLetterAction(report)
    case 'ca-ftb-myftb':
      return formatCaFtbMyFtbAction(report)
    case 'ca-sos-bizfile':
      return formatCaSosBizfileAction(report)
    default:
      return [
        `${formatSourceName(sourceId)}:`,
        '- Review the finding detail below, resolve the issue with the official source, then run compliance-discover again.',
      ]
  }
}

function formatCaSosBizfileAction(report: ComplianceStatusReport): string[] {
  return [
    `${formatSourceName('ca-sos-bizfile')}:`,
    `- Open https://bizfileonline.sos.ca.gov/search/business and ${formatSosSearchInstruction(
      report,
    )}.`,
    '- Tell me the entity status and entity name. Include the jurisdiction and status date if shown.',
  ]
}

function formatCaFtbEntityStatusLetterAction(
  report: ComplianceStatusReport,
): string[] {
  return [
    `${formatSourceName('ca-ftb-entity-status-letter')}:`,
    `- Open https://webapp.ftb.ca.gov/eletter/ and ${formatFtbSearchInstruction(
      report,
    )}.`,
    '- Tell me the FTB status, whether California exempt status is verified, and the letter date if shown.',
  ]
}

function formatCaCdtfaPermitVerificationAction(
  report: ComplianceStatusReport,
): string[] {
  return [
    `${formatSourceName('ca-cdtfa-permit-license-verification')}:`,
    '- Open https://onlineservices.cdtfa.ca.gov/ and choose the option to verify a permit, license, or account.',
    `- ${formatCdtfaPublicIdentifierInstruction(report)}`,
    '- Tell me the account type, account number, verification status, owner name if shown, and start or status date if shown.',
  ]
}

function formatCaAgOnlineRenewalAction(
  report: ComplianceStatusReport,
): string[] {
  return [
    `${formatSourceName('ca-ag-online-filing')}:`,
    '- Public CA AG charity status is already checked from CA Attorney General Registry Reports.',
    `- Use the Registry Search Tool at ${CA_AG_REGISTRY_SEARCH_URL} only if you need to confirm online-renewal eligibility.`,
    '- Open https://rct.doj.ca.gov/eGov/Home.aspx only if you need renewal-dashboard details and an authorized agent can sign in.',
    `- ${formatAgRenewalAccountInstruction(report)}`,
    '- Tell me whether Online Renewal System access is available, the dashboard status or unavailable reason, latest submission status if shown, deficiency or correspondence messages if shown, and the reviewed-at date.',
  ]
}

function formatCaCdtfaOnlineServicesAction(
  report: ComplianceStatusReport,
): string[] {
  return [
    `${formatSourceName('ca-cdtfa-online-services')}:`,
    '- Open https://onlineservices.cdtfa.ca.gov/ and sign in yourself with an authorized account. Complete MFA yourself.',
    `- ${formatCdtfaAuthenticatedIdentifierInstruction(report)}`,
    '- Tell me whether any CDTFA-managed account is present, the account statuses, open filing obligations or none shown, notices or billings if shown, and the reviewed-at date.',
  ]
}

function formatCaFtbMyFtbAction(report: ComplianceStatusReport): string[] {
  return [
    `${formatSourceName('ca-ftb-myftb')}:`,
    '- Open https://www.ftb.ca.gov/myftb/ and sign in yourself with an authorized business representative account. Complete MFA yourself.',
    `- ${formatFtbAccountInstruction(report)}`,
    '- Tell me whether business account access is available, the FTB account status, action-required messages if shown, and the reviewed-at date.',
  ]
}

function formatSosSearchInstruction(report: ComplianceStatusReport): string {
  const sosEntityNumber = report.identifiers['us-ca']?.sosEntityNumber
  if (sosEntityNumber !== undefined) {
    return `search SOS entity number ${sosEntityNumber}`
  }
  return `search exact legal name ${report.entity.legal_name}`
}

function formatFtbSearchInstruction(report: ComplianceStatusReport): string {
  const caIdentifiers = report.identifiers['us-ca']
  if (caIdentifiers?.ftbEntityId !== undefined) {
    return `search FTB entity ID ${caIdentifiers.ftbEntityId}`
  }
  return `search exact legal name ${formatFtbEntityName(report)}`
}

function formatFtbAccountInstruction(report: ComplianceStatusReport): string {
  const caIdentifiers = report.identifiers['us-ca']
  if (caIdentifiers?.ftbEntityId !== undefined) {
    return `Open the business account for FTB entity ID ${caIdentifiers.ftbEntityId}.`
  }
  return `Open the business account for exact legal name ${formatFtbEntityName(
    report,
  )}.`
}

function formatFtbEntityName(report: ComplianceStatusReport): string {
  return report.identifiers['us-ca']?.ftbEntityName ?? report.entity.legal_name
}

function formatAgRenewalAccountInstruction(
  report: ComplianceStatusReport,
): string {
  const agCharityNumber = getCaAgCharityNumber(report)
  if (agCharityNumber !== null) {
    return `Open the renewal account for AG charity registration number ${agCharityNumber}.`
  }
  return `Open the renewal account for exact legal name ${report.entity.legal_name}.`
}

function formatCdtfaPublicIdentifierInstruction(
  report: ComplianceStatusReport,
): string {
  const identifiers = listCdtfaAccountIdentifiers(report)
  if (identifiers.length > 0) {
    return `Search CDTFA account identifier ${formatList(identifiers)}.`
  }
  return 'No CDTFA account identifier is configured. If the organization has a seller permit, license, or account number, use that number; otherwise tell me no CDTFA account identifier is available.'
}

function formatCdtfaAuthenticatedIdentifierInstruction(
  report: ComplianceStatusReport,
): string {
  const identifiers = listCdtfaAccountIdentifiers(report)
  if (identifiers.length > 0) {
    return `Use CDTFA account identifier ${formatList(
      identifiers,
    )} if the portal asks you to choose an account.`
  }
  return 'No CDTFA account identifier is configured. If the portal shows a CDTFA-managed account for this organization, use that account; otherwise tell me no CDTFA-managed account is present.'
}

function listCdtfaAccountIdentifiers(
  report: ComplianceStatusReport,
): readonly string[] {
  const caIdentifiers = report.identifiers['us-ca']
  const identifiers: string[] = []
  if (caIdentifiers?.cdtfaSellerPermitNumber !== undefined) {
    identifiers.push(caIdentifiers.cdtfaSellerPermitNumber)
  }
  if (caIdentifiers?.cdtfaUseTaxAccountNumber !== undefined) {
    identifiers.push(caIdentifiers.cdtfaUseTaxAccountNumber)
  }
  if (caIdentifiers?.cdtfaSpecialTaxAccountNumber !== undefined) {
    identifiers.push(caIdentifiers.cdtfaSpecialTaxAccountNumber)
  }
  return identifiers
}

function formatList(values: readonly string[]): string {
  return values.join(', ')
}

function formatSourceName(sourceId: string): string {
  return SOURCE_DISPLAY_NAMES[sourceId] ?? sourceId
}

function formatRuns(runs: readonly ComplianceDiscoveryRunRow[]): string[] {
  if (runs.length === 0) {
    return ['- None recorded.']
  }
  return runs.map((run) => {
    const label = `${run.jurisdiction_id}/${run.source_id}`
    if (run.status === 'succeeded') {
      return `- OK ${label}: ${run.completed_at}`
    }
    return `- FAILED ${label}: ${run.error_type ?? 'unknown'} ${run.error_message ?? ''}`.trim()
  })
}

function formatFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) {
    return ['- None.']
  }
  return findings.map(
    (finding) =>
      `- ${finding.severity.toUpperCase()} ${finding.jurisdiction_id}/${finding.source_id}: ${finding.title}`,
  )
}
