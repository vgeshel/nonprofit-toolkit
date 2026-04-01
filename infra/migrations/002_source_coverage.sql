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
DELETE FROM donations.events
WHERE source = 'mercury'
  AND status = 'succeeded'
  AND EXISTS (
    SELECT 1
    FROM donations_raw.source_coverage sc
    WHERE sc.source != 'mercury'
      AND LOWER(donations.events.description) LIKE CONCAT('%', LOWER(sc.source), '%')
      AND donations.events.event_ts >= sc.covers_from
  );

-- Also remove inter-bank transfers (not donations)
DELETE FROM donations.events
WHERE source = 'mercury'
  AND status = 'succeeded'
  AND LOWER(description) LIKE '%transfer from another bank account%';
