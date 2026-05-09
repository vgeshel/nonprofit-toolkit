import {
  ResultAsync,
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
} from 'neverthrow'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FetchImpl } from '../types/index.ts'
import type { SourceError } from './errors.ts'

type DownloadCacheParam = string | number | boolean | null
type DownloadRequestParams = Record<string, DownloadCacheParam | undefined>

export interface DownloadCacheKeyInput {
  readonly sourceId: string
  readonly url: string
  readonly requestParams?: DownloadRequestParams
  readonly entityIdentifier?: string
}

export const CachedDownloadMetadataSchema = z.object({
  cacheKey: z.string().min(1),
  sourceId: z.string().min(1),
  url: z.string().url(),
  requestedAt: z.iso.datetime(),
  fetchedAt: z.iso.datetime(),
  etag: z.string().min(1).nullable(),
  lastModified: z.string().min(1).nullable(),
  contentType: z.string().min(1).nullable(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
})

export type CachedDownloadMetadata = z.infer<
  typeof CachedDownloadMetadataSchema
>

export const CachedDownloadSchema = z.object({
  metadata: CachedDownloadMetadataSchema,
  bytes: z.instanceof(Uint8Array),
})

const ErrorCodeSchema = z.object({ code: z.string().optional() }).catch({})

export interface CachedDownload {
  readonly metadata: CachedDownloadMetadata
  readonly bytes: Uint8Array
}

export interface DownloadCacheStore {
  read(cacheKey: string): ResultAsync<CachedDownload | null, SourceError>
  write(artifact: CachedDownload): ResultAsync<void, SourceError>
}

export interface ValidateCachedDownloadArgs {
  readonly artifact: CachedDownload
  readonly now: () => Date
  readonly maxAgeMs?: number
}

export interface FetchDownloadWithCacheArgs {
  readonly sourceId: string
  readonly url: string
  readonly fetch: FetchImpl
  readonly cache: DownloadCacheStore
  readonly now: () => Date
  readonly requestParams?: DownloadRequestParams
  readonly entityIdentifier?: string
  readonly maxAgeMs?: number
}

export type DownloadCacheStatus = 'fetched' | 'revalidated'

export interface CachedDownloadResult extends CachedDownload {
  readonly cacheStatus: DownloadCacheStatus
}

export class LocalDownloadCacheStore implements DownloadCacheStore {
  constructor(private readonly rootDir: string) {}

  read(cacheKey: string): ResultAsync<CachedDownload | null, SourceError> {
    return ResultAsync.fromSafePromise(
      readLocalArtifact(this.rootDir, cacheKey),
    ).andThen((result) => {
      if (result.status === 'missing') {
        return okAsync(null)
      }
      if (result.status === 'failed') {
        return errAsync<CachedDownload | null, SourceError>({
          type: 'internal',
          message: result.message,
        })
      }
      const parsedMetadata = CachedDownloadMetadataSchema.safeParse(
        result.metadataJson,
      )
      if (!parsedMetadata.success) {
        return errAsync<CachedDownload | null, SourceError>({
          type: 'parse',
          message: `Cached download metadata failed schema validation: ${parsedMetadata.error.message}`,
        })
      }
      return okAsync({
        metadata: parsedMetadata.data,
        bytes: result.bytes,
      })
    })
  }

  write(artifact: CachedDownload): ResultAsync<void, SourceError> {
    return ResultAsync.fromSafePromise(
      writeLocalArtifact(this.rootDir, artifact),
    ).andThen((result) =>
      result.status === 'ok'
        ? okAsync(undefined)
        : errAsync<void, SourceError>({
            type: 'internal',
            message: result.message,
          }),
    )
  }
}

export function buildDownloadCacheKey(input: DownloadCacheKeyInput): string {
  const sourceId = sanitiseCacheSegment(input.sourceId)
  const canonical = JSON.stringify({
    version: 1,
    url: canonicalUrl(input.url),
    requestParams: canonicalRequestParams(input.requestParams),
    entityIdentifier: input.entityIdentifier ?? null,
  })
  return `${sourceId}/${hashHex(canonical)}`
}

export function validateCachedDownload(
  args: ValidateCachedDownloadArgs,
): Result<CachedDownload, SourceError> {
  const integrityResult = validateCachedIntegrity(args.artifact)
  if (integrityResult.isErr()) {
    return err(integrityResult.error)
  }

  const staleResult = validateFreshness(args)
  if (staleResult.isErr()) {
    return err(staleResult.error)
  }

  return ok(args.artifact)
}

function validateCachedIntegrity(
  artifact: CachedDownload,
): Result<CachedDownload, SourceError> {
  const parsedMetadata = CachedDownloadMetadataSchema.safeParse(
    artifact.metadata,
  )
  if (!parsedMetadata.success) {
    return err({
      type: 'parse',
      message: `Cached download failed schema validation: ${parsedMetadata.error.message}`,
    })
  }

  const actualHash = hashBytes(artifact.bytes)
  if (actualHash !== artifact.metadata.contentHash) {
    return err({
      type: 'parse',
      message: `Cached download hash mismatch for ${artifact.metadata.cacheKey}`,
    })
  }

  if (artifact.bytes.byteLength !== artifact.metadata.sizeBytes) {
    return err({
      type: 'parse',
      message: `Cached download size mismatch for ${artifact.metadata.cacheKey}`,
    })
  }

  return ok(artifact)
}

export function fetchDownloadWithCache(
  args: FetchDownloadWithCacheArgs,
): ResultAsync<CachedDownloadResult, SourceError> {
  const cacheKey = buildDownloadCacheKey(args)
  return args.cache
    .read(cacheKey)
    .andThen(validateCachedOrNull)
    .andThen((cached) => returnFreshCachedOrNull(args, cached))
    .andThen((cached) => fetchAndCache(args, cacheKey, cached))
}

function validateCachedOrNull(
  cached: CachedDownload | null,
): ResultAsync<CachedDownload | null, SourceError> {
  if (cached === null) {
    return okAsync(null)
  }
  const validation = validateCachedIntegrity(cached)
  return validation.isOk()
    ? okAsync(validation.value)
    : errAsync(validation.error)
}

function returnFreshCachedOrNull(
  args: FetchDownloadWithCacheArgs,
  cached: CachedDownload | null,
): ResultAsync<CachedDownload | null | CachedDownloadResult, SourceError> {
  if (cached === null) {
    return okAsync(null)
  }
  const freshness = validateFreshness({
    artifact: cached,
    now: args.now,
    maxAgeMs: args.maxAgeMs,
  })
  if (freshness.isErr()) {
    return okAsync(cached)
  }
  if (args.maxAgeMs === undefined) {
    return okAsync(cached)
  }
  return okAsync({ ...cached, cacheStatus: 'revalidated' })
}

function fetchAndCache(
  args: FetchDownloadWithCacheArgs,
  cacheKey: string,
  cached: CachedDownload | null | CachedDownloadResult,
): ResultAsync<CachedDownloadResult, SourceError> {
  if (cached !== null && 'cacheStatus' in cached) {
    return okAsync(cached)
  }
  const requestedAt = args.now().toISOString()
  return ResultAsync.fromPromise(
    args.fetch(args.url, { headers: revalidationHeaders(cached) }),
    toNetworkError,
  ).andThen((response) =>
    response.status === 304
      ? returnRevalidated(cached)
      : handleFetchedResponse(args, cacheKey, requestedAt, response),
  )
}

function handleFetchedResponse(
  args: FetchDownloadWithCacheArgs,
  cacheKey: string,
  requestedAt: string,
  response: Response,
): ResultAsync<CachedDownloadResult, SourceError> {
  if (response.status === 429) {
    return errAsync({
      type: 'rate_limit',
      message: `Download source rate-limited ${args.url}`,
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    })
  }
  if (!response.ok) {
    return errAsync({
      type: 'http',
      status: response.status,
      message: `Download source returned HTTP ${String(response.status)} for ${args.url}`,
    })
  }

  return ResultAsync.fromPromise(response.arrayBuffer(), toNetworkError)
    .map((buffer) => new Uint8Array(buffer))
    .andThen((downloaded) => {
      const artifact: CachedDownload = {
        bytes: downloaded,
        metadata: {
          cacheKey,
          sourceId: args.sourceId,
          url: args.url,
          requestedAt,
          fetchedAt: args.now().toISOString(),
          etag: nullableHeader(response.headers.get('etag')),
          lastModified: nullableHeader(response.headers.get('last-modified')),
          contentType: nullableHeader(response.headers.get('content-type')),
          contentHash: hashBytes(downloaded),
          sizeBytes: downloaded.byteLength,
        },
      }
      return args.cache.write(artifact).map<CachedDownloadResult>(() => ({
        ...artifact,
        cacheStatus: 'fetched',
      }))
    })
}

function returnRevalidated(
  cached: CachedDownload | null,
): ResultAsync<CachedDownloadResult, SourceError> {
  if (cached === null) {
    return errAsync({
      type: 'parse',
      message:
        'Download source returned 304 Not Modified without a cache entry',
    })
  }
  return okAsync({ ...cached, cacheStatus: 'revalidated' })
}

function validateFreshness(
  args: ValidateCachedDownloadArgs,
): Result<void, SourceError> {
  if (args.maxAgeMs === undefined) {
    return ok(undefined)
  }
  const fetchedAtMs = Date.parse(args.artifact.metadata.fetchedAt)
  const ageMs = args.now().getTime() - fetchedAtMs
  if (ageMs > args.maxAgeMs) {
    return err({
      type: 'parse',
      message: `Cached download is stale for ${args.artifact.metadata.cacheKey}`,
    })
  }
  return ok(undefined)
}

function revalidationHeaders(
  cached: CachedDownload | null,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (cached?.metadata.etag !== null && cached?.metadata.etag !== undefined) {
    headers['if-none-match'] = cached.metadata.etag
  }
  if (
    cached?.metadata.lastModified !== null &&
    cached?.metadata.lastModified !== undefined
  ) {
    headers['if-modified-since'] = cached.metadata.lastModified
  }
  return headers
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nullableHeader(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${hashHex(bytes)}`
}

function hashHex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function canonicalUrl(url: string): string {
  if (!URL.canParse(url)) {
    return url
  }
  const parsed = new URL(url)
  const sortedParams = Array.from(parsed.searchParams.entries()).sort(
    compareEntries,
  )
  parsed.search = ''
  const query = new URLSearchParams(sortedParams).toString()
  return query.length === 0
    ? parsed.toString()
    : `${parsed.toString()}?${query}`
}

function canonicalRequestParams(
  params: DownloadRequestParams | undefined,
): readonly (readonly [string, DownloadCacheParam])[] {
  const defined: [string, DownloadCacheParam][] = []
  for (const entry of Object.entries(params ?? {})) {
    const value = entry[1]
    if (value !== undefined) {
      defined.push([entry[0], value])
    }
  }
  return defined.sort(compareEntries)
}

function compareEntries(
  left: readonly [string, DownloadCacheParam | string],
  right: readonly [string, DownloadCacheParam | string],
): number {
  const keyCompare = left[0].localeCompare(right[0])
  if (keyCompare !== 0) {
    return keyCompare
  }
  return String(left[1]).localeCompare(String(right[1]))
}

function sanitiseCacheSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-')
  return /[A-Za-z0-9]/.test(sanitized) ? sanitized : 'source'
}

function cachePath(rootDir: string, cacheKey: string): string {
  const segments = cacheKey.split('/').map(sanitiseCacheSegment)
  return join(rootDir, ...segments)
}

interface LocalReadFound {
  readonly status: 'found'
  readonly metadataJson: unknown
  readonly bytes: Uint8Array
}

interface LocalReadMissing {
  readonly status: 'missing'
}

interface LocalReadFailed {
  readonly status: 'failed'
  readonly message: string
}

type LocalReadResult = LocalReadFound | LocalReadMissing | LocalReadFailed

async function readLocalArtifact(
  rootDir: string,
  cacheKey: string,
): Promise<LocalReadResult> {
  const directory = cachePath(rootDir, cacheKey)
  const metadataResult = await readText(join(directory, 'metadata.json'))
  if (metadataResult.status !== 'found') {
    return metadataResult
  }
  const bodyResult = await readBinary(join(directory, 'body.bin'))
  if (bodyResult.status !== 'found') {
    return bodyResult
  }
  const parsed = parseJson(metadataResult.value)
  if (parsed.status === 'failed') {
    return parsed
  }
  return {
    status: 'found',
    metadataJson: parsed.value,
    bytes: bodyResult.value,
  }
}

interface TextReadFound {
  readonly status: 'found'
  readonly value: string
}

interface BinaryReadFound {
  readonly status: 'found'
  readonly value: Uint8Array
}

type TextReadResult = TextReadFound | LocalReadMissing | LocalReadFailed
type BinaryReadResult = BinaryReadFound | LocalReadMissing | LocalReadFailed

async function readText(path: string): Promise<TextReadResult> {
  try {
    return { status: 'found', value: await readFile(path, 'utf8') }
  } catch (readError) {
    return toLocalReadFailure(readError, `Failed to read ${path}`)
  }
}

async function readBinary(path: string): Promise<BinaryReadResult> {
  try {
    const buffer = await readFile(path)
    return { status: 'found', value: new Uint8Array(buffer) }
  } catch (readError) {
    return toLocalReadFailure(readError, `Failed to read ${path}`)
  }
}

function toLocalReadFailure(
  readError: unknown,
  prefix: string,
): LocalReadMissing | LocalReadFailed {
  if (errorCode(readError) === 'ENOENT') {
    return { status: 'missing' }
  }
  return {
    status: 'failed',
    message: `${prefix}: ${describeUnknown(readError)}`,
  }
}

interface JsonParsed {
  readonly status: 'found'
  readonly value: unknown
}

function parseJson(value: string): JsonParsed | LocalReadFailed {
  try {
    const parsed: unknown = JSON.parse(value)
    return { status: 'found', value: parsed }
  } catch (parseError) {
    return {
      status: 'failed',
      message: `Cached download metadata is not valid JSON: ${describeUnknown(
        parseError,
      )}`,
    }
  }
}

interface LocalWriteOk {
  readonly status: 'ok'
}

interface LocalWriteFailed {
  readonly status: 'failed'
  readonly message: string
}

type LocalWriteResult = LocalWriteOk | LocalWriteFailed

async function writeLocalArtifact(
  rootDir: string,
  artifact: CachedDownload,
): Promise<LocalWriteResult> {
  const directory = cachePath(rootDir, artifact.metadata.cacheKey)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify(artifact.metadata, null, 2),
    )
    await writeFile(join(directory, 'body.bin'), artifact.bytes)
    return { status: 'ok' }
  } catch (writeError) {
    return {
      status: 'failed',
      message: `Failed to write cache artifact ${artifact.metadata.cacheKey}: ${describeUnknown(
        writeError,
      )}`,
    }
  }
}

function toNetworkError(networkError: unknown): SourceError {
  return {
    type: 'network',
    message: `Download request failed: ${describeUnknown(networkError)}`,
  }
}

function errorCode(error: unknown): string | undefined {
  return ErrorCodeSchema.parse(error).code
}

function describeUnknown(value: unknown): string {
  return String(value)
}
