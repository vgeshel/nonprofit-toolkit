import type { Finding, SourceManualEvidenceField } from '../types/index.ts'
import type { DiscoveryReport, DiscoveryRun } from './discover.ts'

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export function isDiscoveryComplete(report: DiscoveryReport): boolean {
  const requiredRuns = report.runs.filter(isRequiredDiscoveryRun)
  const actionableFindings = report.findings.filter(isActionableFinding)
  return (
    requiredRuns.length > 0 &&
    requiredRuns.every((run) => run.outcome.status === 'success') &&
    actionableFindings.every((finding) => finding.severity === 'info')
  )
}

export function formatDiscoveryReport(report: DiscoveryReport): string {
  const lines: string[] = [
    `# Compliance Discovery: ${report.entity.legal_name}`,
    '',
    `Status: ${isDiscoveryComplete(report) ? 'complete' : 'incomplete'}`,
  ]
  const actionRequired = formatActionRequired(report)
  if (actionRequired.length > 0) {
    lines.push('', ...actionRequired)
  }
  lines.push(
    '',
    '## Source Runs',
    ...sortRuns(report.runs).map((run) => formatRun(report, run)),
    '',
    '## Findings',
    ...formatFindings(report.findings),
  )

  if (
    report.migration.createdDataset ||
    report.migration.createdTables.length > 0 ||
    report.migration.addedColumns.length > 0
  ) {
    lines.push(
      '',
      'Compliance storage was provisioned or migrated during this run.',
    )
  }

  return `${lines.join('\n')}\n`
}

type ManualRequiredRun = DiscoveryRun & {
  readonly outcome: Extract<
    DiscoveryRun['outcome'],
    { readonly status: 'manual_required' }
  >
}

type AuthRequiredRun = DiscoveryRun & {
  readonly outcome: Extract<
    DiscoveryRun['outcome'],
    { readonly status: 'auth_required' }
  >
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

function sortRuns(runs: readonly DiscoveryRun[]): DiscoveryRun[] {
  return runs
    .slice()
    .sort(
      (left, right) =>
        left.jurisdictionId.localeCompare(right.jurisdictionId) ||
        left.sourceId.localeCompare(right.sourceId),
    )
}

function formatActionRequired(report: DiscoveryReport): string[] {
  const sortedRuns = sortRuns(report.runs)
  const manualRuns = sortedRuns.filter(
    (run): run is ManualRequiredRun =>
      isRequiredDiscoveryRun(run) && isManualRequiredRun(run),
  )
  const authRuns = sortedRuns.filter(
    (run): run is AuthRequiredRun =>
      isRequiredDiscoveryRun(run) && isAuthRequiredRun(run),
  )
  if (manualRuns.length === 0 && authRuns.length === 0) {
    return []
  }

  const lines: string[] = [
    '## Action Required',
    'Discovery is incomplete until these manual or authenticated checks are completed.',
    'I completed every source that can be checked automatically. These remaining sources require a manual website check or a user-owned authenticated session.',
    'Use these exact values if a site asks:',
    ...formatOrganizationContext(report),
  ]
  if (manualRuns.length > 0) {
    lines.push(
      '',
      'Manual checks:',
      ...manualRuns.flatMap((run) => formatManualActionItem(report, run)),
    )
  }
  if (authRuns.length > 0) {
    lines.push(
      '',
      'Authenticated checks:',
      'I cannot sign in or complete MFA for you. Use an authorized account and complete MFA yourself.',
      ...authRuns.flatMap((run) => formatAuthActionItem(report, run)),
      'Do not paste passwords, MFA codes, backup codes, or session cookies into chat.',
    )
  }
  lines.push(
    '',
    'Reply in plain sentences or bullets. I will map your answers into structured compliance evidence.',
  )
  return lines
}

function isManualRequiredRun(run: DiscoveryRun): run is ManualRequiredRun {
  return run.outcome.status === 'manual_required'
}

function isAuthRequiredRun(run: DiscoveryRun): run is AuthRequiredRun {
  return run.outcome.status === 'auth_required'
}

function formatManualActionItem(
  report: DiscoveryReport,
  run: ManualRequiredRun,
): string[] {
  return [
    `${formatSourceName(run)}:`,
    ...formatNumberedSteps(formatManualSteps(report, run, run.outcome)),
  ]
}

function formatAuthActionItem(
  report: DiscoveryReport,
  run: AuthRequiredRun,
): string[] {
  return [
    `${formatSourceName(run)}:`,
    ...formatNumberedSteps(formatAuthSteps(report, run, run.outcome)),
  ]
}

function formatRun(report: DiscoveryReport, run: DiscoveryRun): string {
  const label = formatSourceName(run)
  const outcome = run.outcome
  switch (outcome.status) {
    case 'success':
      return `- OK ${label}: success`
    case 'manual_required':
      return formatManualRun(report, label, run, outcome)
    case 'policy_blocked':
      return `- BLOCKED ${label}: ${outcome.reason}`
    case 'auth_required':
      if (isOptionalCaAgOnlineRenewalRun(run)) {
        return `- INFO ${label}: optional dashboard review not required because CA AG public registry status is checked automatically`
      }
      return formatAuthRun(report, label, run, outcome)
    case 'source_failure':
      return `- ERROR ${label}: failed (${outcome.error_type}) ${outcome.message}`
  }
}

function formatManualRun(
  report: DiscoveryReport,
  label: string,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'manual_required' }>,
): string {
  return [
    `- MANUAL ${label}: manual verification required`,
    `  Why automatic scan is unavailable: ${formatManualOnlyReason(run)}`,
    `  Official URL: ${run.accessUrl}`,
    `  Source terms reviewed: ${run.tosUrl}`,
    '  Manual steps:',
    ...formatNumberedSteps(formatManualSteps(report, run, outcome)).map(
      (step) => `  ${step}`,
    ),
    '  Tell me these values after you complete the check:',
    ...outcome.evidenceFields.map(formatEvidenceField),
  ].join('\n')
}

function formatManualOnlyReason(run: DiscoveryRun): string {
  if (run.manualOnlyReason === undefined) {
    return 'No manual-only reason was captured for this source.'
  }
  return run.manualOnlyReason
}

function formatEvidenceField(field: SourceManualEvidenceField): string {
  return `  - ${formatEvidenceLabel(field)}`
}

function formatAuthRun(
  report: DiscoveryReport,
  label: string,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'auth_required' }>,
): string {
  if (
    outcome.loginUrl === undefined ||
    outcome.credentialMode === undefined ||
    outcome.credentialFields === undefined ||
    outcome.mfa === undefined ||
    outcome.instructions === undefined ||
    outcome.evidenceFields === undefined ||
    outcome.forbiddenActions === undefined
  ) {
    return `- AUTH ${label}: ${outcome.message}`
  }

  return [
    `- AUTH ${label}: authenticated verification required`,
    `  Login URL: ${outcome.loginUrl}`,
    `  Source terms reviewed: ${run.tosUrl}`,
    '  Credential handling: Sign in yourself; do not paste passwords, MFA codes, backup codes, or session cookies into chat.',
    '  Auth/setup steps:',
    ...formatNumberedSteps(formatAuthSteps(report, run, outcome)).map(
      (step) => `  ${step}`,
    ),
    '  Tell me these values after you complete the check:',
    ...outcome.evidenceFields.map(formatEvidenceField),
    '  Forbidden actions:',
    ...outcome.forbiddenActions.map(
      (action, index) => `  ${index + 1}. ${action}`,
    ),
  ].join('\n')
}

function formatFindings(findings: readonly Finding[]): string[] {
  const actionableFindings = findings.filter(isActionableFinding)
  if (actionableFindings.length === 0) {
    return ['- None.']
  }

  return actionableFindings.slice().sort(compareFindings).map(formatFinding)
}

function isRequiredDiscoveryRun(run: DiscoveryRun): boolean {
  return !isOptionalCaAgOnlineRenewalRun(run)
}

function isActionableFinding(finding: Finding): boolean {
  return finding.source_id !== 'ca-ag-online-filing'
}

function isOptionalCaAgOnlineRenewalRun(run: DiscoveryRun): boolean {
  return (
    run.sourceId === 'ca-ag-online-filing' &&
    run.outcome.status === 'auth_required'
  )
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.jurisdiction_id.localeCompare(right.jurisdiction_id) ||
    left.source_id.localeCompare(right.source_id) ||
    left.title.localeCompare(right.title)
  )
}

function formatFinding(finding: Finding): string {
  return `- ${finding.severity.toUpperCase()} ${formatFindingSourceName(
    finding.source_id,
  )}: ${finding.title} - ${formatFindingDetail(finding.detail)}`
}

function formatOrganizationContext(report: DiscoveryReport): string[] {
  const caIdentifiers = report.identifiers['us-ca']
  return [
    `- Legal entity name: ${report.entity.legal_name}`,
    `- FEIN: ${report.identifiers['us-federal']?.ein ?? 'not configured'}`,
    `- State of incorporation: ${report.entity.state_of_incorporation}`,
    `- State registration or formation date: ${report.entity.formation_date}`,
    `- Mailing address: ${formatMailingAddress(report)}`,
    `- California SOS entity number: ${caIdentifiers?.sosEntityNumber ?? 'not configured'}`,
    `- California AG charity registration number: ${getCaAgCharityNumber(report) ?? 'not configured'}`,
    `- FTB entity ID: ${formatFtbEntityIdForContext(report)}`,
    `- FTB entity name: ${caIdentifiers?.ftbEntityName ?? 'not configured'}`,
    `- CDTFA account identifiers: ${formatConfiguredList(
      listCdtfaAccountIdentifiers(report),
    )}`,
    `- IRS ruling or registration date from IRS EO BMF: ${extractIrsRulingDate(report) ?? 'not available in this discovery run'}`,
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

function formatMailingAddress(report: DiscoveryReport): string {
  const street =
    report.entity.mailing_address_line2 === null
      ? report.entity.mailing_address_line1
      : `${report.entity.mailing_address_line1} ${report.entity.mailing_address_line2}`
  return `${street}, ${report.entity.mailing_address_city}, ${report.entity.mailing_address_region} ${report.entity.mailing_address_postal_code}, ${report.entity.mailing_address_country}`
}

function formatConfiguredList(values: readonly string[]): string {
  if (values.length === 0) {
    return 'not configured'
  }
  return formatList(values)
}

function getCaAgCharityNumber(report: DiscoveryReport): string | null {
  return (
    report.identifiers['us-ca']?.agCharityNumber ??
    readString(
      findSuccessfulPayload(report, 'ca-ag-registry'),
      'stateCharityRegistrationNumber',
    )
  )
}

function formatFtbEntityIdForContext(report: DiscoveryReport): string {
  const configuredOrObserved = getConfiguredOrObservedFtbEntityId(report)
  if (configuredOrObserved !== null) {
    return configuredOrObserved
  }
  const sosEntityNumber = report.identifiers['us-ca']?.sosEntityNumber
  if (sosEntityNumber !== undefined) {
    return `${sosEntityNumber} (using California SOS entity number)`
  }
  return 'not configured'
}

function getFtbEntityIdForLookup(report: DiscoveryReport): string | null {
  return (
    getConfiguredOrObservedFtbEntityId(report) ??
    report.identifiers['us-ca']?.sosEntityNumber ??
    null
  )
}

function getConfiguredOrObservedFtbEntityId(
  report: DiscoveryReport,
): string | null {
  return (
    report.identifiers['us-ca']?.ftbEntityId ??
    readString(
      findSuccessfulPayload(report, 'ca-ftb-entity-status-letter'),
      'entity_id',
    )
  )
}

function extractIrsRulingDate(report: DiscoveryReport): string | null {
  const payload = findSuccessfulPayload(report, 'irs-eo-bmf')
  const row = readRecord(payload, 'row')
  const ruling = readString(row, 'ruling')
  if (ruling === null) {
    return null
  }
  return ruling.replace(/^(\d{4})(\d{2})$/, '$1-$2')
}

function extractPayloadString(
  report: DiscoveryReport,
  sourceId: string,
  key: string,
): string {
  return (
    readString(findSuccessfulPayload(report, sourceId), key) ??
    'not available in this discovery run'
  )
}

function extractPayloadStringWithFallbacks(
  report: DiscoveryReport,
  sourceId: string,
  keys: readonly string[],
): string {
  const payload = findSuccessfulPayload(report, sourceId)
  for (const key of keys) {
    const value = readString(payload, key)
    if (value !== null) {
      return value
    }
  }
  return 'not available in this discovery run'
}

function findSuccessfulPayload(
  report: DiscoveryReport,
  sourceId: string,
): unknown {
  const run = report.runs.find(
    (item) => item.sourceId === sourceId && item.outcome.status === 'success',
  )
  if (run?.outcome.status !== 'success') {
    return null
  }
  return run.outcome.output.record.payload
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
  return Reflect.get(value, key)
}

function formatFindingDetail(detail: string): string {
  let formatted = detail
  for (const [sourceId, sourceName] of Object.entries(SOURCE_DISPLAY_NAMES)) {
    formatted = formatted
      .replaceAll(`Source "${sourceId}"`, sourceName)
      .replaceAll(sourceId, sourceName)
  }
  return formatted
}

function formatSourceName(run: DiscoveryRun): string {
  return (
    SOURCE_DISPLAY_NAMES[run.sourceId] ?? formatDescription(run.description)
  )
}

function formatFindingSourceName(sourceId: string): string {
  return SOURCE_DISPLAY_NAMES[sourceId] ?? humanizeIdentifier(sourceId)
}

function formatDescription(description: string): string {
  const withoutTrailingPeriod = description.endsWith('.')
    ? description.slice(0, -1)
    : description
  return withoutTrailingPeriod
    .replace(/^Manual /, '')
    .replace(/^User-assisted /, '')
}

function humanizeIdentifier(identifier: string): string {
  return identifier
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatNumberedSteps(steps: readonly string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`)
}

function formatManualSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'manual_required' }>,
): string[] {
  if (run.sourceId === 'ca-sos-bizfile') {
    return formatCaSosBizfileManualSteps(report, run)
  }
  if (run.sourceId === 'ca-ftb-entity-status-letter') {
    return formatCaFtbEntityStatusLetterManualSteps(report, run)
  }
  if (run.sourceId === 'ca-cdtfa-permit-license-verification') {
    return formatCaCdtfaPermitLicenseVerificationManualSteps(report, run)
  }
  return [
    `Open ${formatSourceName(run)}: ${run.accessUrl}`,
    `Use this exact legal name: ${report.entity.legal_name}.`,
    formatEvidenceSummary(outcome.evidenceFields),
  ]
}

function formatAuthSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'auth_required' }>,
): string[] {
  if (run.sourceId === 'ca-ftb-myftb') {
    return formatCaFtbMyFtbAuthSteps(report, run, outcome)
  }
  if (run.sourceId === 'ca-cdtfa-online-services') {
    return formatCaCdtfaOnlineServicesAuthSteps(report, run, outcome)
  }

  const evidenceFields = outcome.evidenceFields ?? []
  return [
    formatAuthOpenStep(run, outcome),
    'Sign in yourself with an authorized account and complete MFA yourself.',
    formatEvidenceSummary(evidenceFields),
  ]
}

function formatCaSosBizfileManualSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
): string[] {
  const caIdentifiers = report.identifiers['us-ca']
  const searchStep =
    caIdentifiers === undefined
      ? `Search for this exact legal name: ${report.entity.legal_name}.`
      : `Search for this SOS entity number: ${caIdentifiers.sosEntityNumber}.`
  return [
    `Open ${formatSourceName(run)}: ${run.accessUrl}`,
    searchStep,
    'Tell me the entity status and entity name. Include the jurisdiction and status date if they are shown.',
  ]
}

function formatCaFtbEntityStatusLetterManualSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
): string[] {
  return [
    `Open ${formatSourceName(run)}: ${run.accessUrl}`,
    formatFtbSearchStep(report),
    `Use this exact legal name if the site asks for a name: ${formatFtbEntityName(
      report,
    )}.`,
    'Tell me the FTB status, whether exempt status is verified, and the letter date if shown.',
  ]
}

function formatCaCdtfaPermitLicenseVerificationManualSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
): string[] {
  return [
    `Open ${formatSourceName(run)}: ${run.accessUrl}`,
    'Choose the option to verify a permit, license, or account.',
    formatCdtfaManualIdentifierStep(report),
    'Tell me the account type, account number, verification status, owner name if shown, and status date if shown.',
  ]
}

function formatCaFtbMyFtbAuthSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'auth_required' }>,
): string[] {
  return [
    formatAuthOpenStep(run, outcome),
    'Sign in yourself with an authorized business representative account and complete MFA yourself.',
    formatFtbBusinessAccountStep(report),
    'Tell me whether business account access is available, the FTB account status, action-required messages if shown, and the reviewed-at date.',
  ]
}

function formatCaCdtfaOnlineServicesAuthSteps(
  report: DiscoveryReport,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'auth_required' }>,
): string[] {
  return [
    formatAuthOpenStep(run, outcome),
    'Sign in yourself with an authorized account and complete MFA yourself.',
    formatCdtfaAuthIdentifierStep(report),
    'Tell me whether any CDTFA-managed account is present, the account statuses shown in Online Services, open filing obligations or none shown, notices or billings shown if any, and the reviewed-at date.',
  ]
}

function formatAuthOpenStep(
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'auth_required' }>,
): string {
  return `Open ${formatSourceName(run)}: ${outcome.loginUrl ?? run.accessUrl}`
}

function formatFtbSearchStep(report: DiscoveryReport): string {
  const ftbEntityId = getFtbEntityIdForLookup(report)
  if (ftbEntityId !== null) {
    return `Search for this FTB entity ID: ${ftbEntityId}.`
  }
  return `Search for this exact legal name: ${formatFtbEntityName(report)}.`
}

function formatFtbBusinessAccountStep(report: DiscoveryReport): string {
  const ftbEntityId = getFtbEntityIdForLookup(report)
  if (ftbEntityId !== null) {
    return `Open the business account for this FTB entity ID: ${ftbEntityId}.`
  }
  return `Open the business account for this exact legal name: ${formatFtbEntityName(
    report,
  )}.`
}

function formatFtbEntityName(report: DiscoveryReport): string {
  return report.identifiers['us-ca']?.ftbEntityName ?? report.entity.legal_name
}

function formatCdtfaManualIdentifierStep(report: DiscoveryReport): string {
  const identifiers = listCdtfaAccountIdentifiers(report)
  if (identifiers.length === 0) {
    return 'No CDTFA account identifier is configured. If the organization has a CDTFA permit, license, or account number, use that number; otherwise tell me no CDTFA account identifier is available.'
  }
  return `Search these CDTFA account identifiers: ${formatList(identifiers)}.`
}

function formatCdtfaAuthIdentifierStep(report: DiscoveryReport): string {
  const identifiers = listCdtfaAccountIdentifiers(report)
  if (identifiers.length === 0) {
    return 'No CDTFA account identifier is configured. If the portal shows a CDTFA-managed account for this organization, use that account; otherwise tell me no CDTFA-managed account is present.'
  }
  return `Use these CDTFA account identifiers if the portal asks you to choose an account: ${formatList(
    identifiers,
  )}.`
}

function listCdtfaAccountIdentifiers(report: DiscoveryReport): string[] {
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

function formatEvidenceSummary(
  fields: readonly SourceManualEvidenceField[],
): string {
  if (fields.length === 0) {
    return 'Tell me what status or account information is visible after the read-only check.'
  }
  return `Tell me these results: ${formatList(fields.map(formatEvidenceLabel))}.`
}

function formatEvidenceLabel(field: SourceManualEvidenceField): string {
  if (field.required) {
    return `${field.label} (required)`
  }
  if (isSelfQualifiedOptionalLabel(field.label)) {
    return field.label
  }
  return `${field.label} if shown`
}

function isSelfQualifiedOptionalLabel(label: string): boolean {
  const lowerLabel = label.toLowerCase()
  return (
    lowerLabel.includes('if shown') ||
    lowerLabel.includes('if any') ||
    lowerLabel.includes('or none shown')
  )
}

function formatList(values: readonly string[]): string {
  return values.join(', ')
}
