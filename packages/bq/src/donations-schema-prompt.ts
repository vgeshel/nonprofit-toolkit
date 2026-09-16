/**
 * Single source of truth for the donations schema and SQL rules given to an LLM.
 *
 * Both prompt surfaces build on this: the Slack agent in `donation-agent.ts`
 * (which appends its own Slack formatting rules) and the `donations-schema`
 * MCP prompt in `apps/mcp`, where the host LLM formats for its own environment.
 *
 * Previously each surface carried its own copy and they drifted — the
 * period-comparison rule reached two of three copies. Change the schema or the
 * rules here, and every surface picks it up.
 */

/**
 * Build the shared schema + SQL rules block.
 *
 * @param datasetCanon Fully-qualified canonical dataset, e.g. `project.dataset`.
 */
export function buildDonationsSchemaPrompt(datasetCanon: string): string {
  return `## Table Schema

The table is \`${datasetCanon}.events\` with these columns:

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
11. **When the user says "donor" without specifying a field**, search both \`donor_name\` and \`donor_email\`.`
}
