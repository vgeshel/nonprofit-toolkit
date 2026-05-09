import { err, ok, type Result } from 'neverthrow'
import type { CachedDownloadMetadata } from './download-cache.ts'
import type { SourceError } from './errors.ts'

export interface DownloadEvidence {
  readonly kind: 'download'
  readonly sourceId: string
  readonly sourceUrl: string
  readonly cacheKey: string
  readonly observedAt: string
  readonly contentHash: string
  readonly contentType: string | null
  readonly sizeBytes: number
  readonly etag: string | null
  readonly lastModified: string | null
}

export interface TextExcerptEvidence {
  readonly kind: 'text_excerpt'
  readonly sourceId: string
  readonly sourceUrl: string
  readonly observedAt: string
  readonly label: string
  readonly text: string
  readonly originalBytes: number
  readonly excerptBytes: number
  readonly maxBytes: number
  readonly truncated: boolean
}

export interface ManualEvidenceField {
  readonly key: string
  readonly label: string
  readonly required: boolean
}

export interface ManualEvidenceRequirement {
  readonly kind: 'manual'
  readonly sourceId: string
  readonly sourceUrl: string
  readonly observedAt: string
  readonly instructions: readonly string[]
  readonly fields: readonly ManualEvidenceField[]
}

export interface TextExcerptEvidenceArgs {
  readonly sourceId: string
  readonly sourceUrl: string
  readonly observedAt: string
  readonly label: string
  readonly text: string
  readonly maxBytes: number
}

export interface ManualEvidenceRequirementArgs {
  readonly sourceId: string
  readonly sourceUrl: string
  readonly observedAt: string
  readonly instructions: readonly string[]
  readonly fields: readonly ManualEvidenceField[]
}

export function makeDownloadEvidence(
  metadata: CachedDownloadMetadata,
): DownloadEvidence {
  return {
    kind: 'download',
    sourceId: metadata.sourceId,
    sourceUrl: metadata.url,
    cacheKey: metadata.cacheKey,
    observedAt: metadata.fetchedAt,
    contentHash: metadata.contentHash,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
    etag: metadata.etag,
    lastModified: metadata.lastModified,
  }
}

export function makeTextExcerptEvidence(
  args: TextExcerptEvidenceArgs,
): Result<TextExcerptEvidence, SourceError> {
  if (args.maxBytes <= 0) {
    return err({
      type: 'validation',
      message: 'Text evidence maxBytes must be greater than zero',
    })
  }
  const originalBytes = byteLength(args.text)
  const text = truncateUtf8(args.text, args.maxBytes)
  const excerptBytes = byteLength(text)
  return ok({
    kind: 'text_excerpt',
    sourceId: args.sourceId,
    sourceUrl: args.sourceUrl,
    observedAt: args.observedAt,
    label: args.label,
    text,
    originalBytes,
    excerptBytes,
    maxBytes: args.maxBytes,
    truncated: excerptBytes < originalBytes,
  })
}

export function makeManualEvidenceRequirement(
  args: ManualEvidenceRequirementArgs,
): ManualEvidenceRequirement {
  return {
    kind: 'manual',
    sourceId: args.sourceId,
    sourceUrl: args.sourceUrl,
    observedAt: args.observedAt,
    instructions: args.instructions,
    fields: args.fields,
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  let result = ''
  for (const char of text) {
    const next = result + char
    if (byteLength(next) > maxBytes) {
      return result
    }
    result = next
  }
  return result
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
