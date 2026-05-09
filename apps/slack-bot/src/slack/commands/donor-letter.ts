/**
 * Slack slash command handler for /donor-letter.
 *
 * Opens a modal for the user to input donor email and options.
 */
import type { Logger } from 'pino'
import type { Config } from '../../config'
import { buildLetterModal } from '../views/letter-modal'

export interface DonorLetterCommandArgs {
  ack: () => Promise<void>
  command: {
    user_id: string
    channel_id: string
    trigger_id: string
  }
  client: {
    views: {
      open: (opts: {
        trigger_id: string
        view: ReturnType<typeof buildLetterModal>
      }) => Promise<unknown>
    }
  }
}

/**
 * Handle the /donor-letter slash command.
 *
 * Acknowledges the command immediately, then opens a modal.
 */
export async function handleDonorLetterCommand(
  { ack, command, client }: DonorLetterCommandArgs,
  config: Config,
  logger: Logger,
): Promise<void> {
  await ack()

  logger.info(
    { userId: command.user_id, channelId: command.channel_id },
    'Opening donor letter modal',
  )

  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildLetterModal(command.user_id, config),
  })
}
