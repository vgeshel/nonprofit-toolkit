/**
 * Tests for the HTTP router.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config'
import { createTestLogger, parseJsonResponse } from './test-utils'

// Mock handlers
const mockHandleHealth = vi.fn<() => Response>()
const mockHandleSlackHealth = vi.fn<() => Promise<Response>>()
const mockHandleGenerateLetter =
  vi.fn<(req: Request, config: Config, logger: unknown) => Promise<Response>>()

vi.mock('../src/handlers/health', () => ({
  handleHealth: () => mockHandleHealth(),
}))

vi.mock('../src/handlers/slack-health', () => ({
  handleSlackHealth: () => mockHandleSlackHealth(),
}))

vi.mock('../src/handlers/generate-letter', () => ({
  handleGenerateLetter: (req: Request, cfg: Config, log: unknown) =>
    mockHandleGenerateLetter(req, cfg, log),
}))

import { route } from '../src/router'

const config: Config = {
  PORT: 8080,
  LOG_LEVEL: 'info',
  PROJECT_ID: 'test-project',
  DATASET_CANON: 'donations',
  SERVICE_API_KEY: 'test-api-key',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'test-secret',
  ORG_NAME: 'Test Organization',
  ORG_ADDRESS: '123 Test St',
  ORG_MISSION: 'Test mission',
  ORG_TAX_STATUS: 'Test tax status',
  DEFAULT_SIGNER_NAME: 'Test Signer',
  DEFAULT_SIGNER_TITLE: 'Director',
}

const logger = createTestLogger()

describe('route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /health', () => {
    it('calls handleHealth', async () => {
      const healthResponse = new Response('ok')
      mockHandleHealth.mockReturnValue(healthResponse)

      const request = new Request('http://localhost:8080/health', {
        method: 'GET',
      })

      const response = await route(request, config, logger)

      expect(response).toBe(healthResponse)
      expect(mockHandleHealth).toHaveBeenCalled()
    })
  })

  describe('GET /health/slack', () => {
    it('calls handleSlackHealth', async () => {
      const healthResponse = Response.json({ service: 'slack', status: 'ok' })
      mockHandleSlackHealth.mockResolvedValue(healthResponse)

      const request = new Request('http://localhost:8080/health/slack', {
        method: 'GET',
      })

      const response = await route(request, config, logger)

      expect(response).toBe(healthResponse)
      expect(mockHandleSlackHealth).toHaveBeenCalled()
    })
  })

  describe('POST /api/generate-letter', () => {
    it('calls handleGenerateLetter with valid auth', async () => {
      const letterResponse = new Response('pdf data')
      mockHandleGenerateLetter.mockResolvedValue(letterResponse)

      const request = new Request('http://localhost:8080/api/generate-letter', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['test@example.com'] }),
      })

      const response = await route(request, config, logger)

      expect(response).toBe(letterResponse)
      expect(mockHandleGenerateLetter).toHaveBeenCalled()
    })

    it('returns 401 without auth header', async () => {
      const request = new Request('http://localhost:8080/api/generate-letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: ['test@example.com'] }),
      })

      const response = await route(request, config, logger)

      expect(response.status).toBe(401)
      const body = await parseJsonResponse(response)
      expect(body).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 with wrong token', async () => {
      const request = new Request('http://localhost:8080/api/generate-letter', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['test@example.com'] }),
      })

      const response = await route(request, config, logger)

      expect(response.status).toBe(401)
    })
  })

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const request = new Request('http://localhost:8080/unknown', {
        method: 'GET',
      })

      const response = await route(request, config, logger)

      expect(response.status).toBe(404)
      const body = await parseJsonResponse(response)
      expect(body).toEqual({ error: 'Not found' })
    })

    it('returns 404 for wrong method on known path', async () => {
      const request = new Request('http://localhost:8080/health', {
        method: 'POST',
      })

      const response = await route(request, config, logger)

      expect(response.status).toBe(404)
    })
  })
})
