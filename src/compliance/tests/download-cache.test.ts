import { errAsync, okAsync } from 'neverthrow'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalDownloadCacheStore,
  buildDownloadCacheKey,
  fetchDownloadWithCache,
  validateCachedDownload,
  type CachedDownload,
  type DownloadCacheStore,
} from '../sources/download-cache.ts'
import type { SourceError } from '../sources/errors.ts'
import type { FetchImpl } from '../types/index.ts'

const NOW = new Date('2026-04-28T12:00:00.000Z')

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function makeArtifact(overrides: Partial<CachedDownload> = {}): CachedDownload {
  const body = bytes('cached body')
  return {
    bytes: body,
    metadata: {
      cacheKey:
        'irs-teos/0b5d12199d077df58f1a90e745cc5b2f7e5d6d525f6d904f6d19a82be7f4c8fe',
      sourceId: 'irs-teos',
      url: 'https://apps.irs.gov/pub/epostcard/data-download-pub78.zip',
      requestedAt: '2026-04-28T12:00:00.000Z',
      fetchedAt: '2026-04-28T12:00:00.000Z',
      etag: '"abc123"',
      lastModified: 'Tue, 28 Apr 2026 00:00:00 GMT',
      contentType: 'application/zip',
      contentHash:
        'sha256:b25fb84b4755c55ba657ee56d5a751bf8707801e5324f384f9bf08ee397a13be',
      sizeBytes: body.byteLength,
    },
    ...overrides,
  }
}

class MemoryDownloadCacheStore implements DownloadCacheStore {
  artifact: CachedDownload | null = null
  readCalls: string[] = []
  written: CachedDownload[] = []
  writeError = false

  read(cacheKey: string) {
    this.readCalls.push(cacheKey)
    return okAsync(this.artifact)
  }

  write(artifact: CachedDownload) {
    if (this.writeError) {
      return errAsync<void, SourceError>({
        type: 'internal',
        message: 'cache write failed',
      })
    }
    this.written.push(artifact)
    this.artifact = artifact
    return okAsync(undefined)
  }
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/csv', ...init.headers },
    ...init,
  })
}

describe('buildDownloadCacheKey', () => {
  it('is deterministic for equivalent URL, request params, and entity identifier', () => {
    const first = buildDownloadCacheKey({
      sourceId: 'ca-ag-registry',
      url: 'https://oag.ca.gov/charities/reports?b=2&a=1',
      requestParams: { report: 'registry', state: 'CA' },
      entityIdentifier: 'CT0123456',
    })
    const second = buildDownloadCacheKey({
      sourceId: 'ca-ag-registry',
      url: 'https://oag.ca.gov/charities/reports?a=1&b=2',
      requestParams: { state: 'CA', report: 'registry' },
      entityIdentifier: 'CT0123456',
    })

    expect(second).toBe(first)
  })

  it('does not leak raw entity identifiers or request parameter values', () => {
    const key = buildDownloadCacheKey({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      requestParams: { ein: '12-3456789', region: 'pacific' },
      entityIdentifier: '12-3456789',
    })

    expect(key).toMatch(/^irs-bmf\/[a-f0-9]{64}$/)
    expect(key).not.toContain('12-3456789')
    expect(key).not.toContain('pacific')
  })

  it('normalises unsafe source ids and invalid URLs without exposing raw input', () => {
    const key = buildDownloadCacheKey({
      sourceId: '@@@',
      url: 'not a valid url',
      requestParams: { same: 'b', other: undefined },
      entityIdentifier: 'secret-id',
    })

    expect(key).toMatch(/^source\/[a-f0-9]{64}$/)
    expect(key).not.toContain('secret-id')
    expect(key).not.toContain('not a valid url')
  })

  it('sorts duplicate URL query keys by value', () => {
    const first = buildDownloadCacheKey({
      sourceId: 'ca-ag',
      url: 'https://oag.ca.gov/charities/reports?a=2&a=1',
    })
    const second = buildDownloadCacheKey({
      sourceId: 'ca-ag',
      url: 'https://oag.ca.gov/charities/reports?a=1&a=2',
    })

    expect(second).toBe(first)
  })
})

describe('validateCachedDownload', () => {
  it('accepts a fresh cache artifact with a matching content hash', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact(),
      now: () => NOW,
      maxAgeMs: 60_000,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.metadata.contentType).toBe('application/zip')
    }
  })

  it('fails loudly for a corrupt cache artifact', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact({
        metadata: {
          ...makeArtifact().metadata,
          contentHash:
            'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      }),
      now: () => NOW,
      maxAgeMs: 60_000,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.message).toMatch(/hash mismatch/)
    }
  })

  it('fails loudly when metadata does not match the cache schema', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact({
        metadata: {
          ...makeArtifact().metadata,
          url: 'not-a-url',
        },
      }),
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toMatch(/schema validation/)
    }
  })

  it('fails loudly when the cached byte count does not match metadata', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact({
        metadata: {
          ...makeArtifact().metadata,
          sizeBytes: 999,
        },
      }),
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toMatch(/size mismatch/)
    }
  })

  it('does not apply a stale-cache check when no max age is configured', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact({
        metadata: {
          ...makeArtifact().metadata,
          fetchedAt: '2026-04-27T12:00:00.000Z',
        },
      }),
      now: () => NOW,
    })

    expect(result.isOk()).toBe(true)
  })

  it('fails loudly for an invalid cached timestamp', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact({
        metadata: {
          ...makeArtifact().metadata,
          fetchedAt: 'not-a-date',
        },
      }),
      now: () => NOW,
      maxAgeMs: 60_000,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toMatch(/schema validation/)
    }
  })

  it('fails loudly for a stale cache artifact', () => {
    const result = validateCachedDownload({
      artifact: makeArtifact({
        metadata: {
          ...makeArtifact().metadata,
          fetchedAt: '2026-04-28T11:00:00.000Z',
        },
      }),
      now: () => NOW,
      maxAgeMs: 1_000,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.message).toMatch(/stale/)
    }
  })
})

describe('fetchDownloadWithCache', () => {
  it('fetches and stores a download on cache miss', async () => {
    const store = new MemoryDownloadCacheStore()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(
        response('fresh body', {
          headers: {
            etag: '"fresh"',
            'last-modified': 'Tue, 28 Apr 2026 12:00:00 GMT',
            'content-type': 'text/csv',
          },
        }),
      ),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.written).toHaveLength(1)
    if (result.isOk()) {
      expect(new TextDecoder().decode(result.value.bytes)).toBe('fresh body')
      expect(result.value.cacheStatus).toBe('fetched')
      expect(result.value.metadata.etag).toBe('"fresh"')
      expect(result.value.metadata.contentHash).toMatch(/^sha256:/)
    }
  })

  it('surfaces network errors before reading a response body', async () => {
    const store = new MemoryDownloadCacheStore()
    const fetch = vi.fn<FetchImpl>(() => Promise.reject(new Error('offline')))

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('network')
      expect(result.error.message).toContain('offline')
    }
  })

  it('fails before network access when a cached artifact is corrupt', async () => {
    const store = new MemoryDownloadCacheStore()
    store.artifact = makeArtifact({
      metadata: {
        ...makeArtifact().metadata,
        contentHash:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    })
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(response('fresh body')),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-teos',
      url: makeArtifact().metadata.url,
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    if (result.isErr()) {
      expect(result.error.message).toMatch(/hash mismatch/)
    }
  })

  it('surfaces rate limits with numeric retry-after values', async () => {
    const store = new MemoryDownloadCacheStore()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(
        new Response('', {
          status: 429,
          headers: { 'retry-after': '15' },
        }),
      ),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('rate_limit')
      if (result.error.type === 'rate_limit') {
        expect(result.error.retryAfterSeconds).toBe(15)
      }
    }
  })

  it('surfaces rate limits without retry-after when the header is absent or invalid', async () => {
    const invalidRetryStore = new MemoryDownloadCacheStore()
    const invalidRetryFetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(
        new Response('', {
          status: 429,
          headers: { 'retry-after': 'later' },
        }),
      ),
    )
    const missingRetryStore = new MemoryDownloadCacheStore()
    const missingRetryFetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 429 })),
    )

    const invalidResult = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch: invalidRetryFetch,
      cache: invalidRetryStore,
      now: () => NOW,
    })
    const missingResult = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch: missingRetryFetch,
      cache: missingRetryStore,
      now: () => NOW,
    })

    expect(invalidResult.isErr()).toBe(true)
    expect(missingResult.isErr()).toBe(true)
    if (invalidResult.isErr() && invalidResult.error.type === 'rate_limit') {
      expect(invalidResult.error.retryAfterSeconds).toBeUndefined()
    }
    if (missingResult.isErr() && missingResult.error.type === 'rate_limit') {
      expect(missingResult.error.retryAfterSeconds).toBeUndefined()
    }
  })

  it('surfaces a source error when the response body cannot be read', async () => {
    const store = new MemoryDownloadCacheStore()
    const badResponse = new Response('', { status: 200 })
    Object.defineProperty(badResponse, 'arrayBuffer', {
      value: () => Promise.reject(new Error('body unavailable')),
    })
    const fetch = vi.fn<FetchImpl>(() => Promise.resolve(badResponse))

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('network')
      expect(result.error.message).toMatch(/body unavailable/)
    }
  })

  it('surfaces cache write errors after a successful download', async () => {
    const store = new MemoryDownloadCacheStore()
    store.writeError = true
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(response('fresh body')),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-bmf',
      url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    expect(store.written).toHaveLength(0)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toMatch(/cache write failed/)
    }
  })

  it('revalidates with ETag and Last-Modified and returns cached bytes on 304', async () => {
    const store = new MemoryDownloadCacheStore()
    store.artifact = makeArtifact()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response(null, { status: 304 })),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-teos',
      url: makeArtifact().metadata.url,
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    const init = fetch.mock.calls[0]?.[1]
    expect(init?.headers).toEqual({
      'if-none-match': '"abc123"',
      'if-modified-since': 'Tue, 28 Apr 2026 00:00:00 GMT',
    })
    if (result.isOk()) {
      expect(result.value.cacheStatus).toBe('revalidated')
      expect(new TextDecoder().decode(result.value.bytes)).toBe('cached body')
    }
  })

  it('returns a fresh cache artifact without a network request when maxAgeMs allows it', async () => {
    const store = new MemoryDownloadCacheStore()
    store.artifact = makeArtifact()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(response('network body')),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-teos',
      url: makeArtifact().metadata.url,
      fetch,
      cache: store,
      now: () => NOW,
      maxAgeMs: 60_000,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(store.written).toHaveLength(0)
    if (!result.isOk()) return
    expect(result.value.cacheStatus).toBe('revalidated')
    expect(new TextDecoder().decode(result.value.bytes)).toBe('cached body')
  })

  it('refetches when a structurally valid cache artifact is stale', async () => {
    const store = new MemoryDownloadCacheStore()
    store.artifact = makeArtifact({
      metadata: {
        ...makeArtifact().metadata,
        fetchedAt: '2026-04-28T11:00:00.000Z',
      },
    })
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(
        response('refetched body', {
          headers: {
            etag: '"fresh"',
            'last-modified': 'Tue, 28 Apr 2026 12:00:00 GMT',
          },
        }),
      ),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-teos',
      url: makeArtifact().metadata.url,
      fetch,
      cache: store,
      now: () => NOW,
      maxAgeMs: 1_000,
    })

    expect(result.isOk()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      'if-none-match': '"abc123"',
      'if-modified-since': 'Tue, 28 Apr 2026 00:00:00 GMT',
    })
    expect(store.written).toHaveLength(1)
    if (result.isOk()) {
      expect(result.value.cacheStatus).toBe('fetched')
      expect(new TextDecoder().decode(result.value.bytes)).toBe(
        'refetched body',
      )
      expect(result.value.metadata.etag).toBe('"fresh"')
    }
  })

  it('fails loudly when an upstream returns 304 without a cache entry', async () => {
    const store = new MemoryDownloadCacheStore()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response(null, { status: 304 })),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-teos',
      url: makeArtifact().metadata.url,
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.message).toMatch(/without a cache entry/)
    }
  })

  it('surfaces HTTP errors without overwriting a valid cache artifact', async () => {
    const store = new MemoryDownloadCacheStore()
    store.artifact = makeArtifact()
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(response('nope', { status: 503 })),
    )

    const result = await fetchDownloadWithCache({
      sourceId: 'irs-teos',
      url: makeArtifact().metadata.url,
      fetch,
      cache: store,
      now: () => NOW,
    })

    expect(result.isErr()).toBe(true)
    expect(store.written).toHaveLength(0)
    if (result.isErr()) {
      expect(result.error.type).toBe('http')
      expect(result.error.message).toMatch(/503/)
    }
  })
})

describe('LocalDownloadCacheStore', () => {
  let cacheDir: string | null = null

  afterEach(async () => {
    if (cacheDir !== null) {
      await rm(cacheDir, { recursive: true, force: true })
      cacheDir = null
    }
  })

  it('round-trips artifacts through a deterministic filesystem layout', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const store = new LocalDownloadCacheStore(cacheDir)
    const artifact = makeArtifact()

    const writeResult = await store.write(artifact)
    const readResult = await store.read(artifact.metadata.cacheKey)

    expect(writeResult.isOk()).toBe(true)
    expect(readResult.isOk()).toBe(true)
    if (readResult.isOk()) {
      expect(readResult.value).toEqual(artifact)
    }
  })

  it('surfaces invalid cache metadata JSON', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const store = new LocalDownloadCacheStore(cacheDir)
    const directory = join(cacheDir, 'irs-bmf', 'invalid-json')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'metadata.json'), '{')
    await writeFile(join(directory, 'body.bin'), bytes('cached body'))

    const result = await store.read('irs-bmf/invalid-json')

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toMatch(/not valid JSON/)
    }
  })

  it('surfaces cache metadata that fails schema validation', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const store = new LocalDownloadCacheStore(cacheDir)
    const directory = join(cacheDir, 'irs-bmf', 'bad-schema')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'metadata.json'), JSON.stringify({}))
    await writeFile(join(directory, 'body.bin'), bytes('cached body'))

    const result = await store.read('irs-bmf/bad-schema')

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.message).toMatch(/schema validation/)
    }
  })

  it('returns null when metadata exists but the body file is missing', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const store = new LocalDownloadCacheStore(cacheDir)
    const artifact = makeArtifact()
    const directory = join(cacheDir, 'irs-teos', 'metadata-only')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify(artifact.metadata),
    )

    const result = await store.read('irs-teos/metadata-only')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBeNull()
    }
  })

  it('surfaces local read failures that are not missing files', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const store = new LocalDownloadCacheStore(cacheDir)
    const artifact = makeArtifact()
    const directory = join(cacheDir, 'irs-teos', 'body-is-directory')
    await mkdir(join(directory, 'body.bin'), { recursive: true })
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify(artifact.metadata),
    )

    const result = await store.read('irs-teos/body-is-directory')

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toMatch(/Failed to read/)
    }
  })

  it('surfaces local read failures when the root path is not a directory', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const rootFile = join(cacheDir, 'cache-file')
    await writeFile(rootFile, 'not a directory')
    const store = new LocalDownloadCacheStore(rootFile)

    const result = await store.read('irs-bmf/key')

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toMatch(/Failed to read/)
    }
  })

  it('surfaces local write failures when the root path is not a directory', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const rootFile = join(cacheDir, 'cache-file')
    await writeFile(rootFile, 'not a directory')
    const store = new LocalDownloadCacheStore(rootFile)

    const result = await store.write(makeArtifact())

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('internal')
      expect(result.error.message).toMatch(/Failed to write/)
    }
  })

  it('returns null for a missing cache key', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'compliance-cache-'))
    const store = new LocalDownloadCacheStore(cacheDir)

    const result = await store.read('irs-bmf/missing')

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBeNull()
    }
  })
})
