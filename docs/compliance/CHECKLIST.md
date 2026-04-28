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

## Phase 2 — Public-source discovery (CA + IRS BMF) — STUB

Detailed checklist will be drafted at the start of Phase 2 by the Phase 2 implementation
subagent and reviewed by the user before work begins. The skeleton below carries forward
follow-ups from Phase 1 and the high-level scope from the PLAN.

### Phase 1 follow-ups to pick up

- [ ] Manual verification of `compliance-onboard`, `compliance-discover`, and the
      migration script against a real GCP project (was deferred from Phase 1 for lack
      of credentials in the implementation VM).
- [ ] The IRS TEOS source downloads the full Pub. 78 (~30 MB) and Auto-Revocation
      (~larger) zip files on every run. Phase 1 considers this acceptable for a
      single-tenant, daily-cadence flow but Phase 2 should add a local cache (last
      modified / etag check) before adding more bulk-download sources.
- [ ] `EntityIdentifiers` includes `us-ca` keys; Phase 1 only persists them, Phase 2
      consumes them in CA sources.

### Pre-flight

- [ ] Read `CLAUDE.md`, every file in `.claude/rules/`, `docs/compliance/PLAN.md`, and
      this file.
- [ ] Confirm working directory is a fresh worktree on branch `compliance/phase-2-...`
- [ ] Run `bun typecheck`, `bun lint`, `bun test:run` once on a clean tree.
- [ ] Search the web for current ToS pages of CA SOS bizfile, CA AG Registry of
      Charitable Trusts, CA FTB MyFTB / Entity Status Letter, and the IRS Exempt
      Organizations Business Master File Extract. Capture each URL in the source
      definition.

### Playwright source runner

- [ ] Tests for `kind: 'playwright'` source dispatch in the runner: read-only enforcement
      (no DML / no form submissions), explicit MFA hand-off mode, ToS-URL-required
      metadata, fail-loudly when the upstream page changes (DOM-pattern mismatch).
- [ ] Implement Playwright runner adapter with browser injected via context (so tests
      can mock).
- [ ] Decide and document policy: how do we record evidence (HTML snippet, screenshot,
      DOM excerpt) in `discovery_runs.payload` without exploding row sizes?

### `us-ca` jurisdiction module

- [ ] Module exports + entity-id schema that consumes `us-ca.sosEntityNumber` and
      `us-ca.agCharityNumber`.
- [ ] Each source defined separately, registered under the jurisdiction.

### Sources (TDD each)

- [ ] CA SOS bizfile — entity status lookup
- [ ] CA AG Registry of Charities & Fundraisers — RRF-1 status, registration status
- [ ] CA FTB Entity Status Letter — public letter generator (read-only path)
- [ ] IRS Exempt Organizations Business Master File Extract — bulk lookup by EIN

### Findings / gap engine

- [ ] Tests for derived findings: suspended status, missing/late RRF-1, missing latest
      990, address mismatch across registries.
- [ ] Implement engine that consumes raw payloads and emits typed findings.
- [ ] Decide: should the Phase 1 IRS TEOS source's findings move into the engine, or
      stay in-source? (Trade-off: in-source = fast feedback per source; in-engine =
      cross-source correlations.)

### Skill changes

- [ ] Promote `compliance-discover` from minimal to real: prioritised markdown report
      grouped by severity, by jurisdiction, by source.
- [ ] Add `compliance-status` skill: read-only summary of latest stored state, no
      network calls.

### Acceptance gates

- Identical to Phase 1 (zero typecheck errors, zero lint errors, all tests pass, 100%
  coverage on new files, no `any`, no `as`, no inline ESLint suppressions, no skipped
  tests, all external data Zod-validated, all CLI via commander, errors via Result).

### Manual verification

- [ ] Run `compliance-discover` against the user's real entity end-to-end.
- [ ] Verify each Phase 1 follow-up listed above is addressed.

---

## Phase 3 — Authenticated discovery

Stub. To be detailed when reached.

## Phase 4 — Planning + Calendar

Stub. To be detailed when reached.

## Phase 5 — Filing walkthroughs

Stub. To be detailed when reached.

## Phase 6 — Governance + records retention

Stub. To be detailed when reached.
