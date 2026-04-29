import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  CA_AG_REGISTRY_LISTS,
  _internal,
  caAgRegistrySource,
} from '../jurisdictions/us-ca/sources/ca-ag-registry.ts'
import type { DownloadCacheStore } from '../sources/download-cache.ts'
import type { Entity, FetchImpl, SourceContext } from '../types/index.ts'

const ENTITY: Entity = {
  legal_name: 'Foo Foundation',
  state_of_incorporation: 'CA',
  fiscal_year_end_month: 12,
  fiscal_year_end_day: 31,
  formation_date: '2010-01-15',
  mailing_address_line1: '1 Mission St',
  mailing_address_line2: null,
  mailing_address_city: 'San Francisco',
  mailing_address_region: 'CA',
  mailing_address_postal_code: '94105',
  mailing_address_country: 'US',
  updated_at: '2024-01-01T00:00:00Z',
}

const HEADER =
  'Registry Status,State Charity Reg#,FEIN,SOS/FTB#,Name,City,State,Issue Date,Last Renewal,Date Status Set,As-of Date'

function csvRow(args: {
  status: string
  charity: string
  fein: string
  sos: string
  name?: string
  city?: string
  state?: string
  lastRenewal?: string
}): string {
  return [
    args.status,
    args.charity,
    args.fein,
    args.sos,
    args.name ?? 'Foo Foundation',
    args.city ?? 'San Francisco',
    args.state ?? 'CA',
    '2019/10/23',
    args.lastRenewal ?? '2025/07/15',
    '2026/04/15',
    '2026/04/15',
  ].join(',')
}

function makeContext(fetch: FetchImpl): SourceContext {
  return {
    now: () => new Date('2026-04-28T12:00:00.000Z'),
    fetch,
    identifiers: {
      'us-federal': { ein: '12-3456789' },
      'us-ca': { sosEntityNumber: 'C0123456', agCharityNumber: 'CT0123456' },
    },
  }
}

function fetchForLists(bodies: Record<string, string>): FetchImpl {
  return vi.fn<FetchImpl>((input) => {
    const url = toUrlString(input)
    return Promise.resolve(
      new Response(bodies[url] ?? `${HEADER}\n`, {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          etag: `"${url.split('/').pop() ?? 'csv'}"`,
          'last-modified': 'Wed, 15 Apr 2026 00:00:00 GMT',
        },
      }),
    )
  })
}

function toUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}

describe('caAgRegistrySource metadata', () => {
  it('declares official CSV download access', () => {
    expect(caAgRegistrySource).toMatchObject({
      id: 'ca-ag-registry',
      jurisdiction: 'us-ca',
      kind: 'api',
      accessMethod: 'official_bulk_download',
      automationAllowed: true,
    })
    expect(CA_AG_REGISTRY_LISTS).toHaveLength(4)
  })

  it('uses one upstream-published date for source metadata and payloads', async () => {
    const mayOperateUrl = CA_AG_REGISTRY_LISTS[0]?.url ?? ''
    const fetch = fetchForLists({
      [mayOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(_internal.registryReportsUpstreamPublishedAt).toBe(
      caAgRegistrySource.sourceFreshness?.upstreamPublishedAt,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      upstreamPublishedAt: _internal.registryReportsUpstreamPublishedAt,
    })
  })
})

describe('_internal.parseRegistryCsv', () => {
  it('normalizes padded registry CSV rows', () => {
    const result = _internal.parseRegistryCsv(
      `${HEADER}\n${csvRow({
        status: 'Current                                 ',
        charity: 'CT0123456           ',
        fein: '123456789    ',
        sos: 'C0123456             ',
      })}`,
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value[0]).toMatchObject({
        registryStatus: 'Current',
        stateCharityRegistrationNumber: 'CT0123456',
        fein: '123456789',
        sosFtbNumber: 'C0123456',
        asOfDate: '2026/04/15',
      })
    }
  })

  it('fails loudly when a registry CSV row has an invalid shape', () => {
    const result = _internal.parseRegistryCsv(
      `${HEADER},Unexpected\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
      })},extra`,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.message).toContain('schema validation')
    }
  })

  it('returns a parse error when the registry CSV cannot be parsed', () => {
    const result = _internal.parseRegistryCsv(`${HEADER}\n"unterminated`)

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Failed to parse')
  })

  it('accepts unescaped quotes in official registry names', () => {
    const result = _internal.parseRegistryCsv(
      `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
        name: 'BIG " HEART FOUNDATION',
      })}`,
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value[0]?.name).toBe('BIG " HEART FOUNDATION')
  })
})

describe('caAgRegistrySource.run', () => {
  it('finds an entity by EIN across the official Registry Reports CSVs', async () => {
    const mayOperateUrl = CA_AG_REGISTRY_LISTS[0]?.url ?? ''
    const fetch = fetchForLists({
      [mayOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.source_id).toBe('ca-ag-registry')
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      listCategory: 'may_operate_or_solicit',
      registryStatus: 'Current',
      upstreamPublishedAt: '2026-04-15',
    })
    expect(result.value.findings).toHaveLength(0)
  })

  it('finds an entity by EIN when no California identifiers are configured', async () => {
    const mayOperateUrl = CA_AG_REGISTRY_LISTS[0]?.url ?? ''
    const fetch = fetchForLists({
      [mayOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: { 'us-federal': { ein: '12-3456789' } },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      listCategory: 'may_operate_or_solicit',
    })
  })

  it('matches by AG charity number when EIN is absent', async () => {
    const mayNotOperateUrl = CA_AG_REGISTRY_LISTS[1]?.url ?? ''
    const fetch = fetchForLists({
      [mayNotOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Delinquent',
        charity: 'CT0123456',
        fein: '999999999',
        sos: 'C9999999',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {
        'us-ca': { sosEntityNumber: 'C0123456', agCharityNumber: 'CT0123456' },
      },
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.record.payload).toMatchObject({
        matchStatus: 'found',
        listCategory: 'may_not_operate_or_solicit',
        registryStatus: 'Delinquent',
      })
    }
  })

  it('matches by SOS/FTB number when EIN and AG charity number are absent', async () => {
    const mayOperateUrl = CA_AG_REGISTRY_LISTS[0]?.url ?? ''
    const fetch = fetchForLists({
      [mayOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT9999999',
        fein: '999999999',
        sos: 'C0123456',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {
        'us-ca': { sosEntityNumber: 'C0123456' },
      },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      listCategory: 'may_operate_or_solicit',
      registryStatus: 'Current',
    })
  })

  it('returns a not-found source record when no configured identifier appears', async () => {
    const fetch = fetchForLists({})

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.record.payload).toMatchObject({
        matchStatus: 'not_found',
      })
    }
  })

  it('returns not found when a configured SOS/FTB number does not match populated rows', async () => {
    const mayOperateUrl = CA_AG_REGISTRY_LISTS[0]?.url ?? ''
    const fetch = fetchForLists({
      [mayOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT9999999',
        fein: '999999999',
        sos: 'C9999999',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: { 'us-ca': { sosEntityNumber: 'C0123456' } },
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toEqual({ matchStatus: 'not_found' })
  })

  it('returns validation when neither federal nor California identifiers are configured', async () => {
    const fetch = fetchForLists({})

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {},
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toMatch(/identifier/)
    }
  })

  it('returns an HTTP source error when the registry CSV download fails', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 503 })),
    )

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toMatchObject({
      type: 'http',
      status: 503,
    })
    expect(result.error.message).toContain('CA AG Registry CSV')
  })

  it('uses the shared download cache when one is supplied', async () => {
    const mayOperateUrl = CA_AG_REGISTRY_LISTS[0]?.url ?? ''
    const cache: DownloadCacheStore = {
      read: vi.fn<DownloadCacheStore['read']>(() => okAsync(null)),
      write: vi.fn<DownloadCacheStore['write']>(() => okAsync(undefined)),
    }
    const fetch = fetchForLists({
      [mayOperateUrl]: `${HEADER}\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
      })}`,
    })

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      downloadCache: cache,
    })

    expect(result.isOk()).toBe(true)
    expect(cache.read).toHaveBeenCalledTimes(4)
    expect(cache.write).toHaveBeenCalledTimes(4)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      evidence: {
        kind: 'download',
        sourceId: 'ca-ag-registry',
        sourceUrl: mayOperateUrl,
      },
    })
  })

  it('returns a parse source error for invalid cached registry downloads', async () => {
    const cache: DownloadCacheStore = {
      read: vi.fn<DownloadCacheStore['read']>(() => okAsync(null)),
      write: vi.fn<DownloadCacheStore['write']>(() => okAsync(undefined)),
    }
    const fetch = fetchForLists({
      [CA_AG_REGISTRY_LISTS[0]?.url ?? '']: `${HEADER},Unexpected\n${csvRow({
        status: 'Current',
        charity: 'CT0123456',
        fein: '123456789',
        sos: 'C0123456',
      })},extra`,
    })

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      downloadCache: cache,
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('schema validation')
  })

  it('returns a network source error when the registry download rejects', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.reject(new Error('connection reset')),
    )

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('network')
    expect(result.error.message).toContain('connection reset')
  })
})
