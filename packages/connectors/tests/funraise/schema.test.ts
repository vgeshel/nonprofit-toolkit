/**
 * Tests for Funraise CSV schema validation.
 */
import { describe, expect, it } from 'vitest'
import { FunraiseCsvRowSchema } from '../../src/funraise/schema'

describe('FunraiseCsvRowSchema', () => {
  const validRow = {
    Id: '10000001',
    Amount: '107.70',
    'Transaction Date': '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
    'First Name': 'John',
    'Last Name': 'Doe',
    Email: 'john@example.com',
    Status: 'Complete',
  }

  describe('required fields', () => {
    it('validates a row with all required fields', () => {
      const result = FunraiseCsvRowSchema.safeParse(validRow)
      expect(result.success).toBe(true)
    })

    it('rejects row without Id', () => {
      const row = { ...validRow, Id: '' }
      const result = FunraiseCsvRowSchema.safeParse(row)
      expect(result.success).toBe(false)
    })

    it('rejects row without Amount', () => {
      const row = { ...validRow, Amount: '' }
      const result = FunraiseCsvRowSchema.safeParse(row)
      expect(result.success).toBe(false)
    })

    it('rejects row without Transaction Date', () => {
      const row = { ...validRow, 'Transaction Date': '' }
      const result = FunraiseCsvRowSchema.safeParse(row)
      expect(result.success).toBe(false)
    })
  })

  describe('optional fields', () => {
    it('provides default empty string for missing optional fields', () => {
      const minimalRow = {
        Id: '123',
        Amount: '50.00',
        'Transaction Date': '2026-01-01T00:00:00-08:00',
      }

      const result = FunraiseCsvRowSchema.safeParse(minimalRow)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data['First Name']).toBe('')
        expect(result.data['Last Name']).toBe('')
        expect(result.data.Email).toBe('')
        expect(result.data.Status).toBe('Complete') // Default value
        expect(result.data.Currency).toBe('USD') // Default value
      }
    })

    it('preserves provided optional field values', () => {
      const row = {
        ...validRow,
        Phone: '+1-555-123-4567',
        Address: '123 Main St',
        City: 'San Francisco',
        'State/Province': 'California',
        'Postal Code': '94102',
        Country: 'United States',
      }

      const result = FunraiseCsvRowSchema.safeParse(row)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.Phone).toBe('+1-555-123-4567')
        expect(result.data.Address).toBe('123 Main St')
        expect(result.data.City).toBe('San Francisco')
        expect(result.data['State/Province']).toBe('California')
        expect(result.data['Postal Code']).toBe('94102')
        expect(result.data.Country).toBe('United States')
      }
    })
  })

  describe('all CSV columns', () => {
    it('accepts a complete row with all fields from real CSV export', () => {
      const completeRow = {
        Id: '10000001',
        'Supporter Id': '20000001',
        'First Name': 'Kari',
        'Last Name': 'Nordmann',
        'Institution Name': '',
        'Institution Category': 'Individual',
        Address: 'Eksempelveien 1',
        City: 'Oslo',
        'State/Province': 'Oslo',
        'Postal Code': '0001',
        Country: 'Norway',
        Phone: '+4712345678',
        Email: 'kari.nordmann@example.com',
        'Prospecting | Real Estate Value': '',
        Amount: '107.70',
        'Soft Credit Supporter Id': '',
        'Soft Credit Supporter Name': '',
        'Soft Credit Supporter Email': '',
        'Campaign Goal Id': '',
        'Campaign Page URL': '',
        'Campaign Page Id': '',
        'Operations Tip Amount': '0',
        Status: 'Complete',
        Form: 'Website Donate',
        'Form Id': '10001',
        'Transaction Date': '2026-01-24T00:05:47.440049-08:00[US/Pacific]',
        Match: 'false',
        Dedication: 'true',
        'Dedication Email': '',
        'Dedication Name': 'Ola Nordmann',
        'Dedication Type': 'inspired by',
        'Dedication Message': '',
        Anonymous: 'false',
        Comment: '',
        'Payment Method': 'Credit Card',
        'Card Type': 'AMEX',
        'Expiration Date': '12/29',
        Recurring: 'true',
        'Recurring Id': '900001',
        Sequence: '35',
        Frequency: 'Monthly',
        Offline: 'false',
        Currency: 'USD',
        'Last Four': '4242',
        'Gateway Response': 'SUCCEEDED',
        'Gateway Transaction Id': 'ch_test_0000000000000000001',
        'Import External Id': '',
        Name: '00000001',
        'Check Number': '',
        Memo: '',
        Note: '',
        Tags: '',
        'UTM Source': 'website',
        'UTM Medium': '',
        'UTM Content': '',
        'UTM Term': '',
        'UTM Campaign': '',
        Allocations: '',
        'Source Amount': '107.70',
        URL: '',
        'Household Id': '30000001',
        'Household Name': 'Nordmann Household',
        'Platform Fee Amount': '5.00',
        'Platform Fee Percent': '5.0',
        'Tax Deductible Amount': '107.70',
      }

      const result = FunraiseCsvRowSchema.safeParse(completeRow)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.Id).toBe('10000001')
        expect(result.data.Amount).toBe('107.70')
        expect(result.data['Platform Fee Amount']).toBe('5.00')
        expect(result.data.Recurring).toBe('true')
      }
    })
  })
})
