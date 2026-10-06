/**
 * Tests for NDJSON utilities.
 */
import type { DonationEvent } from '@donations-etl/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  chunkEvents,
  eventToNdjsonLine,
  eventsToNdjson,
  generateGcsPath,
  generateGcsPattern,
  generateGcsUri,
} from '../src/ndjson'

/** Schema for parsing NDJSON line output in tests. */
const NdjsonLineSchema = z.record(z.string(), z.unknown())

/** Parse a JSON string into a typed record. */
function parseJsonLine(json: string): Record<string, unknown> {
  return NdjsonLineSchema.parse(JSON.parse(json))
}

describe('NDJSON utilities', () => {
  const createEvent = (id: string): DonationEvent => ({
    source: 'mercury',
    external_id: id,
    event_ts: '2024-01-15T10:30:00Z',
    created_at: '2024-01-15T10:30:00Z',
    ingested_at: '2024-01-15T10:35:00Z',
    amount_cents: 10000,
    fee_cents: 0,
    net_amount_cents: 10000,
    currency: 'USD',
    donor_name: 'John Doe',
    payer_name: null,
    is_recurring: null,
    donor_email: 'john@example.com',
    donor_phone: null,
    donor_address: {
      line1: '123 Main St',
      line2: null,
      city: 'Boston',
      state: 'MA',
      postal_code: '02101',
      country: 'US',
    },
    status: 'succeeded',
    payment_method: 'ach',
    description: 'Monthly donation',
    attribution: null,
    attribution_human: null,
    run_id: '550e8400-e29b-41d4-a716-446655440000',
    source_metadata: {
      counterparty_name: 'John Doe',
    },
  })

  describe('eventToNdjsonLine', () => {
    it('converts an event to a single JSON line', () => {
      const event = createEvent('TX1')
      const line = eventToNdjsonLine(event)

      // Should be valid JSON
      const parsed = parseJsonLine(line)

      expect(parsed.source).toBe('mercury')
      expect(parsed.external_id).toBe('TX1')
      expect(parsed.amount_cents).toBe(10000)
      expect(parsed.donor_name).toBe('John Doe')
    })

    it('preserves all event fields', () => {
      const event = createEvent('TX2')
      const line = eventToNdjsonLine(event)
      const parsed = parseJsonLine(line)

      expect(parsed.source).toBe(event.source)
      expect(parsed.external_id).toBe(event.external_id)
      expect(parsed.event_ts).toBe(event.event_ts)
      expect(parsed.created_at).toBe(event.created_at)
      expect(parsed.ingested_at).toBe(event.ingested_at)
      expect(parsed.amount_cents).toBe(event.amount_cents)
      expect(parsed.fee_cents).toBe(event.fee_cents)
      expect(parsed.net_amount_cents).toBe(event.net_amount_cents)
      expect(parsed.currency).toBe(event.currency)
      expect(parsed.donor_name).toBe(event.donor_name)
      expect(parsed.payer_name).toBe(event.payer_name)
      expect(parsed.donor_email).toBe(event.donor_email)
      expect(parsed.donor_phone).toBe(event.donor_phone)
      expect(parsed.status).toBe(event.status)
      expect(parsed.payment_method).toBe(event.payment_method)
      expect(parsed.description).toBe(event.description)
      expect(parsed.attribution).toBe(event.attribution)
      expect(parsed.attribution_human).toBe(event.attribution_human)
      expect(parsed.run_id).toBe(event.run_id)
    })

    it('includes payer_name when set', () => {
      const event: DonationEvent = {
        ...createEvent('TX-PAYER'),
        payer_name: 'Vanguard Charitable',
      }
      const line = eventToNdjsonLine(event)
      const parsed = parseJsonLine(line)

      expect(parsed.payer_name).toBe('Vanguard Charitable')
    })

    it('includes nested objects', () => {
      const event = createEvent('TX3')
      const line = eventToNdjsonLine(event)
      const parsed = parseJsonLine(line)

      expect(parsed.donor_address).toEqual({
        line1: '123 Main St',
        line2: null,
        city: 'Boston',
        state: 'MA',
        postal_code: '02101',
        country: 'US',
      })

      expect(parsed.source_metadata).toEqual({
        counterparty_name: 'John Doe',
      })
    })

    it('handles null values correctly', () => {
      const event: DonationEvent = {
        ...createEvent('TX4'),
        donor_name: null,
        donor_email: null,
        donor_phone: null,
        donor_address: null,
        description: null,
      }

      const line = eventToNdjsonLine(event)
      const parsed = parseJsonLine(line)

      expect(parsed.donor_name).toBeNull()
      expect(parsed.donor_email).toBeNull()
      expect(parsed.donor_phone).toBeNull()
      expect(parsed.donor_address).toBeNull()
      expect(parsed.description).toBeNull()
    })

    it('produces a single line without newlines', () => {
      const event = createEvent('TX5')
      const line = eventToNdjsonLine(event)

      expect(line).not.toContain('\n')
      expect(line).not.toContain('\r')
    })
  })

  describe('eventsToNdjson', () => {
    it('converts multiple events to newline-delimited JSON', () => {
      const events = [
        createEvent('TX1'),
        createEvent('TX2'),
        createEvent('TX3'),
      ]
      const ndjson = eventsToNdjson(events)

      const lines = ndjson.split('\n')
      expect(lines).toHaveLength(3)

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const parsed = parseJsonLine(line)
        expect(parsed.external_id).toBe(`TX${i + 1}`)
      }
    })

    it('returns empty string for empty array', () => {
      const ndjson = eventsToNdjson([])
      expect(ndjson).toBe('')
    })

    it('handles single event', () => {
      const events = [createEvent('TX1')]
      const ndjson = eventsToNdjson(events)

      expect(ndjson).not.toContain('\n')
      const parsed = parseJsonLine(ndjson)
      expect(parsed.external_id).toBe('TX1')
    })
  })

  describe('chunkEvents', () => {
    it('splits events into chunks of specified size', () => {
      const events = Array.from({ length: 25 }, (_, i) => createEvent(`TX${i}`))
      const chunks = chunkEvents(events, 10)

      expect(chunks).toHaveLength(3)
      expect(chunks[0]).toHaveLength(10)
      expect(chunks[1]).toHaveLength(10)
      expect(chunks[2]).toHaveLength(5)
    })

    it('returns single chunk for small arrays', () => {
      const events = Array.from({ length: 5 }, (_, i) => createEvent(`TX${i}`))
      const chunks = chunkEvents(events, 10)

      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toHaveLength(5)
    })

    it('returns empty array for empty input', () => {
      const chunks = chunkEvents([], 10)
      expect(chunks).toEqual([])
    })

    it('handles exact chunk size', () => {
      const events = Array.from({ length: 20 }, (_, i) => createEvent(`TX${i}`))
      const chunks = chunkEvents(events, 10)

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toHaveLength(10)
      expect(chunks[1]).toHaveLength(10)
    })

    it('preserves event order', () => {
      const events = Array.from({ length: 15 }, (_, i) => createEvent(`TX${i}`))
      const chunks = chunkEvents(events, 5)

      expect(chunks[0]?.[0]?.external_id).toBe('TX0')
      expect(chunks[0]?.[4]?.external_id).toBe('TX4')
      expect(chunks[1]?.[0]?.external_id).toBe('TX5')
      expect(chunks[2]?.[4]?.external_id).toBe('TX14')
    })
  })

  describe('generateGcsPath', () => {
    it('generates correct path format', () => {
      const path = generateGcsPath('run-123', 'mercury', 0)
      expect(path).toBe('runs/run-123/source=mercury/part-00000.ndjson')
    })

    it('pads index to 5 digits', () => {
      expect(generateGcsPath('run-123', 'paypal', 0)).toContain('part-00000')
      expect(generateGcsPath('run-123', 'paypal', 1)).toContain('part-00001')
      expect(generateGcsPath('run-123', 'paypal', 99)).toContain('part-00099')
      expect(generateGcsPath('run-123', 'paypal', 12345)).toContain(
        'part-12345',
      )
    })

    it('includes source in path', () => {
      expect(generateGcsPath('run-123', 'mercury', 0)).toContain(
        'source=mercury',
      )
      expect(generateGcsPath('run-123', 'paypal', 0)).toContain('source=paypal')
      expect(generateGcsPath('run-123', 'givebutter', 0)).toContain(
        'source=givebutter',
      )
    })

    it('includes run ID in path', () => {
      expect(generateGcsPath('abc-def-ghi', 'mercury', 0)).toContain(
        'runs/abc-def-ghi/',
      )
    })

    it('includes chunk prefix when provided', () => {
      const path = generateGcsPath('run-123', 'mercury', 0, '5')
      expect(path).toBe('runs/run-123/source=mercury/chunk-5-part-00000.ndjson')
    })

    it('uses standard format when chunk prefix is undefined', () => {
      const path = generateGcsPath('run-123', 'mercury', 0, undefined)
      expect(path).toBe('runs/run-123/source=mercury/part-00000.ndjson')
    })

    it('combines chunk prefix with part index', () => {
      expect(generateGcsPath('run-123', 'paypal', 0, '10')).toContain(
        'chunk-10-part-00000',
      )
      expect(generateGcsPath('run-123', 'paypal', 5, '10')).toContain(
        'chunk-10-part-00005',
      )
    })
  })

  describe('generateGcsUri', () => {
    it('generates full GCS URI', () => {
      const uri = generateGcsUri('my-bucket', 'path/to/file.ndjson')
      expect(uri).toBe('gs://my-bucket/path/to/file.ndjson')
    })

    it('handles nested paths', () => {
      const uri = generateGcsUri(
        'bucket',
        'runs/123/source=mercury/part-00000.ndjson',
      )
      expect(uri).toBe('gs://bucket/runs/123/source=mercury/part-00000.ndjson')
    })
  })

  describe('generateGcsPattern', () => {
    it('generates wildcard pattern for loading', () => {
      const pattern = generateGcsPattern('my-bucket', 'run-123', 'mercury')
      expect(pattern).toBe(
        'gs://my-bucket/runs/run-123/source=mercury/*.ndjson',
      )
    })

    it('uses wildcard for all parts', () => {
      const pattern = generateGcsPattern('bucket', 'run', 'source')
      expect(pattern).toContain('*.ndjson')
    })
  })
})
