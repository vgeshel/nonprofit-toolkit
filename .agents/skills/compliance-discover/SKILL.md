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

Keep this file focused on the discovery workflow. Source-specific and jurisdiction-specific
details live in `references/` and should be loaded only when the user's question or the
current report needs that detail.

## Reference files

- `references/manual-sources.md` - use when a report contains `MANUAL` or `BLOCKED`
  sources, or when the user asks how to complete a source by hand.
- `references/california-sources.md` - use for CA AG Registry, CA SOS bizfile, CA FTB
  Entity Status Letter, and planned CDTFA work.
- `references/federal-sources.md` - use for IRS TEOS and IRS EO BMF details.

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
- For `MANUAL` sources: why automation is unavailable, the official URL to open, manual
  steps, required/optional evidence fields, and a suggested reply format the user can send
  back to this skill.
- Findings ordered by severity, then jurisdiction, then source.

Tell the user that successful, failed, manual-required, policy-blocked, and auth-required
source outcomes are persisted in `compliance.discovery_runs`, and findings are persisted
in `compliance.findings`.

When a source is not `OK`, do not summarize it as compliant. For manual-required sources,
preserve the report's field names exactly when asking the user for evidence. If the user
returns manual evidence, do not claim it was persisted unless a dedicated manual-evidence
ingestion path has been implemented and successfully run.

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
- `src/compliance/jurisdictions/` - jurisdiction modules and source definitions.
- `scripts/compliance-discover.ts` - CLI wrapper.
