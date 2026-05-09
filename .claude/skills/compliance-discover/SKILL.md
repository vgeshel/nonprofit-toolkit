---
name: compliance-discover
description: >
  Run compliance-discovery sources against the configured nonprofit entity and report
  findings. Use this skill when the user asks "are we compliant?", "check our IRS status",
  "verify our tax-exempt status", "run a compliance check", "is our 501(c)(3) still
  active?", or when they want to refresh the compliance picture before a board meeting,
  audit, or grant application. Phase 3 covers IRS TEOS/BMF, public CA AG Registry
  Search Tool/detail pages, public CA SOS bizfile checks, public CA FTB Entity
  Status Letter checks, public CDTFA permit verification, and user-assisted
  authenticated CA portal checks.
---

# Compliance Discovery

Runs every registered compliance source for the onboarded nonprofit, captures each run in
BigQuery (`compliance.discovery_runs`), records typed findings (`compliance.findings`), and
prints a markdown report.

Keep this file focused on the discovery workflow. Source-specific and jurisdiction-specific
details live in `references/` and should be loaded only when the user's question or the
current report needs that detail.

## Reference files

- `references/manual-sources.md` - use when a report contains `MANUAL`, `BLOCKED`,
  or `AUTH` sources, or when the user asks how to complete a source by hand.
- `references/california-sources.md` - use for CA AG Registry, CA AG Online Renewal,
  CA SOS bizfile, CA FTB Entity Status Letter, MyFTB, and CDTFA details.
- `references/federal-sources.md` - use for IRS TEOS, IRS EO BMF, and IRS Tax Pro
  Account source decisions.

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

That call constructs GCP clients, builds the recorder, registers the default compliance
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
- An `Action Required` section whenever actionable manual-required or auth-required
  sources remain.
- Per-source state: `OK`, `MANUAL`, `BLOCKED`, `AUTH`, or `ERROR`.
- CA AG status comes from the public Registry Search Tool source. The CA AG Online
  Renewal System is optional dashboard-only detail and should not be presented as a
  manual/authenticated status check unless the user explicitly asks for those dashboard
  details.
- For `MANUAL` sources: why automation is unavailable, the official URL to open, manual
  steps with the configured values already filled in, and human-readable result labels to
  report back.
- For `AUTH` sources: login URL, source terms URL, read-only setup steps with configured
  identifiers already filled in, human-readable result labels, and forbidden actions.
- Findings ordered by severity, then jurisdiction, then source.

Tell the user that successful, failed, manual-required, policy-blocked, and auth-required
source outcomes are persisted in `compliance.discovery_runs`, and findings are persisted
in `compliance.findings`.

If the report contains `Action Required`, relay that section to the user as the next step
and ask them to complete the listed manual/auth checks. Do not stop at a machine summary
of source statuses. The skill is responsible for walking the user through the remaining
manual work after automatic discovery finishes.

Before replying with a manual or authenticated next step, run discovery or use the freshly
generated discovery report and treat the `Action Required` section as the source of truth.
Do not handwrite the step from memory. The reply is incomplete unless it includes:

- The official URL the user must open.
- The exact action to take on that site.
- Every relevant identifier or value printed by the report, including legal entity name,
  FEIN, state registration details, mailing address, CA SOS number, CA AG number, FTB
  entity ID/name, CDTFA identifiers, IRS ruling date, and CA AG registry dates when
  available.
- The exact information the user should report back in plain language.
- No raw source IDs or evidence-field keys.

Do every check the code can perform before asking the user to do anything. For each
manual/auth source, give the exact official URL and the exact value the user should enter
when it is configured, such as the SOS entity number, AG charity number, FTB entity ID, or
CDTFA account identifier. Do not say "enter the configured ID" when the ID is known.

Use human names in user-facing instructions: for example, say "CA CDTFA Permit, License,
or Account Verification," not `us-ca/ca-cdtfa-permit-license-verification`. Do not ask the
user to fill raw evidence-field keys such as `entity_status`; ask for "entity status" in a
plain sentence instead. Accept plain sentences or bullets from the user and map them to the
internal evidence fields yourself.

When an actionable source is not `OK`, do not summarize it as compliant. For
manual-required and auth-required sources, keep the instructions concise, clear, and
written as full sentences. If the user returns manual or authenticated evidence, do not
claim it was persisted unless a dedicated evidence-ingestion path has been implemented and
successfully run. The current ingestion path is
`bun scripts/compliance-record-evidence.ts --project <gcp-project-id> --source <source-id>
--evidence-file <json-file>`; map the user's plain-language answer into the source's
evidence field keys yourself before running it.

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
- `auth_required` - source requires a user-assisted authenticated session, credentials,
  MFA, or portal access before it can be treated as checked.

Do not treat a failed, blocked, manual-required, or auth-required source as an all-clear,
except for `us-ca/ca-ag-online-filing`, which is optional dashboard-only detail because
CA AG public status is checked by `us-ca/ca-ag-registry`.

## Source code

- `src/compliance/skills/discover-wiring.ts` - production wiring.
- `src/compliance/skills/discover.ts` - orchestration logic.
- `src/compliance/skills/discover-report.ts` - markdown report formatter.
- `src/compliance/rules/findings.ts` - Phase 2 findings/gap engine.
- `src/compliance/jurisdictions/` - jurisdiction modules and source definitions.
- `scripts/compliance-discover.ts` - CLI wrapper.
