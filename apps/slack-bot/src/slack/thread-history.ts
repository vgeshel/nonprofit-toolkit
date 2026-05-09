/**
 * Shared helper for building conversation history from Slack thread messages.
 *
 * Used by both the Assistant API (DM) and app_mention (channel) handlers
 * to provide consistent multi-turn context to the donation agent.
 */
import type { ConversationMessage } from '@donations-etl/bq'

/**
 * Slack message shape from conversations.replies.
 */
export interface SlackThreadMessage {
  ts?: string
  text?: string
  user?: string
  bot_id?: string
}

/**
 * Build conversation history from Slack thread messages.
 *
 * Filters out:
 * - The current message (matched by timestamp)
 * - SQL thread replies (start with "_Generated SQL:_")
 * - Empty messages and bare @mentions
 *
 * Strips @mentions from all messages for clean LLM context.
 */
export function buildThreadHistory(
  messages: SlackThreadMessage[],
  currentMessageTs: string,
): ConversationMessage[] {
  const history: ConversationMessage[] = []

  for (const msg of messages) {
    if (!msg.text) continue

    // Skip the current message — it's passed separately as the prompt
    if (msg.ts === currentMessageTs) continue

    // Skip SQL thread replies
    if (msg.text.startsWith('_Generated SQL:_')) continue

    // Strip @mentions and trim
    const text = msg.text.replace(/<@[A-Z0-9]+>/g, '').trim()
    if (!text) continue

    const isBot = msg.bot_id !== undefined
    history.push({
      role: isBot ? 'assistant' : 'user',
      content: text,
    })
  }

  return history
}
