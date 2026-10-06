/**
 * Tests for Slack failure alerts.
 */
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config'
import {
  describeError,
  formatFailureAlert,
  sendFailureAlert,
  type FailureAlertDeps,
} from '../src/failure-alert'

const { webClientTokens, webClientPost } = vi.hoisted(() => {
  const tokens: string[] = []
  return {
    webClientTokens: tokens,
    webClientPost: vi
      .fn<(args: { channel: string; text: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true }),
  }
})

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    chat = { postMessage: webClientPost }
    constructor(token: string) {
      webClientTokens.push(token)
    }
  },
}))

const logger = pino({ level: 'silent' })

describe('describeError', () => {
  it('prefixes a typed runner error with its type', () => {
    expect(
      describeError({
        type: 'connector',
        message: 'mercury: unknown certificate verification error',
      }),
    ).toBe('connector: mercury: unknown certificate verification error')
  })

  it('uses the message of a plain Error', () => {
    expect(describeError(new Error('socket hang up'))).toBe('socket hang up')
  })

  it('passes a string through', () => {
    expect(describeError('boom')).toBe('boom')
  })

  it('serializes anything else', () => {
    expect(describeError({ code: 42 })).toBe('{"code":42}')
    expect(describeError(undefined)).toBe('undefined')
  })
})

describe('formatFailureAlert', () => {
  it('names the job and the error', () => {
    expect(
      formatFailureAlert('Daily ETL', { type: 'merge', message: 'quota' }, {}),
    ).toBe(':rotating_light: *Daily ETL failed*\n```merge: quota```')
  })

  it('adds the Cloud Run job, execution and 1-based attempt when present', () => {
    const text = formatFailureAlert('Weekly report', 'no data', {
      CLOUD_RUN_JOB: 'donations-etl',
      CLOUD_RUN_EXECUTION: 'donations-etl-abc12',
      CLOUD_RUN_TASK_ATTEMPT: '1',
    })

    expect(text).toBe(
      ':rotating_light: *Weekly report failed*\n```no data```\n' +
        'Cloud Run job `donations-etl`, execution `donations-etl-abc12`, attempt 2',
    )
  })

  it('omits the attempt when Cloud Run does not report one', () => {
    const text = formatFailureAlert('Backfill', 'x', {
      CLOUD_RUN_JOB: 'donations-etl',
      CLOUD_RUN_EXECUTION: 'donations-etl-abc12',
    })

    expect(text.split('\n').at(-1)).toBe(
      'Cloud Run job `donations-etl`, execution `donations-etl-abc12`',
    )
  })

  it('ignores a malformed attempt number', () => {
    const text = formatFailureAlert('Backfill', 'x', {
      CLOUD_RUN_JOB: 'donations-etl',
      CLOUD_RUN_EXECUTION: 'donations-etl-abc12',
      CLOUD_RUN_TASK_ATTEMPT: 'first',
    })

    expect(text.split('\n').at(-1)).toBe(
      'Cloud Run job `donations-etl`, execution `donations-etl-abc12`',
    )
  })

  it('truncates very long errors', () => {
    const text = formatFailureAlert('Daily ETL', 'e'.repeat(5000), {})
    const body = text.split('```')[1] ?? ''

    expect(body).toHaveLength(1000)
    expect(body.endsWith('…')).toBe(true)
  })
})

describe('sendFailureAlert', () => {
  const baseConfig: Config = {
    PROJECT_ID: 'test-project',
    BUCKET: 'test-bucket',
    DATASET_RAW: 'donations_raw',
    DATASET_CANON: 'donations',
    LOOKBACK_HOURS: 48,
    LOG_LEVEL: 'info',
    CHECK_DEPOSITS_SHEET_NAME: 'checks',
    SLACK_BOT_TOKEN: 'xoxb-test',
    REPORT_SLACK_CHANNEL: 'C123',
  }

  let postMessage: ReturnType<
    typeof vi.fn<FailureAlertDeps['slackClient']['chat']['postMessage']>
  >
  let deps: FailureAlertDeps

  beforeEach(() => {
    postMessage = vi
      .fn<FailureAlertDeps['slackClient']['chat']['postMessage']>()
      .mockResolvedValue({ ok: true })
    deps = { slackClient: { chat: { postMessage } } }
  })

  it('posts the alert to the report channel', async () => {
    const result = await sendFailureAlert(
      baseConfig,
      'Daily ETL',
      { type: 'connector', message: 'mercury: timeout' },
      logger,
      deps,
    )

    expect(result._unsafeUnwrap()).toBe('sent')
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: ':rotating_light: *Daily ETL failed*\n```connector: mercury: timeout```',
    })
  })

  it('posts to the alert channel when one is configured', async () => {
    const result = await sendFailureAlert(
      { ...baseConfig, ALERT_SLACK_CHANNEL: '#alerts' },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrap()).toBe('sent')
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls[0]?.[0].channel).toBe('#alerts')
  })

  it('falls back to the report channel when the alert channel rejects the post', async () => {
    postMessage.mockRejectedValueOnce(new Error('not_in_channel'))

    const result = await sendFailureAlert(
      { ...baseConfig, ALERT_SLACK_CHANNEL: '#alerts' },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrap()).toBe('sent')
    expect(postMessage.mock.calls.map((call) => call[0].channel)).toEqual([
      '#alerts',
      'C123',
    ])
  })

  it('posts once when the alert and report channels are the same', async () => {
    postMessage.mockRejectedValueOnce(new Error('not_in_channel'))

    const result = await sendFailureAlert(
      { ...baseConfig, ALERT_SLACK_CHANNEL: 'C123' },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrapErr().message).toBe(
      'Failed to post failure alert to Slack: C123: not_in_channel',
    )
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('reports every channel when all reject the post', async () => {
    postMessage
      .mockRejectedValueOnce(new Error('not_in_channel'))
      .mockRejectedValueOnce(new Error('channel_not_found'))

    const result = await sendFailureAlert(
      { ...baseConfig, ALERT_SLACK_CHANNEL: '#alerts' },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'slack',
      message:
        'Failed to post failure alert to Slack: #alerts: not_in_channel; C123: channel_not_found',
    })
  })

  it('uses the alert channel alone when no report channel is set', async () => {
    const result = await sendFailureAlert(
      {
        ...baseConfig,
        REPORT_SLACK_CHANNEL: undefined,
        ALERT_SLACK_CHANNEL: '#alerts',
      },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrap()).toBe('sent')
    expect(postMessage.mock.calls[0]?.[0].channel).toBe('#alerts')
  })

  it('skips without posting when the bot token is not configured', async () => {
    const result = await sendFailureAlert(
      { ...baseConfig, SLACK_BOT_TOKEN: undefined },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrap()).toBe('skipped')
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('skips without posting when no channel is configured', async () => {
    const result = await sendFailureAlert(
      { ...baseConfig, REPORT_SLACK_CHANNEL: undefined },
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrap()).toBe('skipped')
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('returns an error when Slack rejects the post', async () => {
    postMessage.mockRejectedValueOnce(new Error('channel_not_found'))

    const result = await sendFailureAlert(
      baseConfig,
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'slack',
      message: 'Failed to post failure alert to Slack: C123: channel_not_found',
    })
  })

  it('reports a non-Error rejection', async () => {
    postMessage.mockRejectedValueOnce('rate_limited')

    const result = await sendFailureAlert(
      baseConfig,
      'Daily ETL',
      'x',
      logger,
      deps,
    )

    expect(result._unsafeUnwrapErr().message).toBe(
      'Failed to post failure alert to Slack: C123: rate_limited',
    )
  })

  it('builds a Slack client from the bot token and names the execution', async () => {
    const result = await sendFailureAlert(
      {
        ...baseConfig,
        CLOUD_RUN_JOB: 'donations-etl',
        CLOUD_RUN_EXECUTION: 'donations-etl-zz9',
        CLOUD_RUN_TASK_ATTEMPT: '0',
      },
      'Daily ETL',
      'x',
      logger,
    )

    expect(result._unsafeUnwrap()).toBe('sent')
    expect(webClientTokens).toEqual(['xoxb-test'])
    expect(webClientPost).toHaveBeenCalledWith({
      channel: 'C123',
      text:
        ':rotating_light: *Daily ETL failed*\n```x```\n' +
        'Cloud Run job `donations-etl`, execution `donations-etl-zz9`, attempt 1',
    })
  })
})
