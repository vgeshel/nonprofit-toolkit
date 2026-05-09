/**
 * Slack token validation, rotation, monitoring, and smoke-check utilities.
 */
import { Command } from 'commander'
import { z } from 'zod'

type FetchWithInit = (url: string, init: RequestInit) => Promise<Response>
type FetchUrl = (url: string) => Promise<Response>

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => Promise<CommandResult>

const SlackAuthResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    team: z.string(),
    user: z.string(),
    team_id: z.string().optional(),
    user_id: z.string().optional(),
    bot_id: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().default('unknown_error'),
  }),
])

export type SlackTokenValidation =
  | {
      ok: true
      team: string
      user: string
      teamId?: string
      userId?: string
      botId?: string
    }
  | { ok: false; error: string }

const ValidateOptionsSchema = z.object({
  command: z.literal('validate'),
  token: z.string().optional(),
  tokenEnv: z.string().optional(),
  projectId: z.string().optional(),
  secretName: z.string().default('SLACK_BOT_TOKEN'),
  version: z.string().default('latest'),
  json: z.boolean().default(false),
})

const PromoteOptionsSchema = z.object({
  command: z.literal('promote'),
  projectId: z.string().min(1),
  secretName: z.string().default('SLACK_BOT_TOKEN'),
  token: z.string().optional(),
  tokenEnv: z.string().optional(),
  disablePreviousLatest: z.boolean().default(false),
  json: z.boolean().default(false),
})

const EnsureMonitoringOptionsSchema = z.object({
  command: z.literal('ensure-monitoring'),
  projectId: z.string().min(1),
  region: z.string().min(1),
  serviceName: z.string().default('letter-service'),
  serviceUrl: z.string().url(),
  schedule: z.string().default('*/10 * * * *'),
  timeZone: z.string().default('Etc/UTC'),
  notificationChannels: z.array(z.string()).default([]),
})

const SmokeOptionsSchema = z.object({
  command: z.literal('smoke'),
  serviceUrl: z.string().url(),
})

const CliOptionsSchema = z.discriminatedUnion('command', [
  ValidateOptionsSchema,
  PromoteOptionsSchema,
  EnsureMonitoringOptionsSchema,
  SmokeOptionsSchema,
])

type CliOptions = z.infer<typeof CliOptionsSchema>
type PromoteOptions = z.infer<typeof PromoteOptionsSchema>
type EnsureMonitoringOptions = z.infer<typeof EnsureMonitoringOptionsSchema>

export interface PromotionResult {
  ok: true
  previousVersion?: string
  newVersion: string
  validation: Extract<SlackTokenValidation, { ok: true }>
}

export interface PromotionFailure {
  ok: false
  error: string
}

export class SlackTokenOpsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackTokenOpsError'
  }
}

export function redactToken(token: string): string {
  if (token.length < 12) {
    return '<redacted>'
  }
  return `${token.slice(0, 8)}...${token.slice(-4)}`
}

export async function validateSlackBotToken(
  token: string,
  fetchFn: FetchWithInit = fetch,
): Promise<SlackTokenValidation> {
  if (token.length === 0) {
    return { ok: false, error: 'missing_token' }
  }

  if (token === 'placeholder') {
    return { ok: false, error: 'placeholder_token' }
  }

  if (!token.startsWith('xoxb-')) {
    return { ok: false, error: 'not_bot_token' }
  }

  try {
    const response = await fetchFn('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const body: unknown = await response.json()
    const parsed = SlackAuthResponseSchema.safeParse(body)

    if (!parsed.success) {
      return { ok: false, error: 'invalid_response' }
    }

    if (!parsed.data.ok) {
      return { ok: false, error: parsed.data.error }
    }

    return {
      ok: true,
      team: parsed.data.team,
      user: parsed.data.user,
      teamId: parsed.data.team_id,
      userId: parsed.data.user_id,
      botId: parsed.data.bot_id,
    }
  } catch {
    return { ok: false, error: 'invalid_response' }
  }
}

async function getLatestEnabledSecretVersion(
  projectId: string,
  secretName: string,
  run: CommandRunner,
): Promise<string | undefined> {
  const result = await run('gcloud', [
    'secrets',
    'versions',
    'list',
    secretName,
    `--project=${projectId}`,
    '--filter=state=enabled',
    '--sort-by=~createTime',
    '--limit=1',
    '--format=value(name)',
  ])

  if (result.code !== 0) {
    return undefined
  }

  return result.stdout.trim() || undefined
}

function extractCreatedVersion(stdout: string): string {
  const match = /Created version \[(\d+)\]/.exec(stdout)
  if (match?.[1]) {
    return match[1]
  }
  return 'latest'
}

export async function promoteSlackBotToken(
  options: Omit<PromoteOptions, 'command' | 'tokenEnv' | 'json'> & {
    token: string
  },
  deps: {
    fetch?: FetchWithInit
    run: CommandRunner
  },
): Promise<PromotionResult | PromotionFailure> {
  const validation = await validateSlackBotToken(options.token, deps.fetch)
  if (!validation.ok) {
    return validation
  }

  const previousVersion = options.disablePreviousLatest
    ? await getLatestEnabledSecretVersion(
        options.projectId,
        options.secretName,
        deps.run,
      )
    : undefined

  const addResult = await deps.run(
    'gcloud',
    [
      'secrets',
      'versions',
      'add',
      options.secretName,
      `--project=${options.projectId}`,
      '--data-file=-',
    ],
    { input: options.token },
  )

  if (addResult.code !== 0) {
    throw new SlackTokenOpsError(addResult.stderr || 'Failed to add secret')
  }

  if (previousVersion) {
    const disableResult = await deps.run('gcloud', [
      'secrets',
      'versions',
      'disable',
      previousVersion,
      `--secret=${options.secretName}`,
      `--project=${options.projectId}`,
      '--quiet',
    ])

    if (disableResult.code !== 0) {
      throw new SlackTokenOpsError(
        disableResult.stderr || 'Failed to disable previous secret version',
      )
    }
  }

  return {
    ok: true,
    previousVersion,
    newVersion: extractCreatedVersion(addResult.stdout),
    validation,
  }
}

export function buildInvalidAuthLogMetricFilter(serviceName: string): string {
  return `resource.type="cloud_run_revision" AND resource.labels.service_name="${serviceName}" AND ("slack_bolt_authorization_error" OR "invalid_auth")`
}

function metricNameForService(serviceName: string): string {
  return `${serviceName.replaceAll('-', '_')}_slack_invalid_auth`
}

export function buildSlackAuthAlertPolicy(options: {
  serviceName: string
  metricName: string
  notificationChannels: string[]
}) {
  return {
    displayName: `${options.serviceName} Slack auth failures`,
    combiner: 'OR',
    enabled: true,
    notificationChannels: options.notificationChannels,
    conditions: [
      {
        displayName: 'Slack invalid_auth logs',
        conditionThreshold: {
          filter: `metric.type="logging.googleapis.com/user/${options.metricName}" AND resource.type="cloud_run_revision"`,
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
  }
}

function serviceHealthUrl(serviceUrl: string): string {
  return `${serviceUrl.replace(/\/+$/, '')}/health/slack`
}

export async function ensureSlackMonitoring(
  options: Omit<EnsureMonitoringOptions, 'command'>,
  deps: {
    run: CommandRunner
    writeFile: (policy: unknown) => Promise<string>
  },
): Promise<void> {
  const metricName = metricNameForService(options.serviceName)
  const metricFilter = buildInvalidAuthLogMetricFilter(options.serviceName)
  const policy = buildSlackAuthAlertPolicy({
    serviceName: options.serviceName,
    metricName,
    notificationChannels: options.notificationChannels,
  })

  await deps.run('gcloud', [
    'services',
    'enable',
    'monitoring.googleapis.com',
    'logging.googleapis.com',
    'cloudscheduler.googleapis.com',
    `--project=${options.projectId}`,
  ])

  const metricDescription = `Slack authorization failures for ${options.serviceName}`
  const metricDescribe = await deps.run('gcloud', [
    'logging',
    'metrics',
    'describe',
    metricName,
    `--project=${options.projectId}`,
  ])
  await deps.run('gcloud', [
    'logging',
    'metrics',
    metricDescribe.code === 0 ? 'update' : 'create',
    metricName,
    `--project=${options.projectId}`,
    `--description=${metricDescription}`,
    `--log-filter=${metricFilter}`,
  ])

  const alertPolicyPath = await deps.writeFile(policy)
  const policyList = await deps.run('gcloud', [
    'monitoring',
    'policies',
    'list',
    `--project=${options.projectId}`,
    `--filter=displayName="${options.serviceName} Slack auth failures"`,
    '--format=value(name)',
  ])
  const policyName = policyList.stdout.trim()
  await deps.run(
    'gcloud',
    policyName
      ? [
          'monitoring',
          'policies',
          'update',
          policyName,
          `--project=${options.projectId}`,
          `--policy-from-file=${alertPolicyPath}`,
        ]
      : [
          'monitoring',
          'policies',
          'create',
          `--project=${options.projectId}`,
          `--policy-from-file=${alertPolicyPath}`,
        ],
  )

  const schedulerName = `${options.serviceName}-slack-health`
  const schedulerDescribe = await deps.run('gcloud', [
    'scheduler',
    'jobs',
    'describe',
    schedulerName,
    `--project=${options.projectId}`,
    `--location=${options.region}`,
  ])
  await deps.run('gcloud', [
    'scheduler',
    'jobs',
    schedulerDescribe.code === 0 ? 'update' : 'create',
    'http',
    schedulerName,
    `--project=${options.projectId}`,
    `--location=${options.region}`,
    `--schedule=${options.schedule}`,
    `--time-zone=${options.timeZone}`,
    `--uri=${serviceHealthUrl(options.serviceUrl)}`,
    '--http-method=GET',
    '--attempt-deadline=30s',
  ])
}

export async function smokeSlackRuntime(
  serviceUrl: string,
  fetchFn: FetchUrl = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetchFn(serviceHealthUrl(serviceUrl))
    const body = z
      .object({ error: z.unknown().optional(), status: z.unknown().optional() })
      .parse(await response.json())
    if (response.ok && body.status === 'ok') {
      return { ok: true }
    }
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : 'unhealthy',
    }
  } catch {
    return { ok: false, error: 'request_failed' }
  }
}

export function parseArgs(args: string[]): CliOptions {
  if (args.length === 0) {
    throw new SlackTokenOpsError('No command provided')
  }

  const program = new Command()
    .name('slack-token-ops')
    .description('Validate, rotate, monitor, and smoke-test Slack bot tokens')
    .exitOverride()

  let parsed: CliOptions | undefined

  program
    .command('validate')
    .option('--token <token>', 'Slack bot token. Prefer --token-env.')
    .option('--token-env <name>', 'Environment variable containing the token')
    .option('--project <id>', 'GCP project for Secret Manager validation')
    .option('--secret <name>', 'Secret Manager secret name', 'SLACK_BOT_TOKEN')
    .option('--version <version>', 'Secret Manager version', 'latest')
    .option('--json', 'Print JSON output', false)
    .action((options: Record<string, unknown>) => {
      parsed = ValidateOptionsSchema.parse({
        command: 'validate',
        token: options.token,
        tokenEnv: options.tokenEnv,
        projectId: options.project,
        secretName: options.secret,
        version: options.version,
        json: options.json,
      })
    })

  program
    .command('promote')
    .requiredOption('--project <id>', 'GCP project')
    .option('--secret <name>', 'Secret Manager secret name', 'SLACK_BOT_TOKEN')
    .option('--token <token>', 'Slack bot token. Prefer --token-env.')
    .option('--token-env <name>', 'Environment variable containing the token')
    .option(
      '--disable-previous-latest',
      'Disable the previous latest enabled version after successful promotion',
      false,
    )
    .option('--json', 'Print JSON output', false)
    .action((options: Record<string, unknown>) => {
      parsed = PromoteOptionsSchema.parse({
        command: 'promote',
        projectId: options.project,
        secretName: options.secret,
        token: options.token,
        tokenEnv: options.tokenEnv,
        disablePreviousLatest: options.disablePreviousLatest,
        json: options.json,
      })
    })

  program
    .command('ensure-monitoring')
    .requiredOption('--project <id>', 'GCP project')
    .requiredOption('--region <region>', 'GCP region')
    .requiredOption('--service-url <url>', 'Cloud Run service URL')
    .option('--service-name <name>', 'Cloud Run service name', 'letter-service')
    .option(
      '--schedule <cron>',
      'Cloud Scheduler health check schedule',
      '*/10 * * * *',
    )
    .option('--time-zone <tz>', 'Cloud Scheduler time zone', 'Etc/UTC')
    .option(
      '--notification-channel <channel...>',
      'Monitoring notification channel',
    )
    .action((options: Record<string, unknown>) => {
      parsed = EnsureMonitoringOptionsSchema.parse({
        command: 'ensure-monitoring',
        projectId: options.project,
        region: options.region,
        serviceName: options.serviceName,
        serviceUrl: options.serviceUrl,
        schedule: options.schedule,
        timeZone: options.timeZone,
        notificationChannels: options.notificationChannel ?? [],
      })
    })

  program
    .command('smoke')
    .requiredOption('--service-url <url>', 'Cloud Run service URL')
    .action((options: Record<string, unknown>) => {
      parsed = SmokeOptionsSchema.parse({
        command: 'smoke',
        serviceUrl: options.serviceUrl,
      })
    })

  program.parse(args, { from: 'user' })

  return CliOptionsSchema.parse(parsed)
}
