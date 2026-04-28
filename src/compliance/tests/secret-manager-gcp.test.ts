/**
 * Tests for the GCP Secret Manager adapter.
 *
 * Uses a fake `SecretManagerClient` so the adapter logic is fully covered
 * without touching real GCP. The adapter:
 *   - constructs the canonical secret resource name
 *   - decodes the base64 payload
 *   - distinguishes not_found, permission_denied, and generic SDK errors
 *   - on write, ensures the secret exists (creating it if missing) and adds
 *     a new version with the provided payload
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createGcpSecretManagerPort,
  toSecretManagerError,
  type SecretManagerClient,
} from '../state/secret-manager-gcp.ts'

interface FakeError extends Error {
  code?: number
}

function makeGrpcError(code: number, message: string): FakeError {
  const err: FakeError = new Error(message)
  err.code = code
  return err
}

function fakeClient(
  overrides: Partial<SecretManagerClient> = {},
): SecretManagerClient {
  return {
    accessSecretVersion: vi.fn<SecretManagerClient['accessSecretVersion']>(() =>
      Promise.resolve([{ payload: { data: Buffer.from('{}') } }]),
    ),
    getSecret: vi.fn<SecretManagerClient['getSecret']>(() =>
      Promise.resolve([{ name: 'x' }]),
    ),
    createSecret: vi.fn<SecretManagerClient['createSecret']>(() =>
      Promise.resolve([{ name: 'created' }]),
    ),
    addSecretVersion: vi.fn<SecretManagerClient['addSecretVersion']>(() =>
      Promise.resolve([{ name: 'v1' }]),
    ),
    ...overrides,
  }
}

const PROJECT = 'my-project'

describe('createGcpSecretManagerPort.accessSecret', () => {
  it('builds the canonical resource name and decodes payload', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() =>
      Promise.resolve([
        { payload: { data: Buffer.from('hello-world', 'utf8') } },
      ]),
    )
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('compliance-entity-ids')
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe('hello-world')

    const [req] = accessSecretVersion.mock.calls[0] ?? []
    expect(req).toEqual({
      name: `projects/${PROJECT}/secrets/compliance-entity-ids/versions/latest`,
    })
  })

  it('decodes a string payload (some clients return data as a base64 string)', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() =>
      Promise.resolve([
        { payload: { data: Buffer.from('plain', 'utf8').toString('base64') } },
      ]),
    )
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('any-name')
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe('plain')
  })

  it('returns not_found when the SDK responds NOT_FOUND', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() => Promise.reject(makeGrpcError(5, 'no such secret')))
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('missing')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('not_found')
    }
  })

  it('returns permission_denied when the SDK responds PERMISSION_DENIED', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() => Promise.reject(makeGrpcError(7, 'forbidden')))
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('locked')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('permission_denied')
    }
  })

  it('falls back to sdk error for unknown gRPC codes', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() => Promise.reject(makeGrpcError(13, 'internal')))
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('flaky')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
    }
  })

  it('translates non-Error thrown values to a sdk error directly', () => {
    // toSecretManagerError is the place where the non-Error branch lives;
    // exercise it without going through Promise.reject (which would
    // require disabling the `prefer-promise-reject-errors` lint rule).
    const e1 = toSecretManagerError('weird')
    expect(e1.type).toBe('sdk')
    expect(e1.message).toBe('weird')

    const e2 = toSecretManagerError(42)
    expect(e2.type).toBe('sdk')
    expect(e2.message).toBe('42')

    const e3 = toSecretManagerError(null)
    expect(e3.type).toBe('sdk')
    expect(e3.message).toBe('null')
  })

  it('returns sdk error when payload is missing', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() => Promise.resolve([{}]))
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('no-payload')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
      expect(result.error.message).toMatch(/payload/i)
    }
  })

  it('returns sdk error when payload data is missing', async () => {
    const accessSecretVersion = vi.fn<
      SecretManagerClient['accessSecretVersion']
    >(() => Promise.resolve([{ payload: {} }]))
    const port = createGcpSecretManagerPort({
      client: fakeClient({ accessSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.accessSecret('no-data')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
    }
  })
})

describe('createGcpSecretManagerPort.upsertSecret', () => {
  it('reuses an existing secret and only adds a new version', async () => {
    const getSecret = vi.fn<SecretManagerClient['getSecret']>(() =>
      Promise.resolve([{ name: `projects/${PROJECT}/secrets/x` }]),
    )
    const createSecret = vi.fn<SecretManagerClient['createSecret']>(() =>
      Promise.resolve([{ name: 'unused' }]),
    )
    const addSecretVersion = vi.fn<SecretManagerClient['addSecretVersion']>(
      () => Promise.resolve([{ name: `${PROJECT}/secrets/x/versions/2` }]),
    )

    const port = createGcpSecretManagerPort({
      client: fakeClient({ getSecret, createSecret, addSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.upsertSecret('x', 'hello')
    expect(result.isOk()).toBe(true)

    expect(getSecret).toHaveBeenCalledWith({
      name: `projects/${PROJECT}/secrets/x`,
    })
    expect(createSecret).not.toHaveBeenCalled()

    const [addReq] = addSecretVersion.mock.calls[0] ?? []
    expect(addReq).toEqual({
      parent: `projects/${PROJECT}/secrets/x`,
      payload: { data: Buffer.from('hello', 'utf8') },
    })
  })

  it('creates the secret if getSecret returns NOT_FOUND, then adds a version', async () => {
    const getSecret = vi.fn<SecretManagerClient['getSecret']>(() =>
      Promise.reject(makeGrpcError(5, 'no such secret')),
    )
    const createSecret = vi.fn<SecretManagerClient['createSecret']>(() =>
      Promise.resolve([{ name: `projects/${PROJECT}/secrets/x` }]),
    )
    const addSecretVersion = vi.fn<SecretManagerClient['addSecretVersion']>(
      () => Promise.resolve([{ name: 'v1' }]),
    )
    const port = createGcpSecretManagerPort({
      client: fakeClient({ getSecret, createSecret, addSecretVersion }),
      projectId: PROJECT,
    })

    const result = await port.upsertSecret('x', 'init')
    expect(result.isOk()).toBe(true)

    expect(createSecret).toHaveBeenCalledWith({
      parent: `projects/${PROJECT}`,
      secretId: 'x',
      secret: { replication: { automatic: {} } },
    })
    expect(addSecretVersion).toHaveBeenCalledTimes(1)
  })

  it('returns permission_denied when getSecret responds 7', async () => {
    const port = createGcpSecretManagerPort({
      client: fakeClient({
        getSecret: vi.fn<SecretManagerClient['getSecret']>(() =>
          Promise.reject(makeGrpcError(7, 'denied')),
        ),
      }),
      projectId: PROJECT,
    })

    const result = await port.upsertSecret('x', 'value')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('permission_denied')
    }
  })

  it('returns sdk error when createSecret fails', async () => {
    const port = createGcpSecretManagerPort({
      client: fakeClient({
        getSecret: vi.fn<SecretManagerClient['getSecret']>(() =>
          Promise.reject(makeGrpcError(5, 'no such secret')),
        ),
        createSecret: vi.fn<SecretManagerClient['createSecret']>(() =>
          Promise.reject(makeGrpcError(13, 'oops')),
        ),
      }),
      projectId: PROJECT,
    })

    const result = await port.upsertSecret('x', 'value')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
    }
  })

  it('returns sdk error when addSecretVersion fails', async () => {
    const port = createGcpSecretManagerPort({
      client: fakeClient({
        addSecretVersion: vi.fn<SecretManagerClient['addSecretVersion']>(() =>
          Promise.reject(makeGrpcError(13, 'oops')),
        ),
      }),
      projectId: PROJECT,
    })

    const result = await port.upsertSecret('x', 'value')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
    }
  })
})
