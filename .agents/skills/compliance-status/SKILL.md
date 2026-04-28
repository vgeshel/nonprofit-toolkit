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
- Latest stored discovery run per source.
- Open findings currently stored in `compliance.findings`.

If the status is `unknown`, tell the user to run `compliance-discover` because no stored
discovery runs exist yet.
