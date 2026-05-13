/**
 * Custom Bolt receiver for Bun.serve().
 *
 * Instead of using Bolt's built-in HTTP server, we handle Slack requests
 * through Bun.serve() and forward them to Bolt's request handler.
 * This allows the Bun HTTP server to forward Slack routes to Bolt.
 */
import type { Receiver, ReceiverEvent } from '@slack/bolt'
import { z } from 'zod'

/**
 * Zod schema for parsing Slack JSON bodies.
 * Slack bodies are always objects with string keys.
 */
const SlackBodySchema = z.record(z.string(), z.unknown())

/**
 * A minimal Bolt receiver that processes requests forwarded from Bun.serve().
 *
 * Bolt's App expects a Receiver that:
 * 1. Has init() / start() / stop() lifecycle methods
 * 2. Emits events when Slack sends requests
 *
 * This receiver doesn't listen on its own port — instead, the main router
 * calls handleSlackRequest() to forward relevant requests.
 */
export class BunReceiver implements Receiver {
  private bolt:
    | { processEvent: (event: ReceiverEvent) => Promise<void> }
    | undefined

  /**
   * Called by Bolt during App initialization.
   * Stores reference to the event processor.
   */
  init(bolt: { processEvent: (event: ReceiverEvent) => Promise<void> }) {
    this.bolt = bolt
  }

  /**
   * Bolt calls this to "start" the receiver.
   * We don't need to start a server since Bun.serve() handles that.
   */
  async start(): Promise<void> {
    // No-op: Bun.serve() handles HTTP
  }

  /**
   * Bolt calls this to "stop" the receiver.
   */
  async stop(): Promise<void> {
    // No-op
  }

  /**
   * Forward a Slack request to Bolt's event processor.
   *
   * Called by the main router for /slack/* paths.
   * Returns the response body and status to send back.
   */
  async handleSlackRequest(
    body: string,
    headers: Record<string, string>,
    errorHandler?: (error: unknown) => void,
  ): Promise<{ status: number; body: string }> {
    if (!this.bolt) {
      return { status: 500, body: 'Bolt not initialized' }
    }

    let responseBody = ''
    let ackCalled = false

    let resolveAck: () => void
    const ackPromise = new Promise<void>((resolve) => {
      resolveAck = resolve
    })

    const ack: ReceiverEvent['ack'] = async (response) => {
      if (typeof response === 'string') {
        responseBody = response
      } else if (response) {
        responseBody = JSON.stringify(response)
      }
      ackCalled = true
      resolveAck()
    }

    const event: ReceiverEvent = {
      body: parseSlackBody(body, headers['content-type'] ?? ''),
      ack,
    }

    // Start processing but don't await completion — only wait for ack.
    // This allows long-running handlers (e.g., AI + BigQuery) to continue
    // in the background while we return 200 to Slack immediately.
    const processPromise = this.bolt.processEvent(event).catch((error) => {
      if (errorHandler) {
        errorHandler(error)
      }
    })

    // Wait for either ack() to be called or processing to complete
    await Promise.race([ackPromise, processPromise])

    // If ack was never called (e.g., processing completed without ack),
    // still return 200 to prevent Slack retries
    /* istanbul ignore next -- @preserve defensive: Bolt always calls ack */
    if (!ackCalled) {
      return { status: 200, body: '' }
    }

    return { status: 200, body: responseBody }
  }
}

/**
 * Parse the Slack request body based on content type.
 *
 * Slack sends form-urlencoded data for slash commands and
 * JSON for interactive components.
 */
function parseSlackBody(
  body: string,
  contentType: string,
): Record<string, unknown> {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body)
    const result: Record<string, unknown> = {}
    for (const [key, value] of params.entries()) {
      // Slack sends a JSON payload for interactive messages
      if (key === 'payload') {
        return SlackBodySchema.parse(JSON.parse(value))
      }
      result[key] = value
    }
    return result
  }

  return SlackBodySchema.parse(JSON.parse(body))
}
