-- Migration 002: Source coverage tracking for disbursement deduplication
--
-- Tracks the earliest event_ts per source so that Mercury disbursements
-- can be excluded when a source has its own connector covering that period.
--
-- Run: bq query --use_legacy_sql=false < infra/migrations/002_source_coverage.sql

-- Create the source_coverage table
CREATE TABLE IF NOT EXISTS donations_raw.source_coverage (
  source STRING NOT NULL,
  covers_from TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
OPTIONS (description = 'Per-source coverage start dates for disbursement deduplication');

-- Backfill from existing canonical data
MERGE donations_raw.source_coverage AS target
USING (
  SELECT source, MIN(event_ts) AS covers_from
  FROM donations.events
  WHERE status = 'succeeded' AND source != 'mercury'
  GROUP BY source
) AS src
ON target.source = src.source
WHEN MATCHED THEN UPDATE SET
  covers_from = src.covers_from,
  updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (source, covers_from)
  VALUES (src.source, src.covers_from);

-- Remove double-counted Mercury disbursements from canonical table.
-- A Mercury transaction is a disbursement if its description contains
-- the name of a source that has its own connector, AND the transaction
-- occurred after that source's coverage start date.
-- Uses JOIN approach because BigQuery does not support EXISTS with
-- non-equality conditions (LIKE) in LEFT SEMI JOIN.
DELETE FROM donations.events
WHERE external_id IN (
  SELECT e.external_id
  FROM donations.events e
  INNER JOIN donations_raw.source_coverage sc
    ON sc.source != 'mercury'
    AND LOWER(e.description) LIKE CONCAT(LOWER(sc.source), ';%')
    AND e.event_ts >= sc.covers_from
  WHERE e.source = 'mercury' AND e.status = 'succeeded'
);

-- Note: inter-bank transfers ("Transfer from another bank account to Mercury")
-- are NOT removed — these are direct donations via bank wire.
