# Manual Source Handling

Load this file when `compliance-discover` reports a `MANUAL`, `BLOCKED`, or `AUTH`
source, or when the user asks how to complete a source by hand.

## User-facing behavior

For every manual-required source, the discovery report must tell the user:

- why automatic scanning is unavailable;
- which official URL to open;
- the exact manual steps to perform;
- the evidence fields required by the source definition;
- a suggested reply format using the source id and evidence-field keys.

For every auth-required source, the discovery report must tell the user:

- why an authenticated user session is required;
- which official login URL to use;
- which source terms were reviewed;
- the credential/session mode and MFA mode;
- which credential/session fields are needed without requesting shared passwords;
- the exact read-only steps to perform;
- the evidence fields required by the source definition;
- forbidden actions that must not be taken in the portal.

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

For auth-required evidence, use the same discipline: summarize what the user provided,
identify missing required fields, and do not imply that the skill logged in or persisted
anything unless a dedicated authenticated/evidence-ingestion path has actually run.

Never ask the user to paste portal passwords into chat. If a source requires a user-owned
account, tell the user to sign in themselves and provide the report's evidence fields.

## Current manual/auth-required sources

See `california-sources.md` for the current CA SOS, CA FTB, CDTFA, MyFTB, and CA AG
source-specific steps and evidence fields.
