/**
 * Natural language to SQL translation using Vercel AI SDK.
 *
 * Translates user questions about donations into BigQuery SQL
 * using an LLM via the Vercel AI Gateway.
 */
import { createVertex } from '@ai-sdk/google-vertex'
import { generateText, Output } from 'ai'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { BigQueryConfig } from './types'

/**
 * NL2SQL error types.
 */
export interface NL2SqlError {
  type: 'generation' | 'validation'
  message: string
}

function createError(type: NL2SqlError['type'], message: string): NL2SqlError {
  return { type, message }
}

/**
 * Schema for the AI model's structured output.
 */
export const SqlResponseSchema = z.object({
  sql: z.string().describe('The BigQuery SQL query to answer the question'),
  explanation: z
    .string()
    .describe('Brief explanation of what the query does, in plain English'),
})

export type SqlResponse = z.infer<typeof SqlResponseSchema>

/**
 * Default model for SQL generation.
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash'

/**
 * Build the system prompt with table schema and rules.
 */
export function buildSystemPrompt(config: BigQueryConfig): string {
  return `You are a SQL assistant for a nonprofit donation database. Generate BigQuery SQL to answer questions about donations.

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

## Rules

1. **Amounts are in cents.** Always divide by 100 to show dollars: \`amount_cents / 100 AS amount_dollars\`
2. **For revenue/total queries**, filter to \`status = 'succeeded'\` unless the user asks about other statuses
3. **Only generate SELECT statements.** Never generate DDL or DML.
4. **Use BigQuery SQL syntax** (not MySQL or PostgreSQL).
5. **Include a LIMIT** for queries that could return many rows (default LIMIT 100).
6. **Format dates** using \`FORMAT_TIMESTAMP('%Y-%m-%d', event_ts)\` when displaying dates.
7. **For "this year"**, use \`EXTRACT(YEAR FROM event_ts) = EXTRACT(YEAR FROM CURRENT_TIMESTAMP())\`
8. **For "last month"**, use \`DATE_TRUNC(event_ts, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)\`
9. **Campaign** means the \`attribution_human\` column.
10. **When the user says "donor" without specifying a field**, search both \`donor_name\` and \`donor_email\`.

## Examples

Question: "How much did we raise this year?"
SQL: SELECT SUM(amount_cents) / 100 AS total_dollars, COUNT(*) AS donation_count FROM \`${config.datasetCanon}.events\` WHERE status = 'succeeded' AND EXTRACT(YEAR FROM event_ts) = EXTRACT(YEAR FROM CURRENT_TIMESTAMP())

Question: "Top 10 donors by total amount"
SQL: SELECT COALESCE(donor_name, donor_email, 'Anonymous') AS donor, SUM(amount_cents) / 100 AS total_dollars, COUNT(*) AS donations FROM \`${config.datasetCanon}.events\` WHERE status = 'succeeded' GROUP BY donor ORDER BY total_dollars DESC LIMIT 10

Question: "Donations by source last month"
SQL: SELECT source, SUM(amount_cents) / 100 AS total_dollars, COUNT(*) AS count FROM \`${config.datasetCanon}.events\` WHERE status = 'succeeded' AND DATE_TRUNC(event_ts, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH) GROUP BY source ORDER BY total_dollars DESC

Question: "Show me all donations from john@example.com"
SQL: SELECT FORMAT_TIMESTAMP('%Y-%m-%d', event_ts) AS date, amount_cents / 100 AS amount, source, status, payment_method FROM \`${config.datasetCanon}.events\` WHERE donor_email = 'john@example.com' ORDER BY event_ts DESC LIMIT 100

Question: "Average donation size"
SQL: SELECT ROUND(AVG(amount_cents) / 100, 2) AS avg_dollars, ROUND(STDDEV(amount_cents) / 100, 2) AS stddev_dollars, MIN(amount_cents) / 100 AS min_dollars, MAX(amount_cents) / 100 AS max_dollars FROM \`${config.datasetCanon}.events\` WHERE status = 'succeeded'`
}

/**
 * Generate SQL from a natural language question.
 *
 * Uses Google Vertex AI with Application Default Credentials.
 * No API key needed — uses the same GCP auth as BigQuery.
 */
export function generateSql(
  question: string,
  config: BigQueryConfig,
  options?: { model?: string },
): ResultAsync<SqlResponse, NL2SqlError> {
  const modelName = options?.model ?? DEFAULT_MODEL
  const vertex = createVertex({
    project: config.projectId,
    location: 'us-central1',
  })

  return ResultAsync.fromPromise(
    generateText({
      model: vertex(modelName),
      output: Output.object({ schema: SqlResponseSchema }),
      system: buildSystemPrompt(config),
      prompt: question,
    }),
    (error) =>
      createError(
        'generation',
        `Failed to generate SQL: ${error instanceof Error ? error.message : String(error)}`,
      ),
  ).andThen((result) => {
    if (!result.output) {
      return errAsync(
        createError('generation', 'Model returned no structured output'),
      )
    }
    return okAsync(result.output)
  })
}
