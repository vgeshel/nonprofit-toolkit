import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import {
  _internal,
  caCdtfaPermitLicenseVerificationSource,
} from '../jurisdictions/us-ca/sources/ca-cdtfa.ts'
import type {
  BrowserLocator,
  BrowserResponse,
  Entity,
  FetchImpl,
  SourceContext,
} from '../types/index.ts'

const ACCESS_URL = 'https://onlineservices.cdtfa.ca.gov/'

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

  click(): Promise<void> {
    this.page.actions.push(`locator-click ${this.selector}`)
    return Promise.resolve()
  }

  innerText(): Promise<string> {
    this.page.actions.push(`innerText ${this.selector}`)
    return Promise.resolve(this.page.bodyText)
  }

  inputValue(): Promise<string> {
    this.page.actions.push(`inputValue ${this.selector}`)
    return Promise.resolve(this.page.values.get(this.selector) ?? '')
  }
}

class FakePage {
  readonly actions: string[] = []
  readonly values = new Map<string, string>()
  bodyText: string

  constructor(
    readonly resultText: string,
    readonly resultValues: ReadonlyMap<string, string>,
    readonly gotoError: unknown = null,
    readonly staleReads = 0,
  ) {
    this.bodyText = [
      'Verify a permit, license or account',
      'Search Criteria',
      'Identification Number',
      'Search',
    ].join('\n')
    this.remainingStaleReads = staleReads
  }

  private remainingStaleReads: number

  setDefaultTimeout(timeoutMs: number): void {
    this.actions.push(`timeout ${String(timeoutMs)}`)
  }

  goto(url: string): Promise<void> {
    this.actions.push(`goto ${url}`)
    if (this.gotoError !== null) {
      const message =
        this.gotoError instanceof Error
          ? this.gotoError.message
          : typeof this.gotoError === 'string'
            ? this.gotoError
            : 'goto failed'
      return Promise.reject(new Error(message))
    }
    return Promise.resolve()
  }

  waitForSelector(selector: string): Promise<void> {
    this.actions.push(`wait ${selector}`)
    return Promise.resolve()
  }

  fill(selector: string, value: string): Promise<void> {
    this.actions.push(`fill ${selector}=${value}`)
    this.values.set(selector, value)
    return Promise.resolve()
  }

  selectOption(
    selector: string,
    option: { readonly label: string },
  ): Promise<void> {
    this.actions.push(`select ${selector}=${option.label}`)
    return Promise.resolve()
  }

  click(selector: string): Promise<void> {
    this.actions.push(`click ${selector}`)
    if (this.remainingStaleReads === 0) {
      this.applyResult()
    }
    return Promise.resolve()
  }

  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
  ): Promise<void> {
    this.actions.push(`load ${state ?? 'default'}`)
    return Promise.resolve()
  }

  waitForResponse(): Promise<BrowserResponse> {
    return Promise.reject(new Error('CDTFA test page has no API response'))
  }

  locator(selector: string): BrowserLocator {
    if (selector === 'body' && this.remainingStaleReads > 0) {
      this.remainingStaleReads -= 1
      if (this.remainingStaleReads === 0) {
        this.applyResult()
      }
    }
    return new FakeLocator(this, selector)
  }

  private applyResult(): void {
    this.bodyText = this.resultText
    for (const [selector, value] of this.resultValues.entries()) {
      this.values.set(selector, value)
    }
  }
}

function validPermitText(): string {
  return [
    'Verify a permit, license or account',
    'This is a valid Sellers Permit.',
    'Start Date',
    'Owner Name',
  ].join('\n')
}

function validPermitValues(
  overrides: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ['#d-4', '202-822944'],
    ['#f-3', '01-Sep-2023'],
    ['#f-4', ''],
    ['#f-5', 'LELEKA FOUNDATION'],
    ['#f-6', ''],
    ['#f-7', '380 HAMILTON AVE UNIT 291'],
    ['#f-8', ''],
    ['#f-9', ''],
    ['#f-a', 'PALO ALTO'],
    ['#f-b', '94302'],
    ...overrides.entries(),
  ])
}

function invalidPermitText(): string {
  return [
    'Verify a permit, license or account',
    'This Sellers Permit is invalid.',
  ].join('\n')
}

function contextWithPage(
  page: FakePage,
  identifiers: SourceContext['identifiers'] = {
    'us-ca': {
      sosEntityNumber: '6423690',
      cdtfaSellerPermitNumber: '202-822944',
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

describe('caCdtfaPermitLicenseVerificationSource metadata', () => {
  it('declares automated public permit verification access', () => {
    expect(caCdtfaPermitLicenseVerificationSource).toMatchObject({
      id: 'ca-cdtfa-permit-license-verification',
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

describe('caCdtfaPermitLicenseVerificationSource.run', () => {
  it('searches the public CDTFA page by configured seller permit and records the verification result', async () => {
    const page = new FakePage(validPermitText(), validPermitValues())

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain(`goto ${ACCESS_URL}`)
    expect(page.actions).toContain('select #d-3=Sellers Permit')
    expect(page.actions).toContain('fill #d-4=202822944')
    expect(page.actions).toContain('click button:has-text("Search")')
    expect(result.value.record).toMatchObject({
      source_id: 'ca-cdtfa-permit-license-verification',
      fetched_at: '2026-05-07T12:00:00.000Z',
      payload: {
        matchStatus: 'found',
        sourceType: 'public_permit_license_account_verification',
        search: {
          accountType: 'Sellers Permit',
          identifier: '202-822944',
          normalizedIdentifier: '202822944',
        },
        account_type: 'Sellers Permit',
        account_number: '202-822944',
        verification_status: 'This is a valid Sellers Permit.',
        is_valid: true,
        start_date: '01-Sep-2023',
        end_date: null,
        owner_name: 'LELEKA FOUNDATION',
        dba_name: null,
        address: '380 HAMILTON AVE UNIT 291',
        suspension_begin: null,
        suspension_end: null,
        city: 'PALO ALTO',
        zip_code: '94302',
      },
    })
    expect(result.value.record.payload.evidence).toMatchObject({
      kind: 'structured_public_verification_result',
      sourceId: 'ca-cdtfa-permit-license-verification',
      sourceUrl: ACCESS_URL,
      observedAt: '2026-05-07T12:00:00.000Z',
      label: 'CA CDTFA public permit, license, or account verification result',
    })
    expect(result.value.findings).toEqual([])
  })

  it('waits for the public page to replace stale content before reading fields', async () => {
    const page = new FakePage(validPermitText(), validPermitValues(), null, 2)

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    expect(
      page.actions.filter((action) => action === 'innerText body').length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('uses the public use-tax activity type when only a use-tax account number is configured', async () => {
    const page = new FakePage(
      'This is a valid Certificate of Registration - Use Tax.',
      validPermitValues(new Map([['#d-4', 'UT-00123456']])),
    )

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-ca': {
          sosEntityNumber: '6423690',
          cdtfaUseTaxAccountNumber: 'UT-00123456',
        },
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(page.actions).toContain(
      'select #d-3=Certificate of Registration - Use Tax',
    )
    expect(page.actions).toContain('fill #d-4=00123456')
    expect(result.value.record.payload).toMatchObject({
      search: {
        accountType: 'Certificate of Registration - Use Tax',
        identifier: 'UT-00123456',
        normalizedIdentifier: '00123456',
      },
      account_type: 'Certificate of Registration - Use Tax',
      is_valid: true,
    })
  })

  it('records an invalid public verification result without asking for manual evidence', async () => {
    const page = new FakePage(
      invalidPermitText(),
      new Map([['#d-4', '999-999999']]),
    )

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-ca': {
          sosEntityNumber: '6423690',
          cdtfaSellerPermitNumber: '999-999999',
        },
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      matchStatus: 'found',
      account_type: 'Sellers Permit',
      account_number: '999-999999',
      verification_status: 'This Sellers Permit is invalid.',
      is_valid: false,
      start_date: null,
      owner_name: null,
    })
  })

  it('falls back to the configured identifier when the public result field omits the account number', async () => {
    const page = new FakePage(
      validPermitText(),
      validPermitValues(new Map([['#d-4', '']])),
    )

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.record.payload).toMatchObject({
      account_number: '202-822944',
    })
  })

  it('returns a validation error when no public-verification CDTFA identifier is configured', async () => {
    const page = new FakePage(validPermitText(), validPermitValues())

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-ca': { sosEntityNumber: '6423690' },
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
    expect(result.error.message).toContain('seller permit')
    expect(page.actions).toEqual([])
  })

  it('returns a validation error when only an ambiguous CDTFA special tax account number is configured', async () => {
    const page = new FakePage(validPermitText(), validPermitValues())

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-ca': {
          sosEntityNumber: '6423690',
          cdtfaSpecialTaxAccountNumber: 'ST-123456',
        },
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
    expect(result.error.message).toContain('activity type')
  })

  it('returns a validation error when a configured CDTFA identifier has no digits to enter', async () => {
    const page = new FakePage(validPermitText(), validPermitValues())

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page, {
        'us-ca': {
          sosEntityNumber: '6423690',
          cdtfaSellerPermitNumber: 'ABC',
        },
        'us-federal': { ein: '47-2377309' },
      }),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('validation')
    expect(result.error.message).toContain('containing digits')
    expect(page.actions).toEqual([])
  })

  it('returns a parse error when public page text does not include a known verification result', () => {
    const result = _internal.readVerificationStatus('Search Criteria only', {
      accountType: 'Sellers Permit',
      identifier: '202-822944',
      normalizedIdentifier: '202822944',
    })

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('expected verification result')
  })

  it('propagates public-page parse failures while summarizing verification fields', async () => {
    const page = new FakePage('Search Criteria only', new Map())
    const result = await _internal.parseVerificationSummary(
      page,
      {
        accountType: 'Sellers Permit',
        identifier: '202-822944',
        normalizedIdentifier: '202822944',
      },
      'Search Criteria only',
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('expected verification result')
  })

  it('returns a parse error when a valid result omits required owner details', async () => {
    const page = new FakePage(
      validPermitText(),
      validPermitValues(new Map([['#f-5', '']])),
    )

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('parse')
    expect(result.error.message).toContain('Owner Name')
  })

  it('surfaces browser failures as network errors', async () => {
    const page = new FakePage(
      validPermitText(),
      validPermitValues(),
      'browser broke',
    )

    const result = await caCdtfaPermitLicenseVerificationSource.run(
      ENTITY,
      contextWithPage(page),
    )

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.type).toBe('network')
    expect(result.error.message).toContain('browser broke')
  })

  it('formats non-Error browser failures defensively', () => {
    expect(_internal.toBrowserSourceError('plain failure')).toEqual({
      type: 'network',
      message:
        'CA CDTFA public verification browser flow failed: plain failure',
    })
  })

  it('treats undefined public-page field values as absent', () => {
    expect(_internal.readOptionalString(undefined)).toBeNull()
  })
})
