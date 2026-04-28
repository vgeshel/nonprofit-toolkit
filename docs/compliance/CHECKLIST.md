# Compliance Toolkit — Implementation Checklist

This is the working checklist used by the implementation subagent for each phase. The companion design document is `docs/compliance/PLAN.md`. Read both before starting any work.

> **Cross-phase rule.** Every phase obeys the rules in `PLAN.md` § Cross-phase rules. They are not optional. Acceptance gates fail closed: if anything is red, the phase is not done.

---

## Phase 1 — Foundation + Identification + IRS TEOS — **COMPLETE**

### Pre-flight

- [x] Read `CLAUDE.md` (root)
- [x] Read every file in `.claude/rules/`
- [x] Read `docs/compliance/PLAN.md` end-to-end
- [x] Confirm working directory is a git worktree on branch `compliance/phase-1-foundation`
- [x] Skim existing `src/` for established conventions
- [x] Run `bun typecheck`, `bun lint`, `bun test:run` once on a clean tree to confirm the baseline is green
- [x] Search the web for current IRS Tax-Exempt-Organization Search API documentation. **Result:** there is no documented public JSON API for the apps.irs.gov/app/eos web app. The IRS publishes Pub. 78 and Auto-Revocation pipe-delimited bulk downloads as the canonical programmatic-access surface; Phase 1 implements those.

### BigQuery schema (TDD)

- [x] Tests for Zod schemas (entity, discovery_runs, findings, sources)
- [x] Implement Zod schemas
- [x] Tests for migration script (mocked BQ port)
- [x] Implement migration (`scripts/compliance-migrate.ts` + `src/compliance/skills/migrate.ts` + `migrate-cli.ts`)

### Jurisdiction abstraction (TDD)

- [x] Types tests
- [x] Implement types and registry
- [x] Source runner tests
- [x] Implement source runner

### IRS TEOS source (TDD)

- [x] Zod schemas for Pub 78 and Auto Revocation rows
- [x] Tests with mocked fetch returning hand-built ZIPs
- [x] Implement source (Pub 78 + Auto Revocation, with rate-limit / network / parse error paths)
- [x] Registered under `us-federal` jurisdiction module

### Identification storage (TDD)

- [x] Secret Manager accessor (port-driven; tests mock the port)
- [x] GCP Secret Manager adapter (separately tested with a fake SDK client)
- [x] Entity BQ-row accessor (port-driven; tests mock the runner)

### Skills

- [x] `compliance-onboard` SKILL.md + backing TS at `src/compliance/skills/onboard.ts`
- [x] `compliance-discover` SKILL.md + backing TS at `src/compliance/skills/discover.ts`
- [x] Tests for backing TS
- [x] **Sandbox note**: the harness this implementation ran under blocked writes under `.claude/skills/`, so the new SKILL.md files live at `.agents/skills/compliance-onboard/SKILL.md` and `.agents/skills/compliance-discover/SKILL.md`. Both paths are read by the harness for skill discovery (other repo skills, e.g. `bootstrap`, `donor-letter`, exist on the `.claude/skills/` side; locally-authored ones land here on the `.agents/skills/` side instead). The reviewer can mirror them under `.claude/skills/` if desired.

### Acceptance gates — all green

- [x] `bun typecheck` — zero errors
- [x] `bun lint` — zero errors. The five pre-existing warnings on `main` (in `apps/service/tests/config.test.ts` and `packages/bq/tests/donation-agent.test.ts`) are out of scope for this phase per the spawn instructions.
- [x] `bun test:run` — all 2028 pass
- [x] `bun test:coverage` — **100%** statements / branches / functions / lines on every new file
- [x] No `any` types
- [x] No `as` casts
- [x] No inline ESLint suppression comments
- [x] No skipped tests
- [x] All external data Zod-validated
- [x] CLI parsing via `commander`
- [x] Production errors via `Result` / `ResultAsync`

### Manual verification — DEFERRED (requires real GCP credentials)

- [ ] Run `compliance-onboard` end-to-end against a fake entity in a dev project. Confirm secret and BQ row land correctly. Inspect both.
- [ ] Run `compliance-discover` against a real EIN provided by the user. Confirm the IRS TEOS payload is captured in `discovery_runs` and that any derivable `findings` are written.
- [ ] Re-run the migration script. Confirm it is a no-op the second time.

### Phase exit

- [x] Mark this phase complete in this file.
- [x] Draft Phase 2 checklist stub below.
- [x] Push branch and open a PR titled `compliance phase 1: foundation + identification + IRS TEOS`.
- [x] PR description includes scope summary, deliverables, acceptance-gate output, manual-verification notes, and follow-ups for Phase 2.
- [x] **Stop.** Wait for review and merge.

---

## Phase 2 — Public-source discovery (CA + IRS BMF) — DETAILED PLAN READY

This is the implementation checklist for the next phase. No Phase 2 implementation
item is complete yet. The implementation agent must refresh official source terms
and URLs before coding because public portals change and source permissions control
the design.

### Phase 1 follow-ups to pick up

- [ ] Manual verification of `compliance-onboard`, `compliance-discover`, and the
      migration script against a real GCP project.
- [ ] Confirm the user's existing onboarded entity IDs and attributes can be read from
      Secret Manager and BigQuery before running any live discovery.
- [ ] Add shared download/cache support before adding IRS BMF or CA AG CSV downloads.
      Phase 1 downloads the full IRS Pub. 78 and Auto-Revocation files on every run;
      Phase 2 should stop repeating identical bulk downloads.
- [ ] Consume the existing `us-ca` keys in `EntityIdentifiers` rather than inventing a
      second California identifier shape.

### Pre-flight

- [x] Read `CLAUDE.md`, every file in `.claude/rules/`, `docs/compliance/PLAN.md`, and
      this file.
- [x] Confirm working directory is a fresh worktree on branch
      `compliance/phase-2-public-sources`.
- [x] Run `bun typecheck`, `bun lint`, and `bun test:run` once on a clean tree.
- [x] Inspect existing Phase 1 compliance code and tests before designing new types.
- [ ] Refresh current official URLs and source terms for:
  - [ ] CA SOS business records / bizfile
  - [ ] CA AG Registry of Charities and Fundraisers
  - [ ] CA FTB Entity Status Letter
  - [ ] IRS EO BMF and TEOS bulk downloads
- [ ] Record each source's `accessUrl`, `tosUrl`, `accessMethod`, and automation
      decision in the source definition.
- [ ] Create a short implementation note in the PR description explaining any source
      modeled as manual because automation is not allowed or not confidently permitted.

### Source metadata and policy (TDD)

- [x] Tests for source metadata schemas: URL fields, source freshness fields, access
      method, automation policy, and manual-only reason.
- [x] Implement metadata schemas with Zod validation for every source definition.
- [x] Tests that a source cannot be registered without `accessUrl`, `tosUrl`, and an
      explicit access policy.
- [ ] Tests that policy-blocked sources return a typed manual-required result rather
      than attempting network automation.
- [x] Implement typed source outcomes for success, source failure, manual required,
      policy blocked, and auth/MFA unexpectedly required.

### Download cache and evidence policy (TDD)

- [ ] Tests for cache key generation from source URL, request parameters, and entity
      identifier without leaking secrets.
- [ ] Tests for ETag / Last-Modified revalidation where upstream headers exist.
- [ ] Tests for hash verification, corrupt cache entries, and stale-cache failure.
- [ ] Tests for deterministic filesystem cache behavior in local/dev/test runs.
- [ ] Implement shared cache abstractions and a local adapter.
- [ ] Tests for bounded evidence payloads: max bytes, structured excerpts, source
      timestamps, content hashes, and no unbounded HTML/PDF/CSV payloads in BigQuery.
- [ ] Implement evidence helpers used by API, bulk-download, manual, and Playwright
      sources.

### Source runner extensions (TDD)

- [ ] Tests for `kind: 'api'` / bulk-download sources using the new cache and evidence
      helpers without regressing Phase 1 IRS TEOS behavior.
- [ ] Tests for `kind: 'manual'` sources that emit exact user instructions and typed
      evidence requirements.
- [ ] Tests for `kind: 'playwright'` dispatch with browser/page injected via context.
- [ ] Tests for read-only policy enforcement:
  - [ ] allowed navigation domains
  - [ ] allowed read-only search/query submissions
  - [ ] denied mutating submits, payments, uploads, order/certification actions, and
        account changes
  - [ ] explicit DOM/schema mismatch errors when expected selectors disappear
- [ ] Implement Playwright runner adapter and policy checks.
- [ ] Ensure no credentials, stored sessions, or MFA automation are introduced in Phase 2. If a public page unexpectedly requires login or MFA, return the typed blocked
      result.

### `us-ca` jurisdiction module (TDD)

- [ ] Tests for `us-ca` jurisdiction registration.
- [ ] Tests for California identifier schema:
  - [ ] SOS legacy corporation IDs
  - [ ] SOS LLC/LP numeric IDs
  - [ ] SOS new 12-character `B...` IDs
  - [ ] AG `CT...` charity registration numbers
  - [ ] older AG six-digit numbers with leading zeroes
  - [ ] optional FTB entity ID/name-search fields
- [ ] Implement `us-ca` module exports and register each source independently.
- [ ] Add fixture entities that include federal-only, CA-complete, and CA-missing-ID
      cases.

### CA SOS business records source (TDD)

- [ ] Refresh and document the current CA SOS access policy. Do not implement browser
      automation unless current terms and source review support it.
- [ ] Tests for the default manual-source path, including exact instructions for
      checking bizfile business status and recording structured evidence.
- [ ] If an authorized bulk/public-data path is available, tests for its parser and
      status mapping.
- [ ] Tests for CA SOS statuses that should produce findings: active, suspended,
      forfeited, dissolved, canceled, surrendered, and not found.
- [ ] Tests that the source preserves entity numbers exactly, including leading zeroes
      or the `B` prefix.
- [ ] Implement CA SOS as manual or authorized bulk/public-data source according to the
      refreshed policy decision.

### CA AG Registry source (TDD)

- [ ] Refresh and document the current CA AG Registry Search Tool / Online Filing
      Service transition state.
- [ ] Tests for downloading and parsing Registry Reports CSVs for:
  - [ ] may operate or solicit
  - [ ] may not operate or solicit
  - [ ] undetermined
  - [ ] not operating / dissolving
- [ ] Tests for Registry status normalization using the official filing-status
      definitions.
- [ ] Tests for AG annual renewal information statuses: accepted, e-accepted, in
      process, incomplete, not submitted, and rejected.
- [ ] Tests for incomplete report data where downloadable lists omit the entity but the
      search tool may still have current detail.
- [ ] Implement Registry Reports CSV source first.
- [ ] Implement search-tool supplementation only if the refreshed policy permits it and
      the CSV source leaves a real data gap. Otherwise emit manual-required evidence
      instructions for the search-tool detail page.

### CA FTB Entity Status Letter source (TDD)

- [ ] Refresh and document the current FTB Entity Status Letter access policy.
- [ ] Tests for supported entity-type lookup by FTB Entity ID and entity name.
- [ ] Tests for good standing, not in good standing, exempt-status verification, not
      found, ambiguous results, and unsupported entity type.
- [ ] Tests for the fact that FTB status does not represent SOS or AG standing.
- [ ] Implement read-only lookup via Playwright only if source policy supports it;
      otherwise implement manual-required source output with exact evidence fields.

### IRS EO BMF source (TDD)

- [ ] Refresh IRS EO BMF posting date and CSV layout before coding.
- [ ] Tests for selecting the correct state/region CSV for the entity.
- [ ] Tests for cached CSV download, content hash, posting date capture, and
      not-modified behavior.
- [ ] Tests for BMF CSV parsing with realistic rows, malformed rows, missing EIN,
      duplicate EIN, and unknown code values.
- [ ] Tests for mapping BMF subsection, foundation, affiliation, deductibility,
      activity, and status codes into typed source records without `any` or `as`.
- [ ] Implement IRS EO BMF lookup by EIN.
- [ ] Decide and implement whether BMF supplements or supersedes any Phase 1 TEOS raw
      fields in discovery reporting. Keep raw source records separate either way.

### Findings / gap engine (TDD)

- [ ] Create typed finding codes, severity levels, evidence schemas, and stable
      de-duplication keys.
- [ ] Tests for source-level findings:
  - [ ] source unreachable
  - [ ] source policy blocked / manual verification required
  - [ ] source stale
  - [ ] source schema changed
- [ ] Tests for federal findings:
  - [ ] Pub. 78 not found
  - [ ] auto-revocation present
  - [ ] BMF not found
  - [ ] BMF/TEOS mismatch
  - [ ] latest Form 990 missing or stale when the source has enough data to know
- [ ] Tests for CA findings:
  - [ ] SOS suspended, forfeited, dissolved, canceled, or not found
  - [ ] AG delinquent, suspended, revoked, cease-and-desist, or not registered
  - [ ] AG RRF-1 missing, incomplete, rejected, or late
  - [ ] FTB not in good standing or not found
- [ ] Tests for cross-source findings:
  - [ ] legal-name mismatch
  - [ ] mailing/principal-address mismatch
  - [ ] missing configured CA identifiers
  - [ ] conflicting good-standing signals
- [ ] Implement the engine so findings are derived from validated source records, not
      ad hoc string checks spread through individual sources.
- [ ] Move Phase 1 TEOS-derived findings into the engine if that keeps federal logic
      consistent. If not, document the reason in the PR.

### BigQuery persistence updates (TDD)

- [ ] Tests for storing new source-run statuses and evidence metadata in
      `discovery_runs`.
- [ ] Tests for writing typed findings with opened/resolved timestamps and stable
      de-duplication.
- [x] Tests for source registry snapshots that include source policy metadata.
- [x] Implement any idempotent migrations required by new fields. Do not weaken Phase
      1 schema tests.

### Skill changes (TDD)

- [ ] Tests for upgraded `compliance-discover` report ordering by severity, then
      jurisdiction, then source.
- [ ] Tests for `compliance-discover` showing live, cached, manual-required,
      policy-blocked, and failed source states distinctly.
- [ ] Tests that `compliance-discover` never reports an all-clear when a required
      source failed, was stale, or requires manual verification.
- [ ] Implement upgraded `compliance-discover` backing TypeScript and skill docs.
- [ ] Tests for `compliance-status` reading only stored BigQuery/Secret Manager state
      and making no network/source-run calls.
- [ ] Implement `compliance-status` backing TypeScript and skill docs.
- [ ] Update `.agents/skills/` and `.claude/skills/` placement according to the actual
      repo constraints discovered in Phase 1. If one side cannot be written, document
      the reason as Phase 1 did.

### Manual verification

- [ ] Confirm `.env` / `.env.local` provide the GCP project and credential settings
      needed for compliance commands.
- [ ] Run migrations in the user's real dev project and confirm idempotency.
- [ ] Read the user's onboarded nonprofit from Secret Manager and BigQuery.
- [ ] Run `compliance-discover` against the onboarded nonprofit.
- [ ] For each source, record whether the result came from live public data, cache,
      manual evidence, policy-blocked manual requirement, or source failure.
- [ ] Run `compliance-status` and verify it reads the stored discovery state without
      performing network discovery.
- [ ] Re-run discovery and confirm cache behavior is visible and correct.

### Acceptance gates

- [ ] `bun typecheck` — zero errors
- [ ] `bun lint` — zero errors, zero warnings
- [ ] `bun test:run` — all green
- [ ] `bun test:coverage` — 100% statements / branches / functions / lines on all new
      files
- [ ] No `any` types
- [ ] No `as` casts except the documented JSONB exception
- [ ] No inline ESLint suppression comments unless required by a framework and
      explained
- [ ] No skipped tests
- [ ] All external data Zod-validated
- [ ] All CLI parsing via `commander`
- [ ] Production errors via `Result` / `ResultAsync`
- [ ] `docs/compliance/CHECKLIST.md` updated with completed Phase 2 items and a Phase
      3 checklist stub or draft

### Phase exit

- [ ] Mark completed Phase 2 items in this file.
- [ ] Push branch and open a PR titled
      `compliance phase 2: public-source discovery`.
- [ ] PR description includes source-policy decisions, deliverables, acceptance-gate
      output, and manual-verification notes.
- [ ] Stop after PR creation and wait for review and merge.

---

## Phase 3 — Authenticated discovery

Stub. To be detailed when reached.

## Phase 4 — Planning + Calendar

Stub. To be detailed when reached.

## Phase 5 — Filing walkthroughs

Stub. To be detailed when reached.

## Phase 6 — Governance + records retention

Stub. To be detailed when reached.
