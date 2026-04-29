import type { Finding } from '../types/index.ts'
import type { DiscoveryReport, DiscoveryRun } from './discover.ts'

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export function isDiscoveryComplete(report: DiscoveryReport): boolean {
  return (
    report.runs.length > 0 &&
    report.runs.every((run) => run.outcome.status === 'success') &&
    report.findings.every((finding) => finding.severity === 'info')
  )
}

export function formatDiscoveryReport(report: DiscoveryReport): string {
  const lines: string[] = [
    `# Compliance Discovery: ${report.entity.legal_name}`,
    '',
    `Status: ${isDiscoveryComplete(report) ? 'complete' : 'incomplete'}`,
    '',
    '## Source Runs',
    ...sortRuns(report.runs).map(formatRun),
    '',
    '## Findings',
    ...formatFindings(report.findings),
  ]

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

function sortRuns(runs: readonly DiscoveryRun[]): DiscoveryRun[] {
  return runs
    .slice()
    .sort(
      (left, right) =>
        left.jurisdictionId.localeCompare(right.jurisdictionId) ||
        left.sourceId.localeCompare(right.sourceId),
    )
}

function formatRun(run: DiscoveryRun): string {
  const label = `${run.jurisdictionId}/${run.sourceId}`
  const outcome = run.outcome
  if (outcome.status === 'success') {
    return `- OK ${label}: success`
  }
  if (outcome.status === 'manual_required') {
    return formatManualRun(label, run, outcome)
  }
  if (outcome.status === 'policy_blocked') {
    return `- BLOCKED ${label}: ${outcome.reason}`
  }
  if (outcome.status === 'auth_required') {
    return `- AUTH ${label}: ${outcome.message}`
  }
  return `- ERROR ${label}: failed (${outcome.error_type}) ${outcome.message}`
}

function formatManualRun(
  label: string,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'manual_required' }>,
): string {
  return [
    `- MANUAL ${label}: manual verification required`,
    `  Why automatic scan is unavailable: ${formatManualOnlyReason(run)}`,
    `  Open manually: ${run.accessUrl}`,
    `  Source terms reviewed: ${run.tosUrl}`,
    '  Manual steps:',
    ...outcome.instructions.map(
      (instruction, index) => `  ${index + 1}. ${instruction}`,
    ),
    '  Give these values back to the compliance-discover skill:',
    ...outcome.evidenceFields.map(formatEvidenceField),
    '  Suggested reply format:',
    `  source: ${label}`,
    ...outcome.evidenceFields.map(formatReplyField),
  ].join('\n')
}

function formatManualOnlyReason(run: DiscoveryRun): string {
  if (run.manualOnlyReason === undefined) {
    return 'No manual-only reason was captured for this source.'
  }
  return run.manualOnlyReason
}

function formatEvidenceField(
  field: Extract<
    DiscoveryRun['outcome'],
    { status: 'manual_required' }
  >['evidenceFields'][number],
): string {
  const requirement = field.required ? 'required' : 'optional'
  return `  - ${field.key} (${requirement}): ${field.label}`
}

function formatReplyField(
  field: Extract<
    DiscoveryRun['outcome'],
    { status: 'manual_required' }
  >['evidenceFields'][number],
): string {
  return `  ${field.key}: <${field.label}>`
}

function formatFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) {
    return ['- None.']
  }

  return findings.slice().sort(compareFindings).map(formatFinding)
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
  return `- ${finding.severity.toUpperCase()} ${finding.jurisdiction_id}/${finding.source_id}: ${finding.title} - ${finding.detail}`
}
