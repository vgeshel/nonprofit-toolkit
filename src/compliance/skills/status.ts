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
    '',
    '## Latest Runs',
    ...formatRuns(report.latestRuns),
    '',
    '## Open Findings',
    ...formatFindings(report.openFindings),
  ]
  return `${lines.join('\n')}\n`
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
