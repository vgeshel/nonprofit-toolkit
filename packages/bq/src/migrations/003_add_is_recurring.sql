-- Migration: Add is_recurring column to existing tables
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS)
--
-- true = the gift is part of a recurring plan, false = the source says it is a
-- one-off, NULL = the source carries no recurrence signal (bank and manual
-- sources). Connectors derive it from source_metadata, which keeps the raw value.

ALTER TABLE donations_raw.stg_events
ADD COLUMN IF NOT EXISTS is_recurring BOOL;

ALTER TABLE donations.events
ADD COLUMN IF NOT EXISTS is_recurring BOOL;
