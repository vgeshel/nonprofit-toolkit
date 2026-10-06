---
name: donations-query
description: >
  Query and analyze the donations BigQuery table using natural language. Use this skill whenever the user
  asks questions about donations, donors, revenue, fundraising metrics, payment sources, transaction
  history, or wants to explore donation data. Triggers on questions like "how much did we raise",
  "who are our top donors", "show me donations by source", "what's our monthly revenue trend",
  "any failed transactions", or any freeform analytical question about the donations dataset.
  Also use when the user says "query donations", "donations analytics", "run a query", or asks
  about donor retention, average gift size, or campaign performance.
---

# Donations Query & Analytics

Answer freeform questions about the organization's donation data by translating them into BigQuery SQL,
executing the queries, and presenting the results clearly.

## How it works

1. Read the user's question
2. Translate it into one or more BigQuery SQL queries against the `donations.events` table
3. Execute via the `bq` CLI
4. Present results in a clear, readable format (tables, summaries, or narrative)

## Connection details

The BigQuery project and dataset are configured via environment variables. Before running your first query, read the PROJECT_ID from `.env` or `.env.local` in the project root. The canonical table is:

```
`<PROJECT_ID>.donations.events`
```

If `.env` / `.env.local` don't exist or don't contain PROJECT_ID, ask the user.

## Executing queries

Use the `bq query` CLI tool. Always use these flags:

```bash
bq query --use_legacy_sql=false --format=prettyjson "SELECT ..."
```

For queries that return tabular results meant for display, `--format=pretty` (table format) is often more readable. Use `--format=prettyjson` when you need to post-process the results programmatically.

For large result sets, add `--max_rows=100` to avoid overwhelming output, and let the user know if results were truncated.

## Schema reference

The `donations.events` table has the following columns:

| Column              | Type             | Description                                                                                        |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `source`            | STRING           | Source system: `mercury`, `paypal`, `givebutter`, `check_deposits`, `funraise`, `venmo`, `wise`    |
| `external_id`       | STRING           | Unique ID from the source system                                                                   |
| `event_ts`          | TIMESTAMP        | When the transaction occurred (UTC). Table is partitioned by `DATE(event_ts)`.                     |
| `created_at`        | TIMESTAMP        | When the transaction was created at the source                                                     |
| `ingested_at`       | TIMESTAMP        | When the ETL ingested this record                                                                  |
| `amount_cents`      | INT64            | Gross amount in cents (e.g., 5000 = $50.00)                                                        |
| `fee_cents`         | INT64            | Transaction fee in cents                                                                           |
| `net_amount_cents`  | INT64            | Net amount after fees, in cents                                                                    |
| `currency`          | STRING           | 3-letter ISO 4217 code (mostly `USD`, but Wise can have `EUR`, `UAH`, etc.)                        |
| `donor_name`        | STRING, nullable | Donor's full name                                                                                  |
| `payer_name`        | STRING, nullable | Institutional payer (e.g., "Vanguard Charitable" for DAF checks)                                   |
| `donor_email`       | STRING, nullable | Donor's email                                                                                      |
| `donor_phone`       | STRING, nullable | Donor's phone                                                                                      |
| `donor_address`     | JSON, nullable   | Structured: `{line1, line2, city, state, postal_code, country}`                                    |
| `status`            | STRING           | `pending`, `succeeded`, `failed`, `cancelled`, `refunded`                                          |
| `payment_method`    | STRING, nullable | `card`, `ach`, `wire`, `check`, `venmo`, `bank_transfer`, `internal`, etc.                         |
| `description`       | STRING, nullable | Transaction description or memo                                                                    |
| `attribution`       | STRING, nullable | Campaign or attribution code                                                                       |
| `attribution_human` | STRING, nullable | Human-readable campaign name                                                                       |
| `is_recurring`      | BOOL, nullable   | `TRUE` recurring gift, `FALSE` known one-off, `NULL` source has no signal (never treat as one-off) |
| `source_metadata`   | JSON             | Source-specific data (varies by source)                                                            |
| `_inserted_at`      | TIMESTAMP        | When this row was first inserted                                                                   |
| `_updated_at`       | TIMESTAMP        | When this row was last updated                                                                     |

**Partitioning**: `DATE(event_ts)` -- always include a date filter on `event_ts` to avoid full table scans.

**Clustering**: `source`, `donor_email` -- queries filtering on these columns are fast.

## Supporting tables

For ETL operational questions, two additional tables are available:

- **`donations_raw.etl_runs`**: ETL run history with `run_id`, `mode` (daily/backfill), `status`, `started_at`, `completed_at`, `from_ts`, `to_ts`, `metrics` (JSON), `error_message`
- **`donations_raw.etl_watermarks`**: Per-source watermarks with `source`, `last_success_to_ts`, `updated_at`

## Query patterns

### Amounts are in cents

Always divide by 100 for dollar display:

```sql
SELECT ROUND(SUM(amount_cents) / 100, 2) AS total_dollars
FROM `PROJECT.donations.events`
WHERE status = 'succeeded'
```

### Multi-currency awareness

Most donations are in USD, but Wise transactions can be in EUR, UAH, or other currencies. When aggregating totals, either filter to a single currency or group by currency:

```sql
-- Safe aggregation
SELECT currency, ROUND(SUM(amount_cents) / 100, 2) AS total
FROM `PROJECT.donations.events`
WHERE status = 'succeeded'
GROUP BY currency
```

### Date filtering

Always filter on `event_ts` for partition pruning:

```sql
WHERE event_ts >= TIMESTAMP('2024-01-01')
  AND event_ts < TIMESTAMP('2025-01-01')
```

### Donor matching

Donors don't have a single unique ID across sources. Match donors using `donor_email` (most reliable) or `donor_name` (fuzzy). For DAF / institutional checks, `payer_name` identifies the granting organization.

### JSON field access

Use `JSON_VALUE()` for scalar values from `donor_address` or `source_metadata`:

```sql
SELECT JSON_VALUE(donor_address, '$.state') AS state,
       COUNT(*) AS donations
FROM `PROJECT.donations.events`
WHERE donor_address IS NOT NULL
GROUP BY state
ORDER BY donations DESC
```

### Common status filter

Most analytical queries should filter to successful donations:

```sql
WHERE status = 'succeeded'
```

Include other statuses only when specifically analyzing failed/pending/refunded transactions.

## Presenting results

- For small result sets (< 20 rows): display as a formatted table
- For single-value answers: state the answer directly in a sentence
- For trends: describe the pattern and suggest the user visualize if needed
- Always show the SQL you ran so the user can modify it
- If a query returns no results, explain possible reasons (date range, filters, data availability)
- Round dollar amounts to 2 decimal places
- Format large numbers with commas for readability

## Iterating

After showing results, offer to refine. The user might want to:

- Drill down into a specific source, time period, or donor
- Add filters or change groupings
- Compare periods (MoM, YoY)
- Export results

Be proactive about suggesting follow-up analyses when the initial results reveal interesting patterns.
