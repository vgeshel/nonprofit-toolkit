# Compliance Toolkit — Implementation Checklist

This is the working checklist used by the implementation subagent for each phase. The companion design document is `docs/compliance/PLAN.md`. Read both before starting any work.

> **Cross-phase rule.** Every phase obeys the rules in `PLAN.md` § Cross-phase rules. They are not optional. Acceptance gates fail closed: if anything is red, the phase is not done.

---

## Phase 1 — Foundation + Identification + IRS TEOS

### Pre-flight (must complete before writing any code)

- [ ] Read `CLAUDE.md` (root)
- [ ] Read every file in `.claude/rules/`
- [ ] Read `docs/compliance/PLAN.md` end-to-end
- [ ] Confirm working directory is a git worktree on branch `compliance/phase-1-foundation`
- [ ] Skim existing `src/` for established conventions: how secrets are accessed today, how the BigQuery client is constructed, how skills are wired
- [ ] Run `bun typecheck`, `bun lint`, `bun test:run` once on a clean tree to confirm the baseline is green
- [ ] Search the web for current IRS Tax Exempt Organization Search API documentation. **Do not rely on training data.**

### BigQuery schema (TDD)

- [ ] Write tests for Zod schemas describing each row type: `entity`, `discovery_runs`, `findings`, `sources`. Tests cover valid rows, missing required fields, extra fields, type coercion expectations.
- [ ] Implement Zod schemas. Infer TS types from them.
- [ ] Write tests for the dataset/table migration script (mocked BQ client): creates dataset, creates each table with correct schema, is idempotent on re-run.
- [ ] Implement migration script (commander-based CLI, parses options, validates with Zod).

### Jurisdiction abstraction (TDD)

- [ ] Write tests for the `Jurisdiction`, `Source`, `DeadlineRule`, `Finding`, `Entity` types and the jurisdiction registry: register, lookup by id, list, duplicate-id error.
- [ ] Implement types and registry.
- [ ] Write tests for the source runner (`api` kind only): success path, source returns error, source throws, schema-validation failure, run metadata recorded.
- [ ] Implement the source runner. It returns `ResultAsync` and records every run to `discovery_runs`.

### IRS TEOS source (TDD)

- [ ] Write Zod schemas for the IRS TEOS response shape (based on web-checked current docs).
- [ ] Write tests for the IRS TEOS source with mocked HTTP responses: found, not-found, malformed payload, network error, rate-limit response.
- [ ] Implement the source. All HTTP responses parsed through Zod before use.
- [ ] Register the source under the `us-federal` jurisdiction module.

### Identification storage (TDD)

- [ ] Write tests for the entity-IDs Secret Manager accessor (mocked GCP client): read, write, secret-not-found, permission-denied. All payloads round-trip through a Zod schema.
- [ ] Implement the accessor.
- [ ] Write tests for the entity BigQuery row accessor: read (no row → undefined), upsert, validation failure on bad input.
- [ ] Implement the accessor.

### Skills (TDD where applicable)

- [ ] Implement `.claude/skills/compliance-onboard/SKILL.md` plus any backing TS. Interview flow: legal name, EIN, state of incorporation, CA SOS entity number, CA AG charity number (optional in Phase 1), fiscal year end, mailing address. Persists IDs to Secret Manager and attributes to BQ. Confirms back to user.
- [ ] Implement `.claude/skills/compliance-discover/SKILL.md` plus any backing TS. Phase-1 scope: runs only the IRS TEOS source for the current entity, writes a `discovery_runs` row and any `findings`, prints a brief summary to the conversation.
- [ ] Tests for any TS code backing the skills. Skill markdown itself is reviewed manually but does not require unit tests.

### Acceptance gates — all must pass; do not proceed if any is red

- [ ] `bun typecheck` — zero errors
- [ ] `bun lint` — zero errors, zero warnings
- [ ] `bun test:run` — all pass
- [ ] `bun test:coverage` — **100%** on every new file. Do not lower thresholds. Do not add coverage-ignore pragmas.
- [ ] No `any` types introduced anywhere
- [ ] No `as` casts introduced (documented JSONB exception only)
- [ ] No inline ESLint suppression comments introduced to silence findings
- [ ] No skipped/`.skip`'d/`.todo`'d tests
- [ ] All external data parsed through Zod
- [ ] All CLI parsing uses `commander`
- [ ] Production errors return `Result`/`ResultAsync`, not throws

### Manual verification

- [ ] Run `compliance-onboard` end-to-end against a fake entity in a dev project. Confirm secret and BQ row land correctly. Inspect both.
- [ ] Run `compliance-discover` against a real EIN provided by the user. Confirm the IRS TEOS payload is captured in `discovery_runs` and that any derivable `findings` are written.
- [ ] Re-run the migration script. Confirm it is a no-op the second time.

### Phase exit

- [ ] Mark this phase complete in this file.
- [ ] Draft (or stub) the Phase 2 checklist below, in the same shape as Phase 1.
- [ ] Push branch and open a PR titled `compliance phase 1: foundation + identification + IRS TEOS`.
- [ ] PR description includes: scope summary, list of deliverables, acceptance-gate output, manual-verification notes, and any open questions or follow-ups for Phase 2.
- [ ] **Stop.** Do not start Phase 2. Wait for the user to review and merge.

---

## Phase 2 — Public-source discovery (CA + IRS BMF)

Stub. Detailed checklist drafted at phase start, in the same shape as Phase 1, by the Phase 2 implementation subagent and reviewed by the user before work begins. Expected high-level items:

- Pre-flight identical to Phase 1 plus reading any Phase 1 follow-ups
- Playwright source runner with read-only constraints, MFA hand-off, ToS-metadata enforcement, explicit failure modes
- `us-ca` jurisdiction module
- Sources: CA SOS bizfile, CA AG Registry, CA FTB Entity Status Letter, IRS BMF bulk lookup
- Findings/gap engine
- Promote `compliance-discover` to real (multi-source report)
- New `compliance-status` skill
- Acceptance gates as Phase 1
- Manual verification against the user's real entity

---

## Phase 3 — Authenticated discovery

Stub. To be detailed when reached.

## Phase 4 — Planning + Calendar

Stub. To be detailed when reached.

## Phase 5 — Filing walkthroughs

Stub. To be detailed when reached.

## Phase 6 — Governance + records retention

Stub. To be detailed when reached.
