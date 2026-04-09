/**
 * Donation query agent using Vercel AI SDK ToolLoopAgent.
 *
 * An agentic loop that translates natural language questions about
 * donations into SQL, executes queries against BigQuery, and formats
 * results for Slack — all in a single LLM interaction.
 *
 * The agent can self-correct: if a query fails, it sees the error
 * and can retry with fixed SQL.
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { ToolLoopAgent, stepCountIs, tool } from 'ai'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import { z } from 'zod'
import { ensureLimit, validateReadOnlySql } from './sql-safety'
import type { BigQueryConfig } from './types'

/**
 * Agent error types.
 */
export interface AgentError {
  type: 'agent'
  message: string
}

/**
 * Default model for the donation agent.
 */
const DEFAULT_AGENT_MODEL = 'gemini-3.1-flash-lite-preview'

/**
 * Maximum agent steps (SQL generation + execution + formatting).
 */
const MAX_STEPS = 6

/**
 * BigQuery query function signature for dependency injection.
 */
export type QueryFn = (
  sql: string,
  maxBytes?: number,
) => Promise<
  | { ok: true; rows: Record<string, unknown>[]; totalRows: number }
  | { ok: false; error: string }
>

/**
 * Build the system prompt for the donation agent.
 */
export function buildAgentPrompt(
  config: BigQueryConfig,
  context?: { orgName?: string },
): string {
  const orgLabel = context?.orgName ?? 'a nonprofit organization'
  const today = new Date().toISOString().split('T')[0]

  return `You are a donation data assistant for ${orgLabel}. You answer questions
about donations by querying a BigQuery database and presenting the results.

Today's date is ${today}.

## How You Work

1. The user asks a question about donations.
2. You write a BigQuery SQL query and execute it using the query_bigquery tool.
3. You see the results and format a clear, well-structured answer.
4. If a query fails, read the error message and fix the SQL.

## Table Schema

The table is \`${config.datasetCanon}.events\` with these columns:

| Column | Type | Description |
|--------|------|-------------|
| source | STRING | Payment platform: 'mercury', 'paypal', 'givebutter', 'check_deposits', 'funraise', 'venmo', 'wise', 'patreon' |
| external_id | STRING | Unique ID from source system |
| event_ts | TIMESTAMP | When the donation occurred (UTC) |
| created_at | TIMESTAMP | When created on source platform |
| ingested_at | TIMESTAMP | When loaded into our system |
| amount_cents | INT64 | Donation amount in cents (e.g., 5000 = $50.00) |
| fee_cents | INT64 | Platform fees in cents |
| net_amount_cents | INT64 | Amount after fees in cents |
| currency | STRING | ISO 3-letter code (e.g., 'USD', 'EUR') |
| donor_name | STRING | Donor's name (nullable) |
| payer_name | STRING | Paying organization name, e.g. for DAF checks (nullable) |
| donor_email | STRING | Donor's email (nullable) |
| donor_phone | STRING | Donor's phone (nullable) |
| donor_address | JSON | Structured address: {line1, line2, city, state, postal_code, country} (nullable) |
| status | STRING | 'pending', 'succeeded', 'failed', 'cancelled', 'refunded' |
| payment_method | STRING | 'card', 'ach', 'wire', 'check', 'venmo', etc. (nullable) |
| description | STRING | Transaction description (nullable) |
| attribution | STRING | Campaign tracking code (nullable) |
| attribution_human | STRING | Human-readable campaign name (nullable) |
| source_metadata | JSON | Source-specific metadata |

The table is partitioned by DATE(event_ts) and clustered by (source, donor_email).

## SQL Rules

1. **Amounts are in cents.** Always divide by 100 to show dollars: \`amount_cents / 100 AS total_dollars\`
2. **For revenue/total queries**, filter to \`status = 'succeeded'\` unless the user asks about other statuses.
3. **Only generate SELECT statements.** Never generate DDL or DML.
4. **Use BigQuery SQL syntax** (not MySQL or PostgreSQL).
5. **Include a LIMIT** for queries that could return many rows (default LIMIT 100).
6. **Format dates** using \`FORMAT_TIMESTAMP('%Y-%m-%d', event_ts)\` when displaying dates.
7. **For "this year"**, use \`EXTRACT(YEAR FROM event_ts) = EXTRACT(YEAR FROM CURRENT_TIMESTAMP())\`
8. **For "last month"**, use \`DATE_TRUNC(event_ts, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)\`
9. **For period comparisons** (e.g., "YTD vs same period last year"), use TIMESTAMP ranges, NOT EXTRACT on month/day. Example: to compare Jan 1–Apr 1 across two years, use \`event_ts >= TIMESTAMP('2025-01-01') AND event_ts < TIMESTAMP('2025-04-01')\` — never \`EXTRACT(MONTH) <= 4 AND EXTRACT(DAY) <= 1\` which only matches day 1 of each month.
10. **Campaign** means the \`attribution_human\` column.
11. **When the user says "donor" without specifying a field**, search both \`donor_name\` and \`donor_email\`.

## Formatting Rules for Your Final Answer

Your final text response will be posted to Slack. Use Slack mrkdwn:
- *bold* for emphasis
- \`code\` for inline values
- \`\`\`code block\`\`\` for tables (monospace, aligned columns)
- > blockquote for callouts
- Bullet lists with •

Formatting guidelines:
1. *Lead with the answer.* Start with the most important number or insight, big and bold.
2. *Format money as whole dollars* with $ and commas (e.g., $15,000). No cents.
3. *Format counts* with commas (e.g., 1,234 donations).
4. *Choose the right layout* based on the data:
   - Single aggregate: Big bold headline number with brief context
   - Small table (2-10 rows): Code block with aligned columns, right-align numbers
   - Large table (10+ rows): Show top 10, note how many more
   - Comparison/ranking: Numbered list or code block
5. *Add brief context* — one sentence explaining what the numbers mean.
6. *Keep it concise* — no filler, no restating the question.
7. *Use emoji sparingly* — one or two at most.
8. Truncate long donor/organization names to ~20 chars.
9. Do NOT include the SQL query in your answer — it's shown separately.`
}

/**
 * Create a donation query agent.
 *
 * The agent has a single tool: query_bigquery, which executes read-only SQL.
 * The queryFn is injected for testability.
 */
export function createDonationAgent(
  config: BigQueryConfig,
  queryFn: QueryFn,
  options?: { model?: string; orgName?: string; apiKey?: string },
) {
  const google = createGoogleGenerativeAI({
    apiKey: options?.apiKey,
  })

  return new ToolLoopAgent({
    model: google(options?.model ?? DEFAULT_AGENT_MODEL),
    instructions: buildAgentPrompt(config, { orgName: options?.orgName }),
    tools: {
      query_bigquery: tool({
        description:
          'Execute a read-only BigQuery SQL query against the donations table. Returns the result rows or an error message.',
        inputSchema: z.object({
          sql: z.string().describe('The BigQuery SQL SELECT query to execute'),
        }),
        execute: async ({ sql }) => queryFn(sql),
      }),
    },
    stopWhen: stepCountIs(MAX_STEPS),
  })
}

/**
 * Build a query function that wraps executeReadOnlyQuery with safety checks.
 */
export function buildQueryFn(
  executeReadOnlyQuery: (
    sql: string,
    maxBytes?: number,
  ) => ResultAsync<
    Record<string, unknown>[],
    { type: string; message: string }
  >,
): QueryFn {
  return async (sql: string) => {
    // Validate SQL before execution
    const validationError = validateReadOnlySql(sql)
    if (validationError) {
      return { ok: false as const, error: validationError }
    }

    const limited = ensureLimit(sql)
    const result = await executeReadOnlyQuery(limited)

    if (result.isErr()) {
      return { ok: false as const, error: result.error.message }
    }

    const rows = result.value
    return {
      ok: true as const,
      rows: rows.slice(0, 50),
      totalRows: rows.length,
    }
  }
}

/**
 * A message in the conversation history.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Agent result containing the formatted answer and SQL used.
 */
export interface AgentResult {
  text: string
  sql: string | null
}

/**
 * Run the donation agent to answer a question.
 *
 * Accepts optional conversation history for follow-up questions in threads.
 * Returns the formatted Slack mrkdwn text and the SQL that was executed.
 */
export function runDonationAgent(
  question: string,
  config: BigQueryConfig,
  queryFn: QueryFn,
  history?: ConversationMessage[],
  options?: { model?: string; orgName?: string; apiKey?: string },
): ResultAsync<AgentResult, AgentError> {
  const agent = createDonationAgent(config, queryFn, options)

  // Build the generate args: use messages for multi-turn, prompt for single-turn
  const generateArgs =
    history && history.length > 0
      ? {
          messages: [
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user' as const, content: question },
          ],
        }
      : { prompt: question }

  return ResultAsync.fromPromise(agent.generate(generateArgs), (error) => ({
    type: 'agent' as const,
    message: `Agent failed: ${error instanceof Error ? error.message : String(error)}`,
  })).andThen((result) => {
    if (!result.text) {
      return errAsync({
        type: 'agent' as const,
        message: 'Agent returned no text response',
      })
    }

    // Extract the last SQL from tool calls
    const allToolCalls = result.steps.flatMap((step) => step.toolCalls)
    const lastQueryCall = allToolCalls.findLast(
      (tc) => tc.toolName === 'query_bigquery',
    )
    const parsed = lastQueryCall
      ? z.object({ sql: z.string() }).safeParse(lastQueryCall.input)
      : undefined
    const sql = parsed?.success ? parsed.data.sql : null

    return okAsync({ text: result.text, sql })
  })
}
