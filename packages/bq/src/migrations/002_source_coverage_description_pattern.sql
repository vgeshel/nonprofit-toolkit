-- Migration: register the bank aliases a source's disbursements arrive under
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS, MERGE upsert).
--
-- Disbursement deduplication suppresses a Mercury lump-sum row once the
-- platform's own donor-level data covers that period. It matched the Mercury
-- description against the source name, which only works when the platform banks
-- under its own name.
--
-- Benevity does not. Its money arrives from the donor-advised funds that issue
-- the grants — "AMER ONLINE GIV1" and "THE UK ONLINE GIVING FOUNDATION" — and
-- no Mercury description contains the word "benevity". Without these rows,
-- loading Benevity double-counts every disbursement the bank has also recorded.

ALTER TABLE donations_raw.source_coverage
ADD COLUMN IF NOT EXISTS description_pattern STRING;

-- One row per alias. covers_from is refreshed after each merge from the
-- source's own earliest event, so the seed value below only has to be no later
-- than the first Benevity donation.
MERGE donations_raw.source_coverage AS target
USING (
  SELECT 'benevity' AS source,
         'amer online giv1' AS description_pattern,
         TIMESTAMP '2015-10-06 00:00:00 UTC' AS covers_from
  UNION ALL
  SELECT 'benevity',
         'the uk online giving foundation',
         TIMESTAMP '2015-10-06 00:00:00 UTC'
) AS src
ON target.source = src.source
  AND target.description_pattern = src.description_pattern
WHEN NOT MATCHED THEN INSERT (source, description_pattern, covers_from)
  VALUES (src.source, src.description_pattern, src.covers_from);
