/**
 * Tests for Givebutter API schema validation.
 */
import { describe, expect, it } from 'vitest'
import {
  GivebutterAddressSchema,
  GivebutterLinksSchema,
  GivebutterMetaSchema,
  GivebutterTransactionResponseSchema,
  GivebutterTransactionSchema,
  KNOWN_STATUSES,
} from '../../src/givebutter/schema'

describe('KNOWN_STATUSES', () => {
  it('includes succeeded', () => {
    expect(KNOWN_STATUSES).toContain('succeeded')
  })

  it('includes authorized', () => {
    expect(KNOWN_STATUSES).toContain('authorized')
  })

  it('includes failed', () => {
    expect(KNOWN_STATUSES).toContain('failed')
  })

  it('includes cancelled', () => {
    expect(KNOWN_STATUSES).toContain('cancelled')
  })
})

describe('GivebutterAddressSchema', () => {
  it('parses a complete address', () => {
    const address = {
      address_1: '123 Main St',
      address_2: 'Apt 4B',
      city: 'San Francisco',
      state: 'CA',
      zipcode: '94102',
      country: 'US',
    }

    const result = GivebutterAddressSchema.parse(address)
    expect(result.address_1).toBe('123 Main St')
    expect(result.city).toBe('San Francisco')
    expect(result.state).toBe('CA')
  })

  it('accepts null values for all fields', () => {
    const address = {
      address_1: null,
      address_2: null,
      city: null,
      state: null,
      zipcode: null,
      country: null,
    }

    const result = GivebutterAddressSchema.parse(address)
    expect(result.address_1).toBeNull()
    expect(result.city).toBeNull()
  })

  it('accepts partial address with nulls', () => {
    const address = {
      address_1: '456 Oak Ave',
      address_2: null,
      city: 'Boston',
      state: 'MA',
      zipcode: '02101',
      country: null,
    }

    const result = GivebutterAddressSchema.parse(address)
    expect(result.address_1).toBe('456 Oak Ave')
    expect(result.address_2).toBeNull()
    expect(result.country).toBeNull()
  })
})

describe('GivebutterTransactionSchema', () => {
  const createValidTransaction = () => ({
    id: 12345,
    number: 'TX-2024-001',
    campaign_id: 100,
    campaign_code: 'SPRING-DRIVE',
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@example.com',
    phone: '555-123-4567',
    address: {
      address_1: '123 Main St',
      address_2: null,
      city: 'Portland',
      state: 'OR',
      zipcode: '97201',
      country: 'US',
    },
    status: 'succeeded' as const,
    method: 'card',
    amount: 100.0,
    fee: 3.5,
    fee_covered: true,
    donated: 100.0,
    payout: 96.5,
    currency: 'USD',
    is_recurring: false,
    plan_id: null,
    transacted_at: '2024-01-15T10:30:00Z',
    created_at: '2024-01-15T10:30:00Z',
  })

  it('parses a complete transaction', () => {
    const tx = createValidTransaction()
    const result = GivebutterTransactionSchema.parse(tx)

    // id is transformed to string by schema
    expect(result.id).toBe('12345')
    expect(result.number).toBe('TX-2024-001')
    expect(result.campaign_id).toBe(100)
    expect(result.first_name).toBe('John')
    expect(result.last_name).toBe('Doe')
    expect(result.email).toBe('john@example.com')
    expect(result.status).toBe('succeeded')
    expect(result.method).toBe('card')
    expect(result.amount).toBe(100.0)
    expect(result.fee).toBe(3.5)
    expect(result.fee_covered).toBe(true)
    expect(result.payout).toBe(96.5)
  })

  it('parses transaction with null optional fields', () => {
    const tx = {
      ...createValidTransaction(),
      campaign_id: null,
      campaign_code: null,
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      address: null,
    }

    const result = GivebutterTransactionSchema.parse(tx)
    expect(result.campaign_id).toBeNull()
    expect(result.first_name).toBeNull()
    expect(result.address).toBeNull()
  })

  it('parses transaction with all payment methods', () => {
    const methods = ['card', 'paypal', 'venmo', 'check', 'cash', 'ach']

    for (const method of methods) {
      const tx = { ...createValidTransaction(), method }
      const result = GivebutterTransactionSchema.parse(tx)
      expect(result.method).toBe(method)
    }
  })

  it('parses transaction with different statuses', () => {
    const statuses = ['succeeded', 'authorized', 'failed', 'cancelled'] as const

    for (const status of statuses) {
      const tx = { ...createValidTransaction(), status }
      const result = GivebutterTransactionSchema.parse(tx)
      expect(result.status).toBe(status)
    }
  })

  it('parses transaction with decimal amounts', () => {
    const tx = {
      ...createValidTransaction(),
      amount: 99.99,
      fee: 2.9,
      donated: 99.99,
      payout: 97.09,
    }

    const result = GivebutterTransactionSchema.parse(tx)
    expect(result.amount).toBe(99.99)
    expect(result.fee).toBe(2.9)
    expect(result.payout).toBe(97.09)
  })

  it('rejects transaction missing required fields', () => {
    const incompleteTransaction = {
      id: 12345,
      // missing other required fields
    }

    expect(() =>
      GivebutterTransactionSchema.parse(incompleteTransaction),
    ).toThrow()
  })

  it('keeps is_recurring and plan_id for a recurring plan charge', () => {
    const result = GivebutterTransactionSchema.parse({
      ...createValidTransaction(),
      is_recurring: true,
      plan_id: 'plan_abc123',
    })
    expect(result.is_recurring).toBe(true)
    expect(result.plan_id).toBe('plan_abc123')
  })

  it('keeps is_recurring false and a null plan_id for a one-off gift', () => {
    const result = GivebutterTransactionSchema.parse(createValidTransaction())
    expect(result.is_recurring).toBe(false)
    expect(result.plan_id).toBeNull()
  })

  it('rejects a transaction without is_recurring', () => {
    const tx: Record<string, unknown> = createValidTransaction()
    delete tx.is_recurring
    const result = GivebutterTransactionSchema.safeParse(tx)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['is_recurring'])
  })

  it('rejects a transaction without plan_id', () => {
    const tx: Record<string, unknown> = createValidTransaction()
    delete tx.plan_id
    const result = GivebutterTransactionSchema.safeParse(tx)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['plan_id'])
  })

  it('accepts unknown status values for resilience', () => {
    // Schema accepts any string status - filtering happens in transformer
    const tx = { ...createValidTransaction(), status: 'refunded' }
    const result = GivebutterTransactionSchema.parse(tx)
    expect(result.status).toBe('refunded')
  })
})

describe('GivebutterLinksSchema', () => {
  it('parses links with next URL', () => {
    const links = {
      first: 'https://api.givebutter.com/v1/transactions?page=1',
      last: 'https://api.givebutter.com/v1/transactions?page=5',
      prev: null,
      next: 'https://api.givebutter.com/v1/transactions?page=2',
    }

    const result = GivebutterLinksSchema.parse(links)
    expect(result.next).toBe(
      'https://api.givebutter.com/v1/transactions?page=2',
    )
    expect(result.prev).toBeNull()
  })

  it('parses links with null next (last page)', () => {
    const links = {
      next: null,
    }

    const result = GivebutterLinksSchema.parse(links)
    expect(result.next).toBeNull()
  })

  it('accepts minimal links object', () => {
    const links = { next: null }
    const result = GivebutterLinksSchema.parse(links)
    expect(result.next).toBeNull()
    expect(result.first).toBeUndefined()
  })
})

describe('GivebutterMetaSchema', () => {
  it('parses complete meta object', () => {
    const meta = {
      current_page: 2,
      last_page: 5,
      per_page: 25,
      total: 120,
      from: 26,
      to: 50,
      path: 'https://api.givebutter.com/v1/transactions',
    }

    const result = GivebutterMetaSchema.parse(meta)
    expect(result.current_page).toBe(2)
    expect(result.last_page).toBe(5)
    expect(result.per_page).toBe(25)
    expect(result.total).toBe(120)
    expect(result.from).toBe(26)
    expect(result.to).toBe(50)
  })

  it('parses minimal meta object', () => {
    const meta = {
      current_page: 1,
      last_page: 1,
      per_page: 25,
      total: 5,
    }

    const result = GivebutterMetaSchema.parse(meta)
    expect(result.current_page).toBe(1)
    expect(result.total).toBe(5)
    expect(result.from).toBeUndefined()
  })

  it('handles first page meta', () => {
    const meta = {
      current_page: 1,
      last_page: 10,
      per_page: 25,
      total: 250,
      from: 1,
      to: 25,
    }

    const result = GivebutterMetaSchema.parse(meta)
    expect(result.current_page).toBe(1)
    expect(result.from).toBe(1)
  })
})

describe('GivebutterTransactionResponseSchema', () => {
  it('parses response with transactions', () => {
    const response = {
      data: [
        {
          id: 1,
          number: 'TX-001',
          campaign_id: 100,
          campaign_code: 'CAMP',
          first_name: 'Jane',
          last_name: 'Smith',
          email: 'jane@example.com',
          phone: null,
          address: null,
          status: 'succeeded' as const,
          method: 'card',
          amount: 50.0,
          fee: 1.5,
          fee_covered: false,
          donated: 50.0,
          payout: 48.5,
          currency: 'USD',
          is_recurring: false,
          plan_id: null,
          transacted_at: '2024-01-15T10:30:00Z',
          created_at: '2024-01-15T10:30:00Z',
        },
      ],
      links: {
        next: 'https://api.givebutter.com/v1/transactions?page=2',
      },
      meta: {
        current_page: 1,
        last_page: 3,
        per_page: 25,
        total: 75,
      },
    }

    const result = GivebutterTransactionResponseSchema.parse(response)
    expect(result.data).toHaveLength(1)
    // id is transformed to string by schema
    expect(result.data[0]?.id).toBe('1')
    expect(result.links.next).toContain('page=2')
    expect(result.meta.total).toBe(75)
  })

  it('parses empty response', () => {
    const response = {
      data: [],
      links: { next: null },
      meta: {
        current_page: 1,
        last_page: 1,
        per_page: 25,
        total: 0,
      },
    }

    const result = GivebutterTransactionResponseSchema.parse(response)
    expect(result.data).toEqual([])
    expect(result.links.next).toBeNull()
    expect(result.meta.total).toBe(0)
  })

  it('parses last page response', () => {
    const response = {
      data: [
        {
          id: 75,
          number: 'TX-075',
          campaign_id: null,
          campaign_code: null,
          first_name: 'Final',
          last_name: 'Donor',
          email: 'final@example.com',
          phone: null,
          address: null,
          status: 'succeeded' as const,
          method: 'ach',
          amount: 1000.0,
          fee: 0.8,
          fee_covered: true,
          donated: 1000.0,
          payout: 999.2,
          currency: 'USD',
          is_recurring: true,
          plan_id: 'plan_final',
          transacted_at: '2024-01-20T15:00:00Z',
          created_at: '2024-01-20T15:00:00Z',
        },
      ],
      links: {
        first: 'https://api.givebutter.com/v1/transactions?page=1',
        prev: 'https://api.givebutter.com/v1/transactions?page=2',
        next: null,
      },
      meta: {
        current_page: 3,
        last_page: 3,
        per_page: 25,
        total: 75,
        from: 51,
        to: 75,
      },
    }

    const result = GivebutterTransactionResponseSchema.parse(response)
    expect(result.data).toHaveLength(1)
    expect(result.links.next).toBeNull()
    expect(result.meta.current_page).toBe(3)
  })
})
