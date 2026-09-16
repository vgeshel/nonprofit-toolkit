/**
 * MCP prompt: donations-schema
 *
 * Provides the BigQuery schema and SQL rules so the host LLM can
 * write SQL queries directly, without an intermediate agent.
 */
import { buildDonationsSchemaPrompt } from '@donations-etl/bq'
import type { Config } from '../config'

/**
 * Build the donations schema prompt for the host LLM.
 *
 * The schema and SQL rules come from the shared builder in
 * `@donations-etl/bq` so this prompt and the Slack agent's prompt cannot
 * drift. Slack formatting rules are deliberately omitted — the host LLM
 * formats for its own environment.
 */
export function buildDonationsPrompt(config: Config): string {
  const today = new Date().toISOString().split('T')[0]
  const orgLabel = config.ORG_NAME

  return `You are a donation data assistant for ${orgLabel}. You answer questions
about donations by querying a BigQuery database and presenting the results.

Today's date is ${today}.

## How You Work

1. The user asks a question about donations.
2. You write a BigQuery SQL query and execute it using the query-bigquery tool.
3. You see the results and format a clear, well-structured answer.
4. If a query fails, read the error message and fix the SQL.

${buildDonationsSchemaPrompt(config.DATASET_CANON)}`
}
