/**
 * Tests for the entity-IDs Secret Manager accessor.
 *
 * The accessor takes a small port (`SecretManagerPort`) so the tests don't
 * need a real GCP client. The production adapter for the port is in
 * `secret-manager-gcp.ts` and tested separately.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  ENTITY_IDS_SECRET_NAME,
  createEntityIdsAccessor,
  describeThrown,
  type SecretManagerPort,
} from '../state/secret-manager.ts'

function fakePort(
  overrides: Partial<SecretManagerPort> = {},
): SecretManagerPort {
  return {
    accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() => okAsync('{}')),
    upsertSecret: vi.fn<SecretManagerPort['upsertSecret']>(() =>
      okAsync(undefined),
    ),
    ...overrides,
  }
}

describe('ENTITY_IDS_SECRET_NAME', () => {
  it('uses the documented prefix', () => {
    expect(ENTITY_IDS_SECRET_NAME).toBe('compliance-entity-ids')
  })
})

describe('describeThrown', () => {
  it('returns the message of an Error instance', () => {
    expect(describeThrown(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(describeThrown('weird')).toBe('weird')
    expect(describeThrown(42)).toBe('42')
    expect(describeThrown(null)).toBe('null')
  })
})

describe('createEntityIdsAccessor.read', () => {
  it('returns the parsed identifiers when present', async () => {
    const port = fakePort({
      accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() =>
        okAsync(JSON.stringify({ 'us-federal': { ein: '12-3456789' } })),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const got = await accessor.read()
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toEqual({
      'us-federal': { ein: '12-3456789' },
    })
    expect(port.accessSecret).toHaveBeenCalledWith(ENTITY_IDS_SECRET_NAME)
  })

  it('returns null when the secret is not found', async () => {
    const port = fakePort({
      accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() =>
        errAsync({ type: 'not_found', message: 'no secret' }),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const got = await accessor.read()
    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toBeNull()
  })

  it('propagates a permission-denied error', async () => {
    const port = fakePort({
      accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() =>
        errAsync({ type: 'permission_denied', message: '403' }),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const got = await accessor.read()
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('permission_denied')
    }
  })

  it('propagates a generic SDK error', async () => {
    const port = fakePort({
      accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() =>
        errAsync({ type: 'sdk', message: 'gRPC failure' }),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const got = await accessor.read()
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('sdk')
    }
  })

  it('returns a parse error if the secret payload is not valid JSON', async () => {
    const port = fakePort({
      accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() =>
        okAsync('not-json{'),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const got = await accessor.read()
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('parse')
    }
  })

  it('returns a parse error if the secret JSON does not match the schema', async () => {
    const port = fakePort({
      accessSecret: vi.fn<SecretManagerPort['accessSecret']>(() =>
        okAsync(JSON.stringify({ 'us-federal': { ein: '12345' } })),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const got = await accessor.read()
    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('parse')
    }
  })
})

describe('createEntityIdsAccessor.write', () => {
  it('persists the JSON-encoded payload', async () => {
    const port = fakePort()
    const accessor = createEntityIdsAccessor({ port })

    const result = await accessor.write({
      'us-federal': { ein: '12-3456789' },
    })
    expect(result.isOk()).toBe(true)
    expect(port.upsertSecret).toHaveBeenCalledWith(
      ENTITY_IDS_SECRET_NAME,
      JSON.stringify({ 'us-federal': { ein: '12-3456789' } }),
    )
  })

  it('rejects a malformed payload before calling the port', async () => {
    const port = fakePort()
    const accessor = createEntityIdsAccessor({ port })

    const result = await accessor.write({
      'us-federal': { ein: 'short' },
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
    expect(port.upsertSecret).not.toHaveBeenCalled()
  })

  it('propagates port errors', async () => {
    const port = fakePort({
      upsertSecret: vi.fn<SecretManagerPort['upsertSecret']>(() =>
        errAsync({ type: 'sdk', message: 'gRPC down' }),
      ),
    })
    const accessor = createEntityIdsAccessor({ port })

    const result = await accessor.write({
      'us-federal': { ein: '12-3456789' },
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('sdk')
    }
  })
})
