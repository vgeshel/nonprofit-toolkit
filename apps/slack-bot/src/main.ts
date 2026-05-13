#!/usr/bin/env bun
/**
 * Main entry point for the Slack bot.
 *
 * Starts a Bun HTTP server that handles:
 * - GET /health — health check
 * - POST /slack/commands — Slack slash command handler
 * - POST /slack/interactivity — Slack modal submissions
 * - POST /slack/events — Slack event subscriptions
 */
import { closeBrowser, launchBrowser } from '@donations-etl/letter'
import { z } from 'zod'
import { loadConfig } from './config'
import { createLogger } from './logger'
import { route } from './router'
import { createSlackApp } from './slack/app'

async function main(): Promise<void> {
  // Load configuration
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch (error) {
    console.error(
      'Configuration Error:',
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  }

  const logger = createLogger(config)

  // Launch browser for PDF generation
  const browserResult = await launchBrowser()
  if (browserResult.isErr()) {
    logger.error({ error: browserResult.error }, 'Failed to launch browser')
    process.exit(1)
  }
  logger.info('Browser launched for PDF generation')

  // Initialize Slack app
  const { receiver } = createSlackApp(config, logger)

  // Start HTTP server
  const server = Bun.serve({
    port: config.PORT,
    async fetch(request) {
      const url = new URL(request.url)

      // Forward Slack requests to the Bolt receiver
      if (
        url.pathname === '/slack/commands' ||
        url.pathname === '/slack/interactivity' ||
        url.pathname === '/slack/events'
      ) {
        // Drop Slack retries — we process the first attempt asynchronously
        // and retries during cold starts cause duplicate responses
        if (request.headers.get('x-slack-retry-num')) {
          return new Response('', { status: 200 })
        }

        const body = await request.text()

        // Handle Slack url_verification challenge directly
        if (url.pathname === '/slack/events') {
          try {
            const ChallengeSchema = z.object({
              type: z.literal('url_verification'),
              challenge: z.string(),
            })
            const challenge = ChallengeSchema.parse(JSON.parse(body))
            return new Response(
              JSON.stringify({ challenge: challenge.challenge }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            )
          } catch {
            // Not a challenge — fall through to Bolt
          }
        }

        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => {
          headers[key] = value
        })

        const result = await receiver.handleSlackRequest(
          body,
          headers,
          (error) => {
            logger.error({ error }, 'Slack event handler error')
          },
        )
        return new Response(result.body, {
          status: result.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Handle all other routes
      return route(request, config, logger)
    },
  })

  logger.info({ port: server.port }, 'Slack bot started')

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    await server.stop()
    await closeBrowser()
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}

main().catch((error) => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
