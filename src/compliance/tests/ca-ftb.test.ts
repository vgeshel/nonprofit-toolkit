import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { caFtbEntityStatusLetterSource } from '../jurisdictions/us-ca/sources/ca-ftb.ts'
import type {
  BrowserResponse,
  Entity,
  FetchImpl,
  SourceContext,
} from '../types/index.ts'

const ACCESS_URL = 'https://webapp.ftb.ca.gov/eletter/'

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

function summaryText(overrides: Partial<Record<string, string>> = {}): string {
  return [
    'The following Entity was found.',
    `Entity ID: ${overrides.entityId ?? '6423690'}`,
    `Entity Name: ${overrides.entityName ?? 'LELEKA FOUNDATION'}`,
    `Address: ${
      overrides.address ?? '380 HAMILTON AVE UNIT 291 PALO ALTO, CA 94302-2405'
    }`,
    `Entity Status: ${overrides.entityStatus ?? 'ACTIVE'}`,
    `Exempt Status: ${overrides.exemptStatus ?? 'NOT EXEMPT'}`,
    'Generate Letter',
  ].join('\n\n')
}

function resultText(): string {
  return [
    'Entity Search Result',
    'Results displayed below.',
    'Entities matching the search criteria',
    'Entity ID\tEntity Name\tCity',
    '6423690\tLELEKA FOUNDATION\tPALO ALTO',
  ].join('\n')
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
    private readonly textFilter: string | RegExp | null = null,
  ) {}

  filter(options: { readonly hasText: string | RegExp }): FakeLocator {
    return new FakeLocator(this.page, this.selector, options.hasText)
  }

  first(): FakeLocator {
    return this
  }

  count(): Promise<number> {
    if (this.selector === 'table button' || this.textFilter !== null) {
      return Promise.resolve(this.page.hasResultButton ? 1 : 0)
    }
    return Promise.resolve(1)
  }

  click(options?: { readonly force?: boolean }): Promise<void> {
    const prefix =
      options?.force === true ? 'locator-click-force' : 'locator-click'
    this.page.actions.push(
      this.textFilter === null
        ? `${prefix} ${this.selector}`
        : `${prefix} ${String(this.textFilter)}`,
    )
    this.page.stage =
      this.selector === 'button[title="Search for an Entity."]'
        ? 'result'
        : 'summary'
    return Promise.resolve()
  }

  innerText(): Promise<string> {
    this.page.actions.push(`innerText ${this.selector}`)
    return Promise.resolve(this.page.innerText())
  }

  inputValue(): Promise<string> {
    this.page.actions.push(`inputValue ${this.selector}`)
    return Promise.resolve('')
  }
}

class FakePage {
  readonly actions: string[] = []
  stage: 'search' | 'result' | 'summary' = 'search'

  constructor(
    readonly result: string,
    readonly summary: string,
    readonly hasResultButton = true,
    readonly gotoError: unknown = null,
    readonly loadError: unknown = null,
    private staleResultReads = 0,
    private staleSummaryReads = 0,
  ) {}

  setDefaultTimeout(timeoutMs: number): void {
    this.actions.push(`timeout ${String(timeoutMs)}`)
  }

  goto(url: string): Promise<void> {
    this.actions.push(`goto ${url}`)
    if (this.gotoError !== null) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(this.gotoError)
    }
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
    this.stage = 'result'
    return Promise.resolve()
  }

  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
  ): Promise<void> {
    this.actions.push(`load ${state ?? 'default'}`)
    if (this.loadError !== null) {
      const message =
        typeof this.loadError === 'string' ? this.loadError : 'load failed'
      return Promise.reject(new Error(message))
    }
    return Promise.resolve()
  }

  waitForResponse(): Promise<BrowserResponse> {
    return Promise.reject(new Error('FTB test page has no API response'))
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector)
  }

  innerText(): string {
    if (this.stage === 'summary') {
      if (this.staleSummaryReads > 0) {
        this.staleSummaryReads -= 1
        return this.result
      }
      return this.summary
    }
    if (this.stage === 'result') {
      if (this.staleResultReads > 0) {
        this.staleResultReads -= 1
        return [
          'Self Serve Entity Status Letter',
          'Entity Search',
          'To search, enter either an Entity ID or Entity Name.',
          'Perform Search',
        ].join('\n')
      }
      return this.result
    }
    return [
      'Self Serve Entity Status Letter',
      'Entity Search',
      'To search, enter either an Entity ID or Entity Name.',
      'Perform Search',
    ].join('\n')
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
  const context: SourceContext = {
    now: () => new Date('2026-05-03T12:00:00.000Z'),
    fetch: vi.fn<FetchImpl>(() =>
      Promise.resolve(new Response('', { status: 500 })),
    ),
    identifiers,
    browserPageFactory: () => okAsync({ page, close }),
  }
  return context
}

describe('caFtbEntityStatusLetterSource metadata', () => {
  it('declares automated public Entity Status Letter access', () => {
    expect(caFtbEntityStatusLetterSource).toMatchObject({
      id: 'ca-ftb-entity-status-letter',
      jurisdiction: 'us-ca',
      kind: 'playwright',
      accessUrl: ACCESS_URL,
      accessMethod: 'official_public_page',
      automationAllowed: true,
      authRequired: false,
    })
  })
})

describe('caFtbEntityStatusLetterSource.run', () => {
  it('searches the public FTB Entity Status Letter page by entity ID and parses the summary status', async () => {
    const page = new FakePage(resultText(), summaryText())

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain(`goto ${ACCESS_URL}`)
    expect(page.actions).toContain('fill #EntityId=6423690')
    expect(page.actions).toContain(
      'locator-click-force button[title="Search for an Entity."]',
    )
    expect(page.actions).toContain('locator-click-force 6423690')
    expect(result.value.record).toMatchObject({
      source_id: 'ca-ftb-entity-status-letter',
      fetched_at: '2026-05-03T12:00:00.000Z',
      payload: {
        matchStatus: 'found',
        sourceType: 'public_entity_status_letter',
        search: { field: 'Entity ID', value: '6423690' },
        entity_id: '6423690',
        entity_name: 'LELEKA FOUNDATION',
        address: '380 HAMILTON AVE UNIT 291 PALO ALTO, CA 94302-2405',
        ftb_status: 'ACTIVE',
        exempt_status_verified: 'NOT EXEMPT',
      },
    })
    expect(result.value.record.payload.evidence).toMatchObject({
      kind: 'text_excerpt',
      sourceId: 'ca-ftb-entity-status-letter',
      sourceUrl: ACCESS_URL,
      observedAt: '2026-05-03T12:00:00.000Z',
      label: 'CA FTB public Entity Status Letter summary',
    })
    expect(result.value.findings).toEqual([])
  })

  it('falls back to the California SOS entity number as the public FTB entity ID when no FTB-specific ID is configured', async () => {
    const page = new FakePage(resultText(), summaryText())

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-federal': { ein: '47-2377309' },
        'us-ca': { sosEntityNumber: '6423690' },
      }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain('fill #EntityId=6423690')
    expect(page.actions).toContain('locator-click-force 6423690')
    expect(result.value.record.payload).toMatchObject({
      search: { field: 'Entity ID', value: '6423690' },
      entity_id: '6423690',
    })
  })

  it('falls back to exact legal-name search when no California entity ID is configured', async () => {
    const page = new FakePage(resultText(), summaryText())

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain('fill #EntityName=Leleka Foundation')
    expect(page.actions).toContain('locator-click-force table button')
    expect(result.value.record.payload).toMatchObject({
      search: { field: 'Entity Name', value: 'Leleka Foundation' },
      entity_id: '6423690',
    })
  })

  it('records a not-found payload when the public result page has no matching entity', async () => {
    const page = new FakePage(
      'Entity Search Result\nNo entities matching the search criteria were found.',
      '',
      false,
    )

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toEqual({
      matchStatus: 'not_found',
      sourceType: 'public_entity_status_letter',
      search: { field: 'Entity ID', value: '6423690' },
    })
  })

  it('returns a parse error when the public summary omits required status fields', async () => {
    const page = new FakePage(
      resultText(),
      summaryText({ exemptStatus: '' }).replace('Exempt Status: ', ''),
    )

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Exempt Status')
  })

  it('returns a parse error when the public summary has a blank required status field', async () => {
    const page = new FakePage(resultText(), summaryText({ exemptStatus: '' }))

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Exempt Status')
  })

  it('returns a parse error when FTB returns a challenge page after search', async () => {
    const page = new FakePage('Challenge Validation', summaryText())

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('browser challenge')
  })

  it('returns a parse error when the search response is not the expected result page', async () => {
    const page = new FakePage('Entity Search\nTry again.', summaryText())

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('expected result page')
  })

  it('returns a parse error when the result page has no entity button', async () => {
    const page = new FakePage(resultText(), summaryText(), false)

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('entity result button')
  })

  it('returns a parse error when FTB returns a challenge page before the summary', async () => {
    const page = new FakePage(resultText(), 'Challenge Validation')

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('public summary')
  })

  it('maps browser Error failures to network source errors', async () => {
    const page = new FakePage(
      resultText(),
      summaryText(),
      true,
      new Error('no browser'),
    )

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('network')
    expect(result.error.message).toContain('no browser')
  })

  it('maps non-Error browser failures to network source errors', async () => {
    const page = new FakePage(resultText(), summaryText(), true, 'boom')

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('network')
    expect(result.error.message).toContain('boom')
  })

  it('still parses the summary when load-state waiting times out after clicks', async () => {
    const page = new FakePage(
      resultText(),
      summaryText(),
      true,
      null,
      'timeout',
    )

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      ftb_status: 'ACTIVE',
      exempt_status_verified: 'NOT EXEMPT',
    })
  })

  it('waits for FTB pages to finish replacing stale body text after clicks', async () => {
    const page = new FakePage(
      resultText(),
      summaryText(),
      true,
      null,
      null,
      1,
      1,
    )

    const result = await caFtbEntityStatusLetterSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      entity_id: '6423690',
      ftb_status: 'ACTIVE',
      exempt_status_verified: 'NOT EXEMPT',
    })
    expect(
      page.actions.filter((action) => action === 'innerText body').length,
    ).toBeGreaterThan(2)
  })
})
