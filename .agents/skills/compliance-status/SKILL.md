---
name: compliance-status
description: >
  Summarize the configured nonprofit's stored compliance state without running network
  discovery. Use this skill when the user asks for current compliance status, the latest
  stored findings, or whether prior discovery found anything that needs attention.
---

# Compliance Status

Reads stored compliance state only. It does not run public-source discovery, fetch IRS or
California data, open browsers, submit forms, or write new source-run rows.

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

## Report to the user

Use `formatComplianceStatusReport` from `src/compliance/skills/status.ts` for a concise
markdown report. The report includes:

- Overall stored status: `clear`, `attention_required`, or `unknown`.
- A `Next Steps` section when stored status is `attention_required` or `unknown`.
- Latest stored discovery run per source.
- Open findings currently stored in `compliance.findings`.

If the status is `unknown`, tell the user to run `compliance-discover` because no stored
discovery runs exist yet.

If the status is `attention_required`, do not stop after listing open findings. Relay the
`Next Steps` section and walk the user through the manual or authenticated items one at a
time. Use the exact URLs and configured values printed by the report, and accept plain
sentences or bullets from the user.

When directing the user to any website, make the task easy: include a complete
organization-context block before the site steps with every value that may be useful on a
government form or portal, including legal entity name, FEIN, state of incorporation,
state registration or formation date, mailing address, California SOS entity number, CA AG
charity registration number, FTB entity ID/name, CDTFA identifiers, IRS ruling or
registration date when stored, and CA AG registry dates/status when stored. If a value is
missing, say that it is not configured or not available in stored status. Do not make the
user infer identifiers from internal field names.

Do not claim manual or authenticated evidence was persisted unless a dedicated ingestion
path has actually run.
