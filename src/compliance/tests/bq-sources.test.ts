/**
 * Tests for the sources registry-snapshot accessor.
 */
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import type { BqQueryRunner } from '../state/bq-entity.ts'
import { createSourcesAccessor } from '../state/bq-sources.ts'
import type { Source } from '../types/index.ts'

const SOURCE_A: Source = {
  id: 'irs-teos',
  jurisdiction: 'us-federal',
  kind: 'api',
  authRequired: false,
  description: 'IRS Pub. 78 + Auto Revocation lookup by EIN.',
  accessUrl:
    'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
  accessMethod: 'official_bulk_download',
  automationAllowed: true,
  sourceFreshness: {
    observedAt: '2026-04-28T00:00:00.000Z',
    upstreamPublishedAt: '2026-04-15',
  },
  tosUrl:
    'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads',
  run: () => {
    throw new Error('not used in accessor tests')
  },
}

function fakeRunner(
  query: ReturnType<typeof vi.fn<BqQueryRunner['query']>>,
): BqQueryRunner {
  return { query }
}

describe('createSourcesAccessor.upsertSources', () => {
  it('upserts each source as a registry-snapshot row', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const fixedNow = new Date('2024-05-01T00:00:00.000Z')
    const accessor = createSourcesAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => fixedNow,
    })

    const result = await accessor.upsertSources([SOURCE_A])
    expect(result.isOk()).toBe(true)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] ?? []
    expect(sql).toMatch(/`proj\.compliance\.sources`/)
    expect(sql).toMatch(/MERGE/i)
    expect(params).toMatchObject({
      source_id: 'irs-teos',
      jurisdiction_id: 'us-federal',
      kind: 'api',
      auth_required: false,
      access_url: SOURCE_A.accessUrl,
      access_method: 'official_bulk_download',
      automation_allowed: true,
      manual_only_reason: null,
      source_freshness: JSON.stringify(SOURCE_A.sourceFreshness),
      tos_url: SOURCE_A.tosUrl,
      updated_at: fixedNow.toISOString(),
    })
  })

  it('upserts manual-only sources with the required reason', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const fixedNow = new Date('2024-05-01T00:00:00.000Z')
    const accessor = createSourcesAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => fixedNow,
    })
    const manualSource: Source = {
      id: 'ca-sos-bizfile',
      jurisdiction: 'us-ca',
      kind: 'manual',
      authRequired: false,
      description: 'Manual CA SOS bizfile business status check.',
      accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
      accessMethod: 'manual',
      automationAllowed: false,
      manualOnlyReason:
        'Published bizfile terms prohibit scraping or similar automated collection.',
      manualInstructions: ['Open the bizfile business search page.'],
      manualEvidenceFields: [
        { key: 'entity_status', label: 'Entity status', required: true },
      ],
      tosUrl:
        'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use',
      run: () => {
        throw new Error('not used in accessor tests')
      },
    }

    const result = await accessor.upsertSources([manualSource])
    expect(result.isOk()).toBe(true)
    const params = query.mock.calls[0]?.[1]
    expect(params).toMatchObject({
      source_id: 'ca-sos-bizfile',
      access_method: 'manual',
      automation_allowed: false,
      manual_only_reason:
        'Published bizfile terms prohibit scraping or similar automated collection.',
      source_freshness: null,
    })
  })

  it('is a no-op for an empty list', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createSourcesAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => new Date(),
    })

    const result = await accessor.upsertSources([])
    expect(result.isOk()).toBe(true)
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects sources whose tos_url is not a URL', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() => okAsync([]))
    const accessor = createSourcesAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => new Date(),
    })

    const broken: Source = { ...SOURCE_A, tosUrl: 'not-a-url' }
    const result = await accessor.upsertSources([broken])
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates a runner error', async () => {
    const query = vi.fn<BqQueryRunner['query']>(() =>
      errAsync({ type: 'query', message: 'BQ down' }),
    )
    const accessor = createSourcesAccessor({
      runner: fakeRunner(query),
      projectId: 'proj',
      now: () => new Date(),
    })

    const result = await accessor.upsertSources([SOURCE_A])
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('query')
    }
  })
})
