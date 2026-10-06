-- Migration: donor screening export view
-- Safe to run multiple times (CREATE OR REPLACE).
--
-- One row per donor (name + address) in the column layout prospect-screening
-- services import: name split into first/last, address, contact, and gift
-- history (largest, first, last, totals) from succeeded donations.

CREATE OR REPLACE VIEW donations.donor_report AS
SELECT
  CAST(NULL AS STRING)                                    AS UniqueScreeningID,
  CAST(NULL AS STRING)                                    AS ConstituentImportID,
  CAST(NULL AS STRING)                                    AS Prefix,
  CASE
    WHEN STRPOS(donor_name, ' ') > 0
    THEN SUBSTR(donor_name, 1, STRPOS(donor_name, ' ') - 1)
    ELSE donor_name
  END                                                     AS FirstName,
  CAST(NULL AS STRING)                                    AS NickName,
  CAST(NULL AS STRING)                                    AS MiddleName_Initial,
  CASE
    WHEN STRPOS(donor_name, ' ') > 0
    THEN SUBSTR(donor_name, STRPOS(donor_name, ' ') + 1)
    ELSE NULL
  END                                                     AS LastName,
  CAST(NULL AS STRING)                                    AS Suffix,
  CAST(NULL AS STRING)                                    AS MaidenName,
  JSON_VALUE(donor_address, '$.line1')             AS Address1,
  JSON_VALUE(donor_address, '$.line2')             AS Address2,
  JSON_VALUE(donor_address, '$.city')              AS City,
  JSON_VALUE(donor_address, '$.state')             AS State_Province,
  JSON_VALUE(donor_address, '$.postal_code')       AS ZIP_PostalCode,
  JSON_VALUE(donor_address, '$.country')           AS Country,
  CAST(NULL AS STRING)                                    AS Business,
  CAST(NULL AS STRING)                                    AS Title,
  MAX(donor_phone)                                        AS Phone,
  MAX(donor_email)                                        AS Email,
  CAST(NULL AS STRING)                                    AS Age,
  CAST(NULL AS STRING)                                    AS SpousePrefix,
  CAST(NULL AS STRING)                                    AS SpouseFirstName,
  CAST(NULL AS STRING)                                    AS SpouseNickName,
  CAST(NULL AS STRING)                                    AS SpouseMiddleName_Initial,
  CAST(NULL AS STRING)                                    AS SpouseLastName,
  CAST(NULL AS STRING)                                    AS SpouseSuffix,
  CAST(NULL AS STRING)                                    AS SpouseMaidenName,
  ROUND(MAX(amount_cents) / 100.0, 2)                    AS LargestGift,
  FORMAT_TIMESTAMP("%m/%d/%Y",
    MAX(CASE
      WHEN amount_cents = (SELECT MAX(e2.amount_cents)
                           FROM donations.events e2
                           WHERE e2.donor_name = e.donor_name
                             AND e2.status = 'succeeded')
      THEN event_ts
    END)
  )                                                       AS LargestGiftDate,
  COUNT(*)                                                AS TotalGiftCount,
  ROUND(SUM(amount_cents) / 100.0, 2)                    AS TotalGiftAmount,
  ROUND(MAX(CASE
    WHEN event_ts = (SELECT MAX(e2.event_ts)
                     FROM donations.events e2
                     WHERE e2.donor_name = e.donor_name
                       AND e2.status = 'succeeded')
    THEN amount_cents
  END) / 100.0, 2)                                        AS LastGiftAmount,
  FORMAT_TIMESTAMP("%m/%d/%Y", MAX(event_ts))             AS LastGiftDate,
  ROUND(MAX(CASE
    WHEN event_ts = (SELECT MIN(e2.event_ts)
                     FROM donations.events e2
                     WHERE e2.donor_name = e.donor_name
                       AND e2.status = 'succeeded')
    THEN amount_cents
  END) / 100.0, 2)                                        AS FirstGiftAmount,
  FORMAT_TIMESTAMP("%m/%d/%Y", MIN(event_ts))             AS FirstGiftDate
FROM donations.events e
WHERE status = 'succeeded'
  AND donor_name IS NOT NULL
GROUP BY
  donor_name,
  JSON_VALUE(donor_address, '$.line1'),
  JSON_VALUE(donor_address, '$.line2'),
  JSON_VALUE(donor_address, '$.city'),
  JSON_VALUE(donor_address, '$.state'),
  JSON_VALUE(donor_address, '$.postal_code'),
  JSON_VALUE(donor_address, '$.country');
