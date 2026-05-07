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
  const actionableRuns = latestRuns.filter(isActionableRun)
  const actionableFindings = openFindings.filter(isActionableFinding)
  if (
    actionableRuns.some((run) => run.status === 'failed') ||
    actionableFindings.some((finding) => finding.severity !== 'info')
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
    ...formatRuns(report),
    '',
    '## Open Findings',
    ...formatFindings(report),
  ]
  return `${lines.join('\n')}\n`
}

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  'ca-ag-online-filing': 'CA Attorney General Online Renewal System',
  'ca-ag-registry': 'CA Attorney General Registry Search Tool',
  'ca-cdtfa-online-services': 'CA CDTFA Online Services',
  'ca-cdtfa-permit-license-verification':
    'CA CDTFA Permit, License, or Account Verification',
  'ca-ftb-entity-status-letter': 'CA Franchise Tax Board Entity Status Letter',
  'ca-ftb-myftb': 'CA Franchise Tax Board MyFTB',
  'ca-sos-bizfile': 'CA Secretary of State bizfile',
  'irs-eo-bmf': 'IRS Exempt Organizations Business Master File',
  'irs-teos': 'IRS Tax Exempt Organization Search',
}

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
  const ftbEntityName = getConfiguredFtbEntityName(report)
  return [
    `- Legal entity name: ${report.entity.legal_name}`,
    `- FEIN: ${report.identifiers['us-federal']?.ein ?? 'not configured'}`,
    `- State of incorporation: ${report.entity.state_of_incorporation}`,
    `- State registration or formation date: ${report.entity.formation_date}`,
    `- Mailing address: ${formatMailingAddress(report.entity)}`,
    `- California SOS entity number: ${caIdentifiers?.sosEntityNumber ?? 'not configured'}`,
    `- California AG charity registration number: ${caAgCharityNumber ?? 'not configured'}`,
    `- FTB entity ID: ${formatFtbEntityIdForContext(report)}`,
    `- FTB entity name: ${ftbEntityName ?? 'not configured'}`,
    `- CDTFA account identifiers: ${formatConfiguredList(
      listCdtfaAccountIdentifiers(report),
    )}`,
    `- IRS ruling or registration date from IRS EO BMF: ${extractIrsRulingDate(report) ?? 'not available in stored status'}`,
    `- CA AG registry status: ${extractPayloadString(
      report,
      'ca-ag-registry',
      'registryStatus',
    )}`,
    `- CA AG registry status date: ${extractPayloadStringWithFallbacks(report, 'ca-ag-registry', ['dateStatusSet', 'effectiveDate'])}`,
    `- CA AG renewal due or expiration date: ${extractPayloadString(report, 'ca-ag-registry', 'renewalDueDate')}`,
    `- CA AG issue date: ${extractPayloadString(report, 'ca-ag-registry', 'issueDate')}`,
    `- CA AG effective date: ${extractPayloadString(report, 'ca-ag-registry', 'effectiveDate')}`,
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

function getFtbEntityId(report: ComplianceStatusReport): string | null {
  return (
    report.identifiers['us-ca']?.ftbEntityId ??
    readString(
      findPayload(report, 'ca-ftb-entity-status-letter'),
      'entity_id',
    ) ??
    report.identifiers['us-ca']?.sosEntityNumber ??
    null
  )
}

function formatFtbEntityIdForContext(report: ComplianceStatusReport): string {
  const configuredOrObserved =
    report.identifiers['us-ca']?.ftbEntityId ??
    readString(findPayload(report, 'ca-ftb-entity-status-letter'), 'entity_id')
  if (configuredOrObserved !== undefined && configuredOrObserved !== null) {
    return configuredOrObserved
  }
  const sosEntityNumber = report.identifiers['us-ca']?.sosEntityNumber
  if (sosEntityNumber !== undefined) {
    return `${sosEntityNumber} (using California SOS entity number)`
  }
  return 'not configured'
}

function getConfiguredFtbEntityName(
  report: ComplianceStatusReport,
): string | null {
  return (
    report.identifiers['us-ca']?.ftbEntityName ??
    readString(
      findPayload(report, 'ca-ftb-entity-status-letter'),
      'entity_name',
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

function extractPayloadStringWithFallbacks(
  report: ComplianceStatusReport,
  sourceId: string,
  keys: readonly string[],
): string {
  const payload = findPayload(report, sourceId)
  for (const key of keys) {
    const value = readString(payload, key)
    if (value !== null) {
      return value
    }
  }
  return 'not available in stored status'
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

function readBoolean(value: unknown, key: string): boolean | null {
  const field = readField(value, key)
  return typeof field === 'boolean' ? field : null
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
    if (isActionableRun(run) && run.status === 'failed') {
      sourceIds.add(run.source_id)
    }
  }
  for (const finding of report.openFindings) {
    if (isActionableFinding(finding) && finding.severity !== 'info') {
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
  const storedIssue = formatStoredCaSosBizfileIssue(report)
  if (storedIssue.length > 0) {
    return storedIssue
  }
  return [
    `${formatSourceName('ca-sos-bizfile')}:`,
    '- The automated CA SOS bizfile public search did not complete in the latest stored run. Run compliance-discover again to retry the public-page check.',
    '- This is an automation or source-access issue, not a manual evidence request. Fix the source failure before treating SOS status as checked.',
  ]
}

function formatStoredCaSosBizfileIssue(
  report: ComplianceStatusReport,
): string[] {
  const latestRun = report.latestRuns.find(
    (run) => run.source_id === 'ca-sos-bizfile' && run.status === 'succeeded',
  )
  if (latestRun === undefined) {
    return []
  }
  const payload = parsePayload(latestRun.payload)
  const matchStatus = readString(payload, 'matchStatus')
  if (matchStatus === 'not_found') {
    return [
      `${formatSourceName('ca-sos-bizfile')}:`,
      '- Latest public CA SOS bizfile search did not return the configured entity.',
      '- The public bizfile check is automated; run compliance-discover again whenever you want to refresh this stored status.',
      '- If the entity should exist in California, confirm the configured SOS entity number and legal name, correct the stored identifiers if needed, then rerun compliance-discover.',
    ]
  }
  const entityStatus = extractPayloadString(
    report,
    'ca-sos-bizfile',
    'entity_status',
  )
  const entityName = extractPayloadString(
    report,
    'ca-sos-bizfile',
    'entity_name',
  )
  const sosEntityNumber = extractPayloadString(
    report,
    'ca-sos-bizfile',
    'sos_entity_number',
  )
  const initialFilingDate = extractPayloadString(
    report,
    'ca-sos-bizfile',
    'initial_filing_date',
  )
  const entityType = extractPayloadString(
    report,
    'ca-sos-bizfile',
    'entity_type',
  )
  const formedIn = extractPayloadString(report, 'ca-sos-bizfile', 'formed_in')
  const agent = extractPayloadString(report, 'ca-sos-bizfile', 'agent')
  return [
    `${formatSourceName('ca-sos-bizfile')}:`,
    `- Latest public CA SOS bizfile search says entity status ${entityStatus}, entity name ${entityName}, SOS entity number ${sosEntityNumber}, initial filing date ${initialFilingDate}, entity type ${entityType}, formed in ${formedIn}, and agent ${agent}.`,
    '- The public bizfile check is automated; run compliance-discover again whenever you want to refresh this stored status.',
    '- If the stored status is not Active or the displayed name or number is wrong, correct the record with CA SOS or the registered agent, then rerun compliance-discover.',
  ]
}

function formatCaFtbEntityStatusLetterAction(
  report: ComplianceStatusReport,
): string[] {
  const storedIssue = formatStoredFtbEntityStatusIssue(report)
  if (storedIssue.length > 0) {
    return storedIssue
  }
  return [
    `${formatSourceName('ca-ftb-entity-status-letter')}:`,
    `- Open https://webapp.ftb.ca.gov/eletter/ and ${formatFtbSearchInstruction(
      report,
    )}.`,
    '- Tell me the FTB status, whether California exempt status is verified, and the letter date if shown.',
  ]
}

function formatStoredFtbEntityStatusIssue(
  report: ComplianceStatusReport,
): string[] {
  const latestRun = report.latestRuns.find(
    (run) =>
      run.source_id === 'ca-ftb-entity-status-letter' &&
      run.status === 'succeeded',
  )
  if (latestRun === undefined) {
    return []
  }
  const payload = parsePayload(latestRun.payload)
  const ftbStatus = readString(payload, 'ftb_status')
  const exemptStatus = readString(payload, 'exempt_status_verified')
  if (exemptStatus === null || isFtbExemptStatusVerified(exemptStatus)) {
    return []
  }
  return [
    `${formatSourceName('ca-ftb-entity-status-letter')}:`,
    `- Latest public FTB Entity Status Letter says FTB status ${ftbStatus ?? 'not available in stored status'} and California exempt status ${exemptStatus}.`,
    '- The public Entity Status Letter check is automated; run compliance-discover again whenever you want to refresh this stored status.',
    '- Use CA Franchise Tax Board MyFTB or FTB support to determine whether California exemption should be registered or corrected. After FTB updates the account, run compliance-discover again to verify the new Entity Status Letter result.',
  ]
}

function isFtbExemptStatusVerified(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized === 'yes' ||
    normalized === 'true' ||
    normalized === 'verified' ||
    normalized === 'exempt' ||
    normalized === 'exempt status verified'
  )
}

function formatCaCdtfaPermitVerificationAction(
  report: ComplianceStatusReport,
): string[] {
  const storedIssue = formatStoredCdtfaPublicVerificationIssue(report)
  if (storedIssue.length > 0) {
    return storedIssue
  }
  const identifiers = listCdtfaConfiguredPublicIdentifiers(report)
  const retryInstruction =
    identifiers.length === 0
      ? '- No CDTFA seller permit or use-tax account number is configured. Store the known CDTFA identifier, then run compliance-discover again.'
      : '- The automated CA CDTFA public verification did not complete in the latest stored run. Run compliance-discover again to retry the public-page check.'
  return [
    `${formatSourceName('ca-cdtfa-permit-license-verification')}:`,
    retryInstruction,
    '- This is an automation or configuration issue, not a manual evidence request.',
  ]
}

function formatStoredCdtfaPublicVerificationIssue(
  report: ComplianceStatusReport,
): string[] {
  const latestRun = report.latestRuns.find(
    (run) =>
      run.source_id === 'ca-cdtfa-permit-license-verification' &&
      run.status === 'succeeded',
  )
  if (latestRun === undefined) {
    return []
  }
  const payload = parsePayload(latestRun.payload)
  if (readBoolean(payload, 'is_valid') === null) {
    return []
  }
  const accountType = extractPayloadString(
    report,
    'ca-cdtfa-permit-license-verification',
    'account_type',
  )
  const accountNumber = extractPayloadString(
    report,
    'ca-cdtfa-permit-license-verification',
    'account_number',
  )
  const verificationStatus = extractPayloadString(
    report,
    'ca-cdtfa-permit-license-verification',
    'verification_status',
  )
  const ownerName = extractPayloadString(
    report,
    'ca-cdtfa-permit-license-verification',
    'owner_name',
  )
  const startDate = extractPayloadString(
    report,
    'ca-cdtfa-permit-license-verification',
    'start_date',
  )
  return [
    `${formatSourceName('ca-cdtfa-permit-license-verification')}:`,
    `- Latest public CA CDTFA verification says ${accountType} ${accountNumber} status ${formatCdtfaVerificationStatus(verificationStatus)}${formatOptionalCdtfaContext('owner name', ownerName)}${formatOptionalCdtfaContext('start date', startDate)}.`,
    '- The public CDTFA verification check is automated; run compliance-discover again whenever you want to refresh this stored status.',
    '- If the stored status, owner name, or account number is wrong, correct the CDTFA identifier or account record, then rerun compliance-discover.',
  ]
}

function formatOptionalCdtfaContext(label: string, value: string): string {
  return value === 'not available in stored status' ? '' : `, ${label} ${value}`
}

function formatCdtfaVerificationStatus(value: string): string {
  return value.replace(/\.$/, '')
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

function formatFtbSearchInstruction(report: ComplianceStatusReport): string {
  const ftbEntityId = getFtbEntityId(report)
  if (ftbEntityId !== null) {
    return `search FTB entity ID ${ftbEntityId}`
  }
  return `search exact legal name ${formatFtbEntityName(report)}`
}

function formatFtbAccountInstruction(report: ComplianceStatusReport): string {
  const ftbEntityId = getFtbEntityId(report)
  if (ftbEntityId !== null) {
    return `Open the business account for FTB entity ID ${ftbEntityId}.`
  }
  return `Open the business account for exact legal name ${formatFtbEntityName(
    report,
  )}.`
}

function formatFtbEntityName(report: ComplianceStatusReport): string {
  return getConfiguredFtbEntityName(report) ?? report.entity.legal_name
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
  return Array.from(
    new Set(
      [
        caIdentifiers?.cdtfaSellerPermitNumber,
        caIdentifiers?.cdtfaUseTaxAccountNumber,
        caIdentifiers?.cdtfaSpecialTaxAccountNumber,
        readString(
          findPayload(report, 'ca-cdtfa-permit-license-verification'),
          'account_number',
        ),
      ].filter(isPresentString),
    ),
  )
}

function listCdtfaConfiguredPublicIdentifiers(
  report: ComplianceStatusReport,
): readonly string[] {
  const caIdentifiers = report.identifiers['us-ca']
  return [
    caIdentifiers?.cdtfaSellerPermitNumber,
    caIdentifiers?.cdtfaUseTaxAccountNumber,
  ].filter(isPresentString)
}

function isPresentString(value: string | undefined | null): value is string {
  return value !== undefined && value !== null
}

function formatList(values: readonly string[]): string {
  return values.join(', ')
}

function formatSourceName(sourceId: string): string {
  return SOURCE_DISPLAY_NAMES[sourceId] ?? sourceId
}

function formatRuns(report: ComplianceStatusReport): string[] {
  if (report.latestRuns.length === 0) {
    return ['- None recorded.']
  }
  return report.latestRuns.map((run) => {
    const label = `${run.jurisdiction_id}/${run.source_id}`
    if (isOptionalCaAgOnlineRenewalRun(run)) {
      return `- INFO ${label}: optional dashboard review not required because CA AG public registry status is checked automatically`
    }
    if (run.status === 'succeeded') {
      return `- OK ${label}: ${run.completed_at}`
    }
    return `- FAILED ${label}: ${run.error_type ?? 'unknown'} ${run.error_message ?? ''}`.trim()
  })
}

function formatFindings(report: ComplianceStatusReport): string[] {
  const findings = report.openFindings.filter(isActionableFinding)
  if (findings.length === 0) {
    return ['- None.']
  }
  return findings.map(
    (finding) =>
      `- ${finding.severity.toUpperCase()} ${finding.jurisdiction_id}/${finding.source_id}: ${finding.title}`,
  )
}

function isActionableRun(run: ComplianceDiscoveryRunRow): boolean {
  return !isOptionalCaAgOnlineRenewalRun(run)
}

function isActionableFinding(finding: Finding): boolean {
  return !isOptionalCaAgOnlineRenewalFinding(finding)
}

function isOptionalCaAgOnlineRenewalRun(
  run: ComplianceDiscoveryRunRow,
): boolean {
  return (
    run.source_id === 'ca-ag-online-filing' &&
    run.status === 'failed' &&
    run.error_type === 'auth_required'
  )
}

function isOptionalCaAgOnlineRenewalFinding(finding: Finding): boolean {
  return finding.source_id === 'ca-ag-online-filing'
}
