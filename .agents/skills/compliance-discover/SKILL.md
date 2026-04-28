---
name: compliance-discover
description: >
  Run compliance-discovery sources against the configured nonprofit entity and report
  findings. Use this skill when the user asks "are we compliant?", "check our IRS status",
  "verify our tax-exempt status", "run a compliance check", "is our 501(c)(3) still
  active?", or when they want to refresh the compliance picture before a board meeting,
  audit, or grant application. Phase 2 covers IRS TEOS, IRS EO BMF, CA AG Registry
  Reports, and manual-required CA SOS/FTB checks.
---

# Compliance Discovery

Runs every registered compliance source for the onboarded nonprofit, captures each run in
BigQuery (`compliance.discovery_runs`), records typed findings (`compliance.findings`), and
prints a markdown report.

Phase 2 public sources:

- IRS Pub. 78 + Automatic Revocation list lookup by EIN.
- IRS EO Business Master File CSV lookup by EIN.
- CA AG Registry Reports CSV lookup by EIN, AG charity number, or SOS/FTB number.
- CA SOS bizfile and CA FTB Entity Status Letter as manual-required sources under the
  current source-policy decisions.

## Pre-flight

The user must have completed onboarding (see `compliance-onboard`). If `runDiscovery`
returns `not_onboarded`, walk the user through onboarding first.

The skill provisions the `compliance` BigQuery dataset and tables itself (idempotently)
before running any sources. Do not ask the user to run a migration script first.

## Wiring

Call `runDiscoveryProduction` from `src/compliance/skills/discover-wiring.ts`:

```ts
import { runDiscoveryProduction } from '../../src/compliance/skills/discover-wiring.ts'

const result = await runDiscoveryProduction({ projectId })
```

That call constructs GCP clients, builds the recorder, registers the default Phase 2
jurisdictions (`usFederalJurisdiction` and `usCaJurisdiction`), runs the schema migration,
and dispatches every source.

For shell use:

```bash
bun scripts/compliance-discover.ts --project <gcp-project-id>
```

Add `--json` for the full structured report.

## Report to the user

Use `formatDiscoveryReport` from `src/compliance/skills/discover-report.ts`. The report
shows:

- Overall completeness.
- Per-source state: `OK`, `MANUAL`, `BLOCKED`, `AUTH`, or `ERROR`.
- Findings ordered by severity, then jurisdiction, then source.

Tell the user that successful, failed, manual-required, policy-blocked, and auth-required
source outcomes are persisted in `compliance.discovery_runs`, and findings are persisted
in `compliance.findings`.

## Failure modes

If `runDiscoveryProduction` returns:

- `not_onboarded` - direct the user to `compliance-onboard`.
- `load` - entity rows, identifiers, or schema migration failed to load.
- `persist` - derived findings could not be written.
- `wiring` - jurisdiction registration failed.

Per-source outcomes include:

- `source_failure` - source was unreachable, rate-limited, invalid, or changed schema.
- `manual_required` - source policy requires manual evidence capture.
- `policy_blocked` - source cannot be read under current policy.
- `auth_required` - source unexpectedly requires authentication.

Do not treat a failed, blocked, or manual-required source as an all-clear.

## Source code

- `src/compliance/skills/discover-wiring.ts` - production wiring.
- `src/compliance/skills/discover.ts` - orchestration logic.
- `src/compliance/skills/discover-report.ts` - markdown report formatter.
- `src/compliance/rules/findings.ts` - Phase 2 findings/gap engine.
- `src/compliance/jurisdictions/us-federal/sources/irs-teos.ts`.
- `src/compliance/jurisdictions/us-federal/sources/irs-bmf.ts`.
- `src/compliance/jurisdictions/us-ca/` - California source definitions.
- `scripts/compliance-discover.ts` - CLI wrapper.
