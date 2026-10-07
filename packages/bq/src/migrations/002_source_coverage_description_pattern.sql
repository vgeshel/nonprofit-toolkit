-- Migration: let a source register the bank aliases its disbursements arrive under
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
--
-- Disbursement deduplication suppresses a Mercury lump-sum row once the
-- platform's own donor-level data covers that period. It matches the Mercury
-- description against the source name, which only works when the platform
-- banks under its own name. A platform paid out by another entity (e.g. a
-- donor-advised fund) needs that name as an alias.
--
-- The aliases themselves depend on the nonprofit's bank, so they are config:
-- DISBURSEMENT_ALIASES in .env, applied by scripts/sync-disbursement-aliases.ts
-- during provisioning.

ALTER TABLE donations_raw.source_coverage
ADD COLUMN IF NOT EXISTS description_pattern STRING;
