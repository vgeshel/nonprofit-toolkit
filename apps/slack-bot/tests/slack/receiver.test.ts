/**
 * Tests for the custom Bun receiver for Slack Bolt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BunReceiver } from '../../src/slack/receiver'

describe('BunReceiver', () => {
  let receiver: BunReceiver

  beforeEach(() => {
    receiver = new BunReceiver()
  })

  describe('lifecycle', () => {
    it('init stores the bolt reference', () => {
      const bolt = { processEvent: vi.fn<(event: unknown) => Promise<void>>() }
      receiver.init(bolt)

      // No assertion needed beyond "doesn't throw"
      expect(true).toBe(true)
    })

    it('start resolves without error', async () => {
      await expect(receiver.start()).resolves.toBeUndefined()
    })

    it('stop resolves without error', async () => {
      await expect(receiver.stop()).resolves.toBeUndefined()
    })
  })

  describe('handleSlackRequest', () => {
    it('returns 500 when bolt not initialized', async () => {
      const result = await receiver.handleSlackRequest('{}', {})

      expect(result.status).toBe(500)
      expect(result.body).toBe('Bolt not initialized')
    })

    it('parses JSON body and forwards to bolt', async () => {
      const mockProcessEvent =
        vi.fn<(event: { body: unknown; ack: unknown }) => Promise<void>>()
      mockProcessEvent.mockResolvedValue(undefined)
      receiver.init({ processEvent: mockProcessEvent })

      const body = JSON.stringify({ type: 'event_callback' })
      await receiver.handleSlackRequest(body, {
        'content-type': 'application/json',
      })

      expect(mockProcessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { type: 'event_callback' },
        }),
      )
    })

    it('parses form-urlencoded body for slash commands', async () => {
      const mockProcessEvent =
        vi.fn<(event: { body: unknown; ack: unknown }) => Promise<void>>()
      mockProcessEvent.mockResolvedValue(undefined)
      receiver.init({ processEvent: mockProcessEvent })

      const body =
        'command=%2Fdonor-letter&user_id=U123&channel_id=C456&trigger_id=T789'
      await receiver.handleSlackRequest(body, {
        'content-type': 'application/x-www-form-urlencoded',
      })

      expect(mockProcessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          body: expect.objectContaining({
            command: '/donor-letter',
            user_id: 'U123',
          }),
        }),
      )
    })

    it('parses payload field from form-urlencoded body', async () => {
      const mockProcessEvent =
        vi.fn<(event: { body: unknown; ack: unknown }) => Promise<void>>()
      mockProcessEvent.mockResolvedValue(undefined)
      receiver.init({ processEvent: mockProcessEvent })

      const payload = JSON.stringify({
        type: 'view_submission',
        view: { callback_id: 'test' },
      })
      const body = `payload=${encodeURIComponent(payload)}`
      await receiver.handleSlackRequest(body, {
        'content-type': 'application/x-www-form-urlencoded',
      })

      expect(mockProcessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          body: expect.objectContaining({
            type: 'view_submission',
          }),
        }),
      )
    })

    it('returns ack string response', async () => {
      const mockProcessEvent =
        vi.fn<
          (event: {
            body: unknown
            ack: (response?: unknown) => Promise<void>
          }) => Promise<void>
        >()
      mockProcessEvent.mockImplementation(async (event) => {
        await event.ack('acknowledged')
      })
      receiver.init({ processEvent: mockProcessEvent })

      const result = await receiver.handleSlackRequest('{}', {})

      expect(result.status).toBe(200)
      expect(result.body).toBe('acknowledged')
    })

    it('returns ack object response as JSON', async () => {
      const mockProcessEvent =
        vi.fn<
          (event: {
            body: unknown
            ack: (response?: unknown) => Promise<void>
          }) => Promise<void>
        >()
      mockProcessEvent.mockImplementation(async (event) => {
        await event.ack({ response_action: 'clear' })
      })
      receiver.init({ processEvent: mockProcessEvent })

      const result = await receiver.handleSlackRequest('{}', {})

      expect(result.status).toBe(200)
      expect(result.body).toBe('{"response_action":"clear"}')
    })

    it('returns empty body when ack called without args', async () => {
      const mockProcessEvent =
        vi.fn<
          (event: {
            body: unknown
            ack: (response?: unknown) => Promise<void>
          }) => Promise<void>
        >()
      mockProcessEvent.mockImplementation(async (event) => {
        await event.ack()
      })
      receiver.init({ processEvent: mockProcessEvent })

      const result = await receiver.handleSlackRequest('{}', {})

      expect(result.status).toBe(200)
      expect(result.body).toBe('')
    })

    it('calls error handler when processEvent throws', async () => {
      const mockProcessEvent = vi.fn<(event: unknown) => Promise<void>>()
      mockProcessEvent.mockRejectedValue(new Error('Processing failed'))
      receiver.init({ processEvent: mockProcessEvent })

      const errorHandler = vi.fn<(error: unknown) => void>()
      const result = await receiver.handleSlackRequest('{}', {}, errorHandler)

      expect(result.status).toBe(200) // Always return 200 to prevent retries
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error))
    })

    it('returns 200 even when processEvent throws without error handler', async () => {
      const mockProcessEvent = vi.fn<(event: unknown) => Promise<void>>()
      mockProcessEvent.mockRejectedValue(new Error('Processing failed'))
      receiver.init({ processEvent: mockProcessEvent })

      const result = await receiver.handleSlackRequest('{}', {})

      expect(result.status).toBe(200)
    })

    it('returns 200 immediately after ack even if handler continues', async () => {
      const mockProcessEvent =
        vi.fn<
          (event: {
            body: unknown
            ack: (response?: unknown) => Promise<void>
          }) => Promise<void>
        >()

      let resolveHandler: () => void
      const handlerPromise = new Promise<void>((resolve) => {
        resolveHandler = resolve
      })

      mockProcessEvent.mockImplementation(async (event) => {
        await event.ack() // Ack immediately
        await handlerPromise // Simulate slow async work
      })
      receiver.init({ processEvent: mockProcessEvent })

      const result = await receiver.handleSlackRequest('{}', {})

      // Should return immediately after ack, not wait for handler
      expect(result.status).toBe(200)

      // Clean up: resolve the handler
      resolveHandler!() // eslint-disable-line @typescript-eslint/no-non-null-assertion
    })

    it('defaults to empty content-type', async () => {
      const mockProcessEvent = vi.fn<(event: unknown) => Promise<void>>()
      mockProcessEvent.mockResolvedValue(undefined)
      receiver.init({ processEvent: mockProcessEvent })

      // No content-type header - should parse as JSON
      const result = await receiver.handleSlackRequest('{"test": true}', {})

      expect(result.status).toBe(200)
    })
  })
})
