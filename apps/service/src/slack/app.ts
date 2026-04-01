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
import type { Logger } from 'pino'
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

      logger.info(
        { question, hasHistory: history.length > 0 },
        'Running donation agent',
      )

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

      logger.info({ question, sql, textLength: text.length }, 'Agent completed')

      // Post the formatted answer
      await say(text)

      // Post SQL as a follow-up (smaller, for reference)
      if (sql) {
        const formatted = prettySql(sql)
        await say(`_Generated SQL:_\n\`\`\`${formatted}\`\`\``)
      }
    },
  })

  app.assistant(assistant)

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
      { question, hasHistory: history.length > 0 },
      'Running donation agent (channel mention)',
    )

    const result = await runDonationAgent(question, bqConfig, queryFn, history)
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

    logger.info({ question, sql, textLength: text.length }, 'Agent completed')

    await client.chat.postMessage({
      channel: event.channel,
      text,
      thread_ts: replyTs,
    })

    if (sql) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `_Generated SQL:_\n\`\`\`${prettySql(sql)}\`\`\``,
        thread_ts: replyTs,
      })
    }
  })

  logger.info('Donation assistant registered (DM + channel mentions)')

  return { app, receiver }
}
