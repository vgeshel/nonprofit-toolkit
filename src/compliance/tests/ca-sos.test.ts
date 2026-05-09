import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  _internal,
  caSosBizfileSource,
} from '../jurisdictions/us-ca/sources/ca-sos.ts'
import type {
  BrowserLocator,
  BrowserResponse,
  Entity,
  FetchImpl,
  SourceContext,
} from '../types/index.ts'

const ACCESS_URL = 'https://bizfileonline.sos.ca.gov/search/business'
const SEARCH_API_URL =
  'https://bizfileonline.sos.ca.gov/api/Records/businesssearch'

const ENTITY: Entity = {
  legal_name: 'Leleka Foundation',
  state_of_incorporation: 'DC',
  fiscal_year_end_month: 12,
  fiscal_year_end_day: 31,
  formation_date: '2014-12-14',
  mailing_address_line1: '380 Hamilton Ave',
  mailing_address_line2: 'Unit 291',
  mailing_address_city: 'Palo Alto',
  mailing_address_region: 'CA',
  mailing_address_postal_code: '94302-2405',
  mailing_address_country: 'US',
  updated_at: '2026-04-28T04:36:09.668Z',
}

function businessSearchPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return businessSearchPayloadWithRows({
    '8668745': {
      SORT_INDEX: 0,
      TITLE: ['Leleka Foundation (6423690)'],
      ID: 8668745,
      FILING_DATE: '10/14/2024',
      RECORD_NUM: '252053035001073229192221244135201168215067026252',
      FORMED_IN: 'DISTRICT OF COLUMBIA',
      AGENT: 'CALIFORNIA CORPORATE AGENTS, INC.',
      STATUS: 'Active',
      ENTITY_TYPE: 'Nonprofit Corporation - Out of State',
      STANDING: 'Good Standing',
      ALERT: false,
      CAN_REINSTATE: false,
      CAN_FILE_AR: true,
      CAN_FILE_REINSTATEMENT: false,
      ...overrides,
    },
  })
}

function businessSearchPayloadWithRows(
  rows: Record<string, unknown>,
): Record<string, unknown> {
  return {
    template: [
      { label: 'Entity Information', id: 'TITLE' },
      { label: 'Initial Filing Date', id: 'FILING_DATE' },
      { label: 'Status', id: 'STATUS' },
      { label: 'Entity Type', id: 'ENTITY_TYPE' },
      { label: 'Formed In', id: 'FORMED_IN' },
      { label: 'Agent', id: 'AGENT' },
    ],
    rows,
  }
}

class FakeResponse implements BrowserResponse {
  constructor(
    private readonly responseStatus: number,
    private readonly body: unknown,
    private readonly responseUrl: string = SEARCH_API_URL,
    private readonly jsonError: Error | null = null,
  ) {}

  url(): string {
    return this.responseUrl
  }

  status(): number {
    return this.responseStatus
  }

  json(): Promise<unknown> {
    if (this.jsonError !== null) {
      return Promise.reject(this.jsonError)
    }
    return Promise.resolve(this.body)
  }
}

class FakeLocator implements BrowserLocator {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
  ) {}

  filter(): BrowserLocator {
    return this
  }

  first(): BrowserLocator {
    return this
  }

  count(): Promise<number> {
    return Promise.resolve(1)
  }

  click(options?: { readonly force?: boolean }): Promise<void> {
    this.page.actions.push(
      options?.force === true
        ? `locator-click-force ${this.selector}`
        : `locator-click ${this.selector}`,
    )
    return Promise.resolve()
  }

  innerText(): Promise<string> {
    return Promise.resolve('')
  }

  inputValue(): Promise<string> {
    return Promise.resolve('')
  }
}

class FakePage {
  readonly actions: string[] = []

  constructor(
    private readonly response: BrowserResponse,
    private readonly responseError: Error | null = null,
  ) {}

  setDefaultTimeout(timeoutMs: number): void {
    this.actions.push(`timeout ${String(timeoutMs)}`)
  }

  goto(url: string): Promise<void> {
    this.actions.push(`goto ${url}`)
    return Promise.resolve()
  }

  waitForSelector(selector: string): Promise<void> {
    this.actions.push(`wait ${selector}`)
    return Promise.resolve()
  }

  selectOption(
    selector: string,
    option: { readonly label: string },
  ): Promise<void> {
    this.actions.push(`select ${selector}=${option.label}`)
    return Promise.resolve()
  }

  fill(selector: string, value: string): Promise<void> {
    this.actions.push(`fill ${selector}=${value}`)
    return Promise.resolve()
  }

  click(selector: string): Promise<void> {
    this.actions.push(`click ${selector}`)
    return Promise.resolve()
  }

  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
  ): Promise<void> {
    this.actions.push(`load ${state ?? 'default'}`)
    return Promise.resolve()
  }

  waitForResponse(
    predicate: (response: BrowserResponse) => boolean,
  ): Promise<BrowserResponse> {
    this.actions.push('wait-response')
    if (this.responseError !== null) {
      return Promise.reject(this.responseError)
    }
    if (!predicate(this.response)) {
      return Promise.reject(new Error('predicate rejected response'))
    }
    return Promise.resolve(this.response)
  }

  locator(selector: string): BrowserLocator {
    return new FakeLocator(this, selector)
  }
}

function contextWithPage(
  page: FakePage,
  identifiers: SourceContext['identifiers'] = {
    'us-ca': {
      sosEntityNumber: '6423690',
      ftbEntityId: '6423690',
      ftbEntityName: 'LELEKA FOUNDATION',
    },
    'us-federal': { ein: '47-2377309' },
  },
): SourceContext {
  const close = vi.fn<() => Promise<void>>(() => Promise.resolve())
  return {
    now: () => new Date('2026-05-07T12:00:00.000Z'),
    fetch: vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 500 })),
    ),
    identifiers,
    browserPageFactory: () => okAsync({ page, close }),
  }
}

describe('caSosBizfileSource metadata', () => {
  it('declares automated public bizfile business-search access', () => {
    expect(caSosBizfileSource).toMatchObject({
      id: 'ca-sos-bizfile',
      jurisdiction: 'us-ca',
      kind: 'playwright',
      accessUrl: ACCESS_URL,
      accessMethod: 'official_public_page',
      automationAllowed: true,
      authRequired: false,
    })
  })

  it('uses the production browser factory when no test factory is injected', () => {
    const context: SourceContext = {
      now: () => new Date('2026-05-07T12:00:00.000Z'),
      fetch: vi.fn<FetchImpl>(() =>
        Promise.resolve(new Response('', { status: 500 })),
      ),
      identifiers: { 'us-federal': { ein: '47-2377309' } },
    }

    expect(_internal.getBrowserPageFactory(context)).toBeTypeOf('function')
  })
})

describe('caSosBizfileSource.run', () => {
  it('searches public bizfile by configured SOS entity number and records the status row', async () => {
    const page = new FakePage(new FakeResponse(200, businessSearchPayload()))

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain(`goto ${ACCESS_URL}`)
    expect(page.actions).toContain(
      'fill input[placeholder="Search by name or file number"]=6423690',
    )
    expect(page.actions.indexOf('wait-response')).toBeLessThan(
      page.actions.indexOf(
        'locator-click-force button[aria-label="Execute search"], button.search-button',
      ),
    )
    expect(result.value.record).toMatchObject({
      source_id: 'ca-sos-bizfile',
      fetched_at: '2026-05-07T12:00:00.000Z',
      payload: {
        matchStatus: 'found',
        sourceType: 'public_bizfile_business_search',
        search: { field: 'SOS Entity Number', value: '6423690' },
        entity_name: 'Leleka Foundation',
        sos_entity_number: '6423690',
        initial_filing_date: '10/14/2024',
        entity_status: 'Active',
        entity_type: 'Nonprofit Corporation - Out of State',
        formed_in: 'DISTRICT OF COLUMBIA',
        agent: 'CALIFORNIA CORPORATE AGENTS, INC.',
        standing: 'Good Standing',
      },
    })
    expect(result.value.record.payload.evidence).toMatchObject({
      kind: 'structured_public_search_row',
      sourceId: 'ca-sos-bizfile',
      sourceUrl: ACCESS_URL,
      observedAt: '2026-05-07T12:00:00.000Z',
      label: 'CA SOS public bizfile business-search row',
    })
    expect(result.value.findings).toEqual([])
  })

  it('removes a C prefix when searching legacy California corporation numbers', async () => {
    const page = new FakePage(new FakeResponse(200, businessSearchPayload()))

    const result = await caSosBizfileSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-ca': { sosEntityNumber: 'C6423690' },
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain(
      'fill input[placeholder="Search by name or file number"]=6423690',
    )
    expect(result.value.record.payload).toMatchObject({
      search: {
        field: 'SOS Entity Number',
        value: '6423690',
        configuredValue: 'C6423690',
      },
      sos_entity_number: '6423690',
    })
  })

  it('falls back to exact legal-name search when no California SOS number is configured', async () => {
    const page = new FakePage(new FakeResponse(200, businessSearchPayload()))

    const result = await caSosBizfileSource.run(
      ENTITY,
      contextWithPage(page, { 'us-federal': { ein: '47-2377309' } }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain(
      'fill input[placeholder="Search by name or file number"]=Leleka Foundation',
    )
    expect(result.value.record.payload).toMatchObject({
      search: { field: 'Entity Name', value: 'Leleka Foundation' },
      entity_name: 'Leleka Foundation',
    })
  })

  it('records not found when the public search returns no rows', async () => {
    const page = new FakePage(new FakeResponse(200, { template: [], rows: {} }))

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toEqual({
      matchStatus: 'not_found',
      sourceType: 'public_bizfile_business_search',
      search: { field: 'SOS Entity Number', value: '6423690' },
      resultCount: 0,
    })
  })

  it('records not found when public search rows do not match the configured SOS number', async () => {
    const page = new FakePage(
      new FakeResponse(
        200,
        businessSearchPayload({ TITLE: ['Different Foundation (9999999)'] }),
      ),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toEqual({
      matchStatus: 'not_found',
      sourceType: 'public_bizfile_business_search',
      search: { field: 'SOS Entity Number', value: '6423690' },
      resultCount: 1,
    })
  })

  it('records not found when public search rows do not match the legal name fallback', async () => {
    const page = new FakePage(
      new FakeResponse(
        200,
        businessSearchPayloadWithRows({
          '1': {
            SORT_INDEX: 1,
            TITLE: ['Different Foundation (9999999)'],
            FILING_DATE: '10/14/2024',
            FORMED_IN: 'CALIFORNIA',
            AGENT: 'EXAMPLE AGENT',
            STATUS: 'Active',
            ENTITY_TYPE: 'Nonprofit Corporation',
          },
          '2': {
            SORT_INDEX: 0,
            TITLE: ['Another Foundation (8888888)'],
            FILING_DATE: '10/15/2024',
            FORMED_IN: 'CALIFORNIA',
            AGENT: 'EXAMPLE AGENT',
            STATUS: 'Active',
            ENTITY_TYPE: 'Nonprofit Corporation',
          },
        }),
      ),
    )

    const result = await caSosBizfileSource.run(
      ENTITY,
      contextWithPage(page, { 'us-federal': { ein: '47-2377309' } }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'not_found',
      search: { field: 'Entity Name', value: 'Leleka Foundation' },
      resultCount: 2,
    })
  })

  it('sorts rows with missing sort indexes before choosing the legal-name match', async () => {
    const page = new FakePage(
      new FakeResponse(
        200,
        businessSearchPayloadWithRows({
          '2': {
            SORT_INDEX: 2,
            TITLE: ['Different Foundation (9999999)'],
            FILING_DATE: '10/14/2024',
            FORMED_IN: 'CALIFORNIA',
            AGENT: 'EXAMPLE AGENT',
            STATUS: 'Active',
            ENTITY_TYPE: 'Nonprofit Corporation',
          },
          '1': {
            TITLE: ['Leleka Foundation (6423690)'],
            FILING_DATE: '10/15/2024',
            FORMED_IN: 'DISTRICT OF COLUMBIA',
            AGENT: 'CALIFORNIA CORPORATE AGENTS, INC.',
            STATUS: 'Active',
            ENTITY_TYPE: 'Nonprofit Corporation - Out of State',
          },
        }),
      ),
    )

    const result = await caSosBizfileSource.run(
      ENTITY,
      contextWithPage(page, { 'us-federal': { ein: '47-2377309' } }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      entity_name: 'Leleka Foundation',
      ca_record_id: null,
    })
  })

  it('returns a parse error when the bizfile row title format changes', async () => {
    const page = new FakePage(
      new FakeResponse(
        200,
        businessSearchPayload({ TITLE: ['Leleka Foundation'] }),
      ),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('entity title and number')
  })

  it('returns a parse error when the bizfile row title list is empty', async () => {
    const page = new FakePage(
      new FakeResponse(200, businessSearchPayload({ TITLE: [] })),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('entity title and number')
  })

  it('returns a parse error when bizfile omits a required status field', async () => {
    const page = new FakePage(
      new FakeResponse(200, businessSearchPayload({ STATUS: undefined })),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Status')
  })

  it('returns a parse error when bizfile returns a blank required status field', async () => {
    const page = new FakePage(
      new FakeResponse(200, businessSearchPayload({ STATUS: '   ' })),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Status')
  })

  it('returns a parse error when the bizfile response schema changes', async () => {
    const page = new FakePage(new FakeResponse(200, { unexpected: true }))

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('schema')
  })

  it('returns a parse error when the public search response is not successful', async () => {
    const page = new FakePage(new FakeResponse(403, ''))

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('status 403')
  })

  it('returns a parse error when the public search response is not JSON', async () => {
    const page = new FakePage(
      new FakeResponse(200, '', SEARCH_API_URL, new Error('Unexpected token')),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Unexpected token')
  })

  it('stringifies non-Error JSON failures in parse errors', () => {
    const error = _internal.toJsonSourceError('invalid json')

    expect(error.type).toBe('parse')
    expect(error.message).toContain('invalid json')
  })

  it('maps browser failures to network source errors', async () => {
    const page = new FakePage(
      new FakeResponse(200, businessSearchPayload()),
      new Error('response timed out'),
    )

    const result = await caSosBizfileSource.run(ENTITY, contextWithPage(page))

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('network')
    expect(result.error.message).toContain('response timed out')
  })

  it('stringifies non-Error browser failures in network source errors', () => {
    const error = _internal.toBrowserSourceError('response timed out')

    expect(error.type).toBe('network')
    expect(error.message).toContain('response timed out')
  })

  it('surfaces title parse errors from row summaries', () => {
    const result = _internal.summarizeRow({
      SORT_INDEX: 0,
      TITLE: ['Leleka Foundation'],
      FILING_DATE: '10/14/2024',
      STATUS: 'Active',
      ENTITY_TYPE: 'Nonprofit Corporation - Out of State',
      FORMED_IN: 'DISTRICT OF COLUMBIA',
      AGENT: 'CALIFORNIA CORPORATE AGENTS, INC.',
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.message).toContain('entity title and number')
  })

  it('surfaces empty title lists from row summaries', () => {
    const result = _internal.summarizeRow({
      SORT_INDEX: 0,
      TITLE: [],
      FILING_DATE: '10/14/2024',
      STATUS: 'Active',
      ENTITY_TYPE: 'Nonprofit Corporation - Out of State',
      FORMED_IN: 'DISTRICT OF COLUMBIA',
      AGENT: 'CALIFORNIA CORPORATE AGENTS, INC.',
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.message).toContain('entity title and number')
  })
})
