# Manual Source Handling

Load this file when `compliance-discover` reports a `MANUAL`, `BLOCKED`, or `AUTH`
source, or when the user asks how to complete a source by hand.

## User-facing behavior

For every manual-required source, the discovery report must tell the user:

- why automatic scanning is unavailable;
- which official URL to open;
- the exact manual steps to perform, with configured values already filled in;
- the human-readable results to report back.

For every actionable auth-required source, the discovery report must tell the user:

- why an authenticated user session is required;
- which official login URL to use;
- which source terms were reviewed;
- that the user must sign in and complete MFA themselves;
- the exact read-only steps to perform, with configured identifiers already filled in;
- the human-readable results to report back;
- forbidden actions that must not be taken in the portal.

Never treat a manual-required, blocked, auth-required, or failed source as an all-clear,
except for `us-ca/ca-ag-online-filing`: CA AG public status is already checked by the
public Registry Search Tool, so Online Renewal is optional dashboard-only detail.
Actionable outcomes mean the compliance picture is incomplete until the missing evidence
or source access is resolved.

When automatic discovery finishes with actionable manual-required or auth-required
sources, the skill must actively ask the user to complete the `Action Required` section. A
status-only summary is not a complete discovery test.

The user-facing walkthrough must use human source names and ordinary result labels. Do not
display internal source identifiers such as `us-ca/ca-sos-bizfile` or evidence keys such
as `entity_status` in the primary instructions. If the code already has a value, print the
value: give the URL, the SOS entity number, the AG charity number, the FTB entity ID, or
the CDTFA account identifier instead of asking the user to infer it.

## Evidence handoff

Ask the user to reply in plain sentences or bullets. The skill maps those answers to the
source definition's internal evidence fields; the user should not need to see or type raw
field keys.

Example handoff:

```text
I opened CA Secretary of State bizfile and searched for C0123456.
The entity status is Active.
The displayed entity name is Example Foundation.
The jurisdiction is California.
The status date shown is 2026-04-29.
```

If the user provides manual evidence, summarize what they gave, identify any missing
required fields, map the answer to source evidence keys yourself, and run
`bun scripts/compliance-record-evidence.ts --project <gcp-project-id> --source <source-id>
--evidence-file <json-file>` when all required fields are present.

For auth-required evidence, use the same discipline: summarize what the user provided,
identify missing required fields, and do not imply that the skill logged in. Only claim
the evidence was persisted after `compliance-record-evidence` or the equivalent
`recordComplianceEvidenceProduction` function succeeds.

Never ask the user to paste portal passwords into chat. If a source requires a user-owned
account, tell the user to sign in themselves and report only the visible status or account
information requested by the walkthrough.

## Current manual/auth-required sources

See `california-sources.md` for the current CA FTB, CDTFA, MyFTB, and CA AG
source-specific steps and evidence fields. CA SOS bizfile and CDTFA public permit
verification are automated public-page sources and should not be presented as manual
evidence tasks.
