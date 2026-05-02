import { describe, expect, it, vi } from 'vitest'
import {
  _internal as caAgRegistryInternal,
  caAgRegistrySource,
} from '../jurisdictions/us-ca/sources/ca-ag-registry.ts'
import type { Entity, FetchImpl, SourceContext } from '../types/index.ts'

const SEARCH_URL =
  'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y'
const DETAIL_URL =
  'https://rct.doj.ca.gov/Verification/Web/Details.aspx?result=public-detail-id'

type MockFetch = ReturnType<typeof vi.fn<FetchImpl>>

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

function searchFormHtml(): string {
  return `
    <form name="TheForm" method="post" action="./Search.aspx?facility=Y" id="TheForm">
      <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="view-state" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="generator" />
      <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="event-validation" />
      <input name="t_web_lookup__license_no" type="text" id="t_web_lookup__license_no" />
      <input name="t_web_lookup__charter_number" type="text" id="t_web_lookup__charter_number" />
      <input name="t_web_lookup__federal_id" type="text" id="t_web_lookup__federal_id" />
      <input name="t_web_lookup__full_name" type="text" id="t_web_lookup__full_name" />
      <input type="submit" name="sch_button" value="Search" id="sch_button" />
    </form>
  `
}

function searchResultsHtml(): string {
  return `
    <table cellspacing="0" rules="all" class="gdata" border="1" id="datagrid_results">
      <tr>
        <th>ORGANIZATION NAME&nbsp;</th>
        <th>RECORD TYPE&nbsp;</th>
        <th>REGISTRY STATUS&nbsp;</th>
        <th>RCT NUMBER&nbsp;</th>
        <th>FEIN</th>
        <th>CITY&nbsp;</th>
        <th>ST</th>
      </tr>
      <tr>
        <td id="datagrid_results__ctl3_result">
          <a id="datagrid_results__ctl3_hl" href="Details.aspx?result=public-detail-id" target="_blank">FOO FOUNDATION</a>
        </td>
        <td><span>Charity Registration</span></td>
        <td><span>Current</span></td>
        <td id="datagrid_results__ctl3_result">
          <a id="datagrid_results__ctl3_hl" href="Details.aspx?result=public-detail-id" target="_blank">CT0123456</a>
        </td>
        <td><span>123456789</span></td>
        <td><span>SAN FRANCISCO</span></td>
        <td><span>CA</span></td>
      </tr>
    </table>
  `
}

function emptySearchResultsHtml(): string {
  return `
    <table cellspacing="0" rules="all" class="gdata" border="1" id="datagrid_results">
      <tr>
        <th>ORGANIZATION NAME&nbsp;</th>
        <th>RECORD TYPE&nbsp;</th>
        <th>REGISTRY STATUS&nbsp;</th>
        <th>RCT NUMBER&nbsp;</th>
        <th>FEIN</th>
        <th>CITY&nbsp;</th>
        <th>ST</th>
      </tr>
    </table>
  `
}

function detailHtml(): string {
  return `
    <span id="_ctl19__ctl1_Label_full_name">Organization Name:</span>
    <span id="_ctl19__ctl1_full_name" class="rdata">FOO FOUNDATION</span>
    <span id="_ctl19__ctl1_fein">IRS FEIN:</span>
    <span id="_ctl19__ctl1_fed" class="rdata">123456789</span>
    <span id="_ctl19__ctl1_owner_type_label">Entity Type:</span>
    <span id="_ctl19__ctl1_owner_type" class="rdata">Charitable or nonprofit corporation</span>
    <span id="_ctl19__ctl1_charterlabel">SOS/FTB Corporate/Organization Number:</span>
    <span id="_ctl19__ctl1_charternumber" class="rdata">C0123456</span>
    <span id="_ctl23__ctl1_License_status">Registry Status:</span>
    <span id="_ctl23__ctl1_License_Status_code" class="rDataBig">Current</span>
    <span id="_ctl23__ctl1_Label_expiration_date">Renewal Due/Exp. Date:</span>
    <span id="_ctl23__ctl1_expiration_date" class="rDataBig">5/15/2026</span>
    <span id="_ctl23__ctl1_Label_license_no">RCT Registration Number:</span>
    <span id="_ctl23__ctl1_license_no" class="rdata">CT0123456</span>
    <span id="_ctl23__ctl1_Label_issue_date">Issue Date:</span>
    <span id="_ctl23__ctl1_issue_date" class="rdata">5/31/2024</span>
    <span id="_ctl23__ctl1_Label_license_type_2">Record Type:</span>
    <span id="_ctl23__ctl1_license_type" class="rdata">Charity Registration</span>
    <span id="_ctl23__ctl1_Label_effective_date">Effective Date:</span>
    <span id="_ctl23__ctl1_eff_date" class="rdata">5/31/2024</span>
    <span id="_ctl23__ctl1_Label_date_last_renewal">Date of Last Renewal:</span>
    <span id="_ctl23__ctl1_date_last_renewal" class="rdata">3/4/2026</span>
    <span id="_ctl23__ctl1_label_dba">DBA:</span>
    <span id="_ctl23__ctl1_lable_dba" class="rdata">Foo DBA</span>
    <span id="_ctl28__ctl1_Label_addr_line_1">Street:</span>
    <span id="_ctl28__ctl1_addr_line_1" class="rdata">1 MISSION ST</span>
    <span id="_ctl28__ctl1_label_addr_line_2">Street Line 2:</span>
    <span id="_ctl28__ctl1_addr_line_2" class="rdata">UNIT 2</span>
    <span id="_ctl28__ctl1_Label_addr_line_4">City, State Zip:</span>
    <span id="_ctl28__ctl1_addr_line_4" class="rdata">SAN FRANCISCO CA 94105</span>
    <span id="RRF_repeater__ctl1_Label_Status">Status of Filing:</span>
    <span id="RRF_repeater__ctl1_Status">Accepted</span>
    <span id="RRF_repeater__ctl1_Label_Fiscal_Begin">Accounting Period Begin Date:</span>
    <span id="RRF_repeater__ctl1_FiscalBegin">1/1/2023</span>
    <span id="RRF_repeater__ctl1_Label_Fiscal_End">Accounting Period End Date:</span>
    <span id="RRF_repeater__ctl1_FiscalEnd">12/31/2023</span>
    <span id="RRF_repeater__ctl1_Label_Receive">Filing Received Date:</span>
    <span id="RRF_repeater__ctl1_Receive_Date">11/14/2024</span>
    <span id="RRF_repeater__ctl2_Label_Status">Status of Filing:</span>
    <span id="RRF_repeater__ctl2_Status">E-Accepted</span>
    <span id="RRF_repeater__ctl2_Label_Fiscal_Begin">Accounting Period Begin Date:</span>
    <span id="RRF_repeater__ctl2_FiscalBegin">1/1/2024</span>
    <span id="RRF_repeater__ctl2_Label_Fiscal_End">Accounting Period End Date:</span>
    <span id="RRF_repeater__ctl2_FiscalEnd">12/31/2024</span>
    <span id="RRF_repeater__ctl2_Label_Receive">Filing Received Date:</span>
    <span id="RRF_repeater__ctl2_Receive_Date">12/15/2025</span>
  `
}

function publicRegistryFetch(args?: {
  readonly searchResults?: string
  readonly detail?: string
  readonly setCookie?: string | null
  readonly detailStatus?: number
}): MockFetch {
  return vi.fn<FetchImpl>((input, init) => {
    const url = toUrlString(input)
    if (url === SEARCH_URL && init?.method !== 'POST') {
      const headers =
        args?.setCookie === null
          ? undefined
          : {
              'set-cookie':
                args?.setCookie ?? 'ASP.NET_SessionId=test-session; path=/',
            }
      return Promise.resolve(
        new Response(searchFormHtml(), {
          status: 200,
          headers,
        }),
      )
    }
    if (url === SEARCH_URL && init?.method === 'POST') {
      return Promise.resolve(
        new Response(args?.searchResults ?? searchResultsHtml(), {
          status: 200,
        }),
      )
    }
    if (url === DETAIL_URL) {
      return Promise.resolve(
        new Response(args?.detail ?? detailHtml(), {
          status: args?.detailStatus ?? 200,
        }),
      )
    }
    return Promise.resolve(new Response('unexpected URL', { status: 404 }))
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

function postedParams(fetch: MockFetch): URLSearchParams {
  const calls = fetch.mock.calls
  const postInit = calls[1]?.[1]
  const body = postInit?.body
  if (body instanceof URLSearchParams) {
    return body
  }
  return new URLSearchParams(typeof body === 'string' ? body : '')
}

describe('caAgRegistrySource metadata', () => {
  it('declares public Registry Search Tool access', () => {
    expect(caAgRegistrySource).toMatchObject({
      id: 'ca-ag-registry',
      jurisdiction: 'us-ca',
      kind: 'api',
      accessUrl: SEARCH_URL,
      accessMethod: 'official_public_page',
      automationAllowed: true,
      authRequired: false,
    })
  })
})

describe('caAgRegistrySource.run', () => {
  it('submits the public Registry Search Tool by EIN and follows the public detail page', async () => {
    const fetch = publicRegistryFetch()

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(postedParams(fetch).get('t_web_lookup__federal_id')).toBe(
      '123456789',
    )
    expect(postedParams(fetch).get('t_web_lookup__profession_name')).toBe(
      'Charity',
    )
    expect(postedParams(fetch).get('t_web_lookup__license_type_name')).toBe(
      'Charity Registration',
    )
    expect(result.value.record.source_id).toBe('ca-ag-registry')
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      sourceType: 'public_registry_search',
      registryStatus: 'Current',
      listCategory: 'may_operate_or_solicit',
      stateCharityRegistrationNumber: 'CT0123456',
      fein: '123456789',
      sosFtbNumber: 'C0123456',
      name: 'FOO FOUNDATION',
      city: 'SAN FRANCISCO',
      state: 'CA',
      recordType: 'Charity Registration',
      entityType: 'Charitable or nonprofit corporation',
      renewalDueDate: '5/15/2026',
      issueDate: '5/31/2024',
      effectiveDate: '5/31/2024',
      lastRenewal: '3/4/2026',
      dba: 'Foo DBA',
      mailingAddress: {
        street: '1 MISSION ST',
        streetLine2: 'UNIT 2',
        cityStateZip: 'SAN FRANCISCO CA 94105',
      },
      annualRenewals: [
        {
          status: 'Accepted',
          accountingPeriodBeginDate: '1/1/2023',
          accountingPeriodEndDate: '12/31/2023',
          filingReceivedDate: '11/14/2024',
        },
        {
          status: 'E-Accepted',
          accountingPeriodBeginDate: '1/1/2024',
          accountingPeriodEndDate: '12/31/2024',
          filingReceivedDate: '12/15/2025',
        },
      ],
      evidence: {
        kind: 'text_excerpt',
        sourceId: 'ca-ag-registry',
        sourceUrl: DETAIL_URL,
      },
    })
    expect(result.value.findings).toHaveLength(0)
  })

  it('searches by AG charity number when EIN is absent', async () => {
    const fetch = publicRegistryFetch()

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {
        'us-ca': { sosEntityNumber: 'C0123456', agCharityNumber: 'CT0123456' },
      },
    })

    expect(result.isOk()).toBe(true)
    expect(postedParams(fetch).get('t_web_lookup__license_no')).toBe(
      'CT0123456',
    )
  })

  it('searches by SOS/FTB number when federal and AG identifiers are absent', async () => {
    const fetch = publicRegistryFetch()

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {
        'us-ca': { sosEntityNumber: 'C0123456' },
      },
    })

    expect(result.isOk()).toBe(true)
    expect(postedParams(fetch).get('t_web_lookup__charter_number')).toBe(
      'C0123456',
    )
  })

  it('searches by exact legal name when no identifiers are configured', async () => {
    const fetch = publicRegistryFetch()

    const result = await caAgRegistrySource.run(ENTITY, {
      ...makeContext(fetch),
      identifiers: {},
    })

    expect(result.isOk()).toBe(true)
    expect(postedParams(fetch).get('t_web_lookup__full_name')).toBe(
      'Foo Foundation',
    )
  })

  it('submits search without a session cookie when the public form does not set one', async () => {
    const fetch = publicRegistryFetch({ setCookie: null })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    const postHeaders = fetch.mock.calls[1]?.[1]?.headers
    expect(JSON.stringify(postHeaders ?? {})).not.toContain('cookie')
  })

  it('uses a session cookie even when the public form cookie has no attributes', async () => {
    const fetch = publicRegistryFetch({
      setCookie: 'ASP.NET_SessionId=test-session',
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    const postHeaders = fetch.mock.calls[1]?.[1]?.headers
    expect(postHeaders).toBeInstanceOf(Headers)
    if (!(postHeaders instanceof Headers)) return
    expect(postHeaders.get('cookie')).toBe('ASP.NET_SessionId=test-session')
  })

  it('omits optional detail fields when public detail spans are empty', async () => {
    const fetch = publicRegistryFetch({
      detail: detailHtml().replace('Foo DBA', '   '),
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).not.toHaveProperty('dba')
  })

  it('falls back to public search-result fields when optional detail fields are absent', async () => {
    const fetch = publicRegistryFetch({
      detail: `
        <span id="_ctl19__ctl1_full_name" class="rdata">FOO FOUNDATION</span>
        <span id="_ctl23__ctl1_License_Status_code" class="rDataBig">Current</span>
      `,
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      registryStatus: 'Current',
      stateCharityRegistrationNumber: 'CT0123456',
      fein: '123456789',
      name: 'FOO FOUNDATION',
      recordType: 'Charity Registration',
    })
  })

  it('returns a not-found source record when the public search returns no rows', async () => {
    const fetch = publicRegistryFetch({
      searchResults: emptySearchResultsHtml(),
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'not_found',
      sourceType: 'public_registry_search',
      search: {
        field: 'FEIN',
        value: '123456789',
      },
    })
  })

  it('returns a parse source error when the public search form changes shape', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('<form></form>', { status: 200 })),
    )

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('__VIEWSTATE')
  })

  it('returns a parse source error when the public search form omits the view-state generator', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(
        new Response(
          searchFormHtml().replace(
            /<input type="hidden" name="__VIEWSTATEGENERATOR"[\s\S]*?\/>/,
            '',
          ),
          { status: 200 },
        ),
      ),
    )

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('__VIEWSTATEGENERATOR')
  })

  it('returns a parse source error when the public search form omits event validation', async () => {
    const fetch = vi.fn<FetchImpl>(() =>
      Promise.resolve(
        new Response(
          searchFormHtml().replace(
            /<input type="hidden" name="__EVENTVALIDATION"[\s\S]*?\/>/,
            '',
          ),
          { status: 200 },
        ),
      ),
    )

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('__EVENTVALIDATION')
  })

  it('returns a parse source error when public search results omit the result table', async () => {
    const fetch = publicRegistryFetch({ searchResults: '<html></html>' })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('datagrid_results')
  })

  it('returns a parse source error when a public result row has no detail link', async () => {
    const fetch = publicRegistryFetch({
      searchResults: searchResultsHtml().replace(
        /href="Details\.aspx\?result=public-detail-id"/g,
        '',
      ),
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('public detail link')
  })

  it('returns a parse source error when the public detail page omits status fields', async () => {
    const fetch = publicRegistryFetch({
      detail: '<span id="_ctl19__ctl1_full_name">FOO FOUNDATION</span>',
    })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('expected organization and status')
  })

  it('returns an HTTP source error when the public detail page is unavailable', async () => {
    const fetch = publicRegistryFetch({ detailStatus: 503 })

    const result = await caAgRegistrySource.run(ENTITY, makeContext(fetch))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toMatchObject({
      type: 'http',
      status: 503,
    })
    expect(result.error.message).toContain('CA AG Registry detail page')
  })

  it('returns an HTTP source error when the public search page is unavailable', async () => {
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
    expect(result.error.message).toContain('CA AG Registry Search Tool')
  })

  it('returns a network source error when the public search rejects', async () => {
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

describe('caAgRegistrySource internals', () => {
  it.each([
    ['Current - Awaiting Reporting', 'may_operate_or_solicit'],
    ['Dissolving', 'not_operating_or_dissolving'],
    ['Delinquent', 'may_not_operate_or_solicit'],
    ['Reporting Incomplete', 'undetermined'],
  ] as const)('classifies registry status %s', (status, category) => {
    expect(caAgRegistryInternal.listCategoryFromStatus(status)).toBe(category)
  })
})
