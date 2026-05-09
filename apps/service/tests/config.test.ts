/**
 * Tests for the service configuration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigSchema, loadConfig } from '../src/config'

describe('ConfigSchema', () => {
  const validEnv = {
    PORT: '8080',
    LOG_LEVEL: 'info',
    PROJECT_ID: 'test-project',
    DATASET_CANON: 'donations',
    SERVICE_API_KEY: 'test-key',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_SIGNING_SECRET: 'test-signing-secret',
  }

  function withoutEnvKey(key: keyof typeof validEnv): Partial<typeof validEnv> {
    const env: Partial<typeof validEnv> = { ...validEnv }
    delete env[key]
    return env
  }

  it('parses valid configuration', () => {
    const config = ConfigSchema.parse(validEnv)

    expect(config.PORT).toBe(8080)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.PROJECT_ID).toBe('test-project')
    expect(config.DATASET_CANON).toBe('donations')
    expect(config.SERVICE_API_KEY).toBe('test-key')
    expect(config.SLACK_BOT_TOKEN).toBe('xoxb-test-token')
    expect(config.SLACK_SIGNING_SECRET).toBe('test-signing-secret')
    expect(config.ORG_NAME).toBe('Your Organization')
    expect(config.ORG_ADDRESS).toBe('')
    expect(config.ORG_MISSION).toContain('positive impact')
    expect(config.ORG_TAX_STATUS).toContain('501(c)(3)')
    expect(config.DEFAULT_SIGNER_NAME).toBe('Organization Leader')
    expect(config.DEFAULT_SIGNER_TITLE).toBe('Director')
  })

  it('applies default PORT', () => {
    const config = ConfigSchema.parse({
      ...validEnv,
      PORT: undefined,
    })

    expect(config.PORT).toBe(8080)
  })

  it('applies default LOG_LEVEL', () => {
    const config = ConfigSchema.parse({
      ...validEnv,
      LOG_LEVEL: undefined,
    })

    expect(config.LOG_LEVEL).toBe('info')
  })

  it('applies default DATASET_CANON', () => {
    const config = ConfigSchema.parse({
      ...validEnv,
      DATASET_CANON: undefined,
    })

    expect(config.DATASET_CANON).toBe('donations')
  })

  it('coerces PORT from string to number', () => {
    const config = ConfigSchema.parse({ ...validEnv, PORT: '3000' })

    expect(config.PORT).toBe(3000)
  })

  it('rejects missing PROJECT_ID', () => {
    const rest = withoutEnvKey('PROJECT_ID')

    expect(() => ConfigSchema.parse(rest)).toThrow()
  })

  it('rejects missing SERVICE_API_KEY', () => {
    const rest = withoutEnvKey('SERVICE_API_KEY')

    expect(() => ConfigSchema.parse(rest)).toThrow()
  })

  it('rejects missing SLACK_BOT_TOKEN', () => {
    const rest = withoutEnvKey('SLACK_BOT_TOKEN')

    expect(() => ConfigSchema.parse(rest)).toThrow()
  })

  it('rejects missing SLACK_SIGNING_SECRET', () => {
    const rest = withoutEnvKey('SLACK_SIGNING_SECRET')

    expect(() => ConfigSchema.parse(rest)).toThrow()
  })

  it('rejects invalid LOG_LEVEL', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, LOG_LEVEL: 'verbose' }),
    ).toThrow()
  })

  it('rejects non-positive PORT', () => {
    expect(() => ConfigSchema.parse({ ...validEnv, PORT: '0' })).toThrow()
  })
})

describe('loadConfig', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Set required env vars
    process.env.PROJECT_ID = 'test-project'
    process.env.SERVICE_API_KEY = 'test-key'
    process.env.SLACK_BOT_TOKEN = 'xoxb-test'
    process.env.SLACK_SIGNING_SECRET = 'test-secret'
  })

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
  })

  it('loads config from process.env', () => {
    const config = loadConfig()

    expect(config.PROJECT_ID).toBe('test-project')
    expect(config.SERVICE_API_KEY).toBe('test-key')
    expect(config.SLACK_BOT_TOKEN).toBe('xoxb-test')
    expect(config.SLACK_SIGNING_SECRET).toBe('test-secret')
  })

  it('throws when required env vars are missing', () => {
    delete process.env.PROJECT_ID

    expect(() => loadConfig()).toThrow()
  })
})
