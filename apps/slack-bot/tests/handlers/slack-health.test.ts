/**
 * Tests for Slack runtime auth health checks.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config'
import {
  checkSlackAuth,
  handleSlackHealth,
} from '../../src/handlers/slack-health'
import { createTestLogger, parseJsonResponse } from '../test-utils'

const config: Config = {
  PORT: 8080,
  LOG_LEVEL: 'info',
  PROJECT_ID: 'test-project',
  DATASET_CANON: 'donations',
  SLACK_BOT_TOKEN: 'xoxb-valid-token',
  SLACK_SIGNING_SECRET: 'test-signing-secret',
  ORG_NAME: 'Leleka Foundation',
  ORG_ADDRESS: '380 Hamilton Ave',
  ORG_MISSION: 'Humanitarian aid',
  ORG_TAX_STATUS: '501(c)(3)',
  DEFAULT_SIGNER_NAME: 'Test Signer',
  DEFAULT_SIGNER_TITLE: 'Director',
}

describe('checkSlackAuth', () => {
  it('calls Slack auth.test with the bot token and returns workspace details', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        Response.json({
          ok: true,
          team: 'Leleka',
          user: 'donor-letter',
          team_id: 'T123',
          user_id: 'U123',
          bot_id: 'B123',
        }),
      )

    const result = await checkSlackAuth('xoxb-valid-token', fetchFn)

    expect(fetchFn).toHaveBeenCalledWith('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: 'Bearer xoxb-valid-token' },
    })
    expect(result).toEqual({
      ok: true,
      team: 'Leleka',
      user: 'donor-letter',
      teamId: 'T123',
      userId: 'U123',
      botId: 'B123',
    })
  })

  it('uses global fetch when no fetch dependency is supplied', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        Response.json({
          ok: true,
          team: 'Leleka',
          user: 'donor-letter',
        }),
      )
    vi.stubGlobal('fetch', fetchFn)

    try {
      await expect(checkSlackAuth('xoxb-valid-token')).resolves.toEqual({
        ok: true,
        team: 'Leleka',
        user: 'donor-letter',
        teamId: undefined,
        userId: undefined,
        botId: undefined,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns the Slack API error without throwing when auth.test rejects the token', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ ok: false, error: 'invalid_auth' }))

    const result = await checkSlackAuth('xoxb-revoked-token', fetchFn)

    expect(result).toEqual({ ok: false, error: 'invalid_auth' })
  })

  it('returns a sanitized error when Slack returns malformed JSON', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response('not json', { status: 200 }))

    const result = await checkSlackAuth('xoxb-valid-token', fetchFn)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })

  it('returns a sanitized error when Slack returns an unexpected schema', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ ok: true, team: 'Leleka' }))

    const result = await checkSlackAuth('xoxb-valid-token', fetchFn)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })
})

describe('handleSlackHealth', () => {
  it('returns 200 without leaking workspace details when Slack auth succeeds', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        Response.json({
          ok: true,
          team: 'Leleka',
          user: 'donor-letter',
          team_id: 'T123',
          user_id: 'U123',
        }),
      )

    const response = await handleSlackHealth(
      config,
      createTestLogger(),
      fetchFn,
    )

    expect(response.status).toBe(200)
    expect(await parseJsonResponse(response)).toEqual({
      service: 'slack',
      status: 'ok',
    })
  })

  it('uses global fetch for the HTTP health handler by default', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        Response.json({
          ok: true,
          team: 'Leleka',
          user: 'donor-letter',
        }),
      )
    vi.stubGlobal('fetch', fetchFn)

    try {
      const response = await handleSlackHealth(config, createTestLogger())

      expect(response.status).toBe(200)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns 503 and a safe error code when the runtime token is invalid', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ ok: false, error: 'invalid_auth' }))

    const response = await handleSlackHealth(
      config,
      createTestLogger(),
      fetchFn,
    )

    expect(response.status).toBe(503)
    expect(await parseJsonResponse(response)).toEqual({
      service: 'slack',
      status: 'error',
      error: 'invalid_auth',
    })
  })
})
