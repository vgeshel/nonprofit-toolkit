import type { Finding } from '../types/index.ts'
import type { DiscoveryReport, DiscoveryRun } from './discover.ts'

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export function isDiscoveryComplete(report: DiscoveryReport): boolean {
  return (
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
    return `- MANUAL ${label}: manual verification required`
  }
  if (outcome.status === 'policy_blocked') {
    return `- BLOCKED ${label}: ${outcome.reason}`
  }
  if (outcome.status === 'auth_required') {
    return `- AUTH ${label}: ${outcome.message}`
  }
  return `- ERROR ${label}: failed (${outcome.error_type}) ${outcome.message}`
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
