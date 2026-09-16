/**
 * Tests for the MCP server configuration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigSchema, loadConfig } from '../src/config'

describe('ConfigSchema', () => {
  const validEnv = {
    PORT: '8080',
    LOG_LEVEL: 'info',
    BASE_URL: 'https://mcp.example.com',
    PROJECT_ID: 'test-project',
    DATASET_CANON: 'donations',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    MCP_ALLOWED_DOMAIN: 'example.com',
  }

  it('parses valid configuration', () => {
    const config = ConfigSchema.parse(validEnv)

    expect(config.PORT).toBe(8080)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.BASE_URL).toBe('https://mcp.example.com')
    expect(config.PROJECT_ID).toBe('test-project')
    expect(config.DATASET_CANON).toBe('donations')
    expect(config.GOOGLE_CLIENT_ID).toBe(
      'test-client-id.apps.googleusercontent.com',
    )
    expect(config.GOOGLE_CLIENT_SECRET).toBe('test-secret')
    expect(config.MCP_ALLOWED_DOMAIN).toBe('example.com')
    expect(config.ORG_NAME).toBe('Your Organization')
    expect(config.DEFAULT_SIGNER_NAME).toBe('Organization Leader')
  })

  it('applies default PORT', () => {
    const config = ConfigSchema.parse({ ...validEnv, PORT: undefined })
    expect(config.PORT).toBe(8080)
  })

  it('applies default LOG_LEVEL', () => {
    const config = ConfigSchema.parse({ ...validEnv, LOG_LEVEL: undefined })
    expect(config.LOG_LEVEL).toBe('info')
  })

  it('applies default DATASET_CANON', () => {
    const config = ConfigSchema.parse({
      ...validEnv,
      DATASET_CANON: undefined,
    })
    expect(config.DATASET_CANON).toBe('donations')
  })

  it('applies default REGION and compliance-discover job name', () => {
    const config = ConfigSchema.parse(validEnv)
    expect(config.REGION).toBe('us-central1')
    expect(config.COMPLIANCE_DISCOVER_JOB_NAME).toBe('compliance-discover')
  })

  it('overrides REGION and compliance-discover job name', () => {
    const config = ConfigSchema.parse({
      ...validEnv,
      REGION: 'europe-west1',
      COMPLIANCE_DISCOVER_JOB_NAME: 'eu-discover',
    })
    expect(config.REGION).toBe('europe-west1')
    expect(config.COMPLIANCE_DISCOVER_JOB_NAME).toBe('eu-discover')
  })

  it('applies default org identity fields', () => {
    const config = ConfigSchema.parse(validEnv)

    expect(config.ORG_NAME).toBe('Your Organization')
    expect(config.ORG_ADDRESS).toBe('')
    expect(config.ORG_MISSION).toContain('positive impact')
    expect(config.ORG_TAX_STATUS).toContain('501(c)(3)')
    expect(config.DEFAULT_SIGNER_NAME).toBe('Organization Leader')
    expect(config.DEFAULT_SIGNER_TITLE).toBe('Director')
  })

  it('overrides org identity fields', () => {
    const config = ConfigSchema.parse({
      ...validEnv,
      ORG_NAME: 'Test Org',
      ORG_ADDRESS: '123 Main St',
      DEFAULT_SIGNER_NAME: 'Jane Doe',
      DEFAULT_SIGNER_TITLE: 'President',
    })

    expect(config.ORG_NAME).toBe('Test Org')
    expect(config.ORG_ADDRESS).toBe('123 Main St')
    expect(config.DEFAULT_SIGNER_NAME).toBe('Jane Doe')
    expect(config.DEFAULT_SIGNER_TITLE).toBe('President')
  })

  it('rejects missing PROJECT_ID', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, PROJECT_ID: undefined }),
    ).toThrow()
  })

  it('rejects missing GOOGLE_CLIENT_ID', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, GOOGLE_CLIENT_ID: undefined }),
    ).toThrow()
  })

  it('rejects missing GOOGLE_CLIENT_SECRET', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, GOOGLE_CLIENT_SECRET: undefined }),
    ).toThrow()
  })

  it('rejects missing MCP_ALLOWED_DOMAIN', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, MCP_ALLOWED_DOMAIN: undefined }),
    ).toThrow()
  })

  it('rejects missing BASE_URL', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, BASE_URL: undefined }),
    ).toThrow()
  })

  it('rejects invalid BASE_URL', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, BASE_URL: 'not-a-url' }),
    ).toThrow()
  })

  it('rejects invalid LOG_LEVEL', () => {
    expect(() =>
      ConfigSchema.parse({ ...validEnv, LOG_LEVEL: 'verbose' }),
    ).toThrow()
  })

  it('coerces PORT from string to number', () => {
    const config = ConfigSchema.parse({ ...validEnv, PORT: '3000' })
    expect(config.PORT).toBe(3000)
  })

  it('rejects non-positive PORT', () => {
    expect(() => ConfigSchema.parse({ ...validEnv, PORT: '0' })).toThrow()
    expect(() => ConfigSchema.parse({ ...validEnv, PORT: '-1' })).toThrow()
  })
})

describe('loadConfig', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.PROJECT_ID = 'test-project'
    process.env.BASE_URL = 'https://mcp.example.com'
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    process.env.MCP_ALLOWED_DOMAIN = 'example.com'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('loads configuration from process.env', () => {
    const config = loadConfig()

    expect(config.PROJECT_ID).toBe('test-project')
    expect(config.GOOGLE_CLIENT_ID).toBe('test-client-id')
    expect(config.MCP_ALLOWED_DOMAIN).toBe('example.com')
  })

  it('throws on missing required fields', () => {
    delete process.env.PROJECT_ID
    expect(() => loadConfig()).toThrow()
  })
})
