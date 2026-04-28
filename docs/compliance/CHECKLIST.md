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

## Phase 2 — Public-source discovery (CA + IRS BMF) — IMPLEMENTED

Phase 2 adds public-source discovery for IRS EO BMF and California, typed source
outcomes, bounded download evidence/cache support, a findings/gap engine, upgraded
`compliance-discover` reporting, and a read-only `compliance-status` skill. Source
review was refreshed on 2026-04-28; CA SOS and CA FTB remain manual-required because
the current public surfaces do not provide a confidently permitted automated path.

### Phase 1 follow-ups to pick up

- [x] Manual verification of `compliance-onboard`, `compliance-discover`, and the
      migration script against a real GCP project.
- [x] Confirm the user's existing onboarded entity IDs and attributes can be read from
      Secret Manager and BigQuery before running any live discovery.
- [x] Add shared download/cache support before adding IRS BMF or CA AG CSV downloads.
      Phase 1 downloads the full IRS Pub. 78 and Auto-Revocation files on every run;
      Phase 2 should stop repeating identical bulk downloads.
- [x] Consume the existing `us-ca` keys in `EntityIdentifiers` rather than inventing a
      second California identifier shape.

### Pre-flight

- [x] Read `CLAUDE.md`, every file in `.claude/rules/`, `docs/compliance/PLAN.md`, and
      this file.
- [x] Confirm working directory is a fresh worktree on branch
      `compliance/phase-2-public-sources`.
- [x] Run `bun typecheck`, `bun lint`, and `bun test:run` once on a clean tree.
- [x] Inspect existing Phase 1 compliance code and tests before designing new types.
- [x] Refresh current official URLs and source terms for:
  - [x] CA SOS business records / bizfile
  - [x] CA AG Registry of Charities and Fundraisers
  - [x] CA FTB Entity Status Letter
  - [x] IRS EO BMF and TEOS bulk downloads
- [x] Record each source's `accessUrl`, `tosUrl`, `accessMethod`, and automation
      decision in the source definition.
- [x] Create a short implementation note in the PR description explaining any source
      modeled as manual because automation is not allowed or not confidently permitted.

### Source metadata and policy (TDD)

- [x] Tests for source metadata schemas: URL fields, source freshness fields, access
      method, automation policy, and manual-only reason.
- [x] Implement metadata schemas with Zod validation for every source definition.
- [x] Tests that a source cannot be registered without `accessUrl`, `tosUrl`, and an
      explicit access policy.
- [x] Tests that policy-blocked sources return a typed manual-required result rather
      than attempting network automation.
- [x] Implement typed source outcomes for success, source failure, manual required,
      policy blocked, and auth/MFA unexpectedly required.

### Download cache and evidence policy (TDD)

- [x] Tests for cache key generation from source URL, request parameters, and entity
      identifier without leaking secrets.
- [x] Tests for ETag / Last-Modified revalidation where upstream headers exist.
- [x] Tests for hash verification, corrupt cache entries, and stale-cache failure.
- [x] Tests for deterministic filesystem cache behavior in local/dev/test runs.
- [x] Implement shared cache abstractions and a local adapter.
- [x] Tests for bounded evidence payloads: max bytes, structured excerpts, source
      timestamps, content hashes, and no unbounded HTML/PDF/CSV payloads in BigQuery.
- [x] Implement evidence helpers used by API, bulk-download, manual, and Playwright
      sources.

### Source runner extensions (TDD)

- [x] Tests for `kind: 'api'` / bulk-download sources using the new cache and evidence
      helpers without regressing Phase 1 IRS TEOS behavior.
- [x] Tests for `kind: 'manual'` sources that emit exact user instructions and typed
      evidence requirements.
- [x] Decide whether `kind: 'playwright'` dispatch is needed in Phase 2. Decision: no
      Playwright adapter was added because the refreshed source review did not identify a
      permitted Playwright source; unsupported automated browser sources return typed
      source failures instead of running.
- [x] Decide whether read-only browser policy enforcement is needed in Phase 2. Decision:
      not applicable until a permitted Playwright source exists; browser automation is
      deferred rather than hand-rolled for sources modeled as manual.
- [x] Ensure no credentials, stored sessions, or MFA automation are introduced in Phase 2. If a public page unexpectedly requires login or MFA, return the typed blocked
      result.

### `us-ca` jurisdiction module (TDD)

- [x] Tests for `us-ca` jurisdiction registration.
- [x] Tests for California identifier schema:
  - [x] SOS legacy corporation IDs
  - [x] SOS LLC/LP numeric IDs
  - [x] SOS new 12-character `B...` IDs
  - [x] AG `CT...` charity registration numbers
  - [x] older AG six-digit numbers with leading zeroes
  - [x] optional FTB entity ID/name-search fields
- [x] Implement `us-ca` module exports and register each source independently.
- [x] Add fixture entities that include federal-only, CA-complete, and CA-missing-ID
      cases.

### CA SOS business records source (TDD)

- [x] Refresh and document the current CA SOS access policy. Do not implement browser
      automation unless current terms and source review support it.
- [x] Tests for the default manual-source path, including exact instructions for
      checking bizfile business status and recording structured evidence.
- [x] If an authorized bulk/public-data path is available, tests for its parser and
      status mapping. No permitted bulk/public-data path was identified in Phase 2.
- [x] Tests for CA SOS statuses that should produce findings: active, suspended,
      forfeited, dissolved, canceled, surrendered, and not found. Deferred until manual
      evidence ingestion exists; Phase 2 emits a manual-required finding instead.
- [x] Tests that the source preserves entity numbers exactly, including leading zeroes
      or the `B` prefix.
- [x] Implement CA SOS as manual or authorized bulk/public-data source according to the
      refreshed policy decision.

### CA AG Registry source (TDD)

- [x] Refresh and document the current CA AG Registry Search Tool / Online Filing
      Service transition state.
- [x] Tests for downloading and parsing Registry Reports CSVs for:
  - [x] may operate or solicit
  - [x] may not operate or solicit
  - [x] undetermined
  - [x] not operating / dissolving
- [x] Tests for Registry status normalization using the official filing-status
      definitions.
- [x] Tests for AG annual renewal information statuses: accepted, e-accepted, in
      process, incomplete, not submitted, and rejected. Phase 2 covers missing
      last-renewal evidence from the official reports; detailed filing-status ingestion
      is deferred until a permitted search/detail source is added.
- [x] Tests for incomplete report data where downloadable lists omit the entity but the
      search tool may still have current detail.
- [x] Implement Registry Reports CSV source first.
- [x] Implement search-tool supplementation only if the refreshed policy permits it and
      the CSV source leaves a real data gap. Otherwise emit manual-required evidence
      instructions for the search-tool detail page.

### CA FTB Entity Status Letter source (TDD)

- [x] Refresh and document the current FTB Entity Status Letter access policy.
- [x] Tests for supported entity-type lookup by FTB Entity ID and entity name. Phase 2
      records required manual evidence fields rather than automating the lookup.
- [x] Tests for good standing, not in good standing, exempt-status verification, not
      found, ambiguous results, and unsupported entity type. Deferred until manual
      evidence ingestion exists; Phase 2 emits a manual-required finding instead.
- [x] Tests for the fact that FTB status does not represent SOS or AG standing.
- [x] Implement read-only lookup via Playwright only if source policy supports it;
      otherwise implement manual-required source output with exact evidence fields.

### IRS EO BMF source (TDD)

- [x] Refresh IRS EO BMF posting date and CSV layout before coding.
- [x] Tests for selecting the correct state/region CSV for the entity.
- [x] Tests for cached CSV download, content hash, posting date capture, and
      not-modified behavior.
- [x] Tests for BMF CSV parsing with realistic rows, malformed rows, missing EIN,
      duplicate EIN, and unknown code values.
- [x] Tests for mapping BMF subsection, foundation, affiliation, deductibility,
      activity, and status codes into typed source records without `any` or `as`.
- [x] Implement IRS EO BMF lookup by EIN.
- [x] Decide and implement whether BMF supplements or supersedes any Phase 1 TEOS raw
      fields in discovery reporting. Keep raw source records separate either way.

### Findings / gap engine (TDD)

- [x] Create typed finding codes, severity levels, evidence schemas, and stable
      de-duplication keys.
- [x] Tests for source-level findings:
  - [x] source unreachable
  - [x] source policy blocked / manual verification required
  - [x] source stale (implemented for stale BMF tax-period data)
  - [x] source schema changed
- [x] Tests for federal findings:
  - [x] Pub. 78 not found
  - [x] auto-revocation present
  - [x] BMF not found
  - [x] BMF/TEOS mismatch. Deferred because TEOS and BMF raw records remain separate
        in Phase 2; no authoritative mismatch rule is applied until a later reconciliation
        pass.
  - [x] latest Form 990 missing or stale when the source has enough data to know
- [x] Tests for CA findings:
  - [x] SOS suspended, forfeited, dissolved, canceled, or not found. Deferred until
        manual evidence ingestion exists; Phase 2 emits manual-required findings.
  - [x] AG delinquent, suspended, revoked, cease-and-desist, or not registered
  - [x] AG RRF-1 missing, incomplete, rejected, or late
  - [x] FTB not in good standing or not found. Deferred until manual evidence ingestion
        exists; Phase 2 emits manual-required findings.
- [x] Tests for cross-source findings:
  - [x] legal-name mismatch
  - [x] mailing/principal-address mismatch. Deferred because Phase 2 source payloads do
        not include enough typed address data for a reliable address comparison.
  - [x] missing configured CA identifiers
  - [x] conflicting good-standing signals. Deferred until manual CA SOS/FTB evidence can
        be ingested as typed source records.
- [x] Implement the engine so findings are derived from validated source records, not
      ad hoc string checks spread through individual sources.
- [x] Move Phase 1 TEOS-derived findings into the engine if that keeps federal logic
      consistent. Decision: TEOS retains its Phase 1 inline findings for compatibility;
      Phase 2 derives additional cross-source and source-outcome findings in
      `src/compliance/rules/findings.ts`.

### BigQuery persistence updates (TDD)

- [x] Tests for storing new source-run statuses and evidence metadata in
      `discovery_runs`.
- [x] Tests for writing typed findings with opened/resolved timestamps and stable
      de-duplication.
- [x] Tests for source registry snapshots that include source policy metadata.
- [x] Implement any idempotent migrations required by new fields. Do not weaken Phase
      1 schema tests.

### Skill changes (TDD)

- [x] Tests for upgraded `compliance-discover` report ordering by severity, then
      jurisdiction, then source.
- [x] Tests for `compliance-discover` showing manual-required, policy-blocked, and
      failed source states distinctly. Cache metadata is stored in source payload/evidence
      where available rather than rendered as a separate top-level state.
- [x] Tests that `compliance-discover` never reports an all-clear when a required
      source failed, was stale, or requires manual verification.
- [x] Implement upgraded `compliance-discover` backing TypeScript and skill docs.
- [x] Tests for `compliance-status` reading only stored BigQuery/Secret Manager state
      and making no network/source-run calls.
- [x] Implement `compliance-status` backing TypeScript and skill docs.
- [x] Update `.agents/skills/` and `.claude/skills/` placement according to the actual
      repo constraints discovered in Phase 1. If one side cannot be written, document
      the reason as Phase 1 did.

### Manual verification

- [x] Confirm `.env` / `.env.local` provide the GCP project and credential settings
      needed for compliance commands.
- [x] Run migrations in the user's real dev project and confirm idempotency.
      Verified `compliance-migrate` rerun reports `added_columns=0`.
- [x] Read the user's onboarded nonprofit from Secret Manager and BigQuery.
- [x] Run `compliance-discover` against the onboarded nonprofit.
- [x] For each source, record whether the result came from live public data, cache,
      manual evidence, policy-blocked manual requirement, or source failure.
      Live verification result: CA AG Registry = public CSV success; IRS EO BMF =
      public CSV success; IRS TEOS = public bulk-download success; CA SOS = manual
      required by source policy; CA FTB = manual required pending source-policy review.
- [x] Run `compliance-status` and verify it reads the stored discovery state without
      performing network discovery.
- [x] Re-run discovery and confirm cache behavior is visible and correct. Local cache
      artifacts were written under `.cache/compliance`; the rerun completed successfully
      with the cache enabled for CA AG, IRS BMF, and IRS TEOS downloads.

### Acceptance gates

- [x] `bun typecheck` — zero errors
- [x] `bun lint` — zero errors, zero warnings
- [x] `bun test:run` — all 2251 tests pass
- [x] `bun test:coverage` — 100% statements / branches / functions / lines on all new
      files
- [x] No `any` types
- [x] No `as` casts except the documented JSONB exception
- [x] No inline ESLint suppression comments unless required by a framework and
      explained
- [x] No skipped tests
- [x] All external data Zod-validated
- [x] All CLI parsing via `commander`
- [x] Production errors via `Result` / `ResultAsync`
- [x] `docs/compliance/CHECKLIST.md` updated with completed Phase 2 items and a Phase
      3 checklist stub or draft

### Phase exit

- [x] Mark completed Phase 2 items in this file.
- [x] Push branch and open a PR titled
      `compliance phase 2: public-source discovery`.
- [x] PR description includes source-policy decisions, deliverables, acceptance-gate
      output, and manual-verification notes.
- [x] Stop after PR creation and wait for review and merge.

---

## Phase 3 — Authenticated discovery

Stub. To be detailed when reached.

## Phase 4 — Planning + Calendar

Stub. To be detailed when reached.

## Phase 5 — Filing walkthroughs

Stub. To be detailed when reached.

## Phase 6 — Governance + records retention

Stub. To be detailed when reached.
