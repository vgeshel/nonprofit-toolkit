/**
 * Tests for the Slack bot logger.
 */
import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger'

describe('createLogger', () => {
  it('creates a logger with the configured level', () => {
    const logger = createLogger({ LOG_LEVEL: 'debug' })

    expect(logger.level).toBe('debug')
  })

  it('defaults to info when configured as info', () => {
    const logger = createLogger({ LOG_LEVEL: 'info' })

    expect(logger.level).toBe('info')
  })

  it('creates a logger with error level', () => {
    const logger = createLogger({ LOG_LEVEL: 'error' })

    expect(logger.level).toBe('error')
  })
})
