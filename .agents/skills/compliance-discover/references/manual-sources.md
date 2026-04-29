# Manual Source Handling

Load this file when `compliance-discover` reports a `MANUAL` or `BLOCKED` source, or
when the user asks how to complete a source by hand.

## User-facing behavior

For every manual-required source, the discovery report must tell the user:

- why automatic scanning is unavailable;
- which official URL to open;
- the exact manual steps to perform;
- the evidence fields required by the source definition;
- a suggested reply format using the source id and evidence-field keys.

Never treat a manual-required, blocked, auth-required, or failed source as an all-clear.
These outcomes mean the compliance picture is incomplete until the missing evidence or
source access is resolved.

## Evidence handoff

Ask the user to reply with the source id plus the evidence fields exactly as printed in
the report. Preserve field keys verbatim because they map to source definitions and future
manual-evidence ingestion.

Example handoff:

```text
source: us-ca/ca-sos-bizfile
entity_status: Active
entity_name: Example Foundation
jurisdiction: California
status_date: 2026-04-29
```

If the user provides manual evidence, summarize what they gave and identify any missing
required fields. Do not claim the evidence has been persisted unless a dedicated
manual-evidence ingestion path exists and has run successfully.

## Current manual-required Phase 2 sources

See `california-sources.md` for the current CA SOS and CA FTB source-specific steps and
evidence fields.
