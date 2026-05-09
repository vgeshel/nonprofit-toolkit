/**
 * Slack auth health check handler.
 */
import type { Logger } from 'pino'
import { z } from 'zod'
import type { Config } from '../config'

type FetchWithInit = (url: string, init: RequestInit) => Promise<Response>

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

export type SlackAuthResult =
  | {
      ok: true
      team: string
      user: string
      teamId?: string
      userId?: string
      botId?: string
    }
  | {
      ok: false
      error: string
    }

export async function checkSlackAuth(
  token: string,
  fetchFn: FetchWithInit = fetch,
): Promise<SlackAuthResult> {
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

export async function handleSlackHealth(
  config: Config,
  logger: Logger,
  fetchFn: FetchWithInit = fetch,
): Promise<Response> {
  const result = await checkSlackAuth(config.SLACK_BOT_TOKEN, fetchFn)

  if (result.ok) {
    return Response.json({ service: 'slack', status: 'ok' })
  }

  logger.error({ error: result.error }, 'Slack auth health check failed')
  return Response.json(
    { service: 'slack', status: 'error', error: result.error },
    { status: 503 },
  )
}
