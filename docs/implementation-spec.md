# Donations ETL - Implementation Specification

This document provides the complete technical specification for implementing the Donations ETL system. It is derived from `docs/spec-by-gpt.md` but reorganized for implementation clarity.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Canonical Schema](#3-canonical-schema)
4. [Connector Specifications](#4-connector-specifications)
5. [BigQuery Schema](#5-bigquery-schema)
6. [Orchestrator Logic](#6-orchestrator-logic)
7. [CLI Interface](#7-cli-interface)
8. [Error Handling](#8-error-handling)
9. [Testing Strategy](#9-testing-strategy)
10. [Infrastructure](#10-infrastructure)

---

## 1. System Overview

### Purpose

A containerized TypeScript ETL runner that:

1. Fetches donation-ish events from multiple sources (Milestone 1: Mercury, PayPal, Givebutter)
2. Normalizes to a canonical `DonationEvent`
3. Writes NDJSON to GCS: `gs://bucket/runs/<runId>/source=<source>/part-*.ndjson`
4. Loads NDJSON into BigQuery staging (`donations_raw.stg_events`)
5. MERGEs into canonical (`donations.events`)
6. Records run status (`donations_raw.etl_runs`) and watermarks (`donations_raw.etl_watermarks`)

### Runtime Environment

- **Runtime**: Bun (not Node.js)
- **Container**: Cloud Run Jobs
- **Trigger**: Cloud Scheduler (daily at 9 AM PT)
- **Storage**: GCS for intermediate NDJSON files
- **Database**: BigQuery for staging, canonical, and metadata tables

### Project Constraints

| Constraint      | Implementation                                    |
| --------------- | ------------------------------------------------- |
| Error handling  | `neverthrow` Result types - no `throw` statements |
| Validation      | Zod schemas for ALL external data                 |
| CLI parsing     | `commander` library only                          |
| Logging         | `pino` structured logging                         |
| Date/time       | `luxon` DateTime                                  |
| Type assertions | **Banned** - use Zod `.parse()` or type guards    |
| Test coverage   | 100% required                                     |

---

## 2. Architecture

### Directory Structure

```
donations-etl/
├── apps/
│   └── runner/
│       ├── src/
│       │   ├── main.ts           # CLI entrypoint
│       │   ├── cli.ts            # Commander setup
│       │   ├── config.ts         # Environment validation
│       │   ├── orchestrator.ts   # Main ETL flow
│       │   ├── daily.ts          # Daily mode logic
│       │   └── backfill.ts       # Backfill mode logic
│       └── tests/
│           ├── cli.test.ts
│           ├── config.test.ts
│           └── orchestrator.test.ts
├── packages/
│   ├── types/
│   │   ├── src/
│   │   │   ├── donation-event.ts
│   │   │   ├── errors.ts
│   │   │   ├── result.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   │   └── donation-event.test.ts
│   │   └── package.json
│   ├── connectors/
│   │   ├── src/
│   │   │   ├── types.ts          # Connector interface
│   │   │   ├── mercury/
│   │   │   │   ├── schema.ts     # API response Zod schemas
│   │   │   │   ├── client.ts     # HTTP client
│   │   │   │   ├── transformer.ts
│   │   │   │   ├── connector.ts
│   │   │   │   └── index.ts
│   │   │   ├── paypal/
│   │   │   │   ├── schema.ts
│   │   │   │   ├── oauth.ts      # Token management
│   │   │   │   ├── client.ts
│   │   │   │   ├── transformer.ts
│   │   │   │   ├── connector.ts
│   │   │   │   └── index.ts
│   │   │   ├── givebutter/
│   │   │   │   ├── schema.ts
│   │   │   │   ├── client.ts
│   │   │   │   ├── transformer.ts
│   │   │   │   ├── connector.ts
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   │   ├── mercury/
│   │   │   │   ├── client.test.ts
│   │   │   │   ├── transformer.test.ts
│   │   │   │   └── fixtures/
│   │   │   │       └── transactions.json
│   │   │   ├── paypal/
│   │   │   └── givebutter/
│   │   └── package.json
│   └── bq/
│       ├── src/
│       │   ├── schema.sql
│       │   ├── client.ts
│       │   ├── gcs.ts
│       │   ├── loader.ts
│       │   ├── merger.ts
│       │   ├── run-tracker.ts
│       │   ├── watermark.ts
│       │   └── index.ts
│       ├── tests/
│       │   ├── loader.test.ts
│       │   ├── merger.test.ts
│       │   └── schema.test.ts
│       └── package.json
├── infra/
│   ├── provision.sh
│   └── README.md
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Package Dependencies

Each package is a workspace member with its own `package.json`:

```json
// Root package.json workspaces
{
  "workspaces": ["apps/*", "packages/*"]
}
```

Internal package references use workspace protocol:

```json
// apps/runner/package.json
{
  "dependencies": {
    "@donations-etl/types": "workspace:*",
    "@donations-etl/connectors": "workspace:*",
    "@donations-etl/bq": "workspace:*"
  }
}
```

---

## 3. Canonical Schema

### DonationEvent Schema

```typescript
// packages/types/src/donation-event.ts
import { z } from 'zod'

export const SourceEnum = z.enum(['mercury', 'paypal', 'givebutter'])
export type Source = z.infer<typeof SourceEnum>

export const DonationStatusEnum = z.enum([
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
])
export type DonationStatus = z.infer<typeof DonationStatusEnum>

export const DonorAddressSchema = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().length(2).nullable(), // ISO 3166-1 alpha-2
})
export type DonorAddress = z.infer<typeof DonorAddressSchema>

export const DonationEventSchema = z.object({
  // === Identity (MERGE key) ===
  source: SourceEnum,
  external_id: z.string().min(1), // Unique within source

  // === Timestamps (all UTC ISO 8601) ===
  event_ts: z.string().datetime(), // When donation occurred
  created_at: z.string().datetime(), // When created in source system
  ingested_at: z.string().datetime(), // When we ingested it

  // === Amounts (cents to avoid floating point) ===
  amount_cents: z.number().int(),
  fee_cents: z.number().int().default(0),
  net_amount_cents: z.number().int(),
  currency: z.string().length(3).default('USD'),

  // === Donor Information ===
  donor_name: z.string().nullable(),
  donor_email: z.string().email().nullable(),
  donor_phone: z.string().nullable(),
  donor_address: DonorAddressSchema.nullable(),

  // === Transaction Metadata ===
  status: DonationStatusEnum,
  payment_method: z.string().nullable(), // card, ach, wire, check, venmo, etc.
  description: z.string().nullable(),

  // === Source-Specific Data ===
  source_metadata: z.record(z.unknown()),

  // === ETL Metadata ===
  run_id: z.string().uuid(),
})

export type DonationEvent = z.infer<typeof DonationEventSchema>

// Factory function for creating events with defaults
export function createDonationEvent(
  input: Omit<DonationEvent, 'ingested_at'> & { ingested_at?: string },
): DonationEvent {
  return DonationEventSchema.parse({
    ...input,
    ingested_at: input.ingested_at ?? new Date().toISOString(),
  })
}
```

### Design Decisions

1. **Amounts in cents**: Avoids floating-point precision issues. `$10.50` becomes `1050`.

2. **MERGE key**: `(source, external_id)` uniquely identifies a donation across all sources.

3. **Nullable strings**: Donor info may be missing from some sources.

4. **source_metadata**: Captures source-specific fields (campaign IDs, tracking numbers, etc.) as JSONB.

5. **ingested_at**: Always set by the ETL, never from source data.

---

## 4. Connector Specifications

### Connector Interface

```typescript
// packages/connectors/src/types.ts
import type { ResultAsync } from 'neverthrow'
import type { DateTime } from 'luxon'
import type { DonationEvent, Source } from '@donations-etl/types'

// === Error Types ===
export type ConnectorErrorType =
  | 'api' // Non-2xx response
  | 'auth' // 401/403
  | 'rate_limit' // 429
  | 'validation' // Zod parse failure
  | 'network' // Connection error

export type ConnectorError = {
  type: ConnectorErrorType
  message: string
  statusCode?: number
  retryable: boolean
  source: Source
}

// === Options ===
export type FetchOptions = {
  from: DateTime // Inclusive start
  to: DateTime // Exclusive end
  runId: string // UUID for this ETL run
}

export type FetchResult = {
  events: DonationEvent[]
  nextCursor?: string
  hasMore: boolean
}

// === Interface ===
export interface Connector {
  readonly source: Source

  /**
   * Fetch all donations in the date range.
   * Handles pagination internally.
   */
  fetchAll(options: FetchOptions): ResultAsync<DonationEvent[], ConnectorError>

  /**
   * Fetch a single page (for testing/debugging).
   */
  fetchPage(
    options: FetchOptions,
    cursor?: string,
  ): ResultAsync<FetchResult, ConnectorError>

  /**
   * Verify API credentials are valid.
   */
  healthCheck(): ResultAsync<void, ConnectorError>
}

// === Factory ===
export type ConnectorConfig = {
  mercury?: { apiKey: string }
  paypal?: { clientId: string; secret: string }
  givebutter?: { apiKey: string }
}

export function createConnector(
  source: Source,
  config: ConnectorConfig,
): Connector {
  switch (source) {
    case 'mercury':
      return new MercuryConnector(config.mercury!)
    case 'paypal':
      return new PayPalConnector(config.paypal!)
    case 'givebutter':
      return new GivebutterConnector(config.givebutter!)
  }
}
```

### Mercury Connector

**API Documentation**: https://docs.mercury.com/reference

**Base URL**: `https://api.mercury.com/api/v1`

**Authentication**: Bearer token (API key)

**Endpoints**:

- `GET /transactions` - List all transactions
- `GET /account/{id}/transactions` - Transactions for specific account

**Pagination**: Offset-based with `limit` and `offset` query params

**Response Schema**:

```typescript
// packages/connectors/src/mercury/schema.ts
import { z } from 'zod'

export const MercuryTransactionSchema = z.object({
  id: z.string(),
  amount: z.number(), // Negative for debits, positive for credits
  counterpartyId: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'sent', 'failed', 'cancelled']),
  kind: z.string(), // externalTransfer, internalTransfer, etc.
  bankDescription: z.string().nullable(),
  details: z
    .object({
      domesticWireRoutingInfo: z
        .object({
          bankName: z.string().optional(),
        })
        .optional(),
      electronicRoutingInfo: z
        .object({
          bankName: z.string().optional(),
        })
        .optional(),
    })
    .nullable(),
  note: z.string().nullable(),
})

export const MercuryTransactionsResponseSchema = z.object({
  transactions: z.array(MercuryTransactionSchema),
  total: z.number(),
})

export type MercuryTransaction = z.infer<typeof MercuryTransactionSchema>
```

**Transformer**:

```typescript
// packages/connectors/src/mercury/transformer.ts
import { DateTime } from 'luxon'
import type { DonationEvent } from '@donations-etl/types'
import type { MercuryTransaction } from './schema'

export function transformMercuryTransaction(
  tx: MercuryTransaction,
  runId: string,
): DonationEvent {
  const amountCents = Math.round(Math.abs(tx.amount) * 100)

  return {
    source: 'mercury',
    external_id: tx.id,
    event_ts: tx.createdAt,
    created_at: tx.createdAt,
    ingested_at: DateTime.utc().toISO()!,
    amount_cents: amountCents,
    fee_cents: 0,
    net_amount_cents: amountCents,
    currency: 'USD',
    donor_name: tx.counterpartyName,
    donor_email: null, // Not available from Mercury
    donor_phone: null,
    donor_address: null,
    status: mapMercuryStatus(tx.status),
    payment_method: mapMercuryKind(tx.kind),
    description: tx.bankDescription ?? tx.note ?? null,
    source_metadata: {
      counterpartyId: tx.counterpartyId,
      kind: tx.kind,
      details: tx.details,
    },
    run_id: runId,
  }
}

function mapMercuryStatus(status: string): DonationEvent['status'] {
  switch (status) {
    case 'sent':
      return 'succeeded'
    case 'pending':
      return 'pending'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'pending'
  }
}

function mapMercuryKind(kind: string): string {
  if (kind.includes('wire')) return 'wire'
  if (kind.includes('ach') || kind === 'externalTransfer') return 'ach'
  return kind
}
```

### PayPal Connector

**API Documentation**: https://developer.paypal.com/docs/api/transaction-search/v1/

**Base URL**: `https://api-m.paypal.com/v1/reporting/transactions`

**Authentication**: OAuth2 with client credentials

**Constraints**:

- Maximum 31-day date range per request
- 3-hour delay for new transactions
- Max 10,000 records per request

**OAuth Flow**:

```typescript
// packages/connectors/src/paypal/oauth.ts
import { z } from 'zod'
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import type { ConnectorError } from '../types'

const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
})

export class PayPalOAuth {
  private accessToken: string | null = null
  private expiresAt: number = 0

  constructor(
    private clientId: string,
    private secret: string,
    private baseUrl = 'https://api-m.paypal.com',
  ) {}

  getToken(): ResultAsync<string, ConnectorError> {
    // Return cached token if valid
    if (this.accessToken && Date.now() < this.expiresAt - 60000) {
      return okAsync(this.accessToken)
    }

    return ResultAsync.fromPromise(
      fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${this.clientId}:${this.secret}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      }),
      (e) => ({
        type: 'network' as const,
        message: String(e),
        retryable: true,
        source: 'paypal' as const,
      }),
    )
      .andThen((response) => {
        if (!response.ok) {
          return errAsync({
            type: 'auth' as const,
            message: `OAuth failed: ${response.status}`,
            statusCode: response.status,
            retryable: false,
            source: 'paypal' as const,
          })
        }
        return ResultAsync.fromPromise(response.json(), (e) => ({
          type: 'api' as const,
          message: String(e),
          retryable: false,
          source: 'paypal' as const,
        }))
      })
      .andThen((data) => {
        const parsed = TokenResponseSchema.safeParse(data)
        if (!parsed.success) {
          return errAsync({
            type: 'validation' as const,
            message: parsed.error.message,
            retryable: false,
            source: 'paypal' as const,
          })
        }
        this.accessToken = parsed.data.access_token
        this.expiresAt = Date.now() + parsed.data.expires_in * 1000
        return okAsync(this.accessToken)
      })
  }
}
```

**Response Schema**:

```typescript
// packages/connectors/src/paypal/schema.ts
import { z } from 'zod'

export const PayPalMoneySchema = z.object({
  value: z.string(), // "10.50"
  currency_code: z.string(),
})

export const PayPalTransactionInfoSchema = z.object({
  transaction_id: z.string(),
  transaction_event_code: z.string(),
  transaction_initiation_date: z.string(),
  transaction_updated_date: z.string(),
  transaction_amount: PayPalMoneySchema,
  fee_amount: PayPalMoneySchema.optional(),
  transaction_status: z.string(),
  transaction_note: z.string().optional(),
})

export const PayPalPayerInfoSchema = z.object({
  account_id: z.string().optional(),
  email_address: z.string().optional(),
  phone_number: z
    .object({
      national_number: z.string(),
    })
    .optional(),
  payer_name: z
    .object({
      given_name: z.string().optional(),
      surname: z.string().optional(),
    })
    .optional(),
  address: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postal_code: z.string().optional(),
      country_code: z.string().optional(),
    })
    .optional(),
})

export const PayPalTransactionSchema = z.object({
  transaction_info: PayPalTransactionInfoSchema,
  payer_info: PayPalPayerInfoSchema.optional(),
})

export const PayPalSearchResponseSchema = z.object({
  transaction_details: z.array(PayPalTransactionSchema),
  page: z.number(),
  total_items: z.number(),
  total_pages: z.number(),
})

export type PayPalTransaction = z.infer<typeof PayPalTransactionSchema>
```

### Givebutter Connector

**API Documentation**: https://docs.givebutter.com/reference

**Base URL**: `https://api.givebutter.com/v1`

**Authentication**: Bearer token (API key)

**Pagination**: Page-based with `page` and `per_page` query params

**Response Schema**:

```typescript
// packages/connectors/src/givebutter/schema.ts
import { z } from 'zod'

export const GivebutterTransactionSchema = z.object({
  id: z.number(),
  number: z.string(), // Reference number
  campaign_id: z.number().nullable(),
  campaign_code: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z
    .object({
      address_1: z.string().nullable(),
      address_2: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      zipcode: z.string().nullable(),
      country: z.string().nullable(),
    })
    .nullable(),
  status: z.enum(['succeeded', 'authorized', 'failed', 'cancelled']),
  method: z.string(), // card, paypal, venmo, check, cash, ach
  amount: z.number(), // In dollars, e.g., 10.50
  fee: z.number(),
  fee_covered: z.boolean(),
  donated: z.number(),
  payout: z.number(),
  currency: z.string(),
  transacted_at: z.string(),
  created_at: z.string(),
})

export const GivebutterResponseSchema = z.object({
  data: z.array(GivebutterTransactionSchema),
  links: z.object({
    next: z.string().nullable(),
  }),
  meta: z.object({
    current_page: z.number(),
    last_page: z.number(),
    per_page: z.number(),
    total: z.number(),
  }),
})

export type GivebutterTransaction = z.infer<typeof GivebutterTransactionSchema>
```

---

## 5. BigQuery Schema

### Schema SQL

```sql
-- packages/bq/src/schema.sql

-- === Run Tracking ===
CREATE TABLE IF NOT EXISTS donations_raw.etl_runs (
  run_id STRING NOT NULL,
  mode STRING NOT NULL,              -- 'daily' | 'backfill'
  status STRING NOT NULL,            -- 'started' | 'succeeded' | 'failed'
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  from_ts TIMESTAMP,
  to_ts TIMESTAMP,
  metrics JSON,                      -- { sources: { mercury: { count: 10, ... }, ... } }
  error_message STRING
)
OPTIONS (description = 'ETL run metadata');

-- === Watermarks ===
CREATE TABLE IF NOT EXISTS donations_raw.etl_watermarks (
  source STRING NOT NULL,
  last_success_to_ts TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
)
OPTIONS (description = 'Per-source watermarks for incremental fetching');

-- === Staging ===
CREATE TABLE IF NOT EXISTS donations_raw.stg_events (
  run_id STRING NOT NULL,
  source STRING NOT NULL,
  external_id STRING NOT NULL,
  event_ts TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  amount_cents INT64 NOT NULL,
  fee_cents INT64 NOT NULL,
  net_amount_cents INT64 NOT NULL,
  currency STRING NOT NULL,
  donor_name STRING,
  donor_email STRING,
  donor_phone STRING,
  donor_address JSON,
  status STRING NOT NULL,
  payment_method STRING,
  description STRING,
  source_metadata JSON NOT NULL,
  _loaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(event_ts)
CLUSTER BY source, external_id
OPTIONS (description = 'Staging table for raw donation events');

-- === Canonical ===
CREATE TABLE IF NOT EXISTS donations.events (
  source STRING NOT NULL,
  external_id STRING NOT NULL,
  event_ts TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  amount_cents INT64 NOT NULL,
  fee_cents INT64 NOT NULL,
  net_amount_cents INT64 NOT NULL,
  currency STRING NOT NULL,
  donor_name STRING,
  donor_email STRING,
  donor_phone STRING,
  donor_address JSON,
  status STRING NOT NULL,
  payment_method STRING,
  description STRING,
  source_metadata JSON NOT NULL,
  _inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  _updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(event_ts)
CLUSTER BY source, donor_email
OPTIONS (description = 'Canonical donation events (deduplicated)');
```

### MERGE SQL

The MERGE is generated at runtime by `generateMergeSql` in
`packages/bq/src/sql.ts`, parameterized on `@run_id`. It is built rather than
kept as a static file because it also carries source-specific filtering that
changes as sources are added:

- staging rows are deduplicated on `(source, external_id)`, keeping the most
  recently ingested;
- Mercury rows that are internal transfers, debits or checks are dropped;
- Mercury rows are dropped when another source already covers that money, matched
  against `donations_raw.source_coverage.description_pattern` (falling back to the
  source name) and that source's `covers_from`.

Rows merged before their coverage existed are removed after each run by
`generateDeleteSupersededSql`, which reuses the same condition.

---

## 6. Orchestrator Logic

### Daily Mode

```
1. Generate run_id (UUID)
2. Insert into etl_runs: status='started', mode='daily'
3. For each enabled source:
   a. Read watermark from etl_watermarks
   b. Calculate fetch window: [watermark - lookback_hours, now]
   c. connector.fetchAll({ from, to, runId })
   d. Validate each event with DonationEventSchema
   e. Write NDJSON to GCS: gs://bucket/runs/{run_id}/source={source}/part-{i}.ndjson
   f. Track counts
4. BigQuery load job: GCS → stg_events
5. Run MERGE: stg_events → events
6. Update watermarks (only for daily mode)
7. Update etl_runs: status='succeeded', metrics
```

### Backfill Mode

```
1. Parse --from, --to, --chunk (day|week|month)
2. Split date range into chunks
3. For each chunk:
   a. Generate chunk_run_id
   b. Insert etl_runs: status='started', mode='backfill'
   c. For each source: fetch, write NDJSON
   d. Load into stg_events
   e. MERGE into events
   f. Update etl_runs: status='succeeded'
   (DO NOT update watermarks in backfill mode)
```

### Configuration

```typescript
// apps/runner/src/config.ts
import { z } from 'zod'

export const ConfigSchema = z.object({
  // GCP
  GCP_PROJECT_ID: z.string(),
  GCS_BUCKET: z.string(),

  // BigQuery
  BQ_DATASET_RAW: z.string().default('donations_raw'),
  BQ_DATASET_CANON: z.string().default('donations'),

  // ETL behavior
  LOOKBACK_HOURS: z.coerce.number().int().positive().default(48),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Secrets (from Secret Manager, mounted as env vars)
  MERCURY_API_KEY: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_SECRET: z.string().optional(),
  GIVEBUTTER_API_KEY: z.string().optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(): Config {
  return ConfigSchema.parse(process.env)
}
```

---

## 7. CLI Interface

### Commands

```bash
# Daily run (default)
bun run apps/runner/src/main.ts daily

# Backfill
bun run apps/runner/src/main.ts backfill --from=2023-01-01 --to=2024-01-01 --chunk=month

# Health check
bun run apps/runner/src/main.ts health
```

### Implementation

```typescript
// apps/runner/src/cli.ts
import { Command } from 'commander'
import { z } from 'zod'

const DailyOptionsSchema = z.object({
  sources: z.array(z.enum(['mercury', 'paypal', 'givebutter'])).optional(),
})

const BackfillOptionsSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  chunk: z.enum(['day', 'week', 'month']).default('month'),
  sources: z.array(z.enum(['mercury', 'paypal', 'givebutter'])).optional(),
})

export function createCli(): Command {
  const program = new Command()
    .name('donations-etl')
    .description('Donations ETL runner')
    .version('1.0.0')

  program
    .command('daily')
    .description('Run daily ETL')
    .option('--sources <sources>', 'Comma-separated sources', parseSourceList)
    .action(async (options) => {
      const parsed = DailyOptionsSchema.parse(options)
      await runDaily(parsed)
    })

  program
    .command('backfill')
    .description('Backfill historical data')
    .requiredOption('--from <date>', 'Start date (YYYY-MM-DD)')
    .requiredOption('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--chunk <size>', 'Chunk size (day|week|month)', 'month')
    .option('--sources <sources>', 'Comma-separated sources', parseSourceList)
    .action(async (options) => {
      const parsed = BackfillOptionsSchema.parse(options)
      await runBackfill(parsed)
    })

  program
    .command('health')
    .description('Check connector health')
    .action(async () => {
      await runHealthCheck()
    })

  return program
}

function parseSourceList(value: string): string[] {
  return value.split(',').map((s) => s.trim())
}
```

---

## 8. Error Handling

### Result Types

All functions that can fail return `ResultAsync<T, E>`:

```typescript
// packages/types/src/result.ts
import { ResultAsync, okAsync, errAsync } from 'neverthrow'

// Re-export for convenience
export { ResultAsync, okAsync, errAsync, Result, ok, err } from 'neverthrow'

// Helper for wrapping fetch
export function safeFetch(
  url: string,
  options?: RequestInit,
): ResultAsync<Response, { type: 'network'; message: string }> {
  return ResultAsync.fromPromise(fetch(url, options), (e) => ({
    type: 'network' as const,
    message: String(e),
  }))
}
```

### Error Flow

1. **Connectors**: Return `ResultAsync<DonationEvent[], ConnectorError>`
2. **BigQuery operations**: Return `ResultAsync<T, BigQueryError>`
3. **Orchestrator**: Aggregates errors, updates etl_runs with error_message
4. **CLI entry point**: Unwraps Result, logs error, exits with code 1

### Failure Policy

Default: Any connector failure fails the entire run.

The run is marked as `failed` in etl_runs with the error message.

---

## 9. Testing Strategy

### Test Types

1. **Unit tests**: Schema validation, transformers, utilities
2. **Integration tests**: Connector HTTP calls (mocked with MSW)
3. **SQL tests**: Verify MERGE SQL formatting
4. **E2E tests**: Full pipeline with mocked APIs

### Fixtures

Each connector has fixture files with real API response shapes:

```
packages/connectors/tests/mercury/fixtures/
  transactions-single.json
  transactions-paginated.json
  transactions-empty.json
  error-401.json
  error-429.json
```

### Coverage Requirements

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
```

---

## 10. Infrastructure

### Dockerfile

```dockerfile
# Dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb ./
COPY packages/ packages/
COPY apps/ apps/
RUN bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER bun
CMD ["bun", "dist/apps/runner/main.js", "daily"]
```

### Environment Variables

See `.env.example` in the spec for the full list.

### Provisioning

Run via: `dotenvx run -- ./infra/provision.sh`

The script handles:

- Enable GCP APIs
- Create Artifact Registry repo
- Create GCS bucket
- Create BigQuery datasets
- Create service accounts + IAM
- Create secrets in Secret Manager
- Apply BigQuery schema
- Build and push Docker image
- Create Cloud Run Job
- Create Cloud Scheduler job

---

## Appendix: API Reference Links

- **Mercury**: https://docs.mercury.com/reference
- **PayPal**: https://developer.paypal.com/docs/api/transaction-search/v1/
- **Givebutter**: https://docs.givebutter.com/reference
