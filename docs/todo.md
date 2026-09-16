# Donations ETL - Implementation Checklist

This checklist tracks implementation progress. Each item must have 100% test coverage.

---

## Phase 1: Foundation

### Monorepo Setup

- [x] Create `apps/runner/` directory structure
- [x] Create `packages/types/` directory structure
- [x] Create `packages/connectors/` directory structure
- [x] Create `packages/bq/` directory structure
- [x] Update root `package.json` with workspaces
- [x] Create `packages/types/package.json`
- [x] Create `packages/connectors/package.json`
- [x] Create `packages/bq/package.json`
- [x] Create `apps/runner/package.json`
- [x] Install dependencies: `@google-cloud/bigquery`, `@google-cloud/storage`

### packages/types

- [x] `src/donation-event.ts` - DonationEventSchema + DonationEvent type
- [x] `src/errors.ts` - ConnectorError, BigQueryError types
- [x] `src/result.ts` - Result type re-exports and helpers
- [x] `src/index.ts` - Public exports
- [x] `tests/donation-event.test.ts` - Schema validation tests
  - [x] Valid event parsing
  - [x] Missing required fields
  - [x] Invalid email format
  - [x] Invalid timestamp format
  - [x] Amount edge cases (negative, zero, large)
- [x] `tests/errors.test.ts` - Error type tests
- [x] `tests/result.test.ts` - Result helper tests

---

## Phase 2: Connector Interface

### packages/connectors

- [x] `src/types.ts` - Connector interface, FetchOptions, FetchResult, ConnectorError
- [x] `src/index.ts` - Public exports + createConnector factory
- [x] `tests/types.test.ts` - Interface tests

---

## Phase 3: Mercury Connector

### Implementation

- [x] `src/mercury/schema.ts` - Zod schemas for API responses
- [x] `src/mercury/client.ts` - HTTP client with auth and pagination
- [x] `src/mercury/transformer.ts` - Transform to DonationEvent
- [x] `src/mercury/connector.ts` - Implements Connector interface
- [x] `src/mercury/index.ts` - Public exports

### Tests

- [x] `tests/mercury/schema.test.ts` - API response validation
- [x] `tests/mercury/client.test.ts` - HTTP client (vitest mocked)
- [x] `tests/mercury/transformer.test.ts` - Transformation logic
- [x] `tests/mercury/connector.test.ts` - Full connector flow

---

## Phase 4: PayPal Connector

### Implementation

- [x] `src/paypal/schema.ts` - Zod schemas for API responses
- [x] `src/paypal/client.ts` - HTTP client with OAuth2 and pagination (OAuth integrated in client)
- [x] `src/paypal/transformer.ts` - Transform to DonationEvent
- [x] `src/paypal/connector.ts` - Implements Connector interface
- [x] `src/paypal/index.ts` - Public exports

### Tests

- [x] `tests/paypal/schema.test.ts` - API response validation
- [x] `tests/paypal/client.test.ts` - HTTP client with OAuth (vitest mocked)
- [x] `tests/paypal/transformer.test.ts` - Transformation logic
- [x] `tests/paypal/connector.test.ts` - Full connector flow

---

## Phase 5: Givebutter Connector

### Implementation

- [x] `src/givebutter/schema.ts` - Zod schemas for API responses
- [x] `src/givebutter/client.ts` - HTTP client with auth and pagination
- [x] `src/givebutter/transformer.ts` - Transform to DonationEvent
- [x] `src/givebutter/connector.ts` - Implements Connector interface
- [x] `src/givebutter/index.ts` - Public exports

### Tests

- [x] `tests/givebutter/schema.test.ts` - API response validation
- [x] `tests/givebutter/client.test.ts` - HTTP client (vitest mocked)
- [x] `tests/givebutter/transformer.test.ts` - Transformation logic
- [x] `tests/givebutter/connector.test.ts` - Full connector flow

---

## Phase 6: BigQuery Package

### Implementation

- [x] `src/schema.sql` - CREATE TABLE statements
- [x] `src/merge.sql` - MERGE statement template
- [x] `src/client.ts` - BigQuery client wrapper with:
  - [x] GCS upload (NDJSON)
  - [x] Load from GCS to staging
  - [x] Merge to canonical table
  - [x] Run tracking (etl_runs CRUD)
  - [x] Watermark tracking (etl_watermarks CRUD)
- [x] `src/ndjson.ts` - NDJSON formatting utilities
- [x] `src/sql.ts` - SQL query builders
- [x] `src/types.ts` - BigQuery types and schemas
- [x] `src/index.ts` - Public exports

### Tests

- [x] `tests/client.test.ts` - Full client functionality
- [x] `tests/ndjson.test.ts` - NDJSON formatting
- [x] `tests/sql.test.ts` - SQL query building
- [x] `tests/types.test.ts` - Type validation

---

## Phase 7: CLI Runner

### Implementation

- [x] `src/config.ts` - Environment variable validation with Zod
- [x] `src/cli.ts` - Commander setup with daily/backfill/health commands
- [x] `src/orchestrator.ts` - Main ETL orchestration with:
  - [x] Daily mode (runDaily)
  - [x] Backfill mode (runBackfill) with date chunking
- [x] `src/logger.ts` - Pino logger configuration
- [x] `src/main.ts` - Entry point

### Tests

- [x] `tests/config.test.ts` - Config validation
- [x] `tests/cli.test.ts` - CLI argument parsing
- [x] `tests/orchestrator.test.ts` - Orchestration flow (daily + backfill)
- [x] `tests/logger.test.ts` - Logger configuration

---

## Phase 8: Infrastructure

### Files

- [x] `.env.example` - Environment variable template
- [x] `infra/provision.sh` - GCP provisioning script
- [x] `infra/README.md` - Usage documentation
- [x] `Dockerfile` - Multi-stage Bun build

### Verification

- [x] `provision.sh` is executable
- [ ] `provision.sh` passes shellcheck (shellcheck not installed)
- [x] Dockerfile syntax valid

---

## Phase 9: Verification

### Build & Quality

- [x] `bun run build` succeeds
- [x] `bun run test:run` passes with 100% coverage
- [x] `bun typecheck` passes
- [x] `bun lint` passes
- [x] Pre-commit hooks configured and passing

### Coverage

- [x] 100% Statements (926/926)
- [x] 100% Branches (428/428)
- [x] 100% Functions (269/269)
- [x] 100% Lines (881/881)

---

## Deferred (Post-Milestone 1)

- [x] Wise connector
- [x] Venmo connector
- [x] Benevity connector (CSV reports + `scripts/benevity-download.ts`)
- [ ] `--continueOnError` flag
- [ ] Retry logic with exponential backoff
- [ ] Metrics/observability integration
- [ ] Docker image build verification
- [ ] Integration tests with real APIs (sandbox)

---

## Notes

- All code follows `.claude/rules/` standards
- No `as` type assertions - uses Zod and type guards
- No `throw` statements - uses Result types (neverthrow)
- TDD approach followed throughout
