# Compliance Toolkit — Plan

## Goal

Help a single-tenant US nonprofit maintain federal and California state compliance through agent-assisted workflows. There is no UI: the agent (Claude Code or similar) is the interface. Users talk to skills; skills orchestrate code.

Scope today: US federal + California. Designed so additional jurisdictions are pluggable modules, added by us or by downstream forks of this repo.

## Operating principles

- **Read, don't file.** Automation may navigate authority sites and read public/private data on the user's behalf. It must never submit filings or pay fees on the user's behalf.
- **Public sources first.** Most "are we current?" questions can be answered without credentials. Authenticated portals come second, only where they fill a real gap.
- **Agent-assisted, not autopilot.** Every action that has external consequences requires explicit user confirmation. The agent prepares; the user signs off.
- **Fail loudly.** If a scraper breaks or a source is unreachable, the system reports "site changed / unreachable" — never silently returns stale or empty data as if it were current.
- **One phase, one fresh subagent, one worktree, one PR.** Each phase below is implemented by a brand-new subagent spawned via the `Agent` tool with `isolation: "worktree"`. The subagent receives only this PLAN, the CHECKLIST, and the merged artifacts of prior phases — no in-conversation context from earlier work. It opens a PR and stops; the user reviews and merges before the next phase begins. Full mechanics in § Cross-phase rules.

## Architecture

### Code layout

```
src/compliance/
  jurisdictions/
    us-federal/    # sources, deadline rules, forms, walkthroughs
    us-ca/         # same shape
  sources/         # source runner abstraction (api | playwright | manual)
  state/           # BigQuery + GCS + Secret Manager accessors
  rules/           # deadline computation, gap/finding detection
  types/           # Jurisdiction, Source, DeadlineRule, Finding, Entity
```

A **Jurisdiction** module exports:

- `id` (e.g. `us-federal`, `us-ca`)
- `entityIdSchema` — Zod schema for the IDs this jurisdiction needs (EIN, SOS entity number, AG charity number, etc.)
- `sources` — list of `Source` definitions for discovery
- `deadlineRules` — data-driven rules to compute upcoming deadlines from entity attributes (added in Phase 4)
- `forms` — form metadata for walkthroughs (added in Phase 5)

A **Source** declares:

```ts
{
  id: string
  jurisdiction: string
  kind: 'api' | 'playwright' | 'manual'
  authRequired: boolean
  description: string
  tosUrl: string                  // documented per source
  run(entity, ctx): ResultAsync<SourceRecord, SourceError>
}
```

Adding a jurisdiction = adding a module. Adding a source within a jurisdiction = adding a `Source` definition. Deadline rules are data wherever possible; code only when a rule cannot be expressed as data.

### Storage layout

- **GCP Secret Manager** — entity IDs and (later) credentials. One secret per logical group, e.g. `compliance/entity-ids/us-federal`, `compliance/entity-ids/us-ca`, `compliance/credentials/<source-id>`.
- **BigQuery dataset `compliance`** — separate from the donations dataset. Tables:
  - `entity` — single row in single-tenant mode; non-secret attributes (legal name, address, FYE, formation date)
  - `discovery_runs` — run metadata: timestamp, source id, status, duration, error
  - `findings` — typed findings with severity, source, evidence, opened/resolved timestamps
  - `sources` — registry snapshot for audit
  - `deadlines` — computed deadlines (Phase 4)
- **GCS bucket** `compliance-records-<project>` — filed documents, confirmations, determination letter, board minutes (Phase 6).

EINs and SOS entity numbers are technically public and don't need to be secret. We still put them in Secret Manager because (a) it gives us one canonical place for "entity identification" and (b) downstream forks may treat them differently. Non-secret entity attributes (name, address) live in BigQuery so they can be queried.

### Skill layer

| Skill                           | Phase                  | Purpose                                                 |
| ------------------------------- | ---------------------- | ------------------------------------------------------- |
| `compliance-onboard`            | 1                      | Interview user; persist entity IDs + attributes         |
| `compliance-discover`           | 1 (minimal) → 2 (real) | Run discovery sources; persist results; report findings |
| `compliance-status`             | 2                      | Read latest stored state; summarize current standing    |
| `compliance-plan`               | 4                      | Compute upcoming deadlines; sync to Google Calendar     |
| `compliance-walkthrough/<form>` | 5                      | Per-form guided filing                                  |

## Phases

> Each phase below is executed by a **fresh subagent in its own git worktree**. The subagent's only inputs are this document, `CHECKLIST.md`, and the merged code from earlier phases. No phase begins until the previous phase's PR is merged.

### Phase 1 — Foundation + Identification + One Source

**Goal.** Smallest end-to-end slice that exercises every architectural layer. If the abstractions are wrong, find out here, before duplicating across sources and jurisdictions.

**In scope:**

- BigQuery `compliance` dataset with the four core tables (`entity`, `discovery_runs`, `findings`, `sources`)
- GCS bucket created (not yet populated)
- `src/compliance/` skeleton with types, jurisdiction registry, source runner (`api` kind only)
- `us-federal` jurisdiction with **one** source: IRS Tax Exempt Organization
  Search bulk-data lookup by EIN (Pub. 78 + Auto-Revocation)
- Entity identification storage: secret-manager accessor for IDs + BigQuery accessor for entity row
- `compliance-onboard` skill: interactive interview, writes IDs and entity row
- `compliance-discover` skill (minimal): runs IRS TEOS bulk-data lookup only,
  writes to BQ, prints raw findings
- 100% test coverage on all new code; all gates green

**Out of scope:**

- Playwright sources (deferred to Phase 2)
- CA jurisdiction (deferred to Phase 2)
- Real findings/gap engine (deferred to Phase 2 — Phase 1 just dumps raw source data)
- Calendar, walkthroughs, governance

**Why this carve-out.** IRS TEOS publishes canonical public bulk downloads for
Pub. 78 and auto-revocation data, so `kind: 'api'` is sufficient for the first
source even without browser automation. Implementing one source end-to-end
shapes the abstraction realistically without the second-system trap of designing
for sources we haven't written yet.

### Phase 2 — Public-source discovery (CA + IRS BMF)

**Goal.** Turn the Phase 1 single-source slice into a real public-source
compliance picture for the user's federal and California standing, without
credentials, filings, payments, or any other external side effects.

**Important source-governance decision.** Phase 2 is not "scrape every portal."
Every source must start with current official-source review, then select the
least invasive allowed access method:

- Prefer official bulk downloads or public CSVs over browser automation.
- Use Playwright only when the official source permits automated read-only
  access or the implementation documents a specific approved basis for it.
- If a source's terms prohibit automated collection, model the source as
  `kind: 'manual'` with exact user instructions and typed evidence capture
  rather than bypassing the restriction.
- Search/query forms are allowed only when the source policy classifies them as
  read-only and documents the request shape. Mutating submits, filings, account
  changes, payments, document uploads, and "certify/order" actions are forbidden.
- A source that cannot be read confidently must produce an explicit source error
  or manual-verification requirement. It must not return stale, empty, or guessed
  compliance status.

**Source research snapshot, checked 2026-04-28.** The implementation phase must
refresh this before coding and capture the final URLs in source definitions.

| Source         | Official URLs to start from                                                                                                                                                                                                        | Planning implication                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA SOS         | `https://www.sos.ca.gov/business-programs/business-entities/information-requests`, `https://www.sos.ca.gov/business-programs/bizfile`, `https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use` | bizfile exposes entity status and related fields, but its terms include anti-scraping restrictions. Start as manual or authorized bulk/public-data access, not blind scrape.                                  |
| CA AG Registry | `https://www.oag.ca.gov/charities`, `https://www.oag.ca.gov/charities/reports`, `https://oag.ca.gov/charities/content/info`, `https://rct.doj.ca.gov`                                                                              | Prefer the downloadable Registry Reports CSVs for status. The search tool remains useful for latest filings and documents, but its replacement by a 2026 online filing system must be handled explicitly.     |
| CA FTB         | `https://www.ftb.ca.gov/help/business/entity-status-letter.asp`, `https://webapp.ftb.ca.gov/eletter/`                                                                                                                              | Entity Status Letter is public and free for supported entity types, including exempt organizations. Treat it as FTB-only status; it does not reflect other agencies.                                          |
| CA CDTFA       | `https://www.cdtfa.ca.gov/services/`, `https://www.cdtfa.ca.gov/services/permits-licenses.htm`, `https://onlineservices.cdtfa.ca.gov/`                                                                                             | Added 2026-04-29 as a next-source candidate. Research seller's permit, use-tax registration, and other CDTFA account verification; CDTFA notes not all permits, licenses, or accounts are publicly disclosed. |
| IRS EO BMF     | `https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf`, `https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads`                               | Official CSV bulk data. Add caching before another large federal download source is introduced.                                                                                                               |

**In scope:**

- Source-governance metadata on every source:
  - `accessUrl` and `tosUrl`
  - `accessMethod` documented as official API/download, Playwright read-only, or manual
  - `automationAllowed` / `manualOnlyReason`
  - source freshness fields (`observedAt`, upstream posting date when available)
  - bounded evidence policy (small typed excerpts, download metadata, or manual
    evidence references; no unbounded HTML dumps in BigQuery rows)
- Shared HTTP/bulk cache for public downloads:
  - ETag / Last-Modified support where the upstream provides it
  - source URL + content hash recorded with each run
  - deterministic local cache for tests and local runs
  - fail-loud behavior for corrupt, stale, or schema-invalid cached artifacts
- `kind: 'playwright'` runner:
  - browser/page injected through the source context for testability
  - denylist and allowlist policy for navigation, downloads, clicks, and form submits
  - no credentials in Phase 2
  - no MFA flow required yet, except a clear "blocked by auth/MFA" result if a
    public page unexpectedly demands it
  - explicit DOM/schema mismatch errors when a page changes
- `us-ca` jurisdiction module:
  - entity ID schema for `sosEntityNumber`, `agCharityNumber`, and optional FTB
    entity ID/name search fields
  - preserve leading zeroes and letters in IDs
  - accept current CA SOS entity-number formats, including the new 12-character
    `B...` IDs for newly registered corporations, LLCs, and LPs
  - register each California source independently
- Public sources:
  - CA SOS business status as a manual or authorized bulk/public-data source unless
    current source review documents a permitted automated path
  - CA AG Registry status and renewal/reporting data, primarily from Registry
    Reports CSVs and secondarily from the search tool only if permitted and needed
  - CA FTB Entity Status Letter lookup for FTB good-standing / exempt-status signal
  - IRS EO BMF CSV lookup by EIN, supplementing Phase 1 Pub. 78 and
    auto-revocation data
- Findings/gap engine:
  - source-specific findings for suspended/forfeited/delinquent/revoked status
  - CA AG renewal findings for missing, incomplete, rejected, late, or not-submitted
    RRF-1 / required annual reporting
  - latest Form 990 presence/freshness finding using IRS TEOS/BMF and CA AG filings
    where available
  - cross-source findings for legal-name/address mismatch, stale source data, and
    missing configured identifiers
  - severity model with stable finding codes, typed evidence, opened/resolved
    timestamps, and deterministic de-duplication
- Skill layer:
  - promote `compliance-discover` from raw Phase 1 output to a multi-source,
    multi-jurisdiction markdown report ordered by severity
  - add `compliance-status`, a read-only skill that summarizes stored state without
    network calls
- Manual verification:
  - run against the user's onboarded nonprofit after implementation
  - record which sources were live, manual, skipped by policy, or unreachable

**Out of scope:**

- Authenticated portal sessions, MyFTB login, AG login, IRS Tax Pro account, and
  MFA-assisted data collection
- Filing submissions, payments, certified-copy orders, document uploads, and portal
  account changes
- Calendar/deadline planning, filing walkthroughs, governance records, or GCS
  document-retention workflows beyond bounded evidence metadata
- Building around a private or undocumented endpoint that the official source does
  not document or permit

**Work packages:**

1. **Source contracts and policy audit.** Refresh official URLs, document ToS/access
   decisions, add source metadata schemas, and create fixture-driven tests for each
   source record shape.
2. **Cache and evidence plumbing.** Add the shared HTTP/download cache and evidence
   size policy before implementing IRS BMF or CA AG CSV downloads.
3. **Runner support.** Extend the source runner for Playwright/manual outcomes with
   read-only policy enforcement and explicit failure types.
4. **Jurisdiction and sources.** Add `us-ca`, then implement one source at a time
   with RED -> GREEN -> REFACTOR tests.
5. **Findings engine.** Move derivable compliance status into typed finding rules,
   including Phase 1 IRS TEOS findings where that simplifies cross-source logic.
6. **Skills and reports.** Upgrade `compliance-discover`, add `compliance-status`,
   and update skill docs with exact behavior and limitations.
7. **Verification and PR.** Run all gates, perform live/manual verification against
   the onboarded nonprofit, update the checklist, push the branch, and open the PR.

### Phase 3 — Authenticated discovery (TBD)

High level only. Playwright sessions with credentials from Secret Manager, MFA passed to the user, per-portal adapters (MyFTB, AG Registry login, possibly IRS Tax Pro account). Only built where authenticated data demonstrably adds value beyond public sources — we do not implement an authenticated source if the public source already answers the question.

Add CDTFA as an explicit Phase 3 source candidate for California sales-and-use-tax
and tax/fee account standing:

- First determine whether the nonprofit has any CDTFA-managed account, such as a
  seller's permit, use-tax registration, or special tax/fee account.
- Review CDTFA Online Services, permit/license/account verification, source terms,
  and any official bulk or authenticated read-only paths before implementation.
- If the account can be verified through an allowed public lookup, implement it as
  a public read-only source. If it requires an account login, implement it only
  through authenticated discovery with user-assisted MFA. If no permitted
  automated path exists, keep it manual with typed evidence capture.
- The source must never file returns, register or close accounts, request relief,
  make payments, or mutate CDTFA account data.

### Phase 4 — Planning + Calendar (TBD)

High level only. Deadline computation engine consuming entity attributes plus jurisdiction `DeadlineRule`s; Google Calendar MCP integration; `compliance-plan` skill. Deadlines stored in `compliance.deadlines` for diffing on subsequent runs.

### Phase 5 — Filing walkthroughs (TBD)

High level only. Per-form skills (`compliance-walkthrough/form-990`, `.../rrf-1`, `.../si-100`, `.../ct-tr-1`, etc.). Document upload to GCS. Confirmation/receipt capture. Each walkthrough is opt-in and explicitly user-driven.

### Phase 6 — Governance + records retention (TBD)

High level only. Board minutes scaffold, conflict-of-interest attestations, records retention schedule, public-disclosure packet generator (Form 1023 + determination letter + last three 990s).

## Cross-phase rules

These are non-negotiable. The phase is not done until all of them hold.

### Execution model

- Each phase runs in a **fresh subagent** spawned via the `Agent` tool with `isolation: "worktree"`. The subagent gets no context from earlier phases beyond the artifacts they produced (this PLAN, the CHECKLIST, merged code, the BigQuery schema, etc.).
- Branch naming: `compliance/phase-<N>-<short-slug>`.
- The subagent opens a PR from the worktree branch and stops. The user reviews and merges. The next phase begins from a clean main.

### TDD is mandatory

- RED → GREEN → REFACTOR. Every unit of behavior starts with a failing test.
- Tests are written, observed to fail for the right reason, then made to pass.
- "Quick fixes" must also start with a failing test. No exceptions.
- See `.claude/rules/testing.md`.

### Acceptance gates (every phase, no exceptions)

- `bun typecheck` — zero errors
- `bun lint` — zero errors, zero warnings
- `bun test:run` — all green
- `bun test:coverage` — **100%** statements, branches, functions, lines on all new files
- No `any` types. No `as` casts (the documented JSONB exception only).
- All external data validated with Zod (see `.claude/rules/external-data-validation.md`).
- All CLI parsing via `commander` (see `.claude/rules/cli-parsing.md`).
- Errors handled with `neverthrow` Result types in production code (see `.claude/rules/error-handling.md`).

### Forbidden escape hatches

The implementation subagent **may not**:

- Lower the project's coverage thresholds.
- Add per-file or per-line coverage exclusions (`/* istanbul ignore next */`, `c8 ignore`, etc.).
- Skip or `.skip` a test to make CI pass.
- Use inline ESLint suppression comments to silence real warnings. (Such suppressions are allowed only for documented framework requirements, and only with an explanatory comment — never to mute a finding.)
- Use `any` or `as` to escape a type error. The fix is the right type, a type guard, or a Zod parse.
- Mock the database in tests in a way that diverges from real BQ schema. Schema validation tests must run against the real schema definition.

If an acceptance gate fails, the answer is to fix the underlying issue, not to weaken the gate. If the user wants the rule changed, they will say so explicitly; the implementation subagent does not get to make that call.

### Per-phase deliverables

- Code under `src/compliance/` and (when applicable) skills under `.claude/skills/` and `.agents/skills/`.
- Migration scripts for any BQ schema changes (idempotent).
- An updated `docs/compliance/CHECKLIST.md` with the phase's items checked off and the next phase's checklist drafted (if work continues immediately) or stubbed (if not).
- A PR with a description that summarizes scope, lists deliverables, shows acceptance-gate output, and notes any manual verification performed.
