import { describe, expect, it } from 'vitest'
import type { CachedDownloadMetadata } from '../sources/download-cache.ts'
import {
  makeDownloadEvidence,
  makeManualEvidenceRequirement,
  makeTextExcerptEvidence,
} from '../sources/evidence.ts'

const DOWNLOAD_METADATA: CachedDownloadMetadata = {
  cacheKey:
    'irs-bmf/47b4b3051b704eeebcc4cf8e707e0dc195fa66c3f2576698fbf23c7bad10eed7',
  sourceId: 'irs-bmf',
  url: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
  requestedAt: '2026-04-28T12:00:00.000Z',
  fetchedAt: '2026-04-28T12:00:01.000Z',
  etag: '"abc123"',
  lastModified: 'Tue, 28 Apr 2026 00:00:00 GMT',
  contentType: 'text/csv',
  contentHash:
    'sha256:47b4b3051b704eeebcc4cf8e707e0dc195fa66c3f2576698fbf23c7bad10eed7',
  sizeBytes: 12_345,
}

describe('makeDownloadEvidence', () => {
  it('captures bounded download metadata without embedding raw content', () => {
    const evidence = makeDownloadEvidence(DOWNLOAD_METADATA)

    expect(evidence).toEqual({
      kind: 'download',
      sourceId: 'irs-bmf',
      sourceUrl: 'https://www.irs.gov/pub/irs-soi/eo1.csv',
      cacheKey:
        'irs-bmf/47b4b3051b704eeebcc4cf8e707e0dc195fa66c3f2576698fbf23c7bad10eed7',
      observedAt: '2026-04-28T12:00:01.000Z',
      contentHash:
        'sha256:47b4b3051b704eeebcc4cf8e707e0dc195fa66c3f2576698fbf23c7bad10eed7',
      contentType: 'text/csv',
      sizeBytes: 12_345,
      etag: '"abc123"',
      lastModified: 'Tue, 28 Apr 2026 00:00:00 GMT',
    })
    expect(JSON.stringify(evidence)).not.toContain('row,row,row')
  })
})

describe('makeTextExcerptEvidence', () => {
  it('caps excerpt text by encoded byte size and records truncation', () => {
    const result = makeTextExcerptEvidence({
      sourceId: 'ca-ag-registry',
      sourceUrl: 'https://oag.ca.gov/charities/reports',
      observedAt: '2026-04-28T12:00:00.000Z',
      label: 'Registry status excerpt',
      text: 'May operate and solicit. Annual renewal accepted.',
      maxBytes: 16,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(
        new TextEncoder().encode(result.value.text).byteLength,
      ).toBeLessThanOrEqual(16)
      expect(result.value.truncated).toBe(true)
      expect(result.value.originalBytes).toBeGreaterThan(16)
    }
  })

  it('does not mark an excerpt truncated when it fits exactly', () => {
    const result = makeTextExcerptEvidence({
      sourceId: 'ca-ftb-esl',
      sourceUrl: 'https://webapp.ftb.ca.gov/eletter/',
      observedAt: '2026-04-28T12:00:00.000Z',
      label: 'FTB result',
      text: 'good',
      maxBytes: 4,
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.text).toBe('good')
      expect(result.value.truncated).toBe(false)
      expect(result.value.originalBytes).toBe(4)
    }
  })

  it('rejects non-positive byte limits', () => {
    const result = makeTextExcerptEvidence({
      sourceId: 'ca-sos',
      sourceUrl: 'https://bizfileonline.sos.ca.gov/search/business',
      observedAt: '2026-04-28T12:00:00.000Z',
      label: 'SOS status',
      text: 'Active',
      maxBytes: 0,
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toMatch(/maxBytes/)
    }
  })
})

describe('makeManualEvidenceRequirement', () => {
  it('records manual evidence fields without claiming network freshness', () => {
    const evidence = makeManualEvidenceRequirement({
      sourceId: 'ca-sos',
      sourceUrl: 'https://bizfileonline.sos.ca.gov/search/business',
      observedAt: '2026-04-28T12:00:00.000Z',
      instructions: [
        'Open the bizfile business search page.',
        'Search for the exact SOS entity number.',
      ],
      fields: [
        { key: 'entity_status', label: 'Entity status', required: true },
        { key: 'status_date', label: 'Status date', required: false },
      ],
    })

    expect(evidence.kind).toBe('manual')
    expect(evidence.fields).toEqual([
      { key: 'entity_status', label: 'Entity status', required: true },
      { key: 'status_date', label: 'Status date', required: false },
    ])
    expect(evidence.instructions).toHaveLength(2)
  })
})
