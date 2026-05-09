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

Read `PROJECT_ID` from the GCP environment. The skill provisions the `compliance`
BigQuery dataset and tables itself (idempotently) on the first run — do NOT ask the user
to run a migration script first. The standalone CLI at `scripts/compliance-migrate.ts`
exists for human convenience, but this skill must reach the same outcome programmatically.

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

Once every required answer is in hand, call **`runOnboardingProduction`** from
`src/compliance/skills/onboard-wiring.ts`:

```ts
import { runOnboardingProduction } from '../../src/compliance/skills/onboard-wiring.ts'

const result = await runOnboardingProduction({ projectId, answers })
```

That single call constructs the `BigQuery` and `SecretManagerServiceClient`, adapts them
to the migration / entity / Secret Manager ports, runs the schema migration, writes the
secret, and upserts the BQ row. There is no boilerplate to write. Tests inject
`bqFactory` / `secretManagerFactory` / `now`; production omits them and the defaults
construct real SDK clients.

If you would rather invoke from a shell, `scripts/compliance-onboard.ts` is a thin
wrapper that reads the answer JSON from stdin (or `--answers-file`) and calls the same
function:

```bash
cat answers.json | bun scripts/compliance-onboard.ts --project <gcp-project-id>
```

Order of operations is enforced inside `runOnboarding` (which `runOnboardingProduction`
delegates to):

1. Validate the answer bundle (Zod). Validation errors abort before any I/O.
2. Ensure the `compliance` dataset and four tables exist (no-op when they already do).
3. Write the identifiers JSON document to Secret Manager (`compliance-entity-ids`).
4. Upsert the non-secret attributes into `compliance.entity` in BigQuery.

If step 4 fails, the user can re-run onboarding to retry — the secret write is idempotent
and the schema migration is a no-op the second time.

## Confirm back

Show the user a summary of what was written (legal name, identifiers minus secrets, fiscal
year end, formation date, mailing address). Ask them to verify each line. Do not invent
fields they did not provide.

If the success summary's `migration` field shows the dataset or any tables were created
(`createdDataset === true || createdTables.length > 0`), mention briefly that compliance
storage was provisioned for the first time. Otherwise stay silent on it — re-runs of the
migration are routine and not worth chatter.

## Next steps

When onboarding succeeds, suggest the user run the `compliance-discover` skill to perform
the first IRS Tax-Exempt-Organization Search lookup against their EIN.

## Source code

- `src/compliance/skills/onboard-wiring.ts` — production wiring
  (`runOnboardingProduction`); construct GCP clients, adapt, call `runOnboarding`. **Use
  this from the agent.**
- `src/compliance/skills/onboard.ts` — pure logic (interview definition, validation,
  persistence orchestration)
- `src/compliance/skills/wiring-common.ts` — shared `buildCommonDeps` helper
- `src/compliance/state/bq-adapters.ts` — adapt `BigQuery` to the migration port and the
  query-runner port
- `src/compliance/state/secret-manager.ts` — entity-IDs accessor
- `src/compliance/state/secret-manager-gcp.ts` — GCP SDK adapter
- `src/compliance/state/bq-entity.ts` — BigQuery entity-row accessor
- `src/compliance/state/bq-rows.ts` — Zod row schemas
- `scripts/compliance-onboard.ts` — thin CLI wrapper around `runOnboardingProduction`
