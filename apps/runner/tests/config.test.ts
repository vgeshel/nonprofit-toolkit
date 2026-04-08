/**
 * Tests for configuration loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import {
  ConfigSchema,
  getEnabledSources,
  loadConfig,
  type Config,
} from '../src/config'

describe('ConfigSchema', () => {
  describe('required fields', () => {
    it('requires PROJECT_ID', () => {
      const input = {
        BUCKET: 'my-bucket',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })

    it('requires BUCKET', () => {
      const input = {
        PROJECT_ID: 'my-project',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })

    it('parses valid minimal config', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
      }

      const result = ConfigSchema.parse(input)

      expect(result.PROJECT_ID).toBe('my-project')
      expect(result.BUCKET).toBe('my-bucket')
    })
  })

  describe('defaults', () => {
    it('uses default DATASET_RAW', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
      }

      const result = ConfigSchema.parse(input)

      expect(result.DATASET_RAW).toBe('donations_raw')
    })

    it('uses default DATASET_CANON', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
      }

      const result = ConfigSchema.parse(input)

      expect(result.DATASET_CANON).toBe('donations')
    })

    it('uses default LOOKBACK_HOURS', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOOKBACK_HOURS).toBe(48)
    })

    it('uses default LOG_LEVEL', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOG_LEVEL).toBe('info')
    })
  })

  describe('optional fields', () => {
    it('accepts MERCURY_API_KEY', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        MERCURY_API_KEY: 'mercury-key',
      }

      const result = ConfigSchema.parse(input)

      expect(result.MERCURY_API_KEY).toBe('mercury-key')
    })

    it('accepts PAYPAL_CLIENT_ID and PAYPAL_SECRET', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        PAYPAL_CLIENT_ID: 'paypal-client',
        PAYPAL_SECRET: 'paypal-secret',
      }

      const result = ConfigSchema.parse(input)

      expect(result.PAYPAL_CLIENT_ID).toBe('paypal-client')
      expect(result.PAYPAL_SECRET).toBe('paypal-secret')
    })

    it('accepts GIVEBUTTER_API_KEY', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        GIVEBUTTER_API_KEY: 'givebutter-key',
      }

      const result = ConfigSchema.parse(input)

      expect(result.GIVEBUTTER_API_KEY).toBe('givebutter-key')
    })

    it('accepts WISE_TOKEN', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        WISE_TOKEN: 'wise-token',
      }

      const result = ConfigSchema.parse(input)

      expect(result.WISE_TOKEN).toBe('wise-token')
    })

    it('accepts WISE_TOKEN and WISE_PROFILE_ID', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        WISE_TOKEN: 'wise-token',
        WISE_PROFILE_ID: 12345,
      }

      const result = ConfigSchema.parse(input)

      expect(result.WISE_TOKEN).toBe('wise-token')
      expect(result.WISE_PROFILE_ID).toBe(12345)
    })

    it('coerces WISE_PROFILE_ID from string', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        WISE_PROFILE_ID: '12345',
      }

      const result = ConfigSchema.parse(input)

      expect(result.WISE_PROFILE_ID).toBe(12345)
    })

    it('rejects non-positive WISE_PROFILE_ID', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        WISE_PROFILE_ID: '0',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })

    it('accepts PATREON_ACCESS_TOKEN and PATREON_CAMPAIGN_ID', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        PATREON_ACCESS_TOKEN: 'patreon-token',
        PATREON_CAMPAIGN_ID: 'cmp_42',
      }

      const result = ConfigSchema.parse(input)

      expect(result.PATREON_ACCESS_TOKEN).toBe('patreon-token')
      expect(result.PATREON_CAMPAIGN_ID).toBe('cmp_42')
    })
  })

  describe('LOOKBACK_HOURS coercion', () => {
    it('coerces string to number', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOOKBACK_HOURS: '72',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOOKBACK_HOURS).toBe(72)
    })

    it('rejects non-positive numbers', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOOKBACK_HOURS: '0',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })

    it('rejects negative numbers', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOOKBACK_HOURS: '-1',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })

    it('rejects non-integer values', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOOKBACK_HOURS: '1.5',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })
  })

  describe('LOG_LEVEL validation', () => {
    it('accepts debug', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOG_LEVEL: 'debug',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOG_LEVEL).toBe('debug')
    })

    it('accepts info', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOG_LEVEL: 'info',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOG_LEVEL).toBe('info')
    })

    it('accepts warn', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOG_LEVEL: 'warn',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOG_LEVEL).toBe('warn')
    })

    it('accepts error', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOG_LEVEL: 'error',
      }

      const result = ConfigSchema.parse(input)

      expect(result.LOG_LEVEL).toBe('error')
    })

    it('rejects invalid log level', () => {
      const input = {
        PROJECT_ID: 'my-project',
        BUCKET: 'my-bucket',
        LOG_LEVEL: 'trace',
      }

      expect(() => ConfigSchema.parse(input)).toThrow(ZodError)
    })
  })
})

describe('loadConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('loads config from process.env', () => {
    process.env.PROJECT_ID = 'test-project'
    process.env.BUCKET = 'test-bucket'
    process.env.MERCURY_API_KEY = 'test-mercury-key'

    const config = loadConfig()

    expect(config.PROJECT_ID).toBe('test-project')
    expect(config.BUCKET).toBe('test-bucket')
    expect(config.MERCURY_API_KEY).toBe('test-mercury-key')
  })

  it('throws ZodError when required env vars are missing', () => {
    delete process.env.PROJECT_ID
    delete process.env.BUCKET

    expect(() => loadConfig()).toThrow(ZodError)
  })

  it('uses SECRET_* vars as fallback for API keys', () => {
    process.env.PROJECT_ID = 'test-project'
    process.env.BUCKET = 'test-bucket'
    process.env.SECRET_MERCURY_API_KEY = 'secret-mercury-key'
    process.env.SECRET_PAYPAL_CLIENT_ID = 'secret-paypal-client'
    process.env.SECRET_PAYPAL_SECRET = 'secret-paypal-secret'
    process.env.SECRET_GIVEBUTTER_API_KEY = 'secret-givebutter-key'
    process.env.SECRET_WISE_TOKEN = 'secret-wise-token'
    process.env.SECRET_PATREON_ACCESS_TOKEN = 'secret-patreon-token'

    const config = loadConfig()

    expect(config.MERCURY_API_KEY).toBe('secret-mercury-key')
    expect(config.PAYPAL_CLIENT_ID).toBe('secret-paypal-client')
    expect(config.PAYPAL_SECRET).toBe('secret-paypal-secret')
    expect(config.GIVEBUTTER_API_KEY).toBe('secret-givebutter-key')
    expect(config.WISE_TOKEN).toBe('secret-wise-token')
    expect(config.PATREON_ACCESS_TOKEN).toBe('secret-patreon-token')
  })

  it('prefers non-SECRET vars over SECRET_* vars', () => {
    process.env.PROJECT_ID = 'test-project'
    process.env.BUCKET = 'test-bucket'
    process.env.MERCURY_API_KEY = 'direct-mercury-key'
    process.env.SECRET_MERCURY_API_KEY = 'secret-mercury-key'

    const config = loadConfig()

    expect(config.MERCURY_API_KEY).toBe('direct-mercury-key')
  })
})

describe('getEnabledSources', () => {
  const baseConfig: Config = {
    PROJECT_ID: 'test-project',
    BUCKET: 'test-bucket',
    DATASET_RAW: 'donations_raw',
    DATASET_CANON: 'donations',
    LOOKBACK_HOURS: 48,
    LOG_LEVEL: 'info',
    CHECK_DEPOSITS_SHEET_NAME: 'checks',
  }

  it('returns empty array when no sources are configured', () => {
    const config: Config = { ...baseConfig }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('returns mercury when MERCURY_API_KEY is set', () => {
    const config: Config = {
      ...baseConfig,
      MERCURY_API_KEY: 'mercury-key',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual(['mercury'])
  })

  it('returns paypal when both PAYPAL_CLIENT_ID and PAYPAL_SECRET are set', () => {
    const config: Config = {
      ...baseConfig,
      PAYPAL_CLIENT_ID: 'paypal-client',
      PAYPAL_SECRET: 'paypal-secret',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual(['paypal'])
  })

  it('does not return paypal when only PAYPAL_CLIENT_ID is set', () => {
    const config: Config = {
      ...baseConfig,
      PAYPAL_CLIENT_ID: 'paypal-client',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('does not return paypal when only PAYPAL_SECRET is set', () => {
    const config: Config = {
      ...baseConfig,
      PAYPAL_SECRET: 'paypal-secret',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('returns givebutter when GIVEBUTTER_API_KEY is set', () => {
    const config: Config = {
      ...baseConfig,
      GIVEBUTTER_API_KEY: 'givebutter-key',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual(['givebutter'])
  })

  it('returns check_deposits when CHECK_DEPOSITS_SPREADSHEET_ID is set', () => {
    const config: Config = {
      ...baseConfig,
      CHECK_DEPOSITS_SPREADSHEET_ID: 'test-spreadsheet-id-123',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual(['check_deposits'])
  })

  it('returns wise when WISE_TOKEN and WISE_PROFILE_ID are set', () => {
    const config: Config = {
      ...baseConfig,
      WISE_TOKEN: 'wise-token',
      WISE_PROFILE_ID: 12345,
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual(['wise'])
  })

  it('does not return wise when only WISE_TOKEN is set', () => {
    const config: Config = {
      ...baseConfig,
      WISE_TOKEN: 'wise-token',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('does not return wise when WISE_PROFILE_ID is missing', () => {
    const config: Config = {
      ...baseConfig,
      WISE_TOKEN: 'wise-token',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('returns patreon when PATREON_ACCESS_TOKEN and PATREON_CAMPAIGN_ID are set', () => {
    const config: Config = {
      ...baseConfig,
      PATREON_ACCESS_TOKEN: 'tok',
      PATREON_CAMPAIGN_ID: 'cmp_1',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual(['patreon'])
  })

  it('does not return patreon when only PATREON_ACCESS_TOKEN is set', () => {
    const config: Config = {
      ...baseConfig,
      PATREON_ACCESS_TOKEN: 'tok',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('does not return patreon when only PATREON_CAMPAIGN_ID is set', () => {
    const config: Config = {
      ...baseConfig,
      PATREON_CAMPAIGN_ID: 'cmp_1',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([])
  })

  it('returns all sources when all are configured', () => {
    const config: Config = {
      ...baseConfig,
      MERCURY_API_KEY: 'mercury-key',
      PAYPAL_CLIENT_ID: 'paypal-client',
      PAYPAL_SECRET: 'paypal-secret',
      GIVEBUTTER_API_KEY: 'givebutter-key',
      CHECK_DEPOSITS_SPREADSHEET_ID: 'test-spreadsheet-id-123',
      WISE_TOKEN: 'wise-token',
      WISE_PROFILE_ID: 12345,
      PATREON_ACCESS_TOKEN: 'patreon-token',
      PATREON_CAMPAIGN_ID: 'cmp_42',
    }

    const sources = getEnabledSources(config)

    expect(sources).toEqual([
      'mercury',
      'paypal',
      'givebutter',
      'check_deposits',
      'wise',
      'patreon',
    ])
  })
})
