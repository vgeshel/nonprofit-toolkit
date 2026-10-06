/**
 * Slack alerts for failed runs.
 *
 * When a daily, backfill or report run fails, the runner posts the error to
 * the report channel before exiting, so a failure is seen the day it happens
 * instead of when someone next reads the job's logs. Successful runs stay
 * silent.
 */
import { WebClient } from '@slack/web-api'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { Config } from './config'

/**
 * Longest error text included in an alert; the full error stays in the logs.
 */
const MAX_ERROR_LENGTH = 1000

export interface FailureAlertError {
  type: 'slack'
  message: string
}

/**
 * Dependencies for sending an alert, injectable for testing.
 */
export interface FailureAlertDeps {
  slackClient: {
    chat: {
      postMessage: (args: { channel: string; text: string }) => Promise<unknown>
    }
  }
}

/**
 * The Cloud Run variables a run was started with (all optional off Cloud Run).
 */
export type ExecutionContext = Pick<
  Config,
  'CLOUD_RUN_JOB' | 'CLOUD_RUN_EXECUTION' | 'CLOUD_RUN_TASK_ATTEMPT'
>

const RunnerErrorSchema = z.object({
  type: z.string().optional(),
  message: z.string(),
})

/**
 * Validates the Cloud Run variables Cloud Run sets in every job task.
 * https://cloud.google.com/run/docs/container-contract#jobs-env-vars
 */
const CloudRunEnvSchema = z.object({
  CLOUD_RUN_JOB: z.string(),
  CLOUD_RUN_EXECUTION: z.string(),
  CLOUD_RUN_TASK_ATTEMPT: z.coerce.number().int().nonnegative().optional(),
})

/**
 * Render any failure value as one line of text.
 *
 * Runner errors are `{ type, message }` objects; uncaught failures are usually
 * Errors, which carry a message but no type.
 */
export function describeError(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  const parsed = RunnerErrorSchema.safeParse(error)
  if (parsed.success) {
    const { type, message } = parsed.data
    return type ? `${type}: ${message}` : message
  }
  return JSON.stringify(error) ?? String(error)
}

/**
 * Describe where the failure happened when running as a Cloud Run job.
 */
function describeExecution(env: ExecutionContext): string | null {
  const parsed = CloudRunEnvSchema.safeParse(env)
  if (!parsed.success) {
    // A malformed attempt number should not hide the job and execution.
    const withoutAttempt = CloudRunEnvSchema.omit({
      CLOUD_RUN_TASK_ATTEMPT: true,
    }).safeParse(env)
    if (!withoutAttempt.success) {
      return null
    }
    const { CLOUD_RUN_JOB, CLOUD_RUN_EXECUTION } = withoutAttempt.data
    return `Cloud Run job \`${CLOUD_RUN_JOB}\`, execution \`${CLOUD_RUN_EXECUTION}\``
  }

  const { CLOUD_RUN_JOB, CLOUD_RUN_EXECUTION, CLOUD_RUN_TASK_ATTEMPT } =
    parsed.data
  const where = `Cloud Run job \`${CLOUD_RUN_JOB}\`, execution \`${CLOUD_RUN_EXECUTION}\``
  // Cloud Run counts attempts from 0; a retried task reports 1.
  return CLOUD_RUN_TASK_ATTEMPT === undefined
    ? where
    : `${where}, attempt ${CLOUD_RUN_TASK_ATTEMPT + 1}`
}

/**
 * Build the Slack message for a failed run.
 */
export function formatFailureAlert(
  job: string,
  error: unknown,
  env: ExecutionContext,
): string {
  const description = describeError(error)
  const body =
    description.length > MAX_ERROR_LENGTH
      ? `${description.slice(0, MAX_ERROR_LENGTH - 1)}…`
      : description

  const lines = [`:rotating_light: *${job} failed*`, `\`\`\`${body}\`\`\``]
  const execution = describeExecution(env)
  if (execution) {
    lines.push(execution)
  }
  return lines.join('\n')
}

/**
 * Post a failure alert to ALERT_SLACK_CHANNEL, falling back to
 * REPORT_SLACK_CHANNEL if Slack rejects the post (e.g. the bot was never
 * invited to the alert channel), so an alert is not lost to a config slip.
 *
 * Returns 'skipped' when Slack is not configured, so deployments without a
 * channel behave exactly as before.
 */
export function sendFailureAlert(
  config: Config,
  job: string,
  error: unknown,
  logger: Logger,
  deps?: FailureAlertDeps,
): ResultAsync<'sent' | 'skipped', FailureAlertError> {
  const token = config.SLACK_BOT_TOKEN
  const channels = [
    ...new Set(
      [config.ALERT_SLACK_CHANNEL, config.REPORT_SLACK_CHANNEL].filter(
        (channel): channel is string => !!channel,
      ),
    ),
  ]
  if (!token || channels.length === 0) {
    logger.warn(
      'SLACK_BOT_TOKEN or a Slack channel (ALERT_SLACK_CHANNEL / REPORT_SLACK_CHANNEL) not set; skipping failure alert',
    )
    return okAsync('skipped')
  }

  const slackClient = deps?.slackClient ?? new WebClient(token)
  const text = formatFailureAlert(job, error, config)

  const attempt = (
    index: number,
    failures: string[],
  ): ResultAsync<'sent', FailureAlertError> => {
    const channel = channels[index]
    if (channel === undefined) {
      return errAsync({
        type: 'slack',
        message: `Failed to post failure alert to Slack: ${failures.join('; ')}`,
      })
    }
    return ResultAsync.fromPromise(
      slackClient.chat.postMessage({ channel, text }),
      (cause) =>
        `${channel}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
      .map(() => 'sent' as const)
      .orElse((failure) => {
        logger.warn({ channel, failure }, 'Failure alert post rejected')
        return attempt(index + 1, [...failures, failure])
      })
  }

  return attempt(0, [])
}
