import type { ResultAsync } from 'neverthrow'
import { createFindingsAccessor } from '../state/bq-findings.ts'
import { createDiscoveryRunsAccessor } from '../state/bq-runs.ts'
import {
  getComplianceStatus,
  type ComplianceStatusError,
  type ComplianceStatusReport,
} from './status.ts'
import {
  buildCommonDeps,
  type BigQueryFactory,
  type SecretManagerFactory,
} from './wiring-common.ts'

export interface GetComplianceStatusProductionArgs {
  readonly projectId: string
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
  readonly now?: () => Date
}

export function defaultComplianceStatusNow(): Date {
  return new Date()
}

export function getComplianceStatusProduction(
  args: GetComplianceStatusProductionArgs,
): ResultAsync<ComplianceStatusReport, ComplianceStatusError> {
  const now = args.now ?? defaultComplianceStatusNow
  const deps = buildCommonDeps({
    projectId: args.projectId,
    now,
    bqFactory: args.bqFactory,
    secretManagerFactory: args.secretManagerFactory,
  })

  return getComplianceStatus({
    entityAccessor: deps.entityAccessor,
    identifiersAccessor: deps.identifiersAccessor,
    runsAccessor: createDiscoveryRunsAccessor({
      runner: deps.queryRunner,
      projectId: args.projectId,
    }),
    findingsAccessor: createFindingsAccessor({
      runner: deps.queryRunner,
      projectId: args.projectId,
    }),
  })
}
