/**
 * Tests for Cloud Monitoring provisioning.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  JOB_FAILED_POLICY_NAME,
  SCHEDULER_FAILED_POLICY_NAME,
  buildJobFailedPolicy,
  buildSchedulerFailedPolicy,
  describeParseError,
  describeSummary,
  ensureMonitoring,
  findSlackChannel,
  normalizeSlackChannel,
  parseArgs,
  resolveNotificationChannels,
  upsertAlertPolicy,
  type MonitoringDeps,
} from './monitoring-lib'

const API = 'https://monitoring.googleapis.com/v3'

type FetchFn = MonitoringDeps['fetch']

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A fake Monitoring API: answers by method + URL, records every request.
 */
function fakeApi(routes: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fetchFn = vi.fn<FetchFn>((url, init) => {
    const method = init.method ?? 'GET'
    const bodyText = typeof init.body === 'string' ? init.body : undefined
    calls.push({
      method,
      url,
      body: bodyText === undefined ? undefined : JSON.parse(bodyText),
    })
    const route = routes[`${method} ${url}`]
    return Promise.resolve(
      route ? route() : json({ error: { message: 'no route' } }, 404),
    )
  })
  return { deps: { fetch: fetchFn, accessToken: 'tok' }, calls, fetchFn }
}

const slackChannel = {
  name: 'projects/p/notificationChannels/111',
  type: 'slack',
  displayName: 'Workspace',
  labels: { channel_name: '#alerts' },
}
const emailChannel = {
  name: 'projects/p/notificationChannels/222',
  type: 'email',
  displayName: 'Ops',
  labels: { email_address: 'ops@example.com' },
}

describe('normalizeSlackChannel', () => {
  it('adds the leading # and lowercases', () => {
    expect(normalizeSlackChannel('Alerts')).toBe('#alerts')
    expect(normalizeSlackChannel(' #Alerts ')).toBe('#alerts')
  })
})

describe('findSlackChannel', () => {
  it('returns the Slack channel whose Slack name matches', async () => {
    const { deps, fetchFn } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({ notificationChannels: [emailChannel, slackChannel] }),
    })

    const result = await findSlackChannel('p', 'alerts', deps)

    expect(result._unsafeUnwrap()).toBe('projects/p/notificationChannels/111')
    expect(fetchFn.mock.calls[0]?.[1].headers).toEqual({
      Authorization: 'Bearer tok',
    })
  })

  it('skips a Slack channel without a channel name', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({
          notificationChannels: [
            { name: 'projects/p/notificationChannels/333', type: 'slack' },
          ],
        }),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrap()).toBeNull()
  })

  it('follows pagination', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({ notificationChannels: [emailChannel], nextPageToken: 'n2' }),
      [`GET ${API}/projects/p/notificationChannels?pageToken=n2`]: () =>
        json({ notificationChannels: [slackChannel] }),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrap()).toBe('projects/p/notificationChannels/111')
  })

  it('returns null when no Slack channel has that name', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () => json({}),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrap()).toBeNull()
  })

  it('reports an API error with its status and message', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({ error: { message: 'Permission denied' } }, 403),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'http',
      message: `GET ${API}/projects/p/notificationChannels failed (403): Permission denied`,
    })
  })

  it('reports an unparseable error body by status alone', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        new Response('<html>oops</html>', { status: 502 }),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrapErr().message).toBe(
      `GET ${API}/projects/p/notificationChannels failed (502)`,
    )
  })

  it('reports a network failure', async () => {
    const fetchFn = vi.fn<FetchFn>().mockRejectedValue(new Error('ECONNRESET'))

    const result = await findSlackChannel('p', '#alerts', {
      fetch: fetchFn,
      accessToken: 'tok',
    })

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'http',
      message: `GET ${API}/projects/p/notificationChannels failed: ECONNRESET`,
    })
  })

  it('reports a non-Error network failure', async () => {
    const fetchFn = vi.fn<FetchFn>().mockRejectedValue('offline')

    const result = await findSlackChannel('p', '#alerts', {
      fetch: fetchFn,
      accessToken: 'tok',
    })

    expect(result._unsafeUnwrapErr().message).toBe(
      `GET ${API}/projects/p/notificationChannels failed: offline`,
    )
  })

  it('rejects a response that does not match the API shape', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({ notificationChannels: [{ type: 'slack' }] }),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrapErr().type).toBe('validation')
  })

  it('rejects a response that is not JSON', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        new Response('not json', { status: 200 }),
    })

    const result = await findSlackChannel('p', '#alerts', deps)

    expect(result._unsafeUnwrapErr().type).toBe('validation')
  })
})

describe('buildJobFailedPolicy', () => {
  it('alerts on any failed Cloud Run job execution, per job', () => {
    const policy = buildJobFailedPolicy(['projects/p/notificationChannels/1'])

    expect(policy.displayName).toBe(JOB_FAILED_POLICY_NAME)
    expect(policy.notificationChannels).toEqual([
      'projects/p/notificationChannels/1',
    ])
    expect(policy.conditions[0]?.conditionThreshold).toEqual({
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
    })
  })
})

describe('buildSchedulerFailedPolicy', () => {
  it('alerts on Cloud Scheduler error logs, rate-limited per hour', () => {
    const policy = buildSchedulerFailedPolicy([])

    expect(policy.displayName).toBe(SCHEDULER_FAILED_POLICY_NAME)
    expect(policy.notificationChannels).toEqual([])
    expect(policy.conditions[0]?.conditionMatchedLog).toEqual({
      filter: 'resource.type="cloud_scheduler_job" AND severity>=ERROR',
      labelExtractors: { job_id: 'EXTRACT(resource.labels.job_id)' },
    })
    expect(policy.alertStrategy).toEqual({
      notificationRateLimit: { period: '3600s' },
      autoClose: '86400s',
    })
  })
})

describe('upsertAlertPolicy', () => {
  const policy = buildSchedulerFailedPolicy([])

  it('creates the policy when none has that display name', async () => {
    const { deps, calls } = fakeApi({
      [`GET ${API}/projects/p/alertPolicies`]: () =>
        json({
          alertPolicies: [
            { name: 'projects/p/alertPolicies/9', displayName: 'Other' },
          ],
        }),
      [`POST ${API}/projects/p/alertPolicies`]: () =>
        json({ name: 'projects/p/alertPolicies/10' }),
    })

    const result = await upsertAlertPolicy('p', policy, deps)

    expect(result._unsafeUnwrap()).toBe('created')
    expect(calls[1]).toEqual({
      method: 'POST',
      url: `${API}/projects/p/alertPolicies`,
      body: policy,
    })
  })

  it('replaces the existing policy with the same display name', async () => {
    const { deps, calls } = fakeApi({
      [`GET ${API}/projects/p/alertPolicies`]: () =>
        json({ alertPolicies: [], nextPageToken: 'n2' }),
      [`GET ${API}/projects/p/alertPolicies?pageToken=n2`]: () =>
        json({
          alertPolicies: [
            {
              name: 'projects/p/alertPolicies/7',
              displayName: SCHEDULER_FAILED_POLICY_NAME,
            },
          ],
        }),
      [`PATCH ${API}/projects/p/alertPolicies/7`]: () =>
        json({ name: 'projects/p/alertPolicies/7' }),
    })

    const result = await upsertAlertPolicy('p', policy, deps)

    expect(result._unsafeUnwrap()).toBe('updated')
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      url: `${API}/projects/p/alertPolicies/7`,
      body: policy,
    })
  })

  it('stops at a listing error', async () => {
    const { deps, calls } = fakeApi({
      [`GET ${API}/projects/p/alertPolicies`]: () =>
        json({ error: { message: 'boom' } }, 500),
    })

    const result = await upsertAlertPolicy('p', policy, deps)

    expect(result._unsafeUnwrapErr().type).toBe('http')
    expect(calls).toHaveLength(1)
  })
})

describe('ensureMonitoring', () => {
  const routes = (channels: unknown[]) => ({
    [`GET ${API}/projects/p/notificationChannels`]: () =>
      json({ notificationChannels: channels }),
    [`GET ${API}/projects/p/alertPolicies`]: () => json({}),
    [`POST ${API}/projects/p/alertPolicies`]: () =>
      json({ name: 'projects/p/alertPolicies/1' }),
  })

  it('sends both policies to the configured Slack channel', async () => {
    const { deps, calls } = fakeApi(routes([slackChannel]))

    const result = await ensureMonitoring(
      { projectId: 'p', slackChannel: '#alerts' },
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual({
      notificationChannel: 'projects/p/notificationChannels/111',
      policies: {
        [JOB_FAILED_POLICY_NAME]: 'created',
        [SCHEDULER_FAILED_POLICY_NAME]: 'created',
      },
    })
    const posted = calls.filter((c) => c.method === 'POST').map((c) => c.body)
    expect(posted).toEqual([
      buildJobFailedPolicy(['projects/p/notificationChannels/111']),
      buildSchedulerFailedPolicy(['projects/p/notificationChannels/111']),
    ])
  })

  it('still creates the policies when the Slack channel is not connected yet', async () => {
    const { deps, calls } = fakeApi(routes([emailChannel]))

    const result = await ensureMonitoring(
      { projectId: 'p', slackChannel: '#alerts' },
      deps,
    )

    expect(result._unsafeUnwrap().notificationChannel).toBeNull()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  it('creates the policies without channels when no Slack channel is configured', async () => {
    const { deps, calls } = fakeApi(routes([slackChannel]))

    const result = await ensureMonitoring({ projectId: 'p' }, deps)

    expect(result._unsafeUnwrap().notificationChannel).toBeNull()
    expect(calls.some((c) => c.url.includes('notificationChannels'))).toBe(
      false,
    )
  })

  it('stops when the channel lookup fails', async () => {
    const { deps, calls } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({ error: { message: 'denied' } }, 403),
    })

    const result = await ensureMonitoring(
      { projectId: 'p', slackChannel: '#alerts' },
      deps,
    )

    expect(result._unsafeUnwrapErr().type).toBe('http')
    expect(calls).toHaveLength(1)
  })
})

describe('parseArgs', () => {
  it('parses the project and Slack channel', () => {
    expect(
      parseArgs([
        '--project',
        'p',
        '--slack-channel',
        '#alerts',
      ])._unsafeUnwrap(),
    ).toEqual({ projectId: 'p', slackChannel: '#alerts' })
  })

  it('treats an empty Slack channel as not configured', () => {
    expect(
      parseArgs(['--project', 'p', '--slack-channel', ''])._unsafeUnwrap(),
    ).toEqual({ projectId: 'p', slackChannel: undefined })
  })

  it('returns --help as an error result instead of printing and exiting', () => {
    expect(parseArgs(['--help'])._unsafeUnwrapErr()).toEqual({
      type: 'validation',
      message: '(outputHelp)',
    })
  })

  it('requires the project', () => {
    expect(parseArgs([])._unsafeUnwrapErr()).toEqual({
      type: 'validation',
      message: "error: required option '--project <id>' not specified",
    })
  })
})

describe('describeParseError', () => {
  it('uses the message of anything that is not a CommanderError', () => {
    expect(describeParseError('odd')).toBe('odd')
  })
})

describe('describeSummary', () => {
  const policies = {
    [JOB_FAILED_POLICY_NAME]: 'created' as const,
    [SCHEDULER_FAILED_POLICY_NAME]: 'updated' as const,
  }

  it('lists each policy and the Slack channel alerts go to', () => {
    expect(
      describeSummary(
        { notificationChannel: 'projects/p/notificationChannels/1', policies },
        '#alerts',
      ),
    ).toEqual([
      `Alert policy "${JOB_FAILED_POLICY_NAME}": created`,
      `Alert policy "${SCHEDULER_FAILED_POLICY_NAME}": updated`,
      'Alerts go to Slack #alerts',
    ])
  })

  it('omits the name when a channel was found without one configured', () => {
    expect(
      describeSummary(
        {
          notificationChannel: 'projects/p/notificationChannels/1',
          policies: {},
        },
        undefined,
      ),
    ).toEqual(['Alerts go to Slack'])
  })

  it('says alerts reach no one when no Slack channel is configured', () => {
    expect(
      describeSummary({ notificationChannel: null, policies: {} }, undefined),
    ).toEqual([
      'ALERT_SLACK_CHANNEL is not set; alert policies record incidents but notify no one.',
    ])
  })

  it('explains the console step when the Slack channel is not connected', () => {
    const lines = describeSummary(
      { notificationChannel: null, policies: {} },
      '#alerts',
    )

    expect(lines[0]).toBe(
      'Slack channel #alerts is not connected to Cloud Monitoring yet, so alerts are not delivered.',
    )
    expect(lines.at(-1)).toBe('Then re-run provisioning to attach it.')
  })
})

describe('resolveNotificationChannels', () => {
  it('returns the connected Slack channel', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () =>
        json({ notificationChannels: [slackChannel] }),
    })

    const result = await resolveNotificationChannels('p', '#alerts', deps)

    expect(result._unsafeUnwrap()).toEqual([
      'projects/p/notificationChannels/111',
    ])
  })

  it('returns no channels when the Slack channel is not connected', async () => {
    const { deps } = fakeApi({
      [`GET ${API}/projects/p/notificationChannels`]: () => json({}),
    })

    const result = await resolveNotificationChannels('p', '#alerts', deps)

    expect(result._unsafeUnwrap()).toEqual([])
  })

  it('does not call the API when no Slack channel is configured', async () => {
    const { deps, fetchFn } = fakeApi({})

    const result = await resolveNotificationChannels('p', undefined, deps)

    expect(result._unsafeUnwrap()).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
