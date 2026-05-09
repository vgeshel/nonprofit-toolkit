/**
 * Tests for Slack token validation, replacement, monitoring, and smoke utilities.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildInvalidAuthLogMetricFilter,
  buildSlackAuthAlertPolicy,
  ensureSlackMonitoring,
  parseArgs,
  promoteSlackBotToken,
  redactToken,
  smokeSlackRuntime,
  validateSlackBotToken,
} from './slack-token-ops-lib'

const okAuthResponse = {
  ok: true,
  team: 'Leleka',
  user: 'donor-letter',
  team_id: 'T123',
  user_id: 'U123',
  bot_id: 'B123',
}

describe('validateSlackBotToken', () => {
  it('validates a Slack bot token with auth.test', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))

    const result = await validateSlackBotToken('xoxb-valid-token', fetchFn)

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
      .mockResolvedValue(Response.json(okAuthResponse))
    vi.stubGlobal('fetch', fetchFn)

    try {
      await expect(validateSlackBotToken('xoxb-valid-token')).resolves.toEqual({
        ok: true,
        team: 'Leleka',
        user: 'donor-letter',
        teamId: 'T123',
        userId: 'U123',
        botId: 'B123',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects missing, placeholder, and non-bot tokens without calling Slack', async () => {
    const fetchFn =
      vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

    await expect(validateSlackBotToken('', fetchFn)).resolves.toEqual({
      ok: false,
      error: 'missing_token',
    })
    await expect(
      validateSlackBotToken('placeholder', fetchFn),
    ).resolves.toEqual({
      ok: false,
      error: 'placeholder_token',
    })
    await expect(
      validateSlackBotToken('xoxp-user-token', fetchFn),
    ).resolves.toEqual({
      ok: false,
      error: 'not_bot_token',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('surfaces Slack auth errors safely', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ ok: false, error: 'invalid_auth' }))

    await expect(
      validateSlackBotToken('xoxb-bad-token', fetchFn),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid_auth',
    })
  })

  it('returns invalid_response for malformed Slack responses and request failures', async () => {
    const malformedFetch = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ ok: true, team: 'Leleka' }))
    const throwingFetch = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValue(new Error('network failed'))

    await expect(
      validateSlackBotToken('xoxb-valid-token', malformedFetch),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    })
    await expect(
      validateSlackBotToken('xoxb-valid-token', throwingFetch),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    })
  })
})

describe('promoteSlackBotToken', () => {
  it('validates before adding a new Secret Manager version', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValueOnce({ code: 0, stdout: '7\n', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'Created version [8]\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'Disabled version [7]\n',
        stderr: '',
      })

    const result = await promoteSlackBotToken(
      {
        projectId: 'leleka-data-373104',
        secretName: 'SLACK_BOT_TOKEN',
        token: 'xoxb-valid-token',
        disablePreviousLatest: true,
      },
      { fetch: fetchFn, run },
    )

    expect(result).toEqual({
      ok: true,
      previousVersion: '7',
      newVersion: '8',
      validation: {
        ok: true,
        team: 'Leleka',
        user: 'donor-letter',
        teamId: 'T123',
        userId: 'U123',
        botId: 'B123',
      },
    })
    expect(run).toHaveBeenNthCalledWith(1, 'gcloud', [
      'secrets',
      'versions',
      'list',
      'SLACK_BOT_TOKEN',
      '--project=leleka-data-373104',
      '--filter=state=enabled',
      '--sort-by=~createTime',
      '--limit=1',
      '--format=value(name)',
    ])
    expect(run).toHaveBeenNthCalledWith(
      2,
      'gcloud',
      [
        'secrets',
        'versions',
        'add',
        'SLACK_BOT_TOKEN',
        '--project=leleka-data-373104',
        '--data-file=-',
      ],
      { input: 'xoxb-valid-token' },
    )
    expect(run).toHaveBeenNthCalledWith(3, 'gcloud', [
      'secrets',
      'versions',
      'disable',
      '7',
      '--secret=SLACK_BOT_TOKEN',
      '--project=leleka-data-373104',
      '--quiet',
    ])
  })

  it('does not write to Secret Manager when validation fails', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ ok: false, error: 'invalid_auth' }))
    const run =
      vi.fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()

    const result = await promoteSlackBotToken(
      {
        projectId: 'leleka-data-373104',
        secretName: 'SLACK_BOT_TOKEN',
        token: 'xoxb-bad-token',
        disablePreviousLatest: true,
      },
      { fetch: fetchFn, run },
    )

    expect(result).toEqual({
      ok: false,
      error: 'invalid_auth',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('promotes without disabling a previous version and falls back when gcloud omits the new version', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValue({ code: 0, stdout: 'created\n', stderr: '' })

    const result = await promoteSlackBotToken(
      {
        projectId: 'leleka-data-373104',
        secretName: 'SLACK_BOT_TOKEN',
        token: 'xoxb-valid-token',
        disablePreviousLatest: false,
      },
      { fetch: fetchFn, run },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.previousVersion).toBeUndefined()
    expect(result.newVersion).toBe('latest')
    expect(result.validation.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('still promotes when the previous latest version cannot be read', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'not found' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'Created version [8]\n',
        stderr: '',
      })

    const result = await promoteSlackBotToken(
      {
        projectId: 'leleka-data-373104',
        secretName: 'SLACK_BOT_TOKEN',
        token: 'xoxb-valid-token',
        disablePreviousLatest: true,
      },
      { fetch: fetchFn, run },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.previousVersion).toBeUndefined()
    expect(result.newVersion).toBe('8')
    expect(result.validation.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('still promotes when the previous latest version lookup returns an empty result', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValueOnce({ code: 0, stdout: '\n', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'Created version [8]\n',
        stderr: '',
      })

    const result = await promoteSlackBotToken(
      {
        projectId: 'leleka-data-373104',
        secretName: 'SLACK_BOT_TOKEN',
        token: 'xoxb-valid-token',
        disablePreviousLatest: true,
      },
      { fetch: fetchFn, run },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.previousVersion).toBeUndefined()
    expect(result.newVersion).toBe('8')
    expect(result.validation.ok).toBe(true)
  })

  it('throws when adding the validated secret version fails', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValue({ code: 1, stdout: '', stderr: 'permission denied' })

    await expect(
      promoteSlackBotToken(
        {
          projectId: 'leleka-data-373104',
          secretName: 'SLACK_BOT_TOKEN',
          token: 'xoxb-valid-token',
          disablePreviousLatest: false,
        },
        { fetch: fetchFn, run },
      ),
    ).rejects.toThrow('permission denied')
  })

  it('uses a fallback add-secret error when gcloud omits stderr', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValue({ code: 1, stdout: '', stderr: '' })

    await expect(
      promoteSlackBotToken(
        {
          projectId: 'leleka-data-373104',
          secretName: 'SLACK_BOT_TOKEN',
          token: 'xoxb-valid-token',
          disablePreviousLatest: false,
        },
        { fetch: fetchFn, run },
      ),
    ).rejects.toThrow('Failed to add secret')
  })

  it('throws when disabling the previous secret version fails', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValueOnce({ code: 0, stdout: '7\n', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'Created version [8]\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'disable failed' })

    await expect(
      promoteSlackBotToken(
        {
          projectId: 'leleka-data-373104',
          secretName: 'SLACK_BOT_TOKEN',
          token: 'xoxb-valid-token',
          disablePreviousLatest: true,
        },
        { fetch: fetchFn, run },
      ),
    ).rejects.toThrow('disable failed')
  })

  it('uses a fallback disable-secret error when gcloud omits stderr', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json(okAuthResponse))
    const run = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { input?: string },
        ) => Promise<{ code: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValueOnce({ code: 0, stdout: '7\n', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'Created version [8]\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })

    await expect(
      promoteSlackBotToken(
        {
          projectId: 'leleka-data-373104',
          secretName: 'SLACK_BOT_TOKEN',
          token: 'xoxb-valid-token',
          disablePreviousLatest: true,
        },
        { fetch: fetchFn, run },
      ),
    ).rejects.toThrow('Failed to disable previous secret version')
  })
})

describe('monitoring helpers', () => {
  it('builds a log filter for Slack auth failures on the service', () => {
    expect(buildInvalidAuthLogMetricFilter('letter-service')).toBe(
      'resource.type="cloud_run_revision" AND resource.labels.service_name="letter-service" AND ("slack_bolt_authorization_error" OR "invalid_auth")',
    )
  })

  it('builds an alert policy with optional notification channels', () => {
    expect(
      buildSlackAuthAlertPolicy({
        serviceName: 'letter-service',
        metricName: 'letter_service_slack_invalid_auth',
        notificationChannels: ['projects/p/notificationChannels/1'],
      }),
    ).toEqual({
      displayName: 'letter-service Slack auth failures',
      combiner: 'OR',
      enabled: true,
      notificationChannels: ['projects/p/notificationChannels/1'],
      conditions: [
        {
          displayName: 'Slack invalid_auth logs',
          conditionThreshold: {
            filter:
              'metric.type="logging.googleapis.com/user/letter_service_slack_invalid_auth" AND resource.type="cloud_run_revision"',
            comparison: 'COMPARISON_GT',
            thresholdValue: 0,
            duration: '0s',
            trigger: { count: 1 },
            aggregations: [
              {
                alignmentPeriod: '60s',
                perSeriesAligner: 'ALIGN_DELTA',
              },
            ],
          },
        },
      ],
      alertStrategy: {
        autoClose: '604800s',
      },
    })
  })

  it('creates metric, alert policy, and scheduler health polling when absent', async () => {
    const commands: string[] = []
    const run = vi.fn(
      async (
        command: string,
        args: string[],
      ): Promise<{ code: number; stdout: string; stderr: string }> => {
        commands.push([command, ...args].join(' '))
        if (args.includes('describe') || args.includes('list')) {
          return { code: 1, stdout: '', stderr: 'not found' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    )
    const writeFile = vi.fn(async () => '/tmp/policy.json')

    await ensureSlackMonitoring(
      {
        projectId: 'leleka-data-373104',
        region: 'us-central1',
        serviceName: 'letter-service',
        serviceUrl: 'https://letter-service.example.com',
        schedule: '*/10 * * * *',
        timeZone: 'Etc/UTC',
        notificationChannels: [],
      },
      { run, writeFile },
    )

    expect(commands).toContain(
      'gcloud services enable monitoring.googleapis.com logging.googleapis.com cloudscheduler.googleapis.com --project=leleka-data-373104',
    )
    expect(commands).toContain(
      'gcloud logging metrics create letter_service_slack_invalid_auth --project=leleka-data-373104 --description=Slack authorization failures for letter-service --log-filter=resource.type="cloud_run_revision" AND resource.labels.service_name="letter-service" AND ("slack_bolt_authorization_error" OR "invalid_auth")',
    )
    expect(commands).toContain(
      'gcloud monitoring policies create --project=leleka-data-373104 --policy-from-file=/tmp/policy.json',
    )
    expect(commands).toContain(
      'gcloud scheduler jobs create http letter-service-slack-health --project=leleka-data-373104 --location=us-central1 --schedule=*/10 * * * * --time-zone=Etc/UTC --uri=https://letter-service.example.com/health/slack --http-method=GET --attempt-deadline=30s',
    )
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'letter-service Slack auth failures',
      }),
    )
  })

  it('updates metric, alert policy, and scheduler health polling when present', async () => {
    const commands: string[] = []
    const run = vi.fn(
      async (
        command: string,
        args: string[],
      ): Promise<{ code: number; stdout: string; stderr: string }> => {
        commands.push([command, ...args].join(' '))
        if (args[0] === 'monitoring' && args.includes('list')) {
          return {
            code: 0,
            stdout: 'projects/p/alertPolicies/abc\n',
            stderr: '',
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    )
    const writeFile = vi.fn(async () => '/tmp/policy.json')

    await ensureSlackMonitoring(
      {
        projectId: 'leleka-data-373104',
        region: 'us-central1',
        serviceName: 'letter-service',
        serviceUrl: 'https://letter-service.example.com/',
        schedule: '*/5 * * * *',
        timeZone: 'America/Los_Angeles',
        notificationChannels: ['projects/p/notificationChannels/1'],
      },
      { run, writeFile },
    )

    expect(commands).toContain(
      'gcloud logging metrics update letter_service_slack_invalid_auth --project=leleka-data-373104 --description=Slack authorization failures for letter-service --log-filter=resource.type="cloud_run_revision" AND resource.labels.service_name="letter-service" AND ("slack_bolt_authorization_error" OR "invalid_auth")',
    )
    expect(commands).toContain(
      'gcloud monitoring policies update projects/p/alertPolicies/abc --project=leleka-data-373104 --policy-from-file=/tmp/policy.json',
    )
    expect(commands).toContain(
      'gcloud scheduler jobs update http letter-service-slack-health --project=leleka-data-373104 --location=us-central1 --schedule=*/5 * * * * --time-zone=America/Los_Angeles --uri=https://letter-service.example.com/health/slack --http-method=GET --attempt-deadline=30s',
    )
  })
})

describe('smokeSlackRuntime', () => {
  it('passes when the deployed service reports Slack health ok', async () => {
    const fetchFn = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValue(Response.json({ service: 'slack', status: 'ok' }))

    await expect(
      smokeSlackRuntime('https://letter-service.example.com/', fetchFn),
    ).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://letter-service.example.com/health/slack',
    )
  })

  it('uses global fetch for smoke checks by default', async () => {
    const fetchFn = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValue(Response.json({ service: 'slack', status: 'ok' }))
    vi.stubGlobal('fetch', fetchFn)

    try {
      await expect(
        smokeSlackRuntime('https://letter-service.example.com'),
      ).resolves.toEqual({ ok: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails when the deployed service reports Slack health unhealthy', async () => {
    const fetchFn = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValue(
        Response.json(
          { service: 'slack', status: 'error', error: 'invalid_auth' },
          { status: 503 },
        ),
      )

    await expect(
      smokeSlackRuntime('https://letter-service.example.com', fetchFn),
    ).resolves.toEqual({ ok: false, error: 'invalid_auth' })
  })

  it('returns unhealthy when the deployed service fails without an error code', async () => {
    const fetchFn = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValue(Response.json({ service: 'slack' }, { status: 503 }))

    await expect(
      smokeSlackRuntime('https://letter-service.example.com', fetchFn),
    ).resolves.toEqual({ ok: false, error: 'unhealthy' })
  })

  it('returns request_failed when the deployed service cannot be reached', async () => {
    const fetchFn = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValue(new Error('network failed'))

    await expect(
      smokeSlackRuntime('https://letter-service.example.com', fetchFn),
    ).resolves.toEqual({ ok: false, error: 'request_failed' })
  })
})

describe('parseArgs', () => {
  it('parses validate, promote, ensure-monitoring, and smoke commands', () => {
    expect(parseArgs(['validate', '--token-env', 'SLACK_BOT_TOKEN'])).toEqual({
      command: 'validate',
      tokenEnv: 'SLACK_BOT_TOKEN',
      token: undefined,
      projectId: undefined,
      secretName: 'SLACK_BOT_TOKEN',
      version: 'latest',
      json: false,
    })

    expect(
      parseArgs([
        'promote',
        '--project',
        'leleka-data-373104',
        '--token-env',
        'SLACK_BOT_TOKEN',
        '--disable-previous-latest',
      ]),
    ).toEqual({
      command: 'promote',
      projectId: 'leleka-data-373104',
      secretName: 'SLACK_BOT_TOKEN',
      tokenEnv: 'SLACK_BOT_TOKEN',
      disablePreviousLatest: true,
      json: false,
    })

    expect(
      parseArgs([
        'ensure-monitoring',
        '--project',
        'leleka-data-373104',
        '--region',
        'us-central1',
        '--service-url',
        'https://letter-service.example.com',
      ]),
    ).toEqual({
      command: 'ensure-monitoring',
      projectId: 'leleka-data-373104',
      region: 'us-central1',
      serviceName: 'letter-service',
      serviceUrl: 'https://letter-service.example.com',
      schedule: '*/10 * * * *',
      timeZone: 'Etc/UTC',
      notificationChannels: [],
    })

    expect(
      parseArgs([
        'smoke',
        '--service-url',
        'https://letter-service.example.com',
      ]),
    ).toEqual({
      command: 'smoke',
      serviceUrl: 'https://letter-service.example.com',
    })
  })

  it('throws when no command is provided', () => {
    expect(() => parseArgs([])).toThrow('No command provided')
  })
})

describe('redactToken', () => {
  it('keeps only stable prefix and suffix characters', () => {
    expect(redactToken('xoxb-1234567890-secret')).toBe('xoxb-123...cret')
    expect(redactToken('short')).toBe('<redacted>')
  })
})
