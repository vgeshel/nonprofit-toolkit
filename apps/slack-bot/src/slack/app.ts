/**
 * Slack Bolt App initialization with Assistant API for donation queries.
 */
import {
  BigQueryClient,
  buildQueryFn,
  runDonationAgent,
  type ConversationMessage,
} from '@donations-etl/bq'
import { App, Assistant } from '@slack/bolt'
import type { KnownBlock } from '@slack/web-api'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { Config } from '../config'
import { handleDonorLetterCommand } from './commands/donor-letter'
import { prettySql } from './formatters/query-result'
import { BunReceiver } from './receiver'
import { buildThreadHistory } from './thread-history'
import type { ViewSubmissionArgs } from './views/letter-modal'
import {
  handleLetterModalSubmission,
  LETTER_MODAL_CALLBACK_ID,
} from './views/letter-modal'

/**
 * Create and configure the Slack Bolt App with a custom Bun receiver.
 *
 * Returns both the App and the receiver so the router can forward requests.
 */
export function createSlackApp(config: Config, logger: Logger) {
  const receiver = new BunReceiver()

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
    receiver,
  })

  // Register slash command
  app.command('/donor-letter', async (args) => {
    await handleDonorLetterCommand(args, config, logger)
  })

  // Register modal submission handler
  app.view(LETTER_MODAL_CALLBACK_ID, async ({ ack, view, client }) => {
    const handlerArgs: ViewSubmissionArgs = {
      ack: async (response?: {
        response_action: string
        errors?: Record<string, string>
      }) => {
        if (response?.errors) {
          await ack({
            response_action: 'errors',
            errors: response.errors,
          })
        } else {
          await ack()
        }
      },
      view,
      client: {
        files: {
          uploadV2: (opts: Parameters<typeof client.files.uploadV2>[0]) =>
            client.files.uploadV2(opts),
        },
        chat: {
          postMessage: (opts: { channel: string; text: string }) =>
            client.chat.postMessage(opts),
        },
        conversations: {
          open: (opts: { users: string }) => client.conversations.open(opts),
        },
      },
    }

    await handleLetterModalSubmission(handlerArgs, config, logger)
  })

  // Register AI Assistant for donation queries
  const bqClient = new BigQueryClient(
    {
      projectId: config.PROJECT_ID,
      datasetRaw: 'donations_raw',
      datasetCanon: config.DATASET_CANON,
    },
    { bucket: '' },
  )

  const queryFn = buildQueryFn(bqClient.executeReadOnlyQuery.bind(bqClient))

  const assistant = new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, setTitle }) => {
      await setTitle('Donation Assistant')
      await say(
        'Hi! I can answer questions about your donations. Ask me anything.',
      )
      await setSuggestedPrompts({
        prompts: [
          {
            title: 'Total raised',
            message: 'How much did we raise this year?',
          },
          { title: 'Top donors', message: 'Who are our top 10 donors?' },
          {
            title: 'By source',
            message: 'Total donations by source this year',
          },
          { title: 'Last month', message: 'How much did we raise last month?' },
        ],
      })
    },

    userMessage: async ({ message, say, setStatus, client }) => {
      const question =
        'text' in message && typeof message.text === 'string'
          ? message.text.trim()
          : ''

      if (!question) return

      await setStatus('Querying donations...')

      const bqConfig = {
        projectId: config.PROJECT_ID,
        datasetRaw: 'donations_raw',
        datasetCanon: config.DATASET_CANON,
      }

      // Build conversation history from thread messages
      let history: ConversationMessage[] = []
      const threadTs =
        'thread_ts' in message ? String(message.thread_ts) : undefined
      const messageTs = 'ts' in message ? String(message.ts) : ''
      if (threadTs && message.channel) {
        try {
          const thread = await client.conversations.replies({
            channel: message.channel,
            ts: threadTs,
            limit: 20,
          })
          history = buildThreadHistory(thread.messages ?? [], messageTs)
        } catch {
          // Non-critical: continue without history
        }
      }

      logger.info({ hasHistory: history.length > 0 }, 'Running donation agent')
      logger.debug({ question }, 'Agent question')

      const result = await runDonationAgent(
        question,
        bqConfig,
        queryFn,
        history,
        {
          model: config.AGENT_MODEL,
          orgName: config.ORG_NAME,
          apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
        },
      )

      if (result.isErr()) {
        logger.error({ error: result.error, question }, 'Agent failed')
        await say(
          "I couldn't answer that question. Try rephrasing it or asking something simpler.",
        )
        return
      }

      const { text, sql } = result.value

      logger.info({ textLength: text.length }, 'Agent completed')
      logger.debug({ question, sql }, 'Agent details')

      // Post the answer with a "Show SQL" button
      if (sql) {
        await say({
          text,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Show SQL' },
                  action_id: 'show_sql',
                  value: sql,
                },
              ],
            },
          ],
        })
      } else {
        await say(text)
      }
    },
  })

  app.assistant(assistant)

  // Slack button value max length
  const MAX_BUTTON_VALUE = 2000

  // Build message blocks with optional SQL display and Show/Hide toggle.
  // If SQL exceeds Slack's 2000-char button value limit, omit the button.
  function buildResultBlocks(
    text: string,
    sql: string | null,
    showSql: boolean,
  ): KnownBlock[] {
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ]
    if (showSql && sql) {
      blocks.push({
        type: 'section',
        block_id: 'sql_display',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`${prettySql(sql)}\`\`\``,
        },
      })
    }
    if (sql && sql.length <= MAX_BUTTON_VALUE) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: showSql ? 'Hide SQL' : 'Show SQL',
            },
            action_id: showSql ? 'hide_sql' : 'show_sql',
            value: sql,
          },
        ],
      })
    }
    return blocks
  }

  // Extract mrkdwn text from the first section block in a message
  const AnswerBlockSchema = z.object({
    type: z.literal('section'),
    text: z.object({ type: z.literal('mrkdwn'), text: z.string() }),
  })

  function extractAnswerText(message: unknown): string {
    const msg = z.object({ blocks: z.array(z.unknown()) }).safeParse(message)
    if (!msg.success) return ''
    for (const block of msg.data.blocks) {
      const parsed = AnswerBlockSchema.safeParse(block)
      if (parsed.success) return parsed.data.text.text
    }
    return ''
  }

  // Toggle SQL display inline by updating the message
  for (const actionId of ['show_sql', 'hide_sql'] as const) {
    app.action(actionId, async ({ ack, action, body, client }) => {
      await ack()
      if (action.type !== 'button' || !action.value) return

      const channel =
        'channel' in body && body.channel ? body.channel.id : undefined
      const messageTs =
        'message' in body && body.message ? body.message.ts : undefined
      if (!channel || !messageTs) return

      const message = 'message' in body ? body.message : undefined
      // Extract mrkdwn from blocks, fall back to message.text (plain text fallback)
      const answerText =
        extractAnswerText(message) ||
        ('message' in body ? String(body.message?.text ?? '') : '')
      if (!answerText) return

      const showSql = actionId === 'show_sql'
      await client.chat.update({
        channel,
        ts: messageTs,
        blocks: buildResultBlocks(answerText, action.value, showSql),
        text: answerText,
      })
    })
  }

  // Also handle @mentions in channels for shared visibility
  app.event('app_mention', async ({ event, client }) => {
    const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()

    if (!question) {
      await client.chat.postMessage({
        channel: event.channel,
        text: 'Ask me a question about donations! For example: "How much did we raise this year?"',
        thread_ts: event.thread_ts ?? event.ts,
      })
      return
    }

    // Add thinking reaction
    try {
      await client.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: 'hourglass_flowing_sand',
      })
    } catch {
      // Non-critical
    }

    const bqConfig = {
      projectId: config.PROJECT_ID,
      datasetRaw: 'donations_raw',
      datasetCanon: config.DATASET_CANON,
    }

    // Build history from thread if this is a follow-up
    let history: ConversationMessage[] = []
    if (event.thread_ts) {
      try {
        const thread = await client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: 20,
        })
        history = buildThreadHistory(thread.messages ?? [], event.ts)
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to fetch thread history',
        )
      }
    }

    logger.info(
      { hasHistory: history.length > 0 },
      'Running donation agent (channel mention)',
    )
    logger.debug({ question }, 'Agent question (channel mention)')

    const result = await runDonationAgent(
      question,
      bqConfig,
      queryFn,
      history,
      {
        model: config.AGENT_MODEL,
        orgName: config.ORG_NAME,
        apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
      },
    )
    const replyTs = event.thread_ts ?? event.ts

    if (result.isErr()) {
      logger.error({ error: result.error, question }, 'Agent failed')
      await client.chat.postMessage({
        channel: event.channel,
        text: "I couldn't answer that question. Try rephrasing it or asking something simpler.",
        thread_ts: replyTs,
      })
      return
    }

    const { text, sql } = result.value

    logger.info(
      { textLength: text.length },
      'Agent completed (channel mention)',
    )
    logger.debug({ question, sql }, 'Agent details (channel mention)')

    await client.chat.postMessage({
      channel: event.channel,
      text,
      thread_ts: replyTs,
      ...(sql && {
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Show SQL' },
                action_id: 'show_sql',
                value: sql,
              },
            ],
          },
        ],
      }),
    })
  })

  logger.info('Donation assistant registered (DM + channel mentions)')

  return { app, receiver }
}
