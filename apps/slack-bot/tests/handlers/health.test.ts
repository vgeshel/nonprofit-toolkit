/**
 * Tests for the health check handler.
 */
import { describe, expect, it } from 'vitest'
import { handleHealth } from '../../src/handlers/health'

describe('handleHealth', () => {
  it('returns 200 status', () => {
    const response = handleHealth()

    expect(response.status).toBe(200)
  })

  it('returns JSON content type', () => {
    const response = handleHealth()

    expect(response.headers.get('Content-Type')).toBe('application/json')
  })

  it('returns ok status in body', async () => {
    const response = handleHealth()
    const body = await response.json()

    expect(body).toEqual({ status: 'ok' })
  })
})
