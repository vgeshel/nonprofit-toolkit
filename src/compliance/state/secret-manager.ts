/**
 * Entity-IDs Secret Manager accessor.
 *
 * Phase 1 stores all entity IDs as a single JSON document in one secret
 * (`compliance-entity-ids`). One secret, one round-trip, one place to look.
 * Per-jurisdiction credentials get separate secrets in later phases (the
 * shape stays the same, just one accessor per concern).
 *
 * The accessor depends on a small `SecretManagerPort` so its tests don't
 * need a real GCP client. The production adapter for the port lives in
 * `secret-manager-gcp.ts`.
 */
import type { ResultAsync } from 'neverthrow'
import { errAsync, okAsync } from 'neverthrow'
import {
  EntityIdentifiersSchema,
  type EntityIdentifiers,
} from '../types/index.ts'

/**
 * Stable secret name. Hard-coded so we have a single place to change it.
 *
 * The leading prefix `compliance-` keeps it from colliding with secrets
 * created by other parts of the codebase (donor-data, MCP creds, etc.).
 */
export const ENTITY_IDS_SECRET_NAME = 'compliance-entity-ids'

/**
 * Failure modes a Secret Manager port may emit.
 *
 * - `not_found`        — the secret does not exist (treated as "no IDs yet")
 * - `permission_denied`— caller lacks IAM access
 * - `sdk`              — any other SDK error (network, invalid arg, etc.)
 */
export type SecretManagerError =
  | { type: 'not_found'; message: string }
  | { type: 'permission_denied'; message: string }
  | { type: 'sdk'; message: string }

/**
 * Tiny port the accessor relies on. The production adapter wraps the
 * `@google-cloud/secret-manager` client; tests pass a `vi.fn()` impl.
 */
export interface SecretManagerPort {
  accessSecret(name: string): ResultAsync<string, SecretManagerError>
  upsertSecret(
    name: string,
    payload: string,
  ): ResultAsync<void, SecretManagerError>
}

/**
 * Errors emitted by the accessor.
 */
export type EntityIdsAccessorError =
  | SecretManagerError
  | { type: 'parse'; message: string }
  | { type: 'validation'; message: string }

/**
 * Wiring.
 */
export interface EntityIdsAccessorDeps {
  readonly port: SecretManagerPort
}

/**
 * Accessor surface.
 */
export interface EntityIdsAccessor {
  read(): ResultAsync<EntityIdentifiers | null, EntityIdsAccessorError>
  write(
    identifiers: EntityIdentifiers,
  ): ResultAsync<void, EntityIdsAccessorError>
}

/**
 * Construct the accessor.
 */
export function createEntityIdsAccessor(
  deps: EntityIdsAccessorDeps,
): EntityIdsAccessor {
  return {
    read() {
      // Map SecretManagerError to EntityIdsAccessorError before chaining so
      // the chain has a single, consistent error type. `not_found` becomes
      // a successful `null` (per the public contract), every other SM error
      // is preserved verbatim.
      return deps.port
        .accessSecret(ENTITY_IDS_SECRET_NAME)
        .orElse((err): ResultAsync<string | null, EntityIdsAccessorError> => {
          if (err.type === 'not_found') {
            return okAsync(null)
          }
          return errAsync(err)
        })
        .andThen(
          (
            raw,
          ): ResultAsync<EntityIdentifiers | null, EntityIdsAccessorError> => {
            if (raw === null) {
              return okAsync(null)
            }
            return parsePayload(raw)
          },
        )
    },

    write(identifiers) {
      const validation = EntityIdentifiersSchema.safeParse(identifiers)
      if (!validation.success) {
        return errAsync<void, EntityIdsAccessorError>({
          type: 'validation',
          message: validation.error.message,
        })
      }
      return deps.port
        .upsertSecret(ENTITY_IDS_SECRET_NAME, JSON.stringify(validation.data))
        .mapErr<EntityIdsAccessorError>((err) => err)
    },
  }
}

/**
 * Stringify a thrown value defensively. Centralised so the
 * `instanceof Error` branch is in one place we can directly exercise from
 * tests, instead of duplicating the conditional everywhere a `try/catch`
 * lives.
 */
export function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

function parsePayload(
  raw: string,
): ResultAsync<EntityIdentifiers | null, EntityIdsAccessorError> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return errAsync({
      type: 'parse',
      message: `Secret payload is not valid JSON: ${describeThrown(err)}`,
    })
  }
  const parsed = EntityIdentifiersSchema.safeParse(json)
  if (!parsed.success) {
    return errAsync({
      type: 'parse',
      message: `Secret payload did not match EntityIdentifiers schema: ${parsed.error.message}`,
    })
  }
  return okAsync(parsed.data)
}
