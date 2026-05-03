---
name: compliance-status
description: >
  Summarize the configured nonprofit's stored compliance state without running network
  discovery. Use this skill when the user asks for current compliance status, the latest
  stored findings, or whether prior discovery found anything that needs attention.
---

# Compliance Status

The initial status read is stored-state only. It does not run public-source discovery,
fetch IRS or California data, open browsers, submit forms, or write new source-run rows.
If the user then provides the manual or authenticated evidence requested by the report,
use the evidence-ingestion path below to record that answer as a new source-run row.

## Pre-flight

The user must have completed `compliance-onboard`. If the backing function returns
`not_onboarded`, run onboarding first.

## Wiring

Call `getComplianceStatusProduction` from
`src/compliance/skills/status-wiring.ts`:

```ts
import { getComplianceStatusProduction } from '../../src/compliance/skills/status-wiring.ts'

const result = await getComplianceStatusProduction({ projectId })
```

For shell use:

```bash
bun scripts/compliance-status.ts --project <gcp-project-id>
```

Add `--json` for the full structured report.

## Recording User Evidence

When the user answers a manual or authenticated walkthrough, map their plain-language
answer to the source's evidence field keys and run:

```bash
bun scripts/compliance-record-evidence.ts --project <gcp-project-id> --source <source-id> --evidence-file <json-file>
```

The JSON file can be either a raw object of evidence fields or an object with
`observedAt` and `evidence`. Example for CA CDTFA Online Services:

```json
{
  "observedAt": "2026-05-02T00:00:00.000Z",
  "evidence": {
    "cdtfa_accounts_present": true,
    "account_statuses": "Account exists; balance 0.",
    "balance": "0",
    "open_filing_obligations": "none",
    "notices_or_billings": "none",
    "reviewed_at": "2026-05-02"
  }
}
```

After recording evidence, rerun `compliance-status` and continue with the next open item.
Do not ask the user to provide internal field names; translate their answer yourself.

## Report to the user

Use `formatComplianceStatusReport` from `src/compliance/skills/status.ts` for a concise
markdown report. The report includes:

- Overall stored status: `clear`, `attention_required`, or `unknown`.
- A `Next Steps` section when stored status is `attention_required` or `unknown`.
- Latest stored discovery run per source.
- Open findings currently stored in `compliance.findings`.

CA AG public charity status is checked by `us-ca/ca-ag-registry` from the public
Registry Search Tool. Do not send the user to the CA AG Online Renewal System for normal
status verification. A stored `us-ca/ca-ag-online-filing` auth-required run is an
optional dashboard-only supplement and is not an open compliance task unless the user
explicitly asks for renewal-dashboard-only details.

If the status is `unknown`, tell the user to run `compliance-discover` because no stored
discovery runs exist yet.

If the status is `attention_required`, do not stop after listing open findings. Relay the
`Next Steps` section and walk the user through the manual or authenticated items one at a
time. Use the exact URLs and configured values printed by the report, and accept plain
sentences or bullets from the user.

Before replying with a manual or authenticated next step, run the status command or
production function and use the generated report as the source of truth. Do not handwrite
the step from memory. The reply is incomplete unless it includes:

- The official URL the user must open.
- The exact action to take on that site.
- Every relevant identifier or value printed by the report, including values recovered
  from stored discovery evidence.
- The exact information the user should report back in plain language.
- No raw source IDs or evidence-field keys.

When directing the user to any website, make the task easy: include a complete
organization-context block before the site steps with every value that may be useful on a
government form or portal, including legal entity name, FEIN, state of incorporation,
state registration or formation date, mailing address, California SOS entity number, CA AG
charity registration number, FTB entity ID/name, CDTFA identifiers, IRS ruling or
registration date when stored, and CA AG registry status, issue/effective dates, renewal
due date, and last-renewal date when stored. If a value is missing, say that it is not
configured or not available in stored status. Do not make the user infer identifiers from
internal field names.

Do not claim manual or authenticated evidence was persisted unless
`compliance-record-evidence` or the equivalent `recordComplianceEvidenceProduction`
function has actually run successfully.
