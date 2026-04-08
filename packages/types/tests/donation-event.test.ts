import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  centsToDollars,
  dollarsToCents,
  DonationEventSchema,
  DonationStatusEnum,
  DonorAddressSchema,
  parseDonationEvent,
  safeParseDonationEvent,
  SourceEnum,
  type DonationEvent,
} from '../src/donation-event'

/**
 * Factory to create a valid DonationEvent for testing.
 */
function createValidEvent(
  overrides: Partial<DonationEvent> = {},
): DonationEvent {
  return {
    source: 'mercury',
    external_id: 'txn_123',
    event_ts: '2024-01-15T10:30:00.000Z',
    created_at: '2024-01-15T10:30:00.000Z',
    ingested_at: '2024-01-15T12:00:00.000Z',
    amount_cents: 10000,
    fee_cents: 0,
    net_amount_cents: 10000,
    currency: 'USD',
    donor_name: 'John Doe',
    payer_name: null,
    donor_email: 'john@example.com',
    donor_phone: '+1-555-123-4567',
    donor_address: {
      line1: '123 Main St',
      line2: null,
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: 'US',
    },
    status: 'succeeded',
    payment_method: 'ach',
    description: 'Monthly donation',
    attribution: null,
    attribution_human: null,
    source_metadata: { counterpartyId: 'cpty_456' },
    run_id: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  }
}

/**
 * Create an event object with specific keys omitted (for testing missing required fields).
 * Returns Record<string, unknown> to allow passing to schema validators.
 */
function createEventWithout<K extends keyof DonationEvent>(
  ...keys: K[]
): Record<string, unknown> {
  const event = createValidEvent()
  const result: Record<string, unknown> = { ...event }
  for (const key of keys) {
    delete result[key]
  }
  return result
}

/**
 * Create an event with defaults omitted (for testing default value application).
 */
function createEventWithoutDefaults(): Record<string, unknown> {
  return createEventWithout('fee_cents', 'currency')
}

describe('SourceEnum', () => {
  it('accepts valid sources', () => {
    expect(SourceEnum.parse('mercury')).toBe('mercury')
    expect(SourceEnum.parse('paypal')).toBe('paypal')
    expect(SourceEnum.parse('givebutter')).toBe('givebutter')
    expect(SourceEnum.parse('check_deposits')).toBe('check_deposits')
    expect(SourceEnum.parse('patreon')).toBe('patreon')
  })

  it('rejects invalid sources', () => {
    expect(() => SourceEnum.parse('stripe')).toThrow(ZodError)
    expect(() => SourceEnum.parse('')).toThrow(ZodError)
    expect(() => SourceEnum.parse(null)).toThrow(ZodError)
  })
})

describe('DonationStatusEnum', () => {
  it('accepts valid statuses', () => {
    expect(DonationStatusEnum.parse('pending')).toBe('pending')
    expect(DonationStatusEnum.parse('succeeded')).toBe('succeeded')
    expect(DonationStatusEnum.parse('failed')).toBe('failed')
    expect(DonationStatusEnum.parse('cancelled')).toBe('cancelled')
    expect(DonationStatusEnum.parse('refunded')).toBe('refunded')
  })

  it('rejects invalid statuses', () => {
    expect(() => DonationStatusEnum.parse('complete')).toThrow(ZodError)
    expect(() => DonationStatusEnum.parse('')).toThrow(ZodError)
  })
})

describe('DonorAddressSchema', () => {
  it('accepts valid address with all fields', () => {
    const address = {
      line1: '123 Main St',
      line2: 'Apt 4B',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: 'US',
    }
    expect(DonorAddressSchema.parse(address)).toEqual(address)
  })

  it('accepts address with nullable fields', () => {
    const address = {
      line1: '123 Main St',
      line2: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
    }
    expect(DonorAddressSchema.parse(address)).toEqual(address)
  })

  it('rejects invalid country code length', () => {
    const address = {
      line1: '123 Main St',
      line2: null,
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: 'USA', // Should be 2 chars
    }
    expect(() => DonorAddressSchema.parse(address)).toThrow(ZodError)
  })
})

describe('DonationEventSchema', () => {
  describe('valid events', () => {
    it('parses a complete valid event', () => {
      const event = createValidEvent()
      expect(DonationEventSchema.parse(event)).toEqual(event)
    })

    it('parses event with null donor fields', () => {
      const event = createValidEvent({
        donor_name: null,
        donor_email: null,
        donor_phone: null,
        donor_address: null,
      })
      expect(DonationEventSchema.parse(event)).toEqual(event)
    })

    it('applies default values', () => {
      const input = createEventWithoutDefaults()

      const result = DonationEventSchema.parse(input)
      expect(result.fee_cents).toBe(0)
      expect(result.currency).toBe('USD')
    })

    it('parses event with zero amounts', () => {
      const event = createValidEvent({
        amount_cents: 0,
        fee_cents: 0,
        net_amount_cents: 0,
      })
      expect(DonationEventSchema.parse(event)).toEqual(event)
    })

    it('parses event with large amounts', () => {
      const event = createValidEvent({
        amount_cents: 1_000_000_00, // $1,000,000.00
        fee_cents: 29_00,
        net_amount_cents: 999_971_00,
      })
      expect(DonationEventSchema.parse(event)).toEqual(event)
    })

    it('parses event with empty source_metadata', () => {
      const event = createValidEvent({ source_metadata: {} })
      expect(DonationEventSchema.parse(event)).toEqual(event)
    })

    it('parses event with complex source_metadata', () => {
      const event = createValidEvent({
        source_metadata: {
          campaign_id: 123,
          tags: ['recurring', 'matched'],
          nested: { deep: { value: true } },
        },
      })
      expect(DonationEventSchema.parse(event)).toEqual(event)
    })
  })

  describe('required field validation', () => {
    it('rejects missing source', () => {
      const input = createEventWithout('source')
      expect(() => DonationEventSchema.parse(input)).toThrow(ZodError)
    })

    it('rejects missing external_id', () => {
      const input = createEventWithout('external_id')
      expect(() => DonationEventSchema.parse(input)).toThrow(ZodError)
    })

    it('rejects empty external_id', () => {
      const event = createValidEvent({ external_id: '' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('rejects missing run_id', () => {
      const input = createEventWithout('run_id')
      expect(() => DonationEventSchema.parse(input)).toThrow(ZodError)
    })

    it('rejects missing status', () => {
      const input = createEventWithout('status')
      expect(() => DonationEventSchema.parse(input)).toThrow(ZodError)
    })
  })

  describe('timestamp validation', () => {
    it('accepts valid ISO 8601 timestamps', () => {
      const event = createValidEvent({
        event_ts: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00.123Z',
        ingested_at: '2024-01-15T10:30:00.123456Z',
      })
      expect(DonationEventSchema.parse(event)).toBeTruthy()
    })

    it('rejects invalid event_ts format', () => {
      const event = createValidEvent({ event_ts: '2024-01-15' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('rejects non-ISO timestamp format', () => {
      const event = createValidEvent({ event_ts: 'January 15, 2024' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('rejects unix timestamp', () => {
      const event = createValidEvent({ event_ts: '1705315800' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })
  })

  describe('email validation', () => {
    it('accepts valid email', () => {
      const event = createValidEvent({ donor_email: 'test@example.com' })
      expect(DonationEventSchema.parse(event).donor_email).toBe(
        'test@example.com',
      )
    })

    it('accepts null email', () => {
      const event = createValidEvent({ donor_email: null })
      expect(DonationEventSchema.parse(event).donor_email).toBeNull()
    })

    it('rejects invalid email format', () => {
      const event = createValidEvent({ donor_email: 'not-an-email' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('rejects email without domain', () => {
      const event = createValidEvent({ donor_email: 'test@' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })
  })

  describe('amount validation', () => {
    it('accepts integer amounts', () => {
      const event = createValidEvent({ amount_cents: 1050 })
      expect(DonationEventSchema.parse(event).amount_cents).toBe(1050)
    })

    it('rejects floating-point amounts', () => {
      const event = createValidEvent({ amount_cents: 10.5 })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('accepts negative amounts (for refunds)', () => {
      const event = createValidEvent({
        amount_cents: -500,
        net_amount_cents: -500,
        status: 'refunded',
      })
      expect(DonationEventSchema.parse(event).amount_cents).toBe(-500)
    })
  })

  describe('currency validation', () => {
    it('accepts 3-letter currency codes', () => {
      const event = createValidEvent({ currency: 'EUR' })
      expect(DonationEventSchema.parse(event).currency).toBe('EUR')
    })

    it('rejects 2-letter currency codes', () => {
      const event = createValidEvent({ currency: 'US' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('rejects 4-letter currency codes', () => {
      const event = createValidEvent({ currency: 'USDT' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })
  })

  describe('run_id validation', () => {
    it('accepts valid UUID v4', () => {
      const event = createValidEvent({
        run_id: '550e8400-e29b-41d4-a716-446655440000',
      })
      expect(DonationEventSchema.parse(event)).toBeTruthy()
    })

    it('rejects invalid UUID format', () => {
      const event = createValidEvent({ run_id: 'not-a-uuid' })
      expect(() => DonationEventSchema.parse(event)).toThrow(ZodError)
    })

    it('rejects empty run_id', () => {
      // Pass an object with empty run_id directly to parse
      const input = { ...createValidEvent(), run_id: '' }
      expect(() => DonationEventSchema.parse(input)).toThrow(ZodError)
    })
  })
})

describe('parseDonationEvent', () => {
  it('returns parsed event for valid input', () => {
    const event = createValidEvent()
    const result = parseDonationEvent(event)
    expect(result).toEqual(event)
  })

  it('throws ZodError for invalid input', () => {
    expect(() => parseDonationEvent({})).toThrow(ZodError)
  })
})

describe('safeParseDonationEvent', () => {
  it('returns success for valid input', () => {
    const event = createValidEvent()
    const result = safeParseDonationEvent(event)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(event)
    }
  })

  it('returns error for invalid input', () => {
    const result = safeParseDonationEvent({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError)
    }
  })
})

describe('dollarsToCents', () => {
  it('converts whole dollars', () => {
    expect(dollarsToCents(10)).toBe(1000)
    expect(dollarsToCents(100)).toBe(10000)
    expect(dollarsToCents(1)).toBe(100)
  })

  it('converts dollars with cents', () => {
    expect(dollarsToCents(10.5)).toBe(1050)
    expect(dollarsToCents(10.99)).toBe(1099)
    expect(dollarsToCents(0.01)).toBe(1)
  })

  it('handles floating-point precision', () => {
    // 19.99 * 100 = 1998.9999999999998 in JS
    expect(dollarsToCents(19.99)).toBe(1999)
    expect(dollarsToCents(0.1 + 0.2)).toBe(30) // 0.1 + 0.2 = 0.30000000000000004
  })

  it('converts zero', () => {
    expect(dollarsToCents(0)).toBe(0)
  })

  it('converts negative amounts', () => {
    expect(dollarsToCents(-10.5)).toBe(-1050)
  })
})

describe('centsToDollars', () => {
  it('converts whole cent amounts', () => {
    expect(centsToDollars(1000)).toBe(10)
    expect(centsToDollars(10000)).toBe(100)
    expect(centsToDollars(100)).toBe(1)
  })

  it('converts amounts with fractional dollars', () => {
    expect(centsToDollars(1050)).toBe(10.5)
    expect(centsToDollars(1099)).toBe(10.99)
    expect(centsToDollars(1)).toBe(0.01)
  })

  it('converts zero', () => {
    expect(centsToDollars(0)).toBe(0)
  })

  it('converts negative amounts', () => {
    expect(centsToDollars(-1050)).toBe(-10.5)
  })
})
