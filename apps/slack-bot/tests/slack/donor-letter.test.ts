/**
 * Tests for the /donor-letter slash command handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config'
import type { DonorLetterCommandArgs } from '../../src/slack/commands/donor-letter'
import { handleDonorLetterCommand } from '../../src/slack/commands/donor-letter'
import { createTestLogger } from '../test-utils'

const config: Config = {
  PORT: 8080,
  LOG_LEVEL: 'info',
  PROJECT_ID: 'test-project',
  DATASET_CANON: 'donations',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'test-secret',
  ORG_NAME: 'Test Organization',
  ORG_ADDRESS: '123 Test St',
  ORG_MISSION: 'Test mission',
  ORG_TAX_STATUS: 'Test tax status',
  DEFAULT_SIGNER_NAME: 'Test Signer',
  DEFAULT_SIGNER_TITLE: 'Director',
}

describe('handleDonorLetterCommand', () => {
  const mockAck = vi.fn<() => Promise<void>>()
  const mockViewsOpen =
    vi.fn<(opts: { trigger_id: string; view: unknown }) => Promise<unknown>>()
  const logger = createTestLogger()

  beforeEach(() => {
    vi.clearAllMocks()
    mockAck.mockResolvedValue(undefined)
    mockViewsOpen.mockResolvedValue({})
  })

  function makeArgs(): DonorLetterCommandArgs {
    return {
      ack: mockAck,
      command: {
        user_id: 'U123',
        channel_id: 'C456',
        trigger_id: 'T789',
      },
      client: { views: { open: mockViewsOpen } },
    }
  }

  it('acknowledges the command immediately', async () => {
    await handleDonorLetterCommand(makeArgs(), config, logger)

    expect(mockAck).toHaveBeenCalled()
  })

  it('opens a modal with the trigger_id', async () => {
    await handleDonorLetterCommand(makeArgs(), config, logger)

    expect(mockViewsOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: 'T789',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        view: expect.objectContaining({
          type: 'modal',
          callback_id: 'donor_letter_modal',
        }),
      }),
    )
  })

  it('passes channel_id as private_metadata', async () => {
    await handleDonorLetterCommand(makeArgs(), config, logger)

    expect(mockViewsOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        view: expect.objectContaining({
          private_metadata: 'U123',
        }),
      }),
    )
  })
})
