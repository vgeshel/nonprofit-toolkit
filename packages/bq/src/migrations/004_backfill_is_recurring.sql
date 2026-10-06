-- Migration: Backfill is_recurring from source_metadata
-- Safe to run multiple times (only fills rows where is_recurring IS NULL).
--
-- Each UPDATE mirrors the connector's transformer, reading the raw value that
-- source_metadata already carries, so existing rows are filled without
-- re-fetching from the source APIs or re-importing CSV exports.
--
-- Givebutter is not here: rows written before is_recurring existed did not keep
-- the API's flag, so they need a re-fetch:
--   bun run etl:run backfill --from <first donation> --to <today> --sources givebutter
-- Mercury, Wise, Venmo and check deposits carry no signal and stay NULL.

-- Benevity: Donation Frequency is "Recurring", "One Time" or "Unspecified".
UPDATE donations.events
SET is_recurring = CASE LOWER(TRIM(JSON_VALUE(source_metadata, '$.donation_frequency')))
    WHEN 'recurring' THEN TRUE
    WHEN 'one time' THEN FALSE
  END,
  _updated_at = CURRENT_TIMESTAMP()
WHERE source = 'benevity'
  AND is_recurring IS NULL
  AND LOWER(TRIM(JSON_VALUE(source_metadata, '$.donation_frequency'))) IN ('recurring', 'one time');

-- Funraise: the Recurring column, stored as a boolean.
UPDATE donations.events
SET is_recurring = CASE JSON_VALUE(source_metadata, '$.recurring')
    WHEN 'true' THEN TRUE
    WHEN 'false' THEN FALSE
  END,
  _updated_at = CURRENT_TIMESTAMP()
WHERE source = 'funraise'
  AND is_recurring IS NULL
  AND JSON_VALUE(source_metadata, '$.recurring') IN ('true', 'false');

-- PayPal: T0002 subscription and T0003 preapproved recurring-bill payments are
-- recurring; other T00xx payments are one-off; other codes are not payments.
UPDATE donations.events
SET is_recurring = JSON_VALUE(source_metadata, '$.transaction_event_code') IN ('T0002', 'T0003'),
  _updated_at = CURRENT_TIMESTAMP()
WHERE source = 'paypal'
  AND is_recurring IS NULL
  AND STARTS_WITH(JSON_VALUE(source_metadata, '$.transaction_event_code'), 'T00');

-- Patreon: memberships only, so every charge is recurring.
UPDATE donations.events
SET is_recurring = TRUE,
  _updated_at = CURRENT_TIMESTAMP()
WHERE source = 'patreon'
  AND is_recurring IS NULL;
