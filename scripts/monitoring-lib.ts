/**
 * Cloud Monitoring provisioning: alert policies for failed jobs and failed
 * scheduler triggers, sent to a Slack channel.
 *
 * Policies are matched by display name, so running this again replaces them
 * in place. The Slack notification channel itself can only be created in the
 * Google Cloud console (Slack OAuth); it is found here by its Slack channel
 * name, so no installation-specific ID lives in code.
 */
import { Command, CommanderError } from 'commander'
import { Result, ResultAsync, err, errAsync, ok, okAsync } from 'neverthrow'
import { z } from 'zod'

const API = 'https://monitoring.googleapis.com/v3'

export const JOB_FAILED_POLICY_NAME = 'Cloud Run job execution failed'
export const SCHEDULER_FAILED_POLICY_NAME = 'Cloud Scheduler trigger failed'

export interface MonitoringError {
  type: 'http' | 'validation'
  message: string
}

export interface MonitoringDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  accessToken: string
}

const ApiErrorSchema = z.object({
  error: z.object({ message: z.string() }),
})

const NotificationChannelSchema = z.object({
  name: z.string(),
  type: z.string(),
  labels: z.record(z.string(), z.string()).default({}),
})

const ChannelPageSchema = z.object({
  notificationChannels: z.array(NotificationChannelSchema).default([]),
  nextPageToken: z.string().optional(),
})

const PolicyPageSchema = z.object({
  alertPolicies: z
    .array(z.object({ name: z.string(), displayName: z.string() }))
    .default([]),
  nextPageToken: z.string().optional(),
})

const PolicyResponseSchema = z.object({ name: z.string() })

/**
 * Slack channel names as Cloud Monitoring stores them: `#name`, lowercase.
 */
export function normalizeSlackChannel(name: string): string {
  const trimmed = name.trim().toLowerCase()
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

function request<T>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  schema: z.ZodType<T>,
  deps: MonitoringDeps,
  body?: unknown,
): ResultAsync<T, MonitoringError> {
  const init: RequestInit = {
    method,
    headers:
      body === undefined
        ? { Authorization: `Bearer ${deps.accessToken}` }
        : {
            Authorization: `Bearer ${deps.accessToken}`,
            'Content-Type': 'application/json',
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }

  return ResultAsync.fromPromise(
    deps.fetch(url, init),
    (cause): MonitoringError => ({
      type: 'http',
      message: `${method} ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  ).andThen((response) =>
    ResultAsync.fromSafePromise(response.text()).andThen((text) => {
      const parsedJson = Result.fromThrowable(
        (): unknown => JSON.parse(text),
        () => undefined,
      )()
      const payload: unknown = parsedJson.unwrapOr(undefined)

      if (!response.ok) {
        const apiError = ApiErrorSchema.safeParse(payload)
        const detail = apiError.success
          ? `: ${apiError.data.error.message}`
          : ''
        return errAsync<T, MonitoringError>({
          type: 'http',
          message: `${method} ${url} failed (${response.status})${detail}`,
        })
      }

      const parsed = schema.safeParse(payload)
      return parsed.success
        ? okAsync<T, MonitoringError>(parsed.data)
        : errAsync<T, MonitoringError>({
            type: 'validation',
            message: `${method} ${url} returned an unexpected response: ${parsed.error.message}`,
          })
    }),
  )
}

/**
 * Fetch every page of a list endpoint.
 */
function listAll<Page extends { nextPageToken?: string }, Item>(
  url: string,
  schema: z.ZodType<Page>,
  items: (page: Page) => Item[],
  deps: MonitoringDeps,
  pageToken?: string,
): ResultAsync<Item[], MonitoringError> {
  const pageUrl = pageToken
    ? `${url}?pageToken=${encodeURIComponent(pageToken)}`
    : url
  return request('GET', pageUrl, schema, deps).andThen((page) =>
    page.nextPageToken
      ? listAll(url, schema, items, deps, page.nextPageToken).map((rest) => [
          ...items(page),
          ...rest,
        ])
      : okAsync(items(page)),
  )
}

/**
 * Find the Slack notification channel for a Slack channel name.
 * Returns null when it has not been connected in the console yet.
 */
export function findSlackChannel(
  projectId: string,
  slackChannel: string,
  deps: MonitoringDeps,
): ResultAsync<string | null, MonitoringError> {
  const wanted = normalizeSlackChannel(slackChannel)
  return listAll(
    `${API}/projects/${projectId}/notificationChannels`,
    ChannelPageSchema,
    (page) => page.notificationChannels,
    deps,
  ).map((channels) => {
    const match = channels.find(
      (channel) =>
        channel.type === 'slack' &&
        normalizeSlackChannel(channel.labels.channel_name ?? '') === wanted,
    )
    return match?.name ?? null
  })
}

/**
 * Notification channels for an optional Slack channel name: the matching
 * channel, or none when no name is configured or it is not connected yet.
 */
export function resolveNotificationChannels(
  projectId: string,
  slackChannel: string | undefined,
  deps: MonitoringDeps,
): ResultAsync<string[], MonitoringError> {
  if (!slackChannel) {
    return okAsync([])
  }
  return findSlackChannel(projectId, slackChannel, deps).map((name) =>
    name ? [name] : [],
  )
}

/**
 * Any Cloud Run job execution that ends in failure, including runs that never
 * reached the application (image would not start, out of memory, timeout) and
 * so could not post their own Slack alert.
 */
export function buildJobFailedPolicy(notificationChannels: string[]) {
  return {
    displayName: JOB_FAILED_POLICY_NAME,
    combiner: 'OR',
    enabled: true,
    notificationChannels,
    conditions: [
      {
        displayName: 'Job execution finished with result=failed',
        conditionThreshold: {
          filter:
            'resource.type = "cloud_run_job" AND metric.type = "run.googleapis.com/job/completed_execution_count" AND metric.labels.result = "failed"',
          aggregations: [
            {
              alignmentPeriod: '300s',
              perSeriesAligner: 'ALIGN_SUM',
              crossSeriesReducer: 'REDUCE_SUM',
              groupByFields: ['resource.labels.job_name'],
            },
          ],
          comparison: 'COMPARISON_GT',
          thresholdValue: 0,
          duration: '0s',
          trigger: { count: 1 },
        },
      },
    ],
    alertStrategy: { autoClose: '3600s' },
    documentation: {
      mimeType: 'text/markdown',
      content:
        "A run of Cloud Run job `${resource.label.job_name}` failed. This also fires for runs that never reached the code (image would not start, out of memory, timeout), which cannot post their own Slack alert.\n\nInvestigate: `gcloud run jobs executions list --job ${resource.label.job_name}`, then read the failed execution's logs.",
    },
  }
}

/**
 * Any Cloud Scheduler attempt that logs an error: a scheduled run that could
 * not be started, or a failed HTTP health check.
 */
export function buildSchedulerFailedPolicy(notificationChannels: string[]) {
  return {
    displayName: SCHEDULER_FAILED_POLICY_NAME,
    combiner: 'OR',
    enabled: true,
    notificationChannels,
    conditions: [
      {
        displayName: 'Scheduler attempt logged an error',
        conditionMatchedLog: {
          filter: 'resource.type="cloud_scheduler_job" AND severity>=ERROR',
          labelExtractors: { job_id: 'EXTRACT(resource.labels.job_id)' },
        },
      },
    ],
    alertStrategy: {
      notificationRateLimit: { period: '3600s' },
      autoClose: '86400s',
    },
    documentation: {
      mimeType: 'text/markdown',
      content:
        "Cloud Scheduler could not complete a trigger. For a job schedule this means the run never started; for an HTTP health check it means the check failed or timed out.\n\nInvestigate: `gcloud scheduler jobs list` and the scheduler job's logs.",
    },
  }
}

/**
 * Create the policy, or replace the one with the same display name.
 */
export function upsertAlertPolicy(
  projectId: string,
  policy: { displayName: string },
  deps: MonitoringDeps,
): ResultAsync<'created' | 'updated', MonitoringError> {
  const collection = `${API}/projects/${projectId}/alertPolicies`
  return listAll(
    collection,
    PolicyPageSchema,
    (page) => page.alertPolicies,
    deps,
  ).andThen((policies) => {
    const existing = policies.find((p) => p.displayName === policy.displayName)
    return existing
      ? request(
          'PATCH',
          `${API}/${existing.name}`,
          PolicyResponseSchema,
          deps,
          policy,
        ).map(() => 'updated' as const)
      : request('POST', collection, PolicyResponseSchema, deps, policy).map(
          () => 'created' as const,
        )
  })
}

export interface MonitoringOptions {
  projectId: string
  slackChannel?: string
}

export interface MonitoringSummary {
  /** Resource name of the Slack channel used, or null if none was found. */
  notificationChannel: string | null
  policies: Record<string, 'created' | 'updated'>
}

/**
 * Ensure both alert policies exist and notify the Slack channel.
 *
 * Policies are created even when the Slack channel is not connected yet, so
 * incidents are recorded from the start; re-running after connecting Slack
 * attaches it.
 */
export function ensureMonitoring(
  options: MonitoringOptions,
  deps: MonitoringDeps,
): ResultAsync<MonitoringSummary, MonitoringError> {
  const channel = options.slackChannel
    ? findSlackChannel(options.projectId, options.slackChannel, deps)
    : okAsync<string | null, MonitoringError>(null)

  return channel.andThen((notificationChannel) => {
    const channels = notificationChannel ? [notificationChannel] : []
    const policies = [
      buildJobFailedPolicy(channels),
      buildSchedulerFailedPolicy(channels),
    ]

    // Sequential: each upsert lists policies, so parallel creates could race.
    return policies
      .reduce<
        ResultAsync<MonitoringSummary['policies'], MonitoringError>
      >((done, policy) => done.andThen((summary) => upsertAlertPolicy(options.projectId, policy, deps).map((outcome) => ({ ...summary, [policy.displayName]: outcome }))), okAsync({}))
      .map((summary) => ({ notificationChannel, policies: summary }))
  })
}

/**
 * Human-readable outcome of a provisioning run, one line per entry.
 */
export function describeSummary(
  summary: MonitoringSummary,
  slackChannel: string | undefined,
): string[] {
  const lines = Object.entries(summary.policies).map(
    ([policy, outcome]) => `Alert policy "${policy}": ${outcome}`,
  )

  if (summary.notificationChannel) {
    return [...lines, `Alerts go to Slack ${slackChannel ?? ''}`.trim()]
  }
  if (!slackChannel) {
    return [
      ...lines,
      'ALERT_SLACK_CHANNEL is not set; alert policies record incidents but notify no one. (In .env, quote it: an unquoted # starts a comment.)',
    ]
  }
  return [
    ...lines,
    `Slack channel ${slackChannel} is not connected to Cloud Monitoring yet, so alerts are not delivered.`,
    'Connecting Slack needs a one-time OAuth approval in the console (no API exists for it):',
    '  1. Google Cloud console > Monitoring > Alerting > Edit notification channels',
    `  2. Slack > Add new > Allow (Slack workspace owner/admin), choose ${slackChannel}`,
    `  3. If the channel is private: /invite @Google Cloud Monitoring in ${slackChannel}`,
    'Then re-run provisioning to attach it.',
  ]
}

const RawArgsSchema = z.object({
  project: z.string().min(1),
  // An empty value (e.g. an unset .env entry) means no channel configured.
  slackChannel: z
    .string()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
})

/**
 * Commander throws CommanderError under exitOverride; anything else is shown as is.
 */
export function describeParseError(error: unknown): string {
  return error instanceof CommanderError ? error.message : String(error)
}

/**
 * Parse `--project <id> [--slack-channel <name>]`.
 */
export function parseArgs(
  args: string[],
): Result<MonitoringOptions, MonitoringError> {
  const program = new Command()
    .name('provision-monitoring')
    .description(
      'Ensure Cloud Monitoring alert policies and their Slack channel',
    )
    .requiredOption('--project <id>', 'GCP project ID')
    .option('--slack-channel <name>', 'Slack channel for alerts, e.g. #alerts')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })

  return Result.fromThrowable(
    (): unknown => program.parse(args, { from: 'user' }).opts(),
    (error): MonitoringError => ({
      type: 'validation',
      message: describeParseError(error),
    }),
  )().andThen((opts) => {
    const parsed = RawArgsSchema.safeParse(opts)
    /* istanbul ignore if -- @preserve commander already enforces the required option */
    if (!parsed.success) {
      return err<MonitoringOptions, MonitoringError>({
        type: 'validation',
        message: parsed.error.message,
      })
    }
    return ok<MonitoringOptions, MonitoringError>({
      projectId: parsed.data.project,
      slackChannel: parsed.data.slackChannel,
    })
  })
}
