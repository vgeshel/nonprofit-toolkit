/**
 * Shared production wiring for compliance skills.
 *
 * `runOnboardingProduction` and `runDiscoveryProduction` both need the same
 * GCP-backed plumbing: a `BigQuery` instance adapted into the migration port
 * and the query runner, and a `SecretManagerServiceClient` adapted into the
 * entity-IDs accessor. This module owns that boilerplate so the per-skill
 * wiring stays small.
 *
 * Tests inject `bqFactory` / `secretManagerFactory` to avoid hitting GCP. The
 * defaults construct real SDK clients with the supplied `projectId`.
 */
import { BigQuery } from '@google-cloud/bigquery'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import {
  adaptBigQueryToBqClient,
  adaptBigQueryToQueryRunner,
} from '../state/bq-adapters.ts'
import {
  createEntityAccessor,
  type BqQueryRunner,
  type EntityAccessor,
} from '../state/bq-entity.ts'
import {
  createGcpSecretManagerPort,
  type SecretManagerClient,
} from '../state/secret-manager-gcp.ts'
import {
  createEntityIdsAccessor,
  type EntityIdsAccessor,
} from '../state/secret-manager.ts'
import { makeBqPort } from './migrate-cli.ts'
import type { ComplianceMigrationPort } from './migrate.ts'

/**
 * Factory shapes for the production GCP SDK clients. Tests inject fakes by
 * providing custom factories; production callers omit them and the defaults
 * construct the real SDK classes.
 */
export type BigQueryFactory = (projectId: string) => BigQuery
export type SecretManagerFactory = () => SecretManagerServiceClient

/**
 * Default factory for `BigQuery`. Uses the project id passed by the caller —
 * the skill never reads it from the environment, by contract.
 */
export const defaultBigQueryFactory: BigQueryFactory = (projectId) =>
  new BigQuery({ projectId })

/**
 * Default factory for `SecretManagerServiceClient`. The SDK reads
 * application-default credentials from the environment (or the standard
 * `GOOGLE_APPLICATION_CREDENTIALS` chain) — the project id is passed
 * explicitly to the accessor that uses this client, not to the constructor.
 */
export const defaultSecretManagerFactory: SecretManagerFactory = () =>
  new SecretManagerServiceClient()

/**
 * Bundle of port-shaped objects the skill orchestrators consume.
 */
export interface CommonDeps {
  readonly migrationPort: ComplianceMigrationPort
  readonly identifiersAccessor: EntityIdsAccessor
  readonly entityAccessor: EntityAccessor
  readonly queryRunner: BqQueryRunner
  readonly projectId: string
}

/**
 * Wiring args common to both production skill entry points.
 */
export interface BuildCommonDepsArgs {
  readonly projectId: string
  readonly now: () => Date
  readonly bqFactory?: BigQueryFactory
  readonly secretManagerFactory?: SecretManagerFactory
}

/**
 * Build the shared production deps: a `BigQuery` adapted to both the
 * migration port and the query runner, plus a `SecretManagerServiceClient`
 * adapted into the entity-IDs accessor.
 *
 * The same `BigQuery` instance backs both `migrationPort` and
 * `entityAccessor`'s `BqQueryRunner` so the skill makes one set of HTTP
 * connections, not two.
 */
export function buildCommonDeps(args: BuildCommonDepsArgs): CommonDeps {
  const bqFactory = args.bqFactory ?? defaultBigQueryFactory
  const secretManagerFactory =
    args.secretManagerFactory ?? defaultSecretManagerFactory

  const bq = bqFactory(args.projectId)
  const sm = secretManagerFactory()

  const migrationPort = makeBqPort(adaptBigQueryToBqClient(bq))
  const queryRunner = adaptBigQueryToQueryRunner(bq)
  const entityAccessor = createEntityAccessor({
    runner: queryRunner,
    projectId: args.projectId,
    now: args.now,
  })
  // `SecretManagerServiceClient` exposes a wider surface than the narrow
  // `SecretManagerClient` port; the port's typing covers exactly the four
  // methods we use, so the real client structurally satisfies it. The cast
  // happens via an explicit subset adapter so we never `as` the SDK type.
  const identifiersAccessor = createEntityIdsAccessor({
    port: createGcpSecretManagerPort({
      client: subsetSecretManagerClient(sm),
      projectId: args.projectId,
    }),
  })

  return {
    migrationPort,
    identifiersAccessor,
    entityAccessor,
    queryRunner,
    projectId: args.projectId,
  }
}

/**
 * Adapt the wide `SecretManagerServiceClient` to the narrow
 * `SecretManagerClient` port the GCP adapter consumes.
 *
 * The SDK's overloaded method signatures (request/options/callback variants)
 * don't structurally line up with a single signature, so we forward each
 * call individually. This keeps `bq-adapters.ts`'s "wrap-each-call" pattern
 * applied here too — and avoids needing an `as` cast on the SDK class.
 */
function subsetSecretManagerClient(
  sm: SecretManagerServiceClient,
): SecretManagerClient {
  return {
    accessSecretVersion: (request) => sm.accessSecretVersion(request),
    getSecret: (request) => sm.getSecret(request),
    createSecret: (request) => sm.createSecret(request),
    addSecretVersion: (request) => sm.addSecretVersion(request),
  }
}
