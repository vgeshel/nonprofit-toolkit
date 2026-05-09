/**
 * HTTP request router.
 *
 * Dispatches incoming requests to the appropriate handler.
 */
import type { Logger } from 'pino'
import type { Config } from './config'
import { handleGenerateLetter } from './handlers/generate-letter'
import { handleHealth } from './handlers/health'
import { handleSlackHealth } from './handlers/slack-health'
import { validateBearerToken } from './middleware/auth'

/**
 * Route an incoming HTTP request.
 */
export async function route(
  request: Request,
  config: Config,
  logger: Logger,
): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  const method = request.method

  // Health check (no auth required)
  if (method === 'GET' && pathname === '/health') {
    return handleHealth()
  }

  if (method === 'GET' && pathname === '/health/slack') {
    return handleSlackHealth(config, logger)
  }

  // Generate letter API (Bearer token auth)
  if (method === 'POST' && pathname === '/api/generate-letter') {
    if (
      !validateBearerToken(
        request.headers.get('Authorization'),
        config.SERVICE_API_KEY,
      )
    ) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return handleGenerateLetter(request, config, logger)
  }

  // 404 for everything else
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}
