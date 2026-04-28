import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  IRS_EO_BMF_CALIFORNIA_URL,
  _internal,
  irsEoBmfSource,
} from '../jurisdictions/us-federal/sources/irs-bmf.ts'
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
  'EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME'

function bmfRow(args: {
  ein: string
  name?: string
  subsection?: string
  affiliation?: string
  deductibility?: string
  foundation?: string
  status?: string
  taxPeriod?: string
}): string {
  return [
    args.ein,
    args.name ?? 'FOO FOUNDATION',
    '',
    '1 MISSION ST',
    'SAN FRANCISCO',
    'CA',
    '94105',
    '0000',
    args.subsection ?? '03',
    args.affiliation ?? '3',
    '1000',
    '201001',
    args.deductibility ?? '1',
    args.foundation ?? '15',
    '000000000',
    '1',
    args.status ?? '01',
    args.taxPeriod ?? '202412',
    '0',
    '0',
    '01',
    '0',
    '12',
    '1000',
    '2000',
    '3000',
    'T30',
    '',
  ].join(',')
}

function makeContext(fetch: FetchImpl): SourceContext {
  return {
    now: () => new Date('2026-04-28T12:00:00.000Z'),
    fetch,
    identifiers: { 'us-federal': { ein: '12-3456789' } },
  }
}

function fetchCsv(body: string): FetchImpl {
  return vi.fn<FetchImpl>(() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          etag: '"eo-ca"',
          'last-modified': 'Tue, 14 Apr 2026 00:00:00 GMT',
        },
      }),
    ),
  )
}

describe('irsEoBmfSource metadata', () => {
  it('declares official BMF CSV download access', () => {
    expect(irsEoBmfSource).toMatchObject({
      id: 'irs-eo-bmf',
      jurisdiction: 'us-federal',
      kind: 'api',
      accessMethod: 'official_bulk_download',
      automationAllowed: true,
    })
    expect(IRS_EO_BMF_CALIFORNIA_URL).toBe(
      'https://www.irs.gov/pub/irs-soi/eo_ca.csv',
    )
  })
})

describe('_internal.parseBmfCsv', () => {
  it('parses and trims BMF rows', () => {
    const result = _internal.parseBmfCsv(
      `${HEADER}\n${bmfRow({ ein: '123456789' })}`,
    )

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value[0]).toMatchObject({
        ein: '123456789',
        name: 'FOO FOUNDATION',
        subsection: '03',
        deductibility: '1',
        status: '01',
      })
    }
  })

  it('fails loudly when the BMF CSV schema changes', () => {
    const result = _internal.parseBmfCsv(
      `${HEADER},UNEXPECTED\n${bmfRow({ ein: '123456789' })},extra`,
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      expect(result.error.message).toContain('schema validation')
    }
  })

  it('returns a parse error when the CSV cannot be parsed', () => {
    const result = _internal.parseBmfCsv(`${HEADER}\n"unterminated`)

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Failed to parse')
  })
})

describe('irsEoBmfSource.run', () => {
  it('selects the California CSV and returns decoded BMF codes for the configured EIN', async () => {
    const fetch = fetchCsv(`${HEADER}\n${bmfRow({ ein: '123456789' })}`)

    const result = await irsEoBmfSource.run(ENTITY, makeContext(fetch))

    expect(fetch).toHaveBeenCalledWith(IRS_EO_BMF_CALIFORNIA_URL, {
      headers: {},
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      upstreamPublishedAt: '2026-04-14',
      row: {
        ein: '123456789',
        taxPeriod: '202412',
      },
      decoded: {
        subsection: '501(c)(3)',
        deductibility: 'Contributions are deductible',
        affiliation: 'Independent',
        status: 'Unconditional Exemption',
      },
    })
  })

  it('preserves unknown BMF code values in decoded output', async () => {
    const fetch = fetchCsv(
      `${HEADER}\n${bmfRow({
        ein: '123456789',
        subsection: '99',
        affiliation: '9',
        deductibility: '9',
        foundation: '99',
        status: '99',
      })}`,
    )

    const result = await irsEoBmfSource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      decoded: {
        subsection: 'Unknown subsection code 99',
        affiliation: 'Unknown affiliation code 9',
        deductibility: 'Unknown deductibility code 9',
        foundation: 'Unknown foundation code 99',
        status: 'Unknown status code 99',
      },
    })
  })

  it('returns a not-found payload when the EIN is absent from the selected CSV', async () => {
    const fetch = fetchCsv(`${HEADER}\n${bmfRow({ ein: '999999999' })}`)

    const result = await irsEoBmfSource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.record.payload).toEqual({
        matchStatus: 'not_found',
        upstreamPublishedAt: '2026-04-14',
      })
    }
  })

  it('returns validation when no EIN is configured', async () => {
    const fetch = fetchCsv(`${HEADER}\n`)

    const result = await irsEoBmfSource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {},
    })

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toMatch(/EIN/)
    }
  })

  it('fails loudly for unsupported state-file selection', async () => {
    const fetch = fetchCsv(`${HEADER}\n`)

    const result = await irsEoBmfSource.run(
      { ...ENTITY, mailing_address_region: 'ZZ' },
      makeContext(fetch),
    )

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toMatch(/state/)
    }
  })

  it('uses the shared download cache when one is supplied', async () => {
    const cache: DownloadCacheStore = {
      read: vi.fn<DownloadCacheStore['read']>(() => okAsync(null)),
      write: vi.fn<DownloadCacheStore['write']>(() => okAsync(undefined)),
    }
    const fetch = fetchCsv(`${HEADER}\n${bmfRow({ ein: '123456789' })}`)

    const result = await irsEoBmfSource.run(ENTITY, {
      ...makeContext(fetch),
      downloadCache: cache,
    })

    expect(result.isOk()).toBe(true)
    expect(cache.read).toHaveBeenCalledTimes(1)
    expect(cache.write).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(IRS_EO_BMF_CALIFORNIA_URL, {
      headers: {},
    })
  })

  it('returns an HTTP source error when the BMF CSV download fails', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 503 })),
    )

    const result = await irsEoBmfSource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toMatchObject({
      type: 'http',
      status: 503,
    })
    expect(result.error.message).toContain('IRS EO BMF CSV')
  })

  it('returns a parse source error when the downloaded BMF CSV schema is invalid', async () => {
    const fetch = fetchCsv(
      `${HEADER},UNEXPECTED\n${bmfRow({ ein: '123456789' })},extra`,
    )

    const result = await irsEoBmfSource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('schema validation')
  })

  it('returns a network source error when the BMF CSV download rejects', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.reject(new Error('connection reset')),
    )

    const result = await irsEoBmfSource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('network')
    expect(result.error.message).toContain('connection reset')
  })
})
