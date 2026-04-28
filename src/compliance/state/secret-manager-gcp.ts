/**
 * Production adapter that wraps `@google-cloud/secret-manager` into the
 * `SecretManagerPort` shape. Kept separate from the accessor logic so the
 * accessor tests stay pure.
 *
 * gRPC error code translation:
 *   5  = NOT_FOUND          → `not_found`
 *   7  = PERMISSION_DENIED  → `permission_denied`
 *   *  = anything else      → `sdk`
 */
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import { z } from 'zod'
import type { SecretManagerError, SecretManagerPort } from './secret-manager.ts'

/**
 * gRPC code constants used by `@google-cloud/secret-manager`.
 */
const GRPC_NOT_FOUND = 5
const GRPC_PERMISSION_DENIED = 7

/**
 * The minimum surface we need from the `SecretManagerServiceClient`. Typing
 * the methods individually (instead of importing the SDK type) keeps the
 * file's tests independent of the SDK at type level — we only need a duck
 * with these four methods.
 */
export interface SecretManagerClient {
  accessSecretVersion(request: {
    name: string
  }): Promise<readonly [unknown, ...unknown[]]>
  getSecret(request: {
    name: string
  }): Promise<readonly [unknown, ...unknown[]]>
  createSecret(request: {
    parent: string
    secretId: string
    secret: { replication: { automatic: object } }
  }): Promise<readonly [unknown, ...unknown[]]>
  addSecretVersion(request: {
    parent: string
    payload: { data: Buffer | Uint8Array | string }
  }): Promise<readonly [unknown, ...unknown[]]>
}

/**
 * Wiring.
 */
export interface GcpSecretManagerPortDeps {
  readonly client: SecretManagerClient
  readonly projectId: string
}

/**
 * Schema describing the shape of an `accessSecretVersion` response payload.
 * The SDK's typings for `data` are loose (Buffer | Uint8Array | string |
 * undefined) so we validate at runtime to keep our types narrow.
 */
const AccessResponseSchema = z.object({
  payload: z
    .object({
      data: z.union([
        z.instanceof(Buffer),
        z.instanceof(Uint8Array),
        z.string(),
      ]),
    })
    .optional(),
})

/**
 * Schema for the `code` property an SDK error may carry. The Google client
 * libraries set `code` to a numeric gRPC status; we narrow at runtime.
 */
const ErrorCodeSchema = z.object({ code: z.number().optional() })

/**
 * Translate a thrown SDK error into a typed `SecretManagerError`.
 *
 * Exported (under the `_internal` namespace) so the non-Error branch can be
 * exercised by a direct unit test rather than via `Promise.reject` of a
 * non-Error (which the project's `prefer-promise-reject-errors` lint rule
 * forbids).
 *
 * `ErrorCodeSchema` has every field optional, so it always succeeds on any
 * record-shaped input. We `parse` (not `safeParse`) here because the only
 * inputs that would fail are non-objects, and we already excluded those via
 * the `instanceof Error` check.
 */
export function toSecretManagerError(err: unknown): SecretManagerError {
  if (err instanceof Error) {
    const code = ErrorCodeSchema.parse(err).code
    if (code === GRPC_NOT_FOUND) {
      return { type: 'not_found', message: err.message }
    }
    if (code === GRPC_PERMISSION_DENIED) {
      return { type: 'permission_denied', message: err.message }
    }
    return { type: 'sdk', message: err.message }
  }
  return { type: 'sdk', message: String(err) }
}

/**
 * Decode a payload `data` field into a UTF-8 string.
 *
 * The SDK can return `data` as:
 *   - a Node `Buffer`            (most common)
 *   - a `Uint8Array`             (raw bytes)
 *   - a base64-encoded string    (some configurations)
 */
function decodePayloadData(data: Buffer | Uint8Array | string): string {
  if (typeof data === 'string') {
    return Buffer.from(data, 'base64').toString('utf8')
  }
  return Buffer.from(data).toString('utf8')
}

/**
 * Construct a `SecretManagerPort` backed by a real GCP client.
 */
export function createGcpSecretManagerPort(
  deps: GcpSecretManagerPortDeps,
): SecretManagerPort {
  const projectName = `projects/${deps.projectId}`

  return {
    accessSecret(name) {
      const resource = `${projectName}/secrets/${name}/versions/latest`
      return ResultAsync.fromPromise(
        deps.client.accessSecretVersion({ name: resource }),
        toSecretManagerError,
      ).andThen<string, SecretManagerError>(([raw]) => {
        const parsed = AccessResponseSchema.safeParse(raw)
        if (!parsed.success || parsed.data.payload?.data === undefined) {
          return errAsync({
            type: 'sdk',
            message: `accessSecretVersion returned no payload data for ${name}`,
          })
        }
        return okAsync(decodePayloadData(parsed.data.payload.data))
      })
    },

    upsertSecret(name, payload) {
      const secretResource = `${projectName}/secrets/${name}`

      const ensureSecret: ResultAsync<void, SecretManagerError> =
        ResultAsync.fromPromise(
          deps.client.getSecret({ name: secretResource }),
          toSecretManagerError,
        )
          .map(() => undefined)
          .orElse((err) => {
            if (err.type === 'not_found') {
              return ResultAsync.fromPromise(
                deps.client.createSecret({
                  parent: projectName,
                  secretId: name,
                  secret: { replication: { automatic: {} } },
                }),
                toSecretManagerError,
              ).map(() => undefined)
            }
            return errAsync<void, SecretManagerError>(err)
          })

      return ensureSecret.andThen(() =>
        ResultAsync.fromPromise(
          deps.client.addSecretVersion({
            parent: secretResource,
            payload: { data: Buffer.from(payload, 'utf8') },
          }),
          toSecretManagerError,
        ).map(() => undefined),
      )
    },
  }
}
