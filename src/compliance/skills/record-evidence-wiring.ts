import type { ResultAsync } from 'neverthrow'
import { errAsync } from 'neverthrow'
import { usCaJurisdiction } from '../jurisdictions/us-ca/index.ts'
import { usFederalJurisdiction } from '../jurisdictions/us-federal/index.ts'
import type { RunRecorder } from '../sources/runner.ts'
import { createFindingsAccessor } from '../state/bq-findings.ts'
import { createDiscoveryRunsAccessor } from '../state/bq-runs.ts'
import type { Jurisdiction } from '../types/index.ts'
import { buildRegistry } from './discover-wiring.ts'
import {
  recordComplianceEvidence,
  type ComplianceEvidenceInput,
  type RecordComplianceEvidenceError,
  type RecordComplianceEvidenceReport,
} from './record-evidence.ts'
import {
  buildCommonDeps,
  type BigQueryFactory,
  type SecretManagerFactory,
} from './wiring-common.ts'

export type RecordComplianceEvidenceProductionError =
  | RecordComplianceEvidenceError
  | { readonly type: 'wiring'; readonly message: string }

export interface RecordComplianceEvidenceProductionArgs {
  readonly projectId: string
  readonly input: ComplianceEvidenceInput
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
  readonly jurisdictions?: readonly Jurisdiction[]
}

export function defaultRecordEvidenceNow(): Date {
  return new Date()
}

export function recordComplianceEvidenceProduction(
  args: RecordComplianceEvidenceProductionArgs,
): ResultAsync<
  RecordComplianceEvidenceReport,
  RecordComplianceEvidenceProductionError
> {
  const now = args.now ?? defaultRecordEvidenceNow
  const jurisdictions = args.jurisdictions ?? [
    usFederalJurisdiction,
    usCaJurisdiction,
  ]
  const registryResult = buildRegistry(jurisdictions)
  if (registryResult.kind === 'err') {
    return errAsync({
      type: 'wiring',
      message: `Failed to register jurisdiction "${registryResult.error.id}": ${registryResult.error.message}`,
    })
  }

  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })

  const recorder: RunRecorder = {
    recordRun: (row) =>
      createDiscoveryRunsAccessor({
        runner: deps.queryRunner,
        projectId: args.projectId,
      }).recordRun(row),
    recordFindings: (findings) =>
      createFindingsAccessor({
        runner: deps.queryRunner,
        projectId: args.projectId,
      }).recordFindings(findings),
  }

  return recordComplianceEvidence({
    registry: registryResult.value,
    entityAccessor: deps.entityAccessor,
    identifiersAccessor: deps.identifiersAccessor,
    migrationPort: deps.migrationPort,
    recorder,
    now,
    input: args.input,
  })
}
