-- BigQuery Schema for Donations ETL
-- Run via: bq query --use_legacy_sql=false < schema.sql

-- === Raw Dataset ===
-- CREATE SCHEMA IF NOT EXISTS donations_raw;

-- === Canonical Dataset ===
-- CREATE SCHEMA IF NOT EXISTS donations;

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

-- === Source Coverage ===
-- Tracks when each source's data coverage begins (earliest event_ts).
-- Used by the merge SQL to exclude Mercury disbursements that overlap
-- with sources that have their own connectors. Time-sensitive: only
-- excludes disbursements after the source's coverage start date.
CREATE TABLE IF NOT EXISTS donations_raw.source_coverage (
  source STRING NOT NULL,
  covers_from TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
OPTIONS (description = 'Per-source coverage start dates for disbursement deduplication');

-- === Staging ===
-- Note: No partitioning on staging table to avoid BigQuery quota limits.
-- The staging table is temporary - data is merged into canonical and doesn't
-- need to be queried by date. Partitioning would hit "partition modifications"
-- quota during backfills that span many dates.
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
  payer_name STRING,
  donor_email STRING,
  donor_phone STRING,
  donor_address JSON,
  status STRING NOT NULL,
  payment_method STRING,
  description STRING,
  attribution STRING,
  attribution_human STRING,
  source_metadata JSON NOT NULL,
  _loaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY source, external_id
OPTIONS (description = 'Staging table for raw donation events (no partitioning)');

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
  payer_name STRING,
  donor_email STRING,
  donor_phone STRING,
  donor_address JSON,
  status STRING NOT NULL,
  payment_method STRING,
  description STRING,
  attribution STRING,
  attribution_human STRING,
  source_metadata JSON NOT NULL,
  _inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  _updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(event_ts)
CLUSTER BY source, donor_email
OPTIONS (description = 'Canonical donation events (deduplicated)');
