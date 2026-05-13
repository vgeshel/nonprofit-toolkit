/**
 * Slack modal for donor letter generation.
 *
 * Defines the modal view and handles submission.
 */
import {
  generateLetterHtml,
  generatePdf,
  processQueryResults,
  queryDonations,
} from '@donations-etl/letter'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { Config } from '../../config'

export const LETTER_MODAL_CALLBACK_ID = 'donor_letter_modal'

// Block IDs for form fields
const BLOCK_EMAIL = 'email_block'
const BLOCK_FROM = 'from_block'
const BLOCK_TO = 'to_block'
const BLOCK_FORMAT = 'format_block'
const BLOCK_SIGNER_NAME = 'signer_name_block'
const BLOCK_SIGNER_TITLE = 'signer_title_block'

// Action IDs for form inputs
const ACTION_EMAIL = 'email_input'
const ACTION_FROM = 'from_input'
const ACTION_TO = 'to_input'
const ACTION_FORMAT = 'format_input'
const ACTION_SIGNER_NAME = 'signer_name_input'
const ACTION_SIGNER_TITLE = 'signer_title_input'

export interface ViewSubmissionArgs {
  ack: (response?: {
    response_action: string
    errors?: Record<string, string>
  }) => Promise<void>
  view: {
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            value?: string | null
            selected_date?: string | null
            selected_option?: { value: string } | null
          }
        >
      >
    }
    private_metadata: string
  }
  client: {
    files: {
      uploadV2: (
        opts: {
          channel_id: string
          filename: string
          title: string
          initial_comment: string
        } & ({ content: string } | { file: Buffer }),
      ) => Promise<unknown>
    }
    chat: {
      postMessage: (opts: { channel: string; text: string }) => Promise<unknown>
    }
    conversations: {
      open: (opts: { users: string }) => Promise<{ channel?: { id?: string } }>
    }
  }
}

/**
 * Build the Slack modal view definition.
 */
export function buildLetterModal(channelId: string, config: Config) {
  return {
    type: 'modal' as const,
    callback_id: LETTER_MODAL_CALLBACK_ID,
    private_metadata: channelId,
    title: {
      type: 'plain_text' as const,
      text: 'Donor Letter',
    },
    submit: {
      type: 'plain_text' as const,
      text: 'Generate',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'input',
        block_id: BLOCK_EMAIL,
        label: { type: 'plain_text' as const, text: 'Donor Email(s)' },
        hint: {
          type: 'plain_text' as const,
          text: 'Enter one or more emails, separated by commas',
        },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_EMAIL,
          placeholder: {
            type: 'plain_text' as const,
            text: 'jane@example.com, j.doe@work.org',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_FROM,
        optional: true,
        label: { type: 'plain_text' as const, text: 'From Date' },
        element: {
          type: 'datepicker',
          action_id: ACTION_FROM,
          placeholder: {
            type: 'plain_text' as const,
            text: 'Select start date',
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_TO,
        optional: true,
        label: { type: 'plain_text' as const, text: 'To Date' },
        element: {
          type: 'datepicker',
          action_id: ACTION_TO,
          placeholder: { type: 'plain_text' as const, text: 'Select end date' },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_FORMAT,
        label: { type: 'plain_text' as const, text: 'Output Format' },
        element: {
          type: 'static_select',
          action_id: ACTION_FORMAT,
          initial_option: {
            text: { type: 'plain_text' as const, text: 'PDF' },
            value: 'pdf',
          },
          options: [
            {
              text: { type: 'plain_text' as const, text: 'PDF' },
              value: 'pdf',
            },
            {
              text: { type: 'plain_text' as const, text: 'HTML' },
              value: 'html',
            },
          ],
        },
      },
      {
        type: 'input',
        block_id: BLOCK_SIGNER_NAME,
        optional: true,
        label: { type: 'plain_text' as const, text: 'Signer Name' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_SIGNER_NAME,
          initial_value: config.DEFAULT_SIGNER_NAME,
          placeholder: {
            type: 'plain_text' as const,
            text: config.DEFAULT_SIGNER_NAME,
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_SIGNER_TITLE,
        optional: true,
        label: { type: 'plain_text' as const, text: 'Signer Title' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_SIGNER_TITLE,
          initial_value: config.DEFAULT_SIGNER_TITLE,
          placeholder: {
            type: 'plain_text' as const,
            text: config.DEFAULT_SIGNER_TITLE,
          },
        },
      },
    ],
  }
}

/**
 * Zod schema for validating parsed modal values.
 */
const ModalValuesSchema = z.object({
  emails: z.array(z.string().trim()).min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  format: z.enum(['pdf', 'html']),
  signerName: z.string().nullable(),
  signerTitle: z.string().nullable(),
})

/**
 * Extract and validate values from the modal submission.
 */
function parseModalValues(
  values: ViewSubmissionArgs['view']['state']['values'],
) {
  const emailRaw = values[BLOCK_EMAIL]?.[ACTION_EMAIL]?.value ?? ''
  const from = values[BLOCK_FROM]?.[ACTION_FROM]?.selected_date ?? null
  const to = values[BLOCK_TO]?.[ACTION_TO]?.selected_date ?? null
  const format =
    values[BLOCK_FORMAT]?.[ACTION_FORMAT]?.selected_option?.value ?? 'pdf'
  const signerName =
    values[BLOCK_SIGNER_NAME]?.[ACTION_SIGNER_NAME]?.value ?? null
  const signerTitle =
    values[BLOCK_SIGNER_TITLE]?.[ACTION_SIGNER_TITLE]?.value ?? null

  const emails = emailRaw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)

  return ModalValuesSchema.parse({
    emails,
    from,
    to,
    format,
    signerName,
    signerTitle,
  })
}

/**
 * Handle the modal submission.
 *
 * Generates the letter and uploads it to the Slack channel.
 */
export async function handleLetterModalSubmission(
  { ack, view, client }: ViewSubmissionArgs,
  config: Config,
  logger: Logger,
): Promise<void> {
  const userId = view.private_metadata

  // Open a DM channel with the user so we can post/upload there
  const dmResponse = await client.conversations.open({ users: userId })
  const channelId = dmResponse.channel?.id ?? userId

  // Parse modal values
  let values: z.infer<typeof ModalValuesSchema>
  try {
    values = parseModalValues(view.state.values)
  } catch {
    await ack({
      response_action: 'errors',
      errors: {
        [BLOCK_EMAIL]: 'Please enter at least one valid email address',
      },
    })
    return
  }

  // Acknowledge the submission (closes the modal)
  await ack()

  const { emails, from, to, format, signerName, signerTitle } = values

  logger.info(
    { emails: emails.length, format, channelId },
    'Processing letter from Slack modal',
  )

  // Query donations
  const queryResult = await queryDonations(
    { projectId: config.PROJECT_ID, dataset: config.DATASET_CANON },
    emails,
    from ?? undefined,
    to ?? undefined,
  )

  if (queryResult.isErr()) {
    logger.error({ error: queryResult.error }, 'Query failed for Slack request')
    await client.chat.postMessage({
      channel: channelId,
      text: `:x: Failed to query donations: ${queryResult.error.message}`,
    })
    return
  }

  const rows = queryResult.value

  if (rows.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: `:warning: No succeeded donations found for ${emails.join(', ')}. Please check the email address(es).`,
    })
    return
  }

  // Generate letter
  const letterData = processQueryResults(rows, {
    signerName: signerName ?? undefined,
    signerTitle: signerTitle ?? undefined,
    orgName: config.ORG_NAME,
    orgAddress: config.ORG_ADDRESS,
    orgMission: config.ORG_MISSION,
    orgTaxStatus: config.ORG_TAX_STATUS,
  })
  const html = await generateLetterHtml(letterData)

  if (format === 'html') {
    await client.files.uploadV2({
      channel_id: channelId,
      content: html,
      filename: `donation-confirmation-${letterData.donorName.replace(/\s+/g, '-').toLowerCase()}.html`,
      title: `Donation Confirmation - ${letterData.donorName}`,
      initial_comment: `:white_check_mark: Generated donation confirmation letter for *${letterData.donorName}* (${String(letterData.totalCount)} donation${letterData.totalCount === 1 ? '' : 's'})`,
    })
    return
  }

  // Generate PDF
  const pdfResult = await generatePdf(html)

  if (pdfResult.isErr()) {
    logger.error({ error: pdfResult.error }, 'PDF generation failed for Slack')
    await client.chat.postMessage({
      channel: channelId,
      text: ':x: Failed to generate PDF. Please try again or use HTML format.',
    })
    return
  }

  await client.files.uploadV2({
    channel_id: channelId,
    file: pdfResult.value,
    filename: `donation-confirmation-${letterData.donorName.replace(/\s+/g, '-').toLowerCase()}.pdf`,
    title: `Donation Confirmation - ${letterData.donorName}`,
    initial_comment: `:white_check_mark: Generated donation confirmation letter for *${letterData.donorName}* (${String(letterData.totalCount)} donation${letterData.totalCount === 1 ? '' : 's'})`,
  })
}
