---
name: create-connector
description: >
  Create a new data source connector for donations-etl. Use this skill when the user wants to
  add a new payment platform, bank, fundraising service, or any other donation data source.
  Triggers on "add connector", "new connector", "add data source", "integrate with X",
  "connect to X", "import from X", "add X as a source", or when the user mentions a payment
  platform (Stripe, Square, GoFundMe, etc.) and wants to pull donation data from it.
  Also use when modifying or extending an existing connector.
---

# Create a New Connector

Build a connector to import donation data from a new source into the ETL pipeline.

## Step 1: Gather requirements

Ask the user:

1. **What is the data source?** (e.g., Stripe, Square, GoFundMe)
2. **How is data accessed?**
   - REST API (most common)
   - CSV file import
   - Webhook
   - Database query
3. **Do you have API documentation?** Get the URL. Use `WebFetch` to read it.
4. **Do you have credentials/API keys?** (needed for testing, not for writing code)
5. **What data fields are available?** (amount, donor name, email, date, status, etc.)

## Step 2: Study existing connectors

Read these reference implementations to understand the patterns:

```
packages/connectors/src/mercury/    # REST API connector (good reference)
packages/connectors/src/venmo/      # CSV-based connector (if source is CSV)
packages/connectors/src/paypal/     # OAuth-based API (if source uses OAuth)
packages/connectors/src/types.ts    # Shared connector types
packages/types/src/donation-event.ts # Target DonationEvent type
```

## Step 3: Create the file structure

Every connector has exactly 5 source files and 4 test files:

```
packages/connectors/src/<connector-name>/
  client.ts          # API/data client
  schema.ts          # Zod schemas for API responses
  transformer.ts     # Transform source data -> DonationEvent
  connector.ts       # Connector class wiring client + transformer
  index.ts           # Public exports

packages/connectors/tests/<connector-name>/
  client.test.ts
  schema.test.ts
  transformer.test.ts
  connector.test.ts
```

Use kebab-case for the directory name. Use TDD: write tests first, then implementation.

## Step 4: Implement the schema (schema.ts)

Define Zod schemas for ALL external data from the source API.

### Rules

- **Every API response field must have a Zod schema** - no `as` casting
- Use `.optional()` for fields that may be absent
- Use `.nullable()` for fields that may be explicitly `null`
- Use `.default()` for fields with sensible defaults
- Export both the schema AND the inferred TypeScript type
- Be permissive: APIs change, so prefer `.optional()` over required where reasonable

### Pattern

```typescript
import { z } from 'zod'

export const SourceTransactionSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string().length(3).default('USD'),
  status: z.string(),
  created_at: z.string(),
  donor_name: z.string().nullable().optional(),
  donor_email: z.string().nullable().optional(),
  // ... all fields from the API
})

export type SourceTransaction = z.infer<typeof SourceTransactionSchema>

export const SourceResponseSchema = z.object({
  data: z.array(SourceTransactionSchema),
  has_more: z.boolean().optional(),
  next_cursor: z.string().optional(),
})

export type SourceResponse = z.infer<typeof SourceResponseSchema>
```

### Tests (schema.test.ts)

- Test parsing valid data
- Test optional/nullable fields
- Test rejection of invalid data (wrong types, missing required fields)
- Test with realistic API response payloads

## Step 5: Implement the transformer (transformer.ts)

Convert source-specific data to the standard `DonationEvent` type.

### Rules

- **Never throw exceptions** - use `logger.warn()` for unknown values, return safe defaults
- **All amounts in cents** - use `dollarsToCents()` from `@donations-etl/types`
- **All timestamps in UTC ISO 8601** - use `DateTime.utc()` from luxon
- **All nullable fields use `?? null`** - convert `undefined` to `null`
- **Store all raw source fields in `source_metadata`** for auditing
- **Filter out non-donation transactions** (internal transfers, refunds, etc.)

### Required functions

```typescript
import { DateTime } from 'luxon'
import type {
  DonationEvent,
  DonationStatus,
  DonorAddress,
} from '@donations-etl/types'
import { dollarsToCents } from '@donations-etl/types'

// 1. Status mapping
export function mapSourceStatus(status: string): DonationStatus {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return 'succeeded'
    case 'pending':
      return 'pending'
    case 'failed':
    case 'declined':
      return 'failed'
    case 'refunded':
      return 'refunded'
    default:
      logger.warn({ status }, 'Unknown source status, defaulting to succeeded')
      return 'succeeded'
  }
}

// 2. Address extraction (if source provides addresses)
export function extractDonorAddress(data: SourceData): DonorAddress | null {
  if (!data.address) return null
  return {
    line1: data.address.line1 ?? null,
    line2: data.address.line2 ?? null,
    city: data.address.city ?? null,
    state: data.address.state ?? null,
    postal_code: data.address.zip ?? null,
    country: data.address.country ?? null,
  }
}

// 3. Single transaction transform
export function transformSourceTransaction(
  tx: SourceTransaction,
  runId: string,
): DonationEvent {
  const amountCents = dollarsToCents(tx.amount)
  const feeCents = dollarsToCents(tx.fee ?? 0)

  return {
    source: 'source-name', // Must match the Source type
    external_id: tx.id,
    event_ts: tx.created_at,
    created_at: tx.created_at,
    ingested_at: DateTime.utc().toISO()!,
    amount_cents: amountCents,
    fee_cents: feeCents,
    net_amount_cents: amountCents - feeCents,
    currency: tx.currency ?? 'USD',
    donor_name: tx.donor_name ?? null,
    payer_name: null,
    donor_email: tx.donor_email ?? null,
    donor_phone: tx.donor_phone ?? null,
    donor_address: extractDonorAddress(tx),
    status: mapSourceStatus(tx.status),
    payment_method: tx.payment_method ?? null,
    description: tx.description ?? null,
    attribution: null,
    attribution_human: null,
    // true/false only when the source says so; null when it has no signal
    is_recurring: null,
    source_metadata: { ...tx }, // Store full raw data
    run_id: runId,
  }
}

// 4. Batch transform with filtering
export function transformSourceTransactions(
  transactions: SourceTransaction[],
  runId: string,
): DonationEvent[] {
  return transactions
    .filter((tx) => tx.amount > 0) // Only donations (positive amounts)
    .filter((tx) => !isInternalTransfer(tx)) // Skip internal transfers
    .map((tx) => transformSourceTransaction(tx, runId))
}
```

### Tests (transformer.test.ts)

- Test every status mapping (known and unknown)
- Test amount conversion to cents (including edge cases: 0, fractions)
- Test address extraction (full, partial, missing)
- Test filtering (negative amounts, internal transfers)
- Test with realistic data from the actual API

## Step 6: Implement the client (client.ts)

Handle all communication with the external data source.

### Rules

- **All methods return `ResultAsync<T, ConnectorError>`** - never throw
- **Use `createConnectorError()` from `@donations-etl/types`**
- **Map HTTP status codes to error types**: 401/403 -> 'auth', 429 -> 'rate_limit', 5xx -> 'api'
- **Mark errors as retryable**: `true` for 429 and 5xx, `false` for 4xx
- **Validate ALL API responses through Zod schemas**
- **Use `fetchIPv4` from the connectors package** (some APIs are IPv4-only)
- **Accept a `baseUrl` override in config** for testing

### Pattern (REST API)

```typescript
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import { createConnectorError, type ConnectorError } from '@donations-etl/types'
import { fetchIPv4 } from '../ipv4-fetch'

export class SourceClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.source.com'
  }

  getTransactions(
    from: DateTime,
    to: DateTime,
    page = 1,
  ): ResultAsync<SourceResponse, ConnectorError> {
    const url = new URL('/v1/transactions', this.baseUrl)
    url.searchParams.set('start_date', from.toISO()!)
    url.searchParams.set('end_date', to.toISO()!)
    url.searchParams.set('page', page.toString())

    return ResultAsync.fromPromise(
      fetchIPv4(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      }),
      (error) => createConnectorError('network', 'source', String(error)),
    ).andThen((response) => {
      if (!response.ok) {
        return errAsync(
          createConnectorError(
            response.status === 401 || response.status === 403
              ? 'auth'
              : response.status === 429
                ? 'rate_limit'
                : 'api',
            'source',
            `HTTP ${response.status}`,
            {
              statusCode: response.status,
              retryable: response.status >= 500 || response.status === 429,
            },
          ),
        )
      }

      return ResultAsync.fromPromise(
        response.json() as Promise<unknown>,
        (error) => createConnectorError('api', 'source', String(error)),
      ).andThen((json) => {
        const result = SourceResponseSchema.safeParse(json)
        if (!result.success) {
          return errAsync(
            createConnectorError('validation', 'source', result.error.message),
          )
        }
        return okAsync(result.data)
      })
    })
  }

  healthCheck(): ResultAsync<void, ConnectorError> {
    // Fetch a small page to verify credentials work
    return this.getTransactions(
      DateTime.utc().minus({ hours: 1 }),
      DateTime.utc(),
      1,
    ).map(() => undefined)
  }
}
```

### Pattern (CSV-based)

For CSV sources, see `packages/connectors/src/venmo/client.ts`. Key differences:

- Read files from disk instead of HTTP
- Use `csv-parse` library with `{ columns: true, skip_empty_lines: true }`
- Validate each row with Zod, skip invalid rows with `logger.warn()`
- `healthCheck()` verifies the directory/file exists

### Tests (client.test.ts)

- Mock `fetch` (for API) or `readFile` (for CSV)
- Test success path with realistic API responses
- Test error handling: 401, 403, 429, 500, network errors
- Test that retryable flag is set correctly
- Test schema validation failure (malformed API response)

## Step 7: Implement the connector (connector.ts)

Wire the client and transformer together, implementing the `Connector` interface.

### Rules

- **Accept an optional `client` parameter** for dependency injection in tests
- **Handle pagination** via JSON-serialized cursor strings
- **Use `fetchAllRecursive` pattern** for full data fetching
- **Validate cursor parsing** with Zod safeParse, fall back to defaults

### Pattern

```typescript
import { type ResultAsync, okAsync } from 'neverthrow'
import type {
  ConnectorError,
  DonationEvent,
  Source,
} from '@donations-etl/types'
import type { Connector, FetchOptions, FetchResult } from '../types'

export interface ISourceClient {
  getTransactions: SourceClient['getTransactions']
  healthCheck: SourceClient['healthCheck']
}

export interface SourceConnectorOptions {
  config: SourceConfig
  client?: ISourceClient
}

export class SourceConnector implements Connector {
  readonly source: Source = 'source_name'
  private readonly client: ISourceClient

  constructor(options: SourceConnectorOptions) {
    this.client = options.client ?? new SourceClient(options.config)
  }

  healthCheck(): ResultAsync<void, ConnectorError> {
    return this.client.healthCheck()
  }

  fetchPage(
    options: FetchOptions,
    cursor?: string,
  ): ResultAsync<FetchResult, ConnectorError> {
    const page = cursor ? parseCursor(cursor) : 1

    return this.client
      .getTransactions(options.from, options.to, page)
      .map((response) => ({
        events: transformSourceTransactions(response.data, options.runId),
        hasMore: response.has_more ?? false,
        nextCursor: response.has_more ? JSON.stringify(page + 1) : undefined,
      }))
  }

  fetchAll(
    options: FetchOptions,
  ): ResultAsync<DonationEvent[], ConnectorError> {
    return this.fetchAllRecursive(options, undefined, [])
  }

  private fetchAllRecursive(
    options: FetchOptions,
    cursor: string | undefined,
    accumulated: DonationEvent[],
  ): ResultAsync<DonationEvent[], ConnectorError> {
    return this.fetchPage(options, cursor).andThen((result) => {
      const allEvents = [...accumulated, ...result.events]
      if (!result.hasMore) return okAsync(allEvents)
      return this.fetchAllRecursive(options, result.nextCursor, allEvents)
    })
  }
}
```

### Tests (connector.test.ts)

- Test that it implements the `Connector` interface
- Test `fetchPage` with mocked client
- Test `fetchAll` pagination (multiple pages)
- Test `healthCheck` delegation
- Test cursor parsing (valid, invalid, missing)

## Step 8: Create index.ts exports

```typescript
export { SourceClient } from './client'
export {
  SourceConnector,
  type ISourceClient,
  type SourceConnectorOptions,
} from './connector'
export {
  SourceTransactionSchema,
  SourceResponseSchema,
  type SourceTransaction,
} from './schema'
export {
  transformSourceTransaction,
  transformSourceTransactions,
  mapSourceStatus,
} from './transformer'
```

## Step 9: Register the connector

### Add the source type

Edit `packages/types/src/donation-event.ts` and add the new source to the `Source` type:

```typescript
export type Source =
  | 'mercury'
  | 'paypal'
  | 'givebutter'
  | 'check_deposits'
  | 'wise'
  | 'venmo'
  | 'funraise'
  | 'new_source'
```

### Export from connectors package

Edit `packages/connectors/src/index.ts` and add exports for the new connector.

### Add to runner config (if API-based)

Edit `apps/runner/src/config.ts`:

- Add config schema fields for the new source's credentials
- Add the source to `getEnabledSources()`

Edit `apps/runner/src/orchestrator.ts`:

- Import the new connector
- Add a case for the new source in the orchestrator's source selection

### Update .env.example

Add the new source's configuration variables with documentation.

## Step 10: Verify

```bash
bun typecheck    # Must pass
bun lint         # Must pass
bun test:run     # Must pass, 100% coverage on new files
```

## Common pitfalls

1. **Forgetting `?? null`** - TypeScript `undefined` becomes `null` in BigQuery JSON. Always use `?? null`.
2. **Float amounts** - Always convert to cents with `dollarsToCents()`. Never store floats.
3. **Timezone bugs** - Always use `DateTime.utc()`. Never use local time.
4. **Missing schema validation** - Every `fetch()` response and every CSV row must go through Zod.
5. **Throwing in client code** - Use `ResultAsync.fromPromise()` to catch and wrap all errors.
6. **Not filtering internal transfers** - Banks include internal moves. Filter them in the transformer.
7. **Forgetting `source_metadata`** - Always store the full raw source data for debugging.
8. **Not testing error paths** - Every `errAsync()` return must have a test that exercises it.
