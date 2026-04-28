---
name: compliance-onboard
description: >
  Capture the nonprofit's identifying information for compliance discovery and persist it to
  Secret Manager (entity IDs) and BigQuery (entity attributes). Use this skill when the user
  is setting up the compliance toolkit for a new nonprofit, when they say "onboard us", "set
  up compliance", "register our nonprofit details", "configure the compliance module", or
  when running `compliance-discover` reports that no entity is configured. Also use when the
  user wants to update the legal name, EIN, fiscal year end, or mailing address on file.
---

# Compliance Onboarding

Phase 1 of the compliance toolkit. Collects the entity's federal and California identifiers
along with non-secret attributes (legal name, fiscal year end, mailing address) and persists
them so subsequent skills can run.

## Pre-flight

Read `PROJECT_ID` from the GCP environment. The migration script must have run once before
onboarding so the `compliance` dataset exists. If the user has not run it, walk them through:

```bash
bun scripts/compliance-migrate.ts --project <PROJECT_ID>
```

Re-runs of the migration are idempotent (no-op when dataset/tables already exist).

## Interview

Walk the user through the questions defined in
`src/compliance/skills/onboard.ts → ONBOARD_INTERVIEW_QUESTIONS`. Ask one at a time. Echo each
answer back for confirmation before moving on. Do **not** write anything until every required
answer is collected.

Required:

1. Legal name of the nonprofit (as registered with the IRS)
2. Federal EIN (9 digits, optional dash NN-NNNNNNN)
3. State of incorporation (2-letter code)
4. California Secretary of State entity number
5. Fiscal year end month (1-12)
6. Fiscal year end day (1-31)
7. Date of formation (YYYY-MM-DD)
8. Mailing address — line 1, city, state/region, postal code, country

Optional:

- California AG Registry of Charitable Trusts charity number (CT…)
- Mailing address — line 2

## Persist

Once every required answer is in hand, call `runOnboarding` from
`src/compliance/skills/onboard.ts` with the answer bundle and accessor instances built from:

- `createEntityIdsAccessor` (Secret Manager) wired via `createGcpSecretManagerPort`
- `createEntityAccessor` (BigQuery) wired via the project-wide BigQuery client

Order of operations is enforced inside `runOnboarding`:

1. Validate the answer bundle (Zod). Validation errors abort before any I/O.
2. Write the identifiers JSON document to Secret Manager (`compliance-entity-ids`).
3. Upsert the non-secret attributes into `compliance.entity` in BigQuery.

If step 3 fails, the user can re-run onboarding to retry — the secret write is idempotent.

## Confirm back

Show the user a summary of what was written (legal name, identifiers minus secrets, fiscal
year end, formation date, mailing address). Ask them to verify each line. Do not invent
fields they did not provide.

## Next steps

When onboarding succeeds, suggest the user run the `compliance-discover` skill to perform
the first IRS Tax-Exempt-Organization Search lookup against their EIN.

## Source code

- `src/compliance/skills/onboard.ts` — pure logic (interview definition, validation,
  persistence orchestration)
- `src/compliance/state/secret-manager.ts` — entity-IDs accessor
- `src/compliance/state/secret-manager-gcp.ts` — GCP SDK adapter
- `src/compliance/state/bq-entity.ts` — BigQuery entity-row accessor
- `src/compliance/state/bq-rows.ts` — Zod row schemas
