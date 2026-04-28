---
name: compliance-discover
description: >
  Run compliance-discovery sources against the configured nonprofit entity and report
  findings. Use this skill when the user asks "are we compliant?", "check our IRS status",
  "verify our tax-exempt status", "run a compliance check", "is our 501(c)(3) still
  active?", or when they want to refresh the compliance picture before a board meeting,
  audit, or grant application. Phase 1 covers the IRS Tax-Exempt-Organization Search
  (Pub. 78 + auto-revocation list) only. Returns a brief summary of new findings.
---

# Compliance Discovery (Phase 1)

Runs every registered compliance source for the onboarded nonprofit, captures each run in
BigQuery (`compliance.discovery_runs`), records typed findings (`compliance.findings`), and
prints a brief summary to the conversation.

Phase 1 ships with **one** source: IRS Pub. 78 + Automatic Revocation list lookup by EIN.
Later phases add California sources (SOS, AG Registry, FTB) and an authentication-required
tier (Phase 3+).

## Pre-flight

The user must have completed onboarding (see `compliance-onboard`). If `runDiscovery`
returns `not_onboarded`, walk the user through onboarding first.

The skill provisions the `compliance` BigQuery dataset and tables itself (idempotently)
before running any sources — do NOT ask the user to run a migration script first.

## Wiring

Build the orchestration with:

- `createJurisdictionRegistry()` from `src/compliance/registry/jurisdiction-registry.ts`
- `register(usFederalJurisdiction)` from
  `src/compliance/jurisdictions/us-federal/index.ts`
- `createEntityAccessor` (BigQuery)
- `createEntityIdsAccessor` (Secret Manager)
- A `RunRecorder` composed from `createDiscoveryRunsAccessor` and
  `createFindingsAccessor`
- `migrationPort` — built with `makeBqPort` from
  `src/compliance/skills/migrate-cli.ts`, wrapping the same BigQuery client used by the
  accessors
- A `now: () => new Date()` clock and the global `fetch`

Then call `runDiscovery` from `src/compliance/skills/discover.ts`. The first thing it
does is run the schema migration; on every subsequent invocation that step is a no-op.

## Report to the user

The `DiscoveryReport` returned by `runDiscovery` contains:

- `runs`: per-source success/failure (each with `outcome: 'ok' | 'err'`)
- `findings`: flattened findings across sources

Render a short markdown summary:

1. **Header** — date, entity legal name.
2. **Per-source line** — for each run, one line: `✅ irs-teos (1.2s)` or
   `❌ irs-teos: [http 502] Bad Gateway`.
3. **Findings** — group by severity. Show title and detail for each. Severity ladder:
   - `error` → action required
   - `warn` → action recommended
   - `info` → informational

Tell the user that:

- Successful runs are persisted in `compliance.discovery_runs`.
- Findings are persisted in `compliance.findings`.
- Failed sources are still recorded as runs with `status='failed'` so partial outages are
  visible in the audit trail.

If the report's `migration` field shows the dataset or any tables were created
(`createdDataset === true || createdTables.length > 0`), mention briefly that compliance
storage was provisioned during this run. Otherwise stay silent on it — re-runs of the
migration are routine and not worth chatter.

## Failure modes

If `runDiscovery` returns:

- `not_onboarded` — direct the user to `compliance-onboard`.
- `load` — the entity row or identifiers couldn't be read; surface the underlying message.
  Most common cause: missing IAM permission on the service account.

Per-source failures (in `runs`) include:

- `network` / `http` — IRS site unreachable. Try again later.
- `rate_limit` — IRS throttled us. Honour `retryAfterSeconds` if present.
- `parse` — IRS payload didn't match the expected schema. The source is broken; file an
  issue. **Do not** silently treat this as "no findings" — that's the difference between
  "nothing to report" and "we don't know".
- `validation` — the entity is missing the EIN. Re-run `compliance-onboard`.

## Source code

- `src/compliance/skills/discover.ts` — orchestration logic (port-driven, fully tested)
- `src/compliance/sources/runner.ts` — per-source execution and persistence
- `src/compliance/jurisdictions/us-federal/sources/irs-teos.ts` — the only Phase 1 source
- `src/compliance/state/bq-runs.ts` — discovery_runs accessor
- `src/compliance/state/bq-findings.ts` — findings accessor
