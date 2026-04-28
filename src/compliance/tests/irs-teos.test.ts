/**
 * Tests for the IRS TEOS source.
 *
 * The source consults two IRS bulk-data files (Pub. 78 and Auto Revocation),
 * both available as pipe-delimited text inside a ZIP archive. The data
 * dictionaries are documented at:
 *   https://www.irs.gov/pub/irs-tege/pub-78-data-dictionary.pdf
 *   https://www.irs.gov/pub/irs-tege/auto-revocation-data-dictionary.pdf
 *
 * Tests inject a fake `fetch` that returns small, hand-built ZIPs so they
 * exercise the full happy and unhappy paths without hitting irs.gov.
 */
import { strToU8, zipSync } from 'fflate'
import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  IRS_TEOS_PUB78_URL,
  IRS_TEOS_REVOCATION_URL,
  _internal,
  irsTeosSource,
} from '../jurisdictions/us-federal/sources/irs-teos.ts'
import type {
  CachedDownload,
  DownloadCacheStore,
} from '../sources/download-cache.ts'
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

/**
 * Build a Pub. 78 entry. Field order:
 *   TIN | Organization Name | City | State | Foreign Country | Deductibility Code
 */
function pub78Row(args: {
  tin: string
  name?: string
  city?: string
  state?: string
  country?: string
  code?: string
}): string {
  const {
    tin,
    name = 'Test Org',
    city = 'San Francisco',
    state = 'CA',
    country = '',
    code = 'PC',
  } = args
  return `${tin}|${name}|${city}|${state}|${country}|${code}`
}

/**
 * Build an Auto Revocation entry. Field order:
 *   TIN | Organization Name | Sort Name | Address | City | State | Zip Code |
 *   Country | Sub Section Code | Revocation Date | Revocation Posting Date |
 *   Exemption Reinstatement Date
 */
function revocationRow(args: {
  tin: string
  name?: string
  revocationDate?: string
  postingDate?: string
  reinstatementDate?: string
  subSectionCode?: string
}): string {
  const {
    tin,
    name = 'Test Org',
    revocationDate = '05/15/2022',
    postingDate = '05/15/2022',
    reinstatementDate = '',
    subSectionCode = '03',
  } = args
  // sort_name | address | city | state | zip | country
  return [
    tin,
    name,
    '',
    '1 Main St',
    'San Francisco',
    'CA',
    '94105',
    'US',
    subSectionCode,
    revocationDate,
    postingDate,
    reinstatementDate,
  ].join('|')
}

function zipString(filename: string, contents: string): Uint8Array {
  return zipSync({ [filename]: strToU8(contents) })
}

interface FetchPlan {
  pub78:
    | { status: number; body: Uint8Array | string }
    | (() => Promise<Response>)
  revocation:
    | { status: number; body: Uint8Array | string }
    | (() => Promise<Response>)
}

/**
 * Render the first argument to `fetch` (string | URL | Request) as a URL
 * string, in one place so test fakes can assert on URL equality.
 */
function toUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}

function planned(plan: FetchPlan): FetchImpl {
  return vi.fn<FetchImpl>((input) => {
    const url = toUrlString(input)
    const choice =
      url === IRS_TEOS_PUB78_URL
        ? plan.pub78
        : url === IRS_TEOS_REVOCATION_URL
          ? plan.revocation
          : null
    if (choice === null) {
      return Promise.resolve(new Response('', { status: 404 }))
    }
    if (typeof choice === 'function') {
      return choice()
    }
    const blob =
      typeof choice.body === 'string' ? choice.body : new Blob([choice.body])
    return Promise.resolve(new Response(blob, { status: choice.status }))
  })
}

function makeContext(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    now: () => new Date('2024-05-01T00:00:00.000Z'),
    fetch: vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 500 })),
    ),
    identifiers: { 'us-federal': { ein: '12-3456789' } },
    ...overrides,
  }
}

class MemoryDownloadCacheStore implements DownloadCacheStore {
  private readonly artifacts = new Map<string, CachedDownload>()

  read(cacheKey: string) {
    return okAsync(this.artifacts.get(cacheKey) ?? null)
  }

  write(artifact: CachedDownload) {
    this.artifacts.set(artifact.metadata.cacheKey, artifact)
    return okAsync(undefined)
  }
}

describe('_internal.describeError', () => {
  it('returns the message of an Error instance', () => {
    expect(_internal.describeError(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error thrown value', () => {
    expect(_internal.describeError('weird')).toBe('weird')
    expect(_internal.describeError(42)).toBe('42')
    expect(_internal.describeError(undefined)).toBe('undefined')
  })
})

describe('_internal.normaliseEin', () => {
  it('strips dashes', () => {
    expect(_internal.normaliseEin('12-3456789')).toBe('123456789')
  })

  it('passes through plain digits', () => {
    expect(_internal.normaliseEin('123456789')).toBe('123456789')
  })
})

describe('irsTeosSource metadata', () => {
  it('declares the expected static fields', () => {
    expect(irsTeosSource.id).toBe('irs-teos')
    expect(irsTeosSource.jurisdiction).toBe('us-federal')
    expect(irsTeosSource.kind).toBe('api')
    expect(irsTeosSource.authRequired).toBe(false)
    expect(irsTeosSource.accessMethod).toBe('official_bulk_download')
    expect(irsTeosSource.accessUrl).toMatch(/irs\.gov/)
    expect(irsTeosSource.automationAllowed).toBe(true)
    expect(irsTeosSource.tosUrl).toMatch(/irs\.gov/)
    expect(irsTeosSource.description.length).toBeGreaterThan(20)
  })
})

describe('irsTeosSource.run', () => {
  it('returns a validation error when no EIN is configured', async () => {
    const ctx = makeContext({ identifiers: {} })
    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('validation')
      expect(result.error.message).toMatch(/EIN/)
    }
  })

  it('emits an info finding when EIN is in Pub. 78', async () => {
    const pub78Text = [
      'header line should be ignored if it is not 9 digits',
      pub78Row({ tin: '999999999', code: 'PC' }),
      pub78Row({ tin: '123456789', code: 'PC' }),
    ].join('\n')
    const fetchFn = planned({
      pub78: { status: 200, body: zipString('pub78.txt', pub78Text) },
      revocation: {
        status: 200,
        body: zipString('revocation.txt', ''),
      },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const { record, findings } = result.value
    expect(record.source_id).toBe('irs-teos')
    expect(record.fetched_at).toBe('2024-05-01T00:00:00.000Z')

    expect(findings.map((f) => f.title)).toContain('EIN listed in IRS Pub. 78')
    const pubFinding = findings.find(
      (f) => f.title === 'EIN listed in IRS Pub. 78',
    )
    expect(pubFinding?.severity).toBe('info')
    expect(pubFinding?.evidence).toMatchObject({ deductibilityCode: 'PC' })
  })

  it('uses the shared download cache for IRS bulk ZIPs when provided', async () => {
    const cache = new MemoryDownloadCacheStore()
    const pub78Text = pub78Row({ tin: '123456789', code: 'PC' })
    const fetchFn = vi.fn<FetchImpl>((input, init) => {
      const url = toUrlString(input)
      const firstCachedRun = fetchFn.mock.calls.length > 2
      if (firstCachedRun) {
        expect(init?.headers).toEqual({
          'if-none-match': url.endsWith('pub78.zip') ? '"pub78"' : '"revoked"',
          'if-modified-since': 'Tue, 28 Apr 2026 00:00:00 GMT',
        })
        return Promise.resolve(new Response(null, { status: 304 }))
      }
      const body = url.endsWith('pub78.zip')
        ? zipString('pub78.txt', pub78Text)
        : zipString('revocation.txt', '')
      return Promise.resolve(
        new Response(new Blob([body]), {
          status: 200,
          headers: {
            etag: url.endsWith('pub78.zip') ? '"pub78"' : '"revoked"',
            'last-modified': 'Tue, 28 Apr 2026 00:00:00 GMT',
          },
        }),
      )
    })
    const ctx = makeContext({ fetch: fetchFn, downloadCache: cache })

    const first = await irsTeosSource.run(ENTITY, ctx)
    const second = await irsTeosSource.run(ENTITY, ctx)

    expect(first.isOk()).toBe(true)
    expect(second.isOk()).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(4)
    if (second.isOk()) {
      expect(second.value.record.payload.pub78).toMatchObject({
        tin: '123456789',
        deductibilityCode: 'PC',
      })
    }
  })

  it('emits a warn finding when EIN is NOT in Pub. 78', async () => {
    const pub78Text = pub78Row({ tin: '999999999' })
    const fetchFn = planned({
      pub78: { status: 200, body: zipString('pub78.txt', pub78Text) },
      revocation: { status: 200, body: zipString('revocation.txt', '') },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const findings = result.value.findings
    const titles = findings.map((f) => f.title)
    expect(titles).toContain('EIN not found in IRS Pub. 78')
    const f = findings.find((x) => x.title === 'EIN not found in IRS Pub. 78')
    expect(f?.severity).toBe('warn')
  })

  it('emits an error finding when EIN is on the auto-revocation list (no reinstatement)', async () => {
    const pub78Text = pub78Row({ tin: '999999999' })
    const revocationText = revocationRow({
      tin: '123456789',
      revocationDate: '05/15/2022',
      reinstatementDate: '',
    })
    const fetchFn = planned({
      pub78: { status: 200, body: zipString('pub78.txt', pub78Text) },
      revocation: {
        status: 200,
        body: zipString('rev.txt', revocationText),
      },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const errors = result.value.findings.filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.title).toMatch(/auto-revoc/i)
    expect(errors[0]?.evidence).toMatchObject({
      revocationDate: '05/15/2022',
    })
  })

  it('emits an info finding when EIN was auto-revoked but reinstated', async () => {
    const pub78Text = pub78Row({ tin: '123456789', code: 'PC' })
    const revocationText = revocationRow({
      tin: '123456789',
      revocationDate: '05/15/2022',
      reinstatementDate: '01/01/2023',
    })
    const fetchFn = planned({
      pub78: { status: 200, body: zipString('pub78.txt', pub78Text) },
      revocation: {
        status: 200,
        body: zipString('rev.txt', revocationText),
      },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const findings = result.value.findings
    const reinstated = findings.find((f) =>
      f.title.toLowerCase().includes('reinstat'),
    )
    expect(reinstated?.severity).toBe('info')
    expect(reinstated?.evidence).toMatchObject({
      reinstatementDate: '01/01/2023',
    })
  })

  it('captures the matched Pub. 78 row in the persisted payload', async () => {
    const pub78Text = pub78Row({
      tin: '123456789',
      name: 'Foo Foundation',
      city: 'San Francisco',
      state: 'CA',
      code: 'PC',
    })
    const fetchFn = planned({
      pub78: { status: 200, body: zipString('pub78.txt', pub78Text) },
      revocation: { status: 200, body: zipString('rev.txt', '') },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.record.payload).toMatchObject({
      pub78: {
        tin: '123456789',
        organizationName: 'Foo Foundation',
        city: 'San Francisco',
        state: 'CA',
        deductibilityCode: 'PC',
      },
      autoRevocation: null,
    })
  })

  it('returns an http error when Pub. 78 fetch fails with non-2xx', async () => {
    const fetchFn = planned({
      pub78: { status: 503, body: 'down' },
      revocation: { status: 200, body: zipString('rev.txt', '') },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('http')
      if (result.error.type === 'http') {
        expect(result.error.status).toBe(503)
      }
    }
  })

  it('returns rate_limit when upstream responds 429', async () => {
    const fetchFn = vi.fn<FetchImpl>((input) => {
      const url = toUrlString(input)
      if (url === IRS_TEOS_PUB78_URL) {
        return Promise.resolve(
          new Response('slow down', {
            status: 429,
            headers: { 'retry-after': '60' },
          }),
        )
      }
      return Promise.resolve(
        new Response(zipString('rev.txt', ''), { status: 200 }),
      )
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('rate_limit')
      if (result.error.type === 'rate_limit') {
        expect(result.error.retryAfterSeconds).toBe(60)
      }
    }
  })

  it('returns a network error when fetch itself rejects', async () => {
    const fetchFn = vi.fn<FetchImpl>(() =>
      Promise.reject(new Error('ECONNRESET')),
    )
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('network')
      expect(result.error.message).toContain('ECONNRESET')
    }
  })

  it('reports a parse error with a non-Error thrown by the unzipper', async () => {
    // The Pub.78 fetch returns invalid bytes that throw a non-Error from the
    // unzipper boundary. Concretely fflate throws a string for malformed
    // input, which exercises the `String(err)` fallback in toFetchError /
    // unzipSingle's error formatter.
    const fetchFn = planned({
      pub78: {
        status: 200,
        body: new Uint8Array([0xff, 0xfe, 0xfd]),
      },
      revocation: { status: 200, body: zipString('rev.txt', '') },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
      // Either a real Error or a stringified value made it into the message.
      expect(result.error.message.length).toBeGreaterThan(0)
    }
  })

  it('returns a parse error when the zip cannot be unzipped', async () => {
    const fetchFn = planned({
      pub78: {
        status: 200,
        body: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      },
      revocation: { status: 200, body: zipString('rev.txt', '') },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
    }
  })

  it('returns a parse error when the zip is empty (no entries)', async () => {
    const fetchFn = planned({
      pub78: { status: 200, body: zipSync({}) },
      revocation: { status: 200, body: zipString('rev.txt', '') },
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.type).toBe('parse')
    }
  })

  it('normalises an EIN with a dash to plain digits', async () => {
    const pub78Text = pub78Row({ tin: '123456789', code: 'PC' })
    const fetchFn = planned({
      pub78: { status: 200, body: zipString('pub78.txt', pub78Text) },
      revocation: { status: 200, body: zipString('rev.txt', '') },
    })
    const ctx = makeContext({
      fetch: fetchFn,
      identifiers: { 'us-federal': { ein: '12-3456789' } },
    })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const titles = result.value.findings.map((f) => f.title)
    expect(titles).toContain('EIN listed in IRS Pub. 78')
  })

  it('rate_limit error omits retryAfterSeconds when the header is missing', async () => {
    const fetchFn = vi.fn<FetchImpl>((input) => {
      const url = toUrlString(input)
      if (url === IRS_TEOS_PUB78_URL) {
        return Promise.resolve(new Response('', { status: 429 }))
      }
      return Promise.resolve(
        new Response(zipString('rev.txt', ''), { status: 200 }),
      )
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr() && result.error.type === 'rate_limit') {
      expect(result.error.retryAfterSeconds).toBeUndefined()
    }
  })

  it('rate_limit ignores a non-numeric retry-after header', async () => {
    const fetchFn = vi.fn<FetchImpl>((input) => {
      const url = toUrlString(input)
      if (url === IRS_TEOS_PUB78_URL) {
        return Promise.resolve(
          new Response('', {
            status: 429,
            headers: { 'retry-after': 'soon' },
          }),
        )
      }
      return Promise.resolve(
        new Response(zipString('rev.txt', ''), { status: 200 }),
      )
    })
    const ctx = makeContext({ fetch: fetchFn })

    const result = await irsTeosSource.run(ENTITY, ctx)
    expect(result.isErr()).toBe(true)
    if (result.isErr() && result.error.type === 'rate_limit') {
      expect(result.error.retryAfterSeconds).toBeUndefined()
    }
  })
})
