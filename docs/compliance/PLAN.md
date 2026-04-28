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
- `us-federal` jurisdiction with **one** source: IRS Tax Exempt Organization Search lookup by EIN
- Entity identification storage: secret-manager accessor for IDs + BigQuery accessor for entity row
- `compliance-onboard` skill: interactive interview, writes IDs and entity row
- `compliance-discover` skill (minimal): runs IRS TEOS only, writes to BQ, prints raw findings
- 100% test coverage on all new code; all gates green

**Out of scope:**

- Playwright sources (deferred to Phase 2)
- CA jurisdiction (deferred to Phase 2)
- Real findings/gap engine (deferred to Phase 2 — Phase 1 just dumps raw source data)
- Calendar, walkthroughs, governance

**Why this carve-out.** IRS TEOS has a clean public JSON API, so `kind: 'api'` is sufficient. Implementing one source end-to-end shapes the abstraction realistically without the second-system trap of designing for sources we haven't written yet.

### Phase 2 — Public-source discovery (CA + IRS BMF)

High-level scope:

- Add `kind: 'playwright'` source runner with read-only constraints, MFA hand-off, ToS-check metadata, and explicit failure modes (no silent stale data)
- `us-ca` jurisdiction module
- Sources: CA SOS bizfile, CA AG Registry of Charities & Fundraisers search, CA FTB Entity Status Letter, IRS BMF bulk lookup
- Findings/gap engine: detect suspended status, missing/late RRF-1, missing latest 990, address mismatch across registries
- Promote `compliance-discover` from minimal to real (multi-source, multi-jurisdiction, prioritized markdown report)
- New `compliance-status` skill (read-only summary of stored state)

Detailed checklist for Phase 2 will be drafted at the start of the phase, after Phase 1 is merged.

### Phase 3 — Authenticated discovery (TBD)

High level only. Playwright sessions with credentials from Secret Manager, MFA passed to the user, per-portal adapters (MyFTB, AG Registry login, possibly IRS Tax Pro account). Only built where authenticated data demonstrably adds value beyond public sources — we do not implement an authenticated source if the public source already answers the question.

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
