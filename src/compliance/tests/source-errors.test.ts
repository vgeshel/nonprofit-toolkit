/**
 * Tests for SourceError formatting.
 */
import { describe, expect, it } from 'vitest'
import { formatSourceError, type SourceError } from '../sources/errors.ts'

describe('formatSourceError', () => {
  it('formats network errors', () => {
    const err: SourceError = { type: 'network', message: 'ECONNRESET' }
    expect(formatSourceError(err)).toBe('[network] ECONNRESET')
  })

  it('formats http errors with status', () => {
    const err: SourceError = {
      type: 'http',
      status: 502,
      message: 'Bad Gateway',
    }
    expect(formatSourceError(err)).toBe('[http 502] Bad Gateway')
  })

  it('formats rate_limit without retry-after', () => {
    const err: SourceError = { type: 'rate_limit', message: 'slow down' }
    expect(formatSourceError(err)).toBe('[rate_limit] slow down')
  })

  it('formats rate_limit with retry-after', () => {
    const err: SourceError = {
      type: 'rate_limit',
      message: 'slow down',
      retryAfterSeconds: 30,
    }
    expect(formatSourceError(err)).toBe(
      '[rate_limit retry-after=30s] slow down',
    )
  })

  it('formats validation errors', () => {
    expect(formatSourceError({ type: 'validation', message: 'bad EIN' })).toBe(
      '[validation] bad EIN',
    )
  })

  it('formats parse errors', () => {
    expect(
      formatSourceError({ type: 'parse', message: 'unexpected payload' }),
    ).toBe('[parse] unexpected payload')
  })

  it('formats not_found errors', () => {
    expect(
      formatSourceError({ type: 'not_found', message: 'no row for EIN' }),
    ).toBe('[not_found] no row for EIN')
  })

  it('formats tos errors', () => {
    expect(formatSourceError({ type: 'tos', message: 'auth required' })).toBe(
      '[tos] auth required',
    )
  })

  it('formats internal errors', () => {
    expect(
      formatSourceError({ type: 'internal', message: 'unreachable' }),
    ).toBe('[internal] unreachable')
  })
})
