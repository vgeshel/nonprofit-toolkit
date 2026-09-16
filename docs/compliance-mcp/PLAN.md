# Compliance MCP Surface + Plugin Packaging — Plan

Branch: `feat/compliance-mcp-and-plugin`

Expose the compliance toolkit (`src/compliance/`) through the deployed remote MCP server (`apps/mcp/`) so claude.ai users and autonomous agents can call it with the same parity as the local skills. Additionally, package the project as a Claude Code marketplace with two plugins (`nonprofit-toolkit-core` and `nonprofit-toolkit-compliance`) so Claude Code users install everything in one shot.

Companion checklist: [`CHECKLIST.md`](./CHECKLIST.md).

Acceptance gates from `.claude/rules/*` apply: TDD, 100% coverage on new code, `bun typecheck`/`lint`/`test:run` all green, no `any`, no `as` (except documented JSONB), Zod on all external data, no `throw` in production code.

---

## Decisions captured from interview

| Choice                 | Decision                                                        | Notes                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer               | Full parity — claude.ai + autonomous agents                     | Same surface in both.                                                                                                                       |
| Streaming progress     | Out of scope                                                    | No Claude client surfaces `notifications/progress` reliably (verified 2026-05-20 via Anthropic docs + GitHub issues #31893, #51713, #4157). |
| Discover semantics     | Async with run-id polling                                       | Three tools: `start`, `status`, `result`. Job state persisted to BigQuery.                                                                  |
| Onboard surface        | Question-list resource + full-submit tool + partial-update tool | Matches existing `OnboardingAnswers` / `InterviewQuestion[]` split in `onboard.ts`.                                                         |
| User-assisted evidence | Instructions resource + submit tool                             | Resource generated from `SourceManualEvidenceField[]`.                                                                                      |
| Read-only resources    | Aggregated status + source registry                             | No separate findings/runs resources — status covers them.                                                                                   |
| Plugin scope           | Marketplace at repo root with two plugins                       | `nonprofit-toolkit-core` + `nonprofit-toolkit-compliance`. Both reference the same remote MCP server.                                       |
| Local skills           | Unchanged                                                       | Skills keep calling backends directly via wiring files. MCP is additive.                                                                    |
| Auth                   | Existing OAuth + `confirm: true` parameter on writes            | No new role/scope system.                                                                                                                   |

---

## MCP surface

All compliance handlers live under `apps/mcp/src/tools/compliance/`. Each handler calls the existing production wiring in `src/compliance/skills/*-wiring.ts` — no new business logic in the MCP layer.

### Tools

| Tool                         | Inputs                                                                             | Wires to                                                                | Mutates                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `compliance-status`          | none                                                                               | `getComplianceStatusProduction`                                         | no                                                                  |
| `compliance-onboard`         | `OnboardingAnswers` + `confirm: true`                                              | `runOnboardingProduction`                                               | yes (Secret Manager + BQ entity row)                                |
| `compliance-onboard-update`  | partial `OnboardingAnswers` + `confirm: true`                                      | new `runOnboardingUpdateProduction` (added to `src/compliance/skills/`) | yes (Secret Manager + BQ entity row, merge)                         |
| `compliance-discover-start`  | optional `sources?: string[]`, optional `jurisdictionId?: string`, `confirm: true` | new `startDiscoveryJobProduction` (job control, see below)              | yes (`discovery_jobs` row + downstream `discovery_runs`/`findings`) |
| `compliance-discover-status` | `jobId`                                                                            | reads `discovery_jobs` + `discovery_runs` counts                        | no                                                                  |
| `compliance-discover-result` | `jobId`                                                                            | reads `discovery_jobs` + `discovery_runs` + `findings` by `job_id`      | no                                                                  |
| `compliance-record-evidence` | `ComplianceEvidenceInput` + `confirm: true`                                        | `recordComplianceEvidenceProduction`                                    | yes (`discovery_runs` + `findings`)                                 |

### Resources

| URI                                                            | Source                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `compliance://status`                                          | Same data as `compliance-status` tool.                                                                  |
| `compliance://sources/registry`                                | `buildRegistry([usFederalJurisdiction, usCaJurisdiction])` projected to JSON.                           |
| `compliance://onboarding/interview-questions`                  | The `ONBOARD_INTERVIEW_QUESTIONS` array already exported from `onboard.ts`.                             |
| `compliance://sources/{sourceId}/manual-evidence-instructions` | ResourceTemplate. Per-source instructions generated from `SourceManualEvidenceField[]` in the registry. |

### Prompts

| Prompt                | Purpose                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compliance-overview` | Short prose explaining the available compliance tools, the recommended order of operations, and references to the resources. Mirrors the `donations-schema` prompt pattern. |

### Confirmation parameter

Every write tool declares an `inputSchema` field:

```ts
confirm: z.literal(true).describe(
  'Set to true to confirm this write. Reject any call lacking this field.',
)
```

Tools refuse without it. Read tools omit the field entirely.

---

## Async discover job model

### New BigQuery table: `discovery_jobs`

```
job_id            STRING NOT NULL
started_at        TIMESTAMP NOT NULL
finished_at       TIMESTAMP
status            STRING NOT NULL    -- 'running' | 'completed' | 'failed'
requested_sources ARRAY<STRING>      -- empty array = all sources
requested_jurisdiction STRING        -- null = all jurisdictions
error_type        STRING
error_message     STRING
```

### Additive change to `discovery_runs`

Add `job_id STRING NULLABLE`. Existing rows have null. New rows carry the parent job id so `discover-status` can count completed per-source rows and `discover-result` can fetch aggregate output for one job.

Both changes go through `ensureComplianceSchema` (idempotent migration), tested with the existing migration test pattern.

### Lifecycle (handler responsibilities)

1. **start** — validate inputs → INSERT `discovery_jobs` row (lifecycle in Firestore) with status `running` → trigger an out-of-band **Cloud Run Job** execution (`compliance-discover`, via the Cloud Run Admin `:run` REST endpoint) passing the `jobId` + filter as container env overrides → return `{ jobId }`. The launch resolves as soon as the execution is accepted; if it fails, the orphaned `running` row is best-effort marked `failed`. This runs the discovery in its own process so it survives the MCP service scaling to zero and the request timeout (the prior fire-and-forget-in-process approach could not).
2. **executor** — the Cloud Run Job entrypoint (`apps/mcp/src/compliance-discover-job.ts`) reads the env, runs `runDiscoveryAndPersist` via `executeDiscoveryJobProduction` using a `RunRecorder` wrapper that tags every `discovery_runs` row and finding with the `job_id`, then flips the `discovery_jobs` row to `completed` (with the assembled report) or `failed` (with error metadata) and exits.
3. **status** — read `discovery_jobs` row + count `discovery_runs` by `job_id` → return `{ status, startedAt, finishedAt?, completedSourceCount, requestedSources?, error? }`. The total source count is taken from the jurisdiction registry filtered by `requestedSources`/`requestedJurisdiction`.
4. **result** — read `discovery_jobs` row (must be `completed`) → read `discovery_runs` and `findings` by `job_id` → re-assemble a `DiscoveryReport`-shaped response (with the same per-source summary metadata).
5. **failure mode** — the executor catches all errors and writes them to `discovery_jobs.error_*` + flips status to `failed`. A Cloud Run Job execution has its own retry/timeout (`--max-retries 1 --task-timeout 3600s`) independent of the MCP request, so the orphaned-on-restart risk of the old in-process design no longer applies; a job that genuinely dies mid-run still gets a stale-detection rule in a later iteration.

### Filter parameter semantics

`sources` is an `Array<string>` of source ids. `jurisdictionId` is a single jurisdiction id. Either or both. The wiring builds a filtered registry and passes it to `runDiscoveryProduction`. Adds a new `runDiscoveryProductionFiltered` helper rather than rewriting the existing entry.

---

## Plugin packaging

### Marketplace

```
.claude-plugin/
  marketplace.json
```

Marketplace `name`: `nonprofit-toolkit`. Owner: `vgeshel/nonprofit-toolkit`. Two plugins listed.

### Plugin layout

```
plugins/
  nonprofit-toolkit-core/
    .claude-plugin/
      plugin.json
    .mcp.json
    skills/...           # core skills (donor-letter, donations-query, bootstrap, etc.)
    README.md
  nonprofit-toolkit-compliance/
    .claude-plugin/
      plugin.json
    .mcp.json
    skills/...           # compliance-onboard, compliance-status, compliance-discover
    README.md
```

### How skill files reach the plugin

The repo's `.claude/skills/` is what local users (devs in the repo) use. The plugins under `plugins/*/skills/` are what marketplace installers get. **Use symlinks** from `plugins/*/skills/<skill-name>` → `../../../.claude/skills/<skill-name>` so the two stay in sync. Git tracks symlinks. (Verified during scaffolding step; if symlinks bite the marketplace install for any reason, fall back to copies updated by a `bun scripts/sync-plugin-skills.ts`.)

### Skill assignments

- **core**: `donor-letter`, `donations-query`, `running-etl-locally`, `deploying-etl`, `bootstrap`, `create-connector`, `provision`, `agentic-analytics`, `slack-bot`, `mcp-server`.
- **compliance**: `compliance-onboard`, `compliance-status`, `compliance-discover`.
- **Excluded** (Claude-runtime concerns, not project workflow): `find-skills`, `keybindings-help`, `update-config`, `skill-creator`, `loop`, `schedule`, `verify`, `simplify`, `fewer-permission-prompts`, `tdd`, `search-for-documentation`, `init`, `review`, `security-review`, `claude-api`, `ai-sdk`, `run`, `setup`, `result`, `status`, `parallel-*`.

### `.mcp.json`

Both plugins ship the same content:

```json
{
  "mcpServers": {
    "nonprofit-toolkit": {
      "type": "http",
      "url": "https://your-mcp-server.example.com/mcp"
    }
  }
}
```

The URL is a placeholder that fork-ers edit when deploying their own MCP server. We will _also_ check during implementation whether Claude Code supports env var substitution in `.mcp.json` — if it does, we'll switch to `${DONATIONS_MCP_URL}` with a documented default. If not, the placeholder approach stands.

### Plugin manifest fields

Both plugins specify `name`, `version` (start at `0.1.0`), `displayName`, `description`, `repository`, `license` (MIT — match repo), `keywords`.

### Open question to resolve during implementation

Two plugins each declaring the same MCP server: does Claude Code dedupe by URL, or start two sessions? Verify with a real `/plugin install` of both into a clean Claude Code env. Fallbacks:

1. If dedupe works: ship as-is.
2. If both spin up: move `.mcp.json` to only `nonprofit-toolkit-core`; document core as a prerequisite for compliance; the compliance plugin becomes skills-only.

---

## File map (additions)

```
apps/mcp/src/tools/compliance/
  status.ts              # handleComplianceStatus
  onboard.ts             # handleComplianceOnboard, handleComplianceOnboardUpdate
  discover.ts            # handleComplianceDiscoverStart/Status/Result
  record-evidence.ts     # handleComplianceRecordEvidence
  resources.ts           # buildStatusResource, buildSourceRegistryResource,
                         # buildInterviewQuestionsResource, buildManualEvidenceInstructions
  prompt.ts              # buildComplianceOverviewPrompt
  index.ts               # registerComplianceSurface(mcp, deps)

apps/mcp/tests/compliance/
  status.test.ts
  onboard.test.ts
  discover.test.ts
  record-evidence.test.ts
  resources.test.ts
  prompt.test.ts

src/compliance/skills/
  onboard-update.ts          # runOnboardingUpdate (pure backend, partial merge)
  onboard-update-wiring.ts   # runOnboardingUpdateProduction
  discover-job.ts            # startDiscoveryJob / readDiscoveryJob / writeDiscoveryJob (pure)
  discover-job-wiring.ts     # production wiring of the above
src/compliance/state/
  bq-jobs.ts                 # createDiscoveryJobsAccessor (BQ adapter for discovery_jobs)

src/compliance/tests/
  onboard-update.test.ts
  discover-job.test.ts
  bq-jobs.test.ts

# schema changes go through existing migrate.ts / ensure-schema.ts

.claude-plugin/
  marketplace.json
plugins/
  nonprofit-toolkit-core/
    .claude-plugin/plugin.json
    .mcp.json
    skills/...                   # symlinks
    README.md
  nonprofit-toolkit-compliance/
    .claude-plugin/plugin.json
    .mcp.json
    skills/...                   # symlinks
    README.md

docs/compliance-mcp/
  PLAN.md         # this file
  CHECKLIST.md
```

---

## Tests strategy

- Mirror `apps/mcp/tests/query-bigquery.test.ts` shape — mock wiring functions via `vi.mock`, assert handler returns.
- Backend modules in `src/compliance/skills/onboard-update.ts` and `discover-job.ts` follow the existing port-shaped accessor pattern with in-memory fake accessors; same as `onboard.test.ts`, `status.test.ts`, `discover.test.ts`.
- Schema migration test exercises the additive change end-to-end against the mocked migration port.
- Plugin manifest test loads each `plugin.json` + `marketplace.json` and validates against the official JSON Schema (`https://json.schemastore.org/claude-code-plugin-manifest.json`). Cached locally to avoid network in CI.
- E2E session test boots the MCP server, opens a session, calls `compliance-status`, asserts the structured result. Mirrors what `apps/mcp/tests/storage.test.ts` and friends already cover for the existing tools.

100% line + branch coverage on every new file. Tests live next to existing test files (`apps/mcp/tests/`, `src/compliance/tests/`).

---

## Sequencing

1. **Branch + scaffold** (this commit) — write PLAN + CHECKLIST, create branch.
2. **Backend extensions** — `onboard-update.ts`, `discover-job.ts`, `bq-jobs.ts`, schema migration. TDD.
3. **MCP read surface** — `compliance-status` tool, `compliance://status` resource, `compliance://sources/registry` resource, `compliance://onboarding/interview-questions` resource. Smallest end-to-end loop validating the integration pattern.
4. **MCP write surface (onboarding)** — `compliance-onboard`, `compliance-onboard-update`. Both with `confirm: true`.
5. **MCP write surface (evidence)** — `compliance://sources/{sourceId}/manual-evidence-instructions` resource + `compliance-record-evidence` tool.
6. **MCP async discover surface** — `compliance-discover-start`, `-status`, `-result`.
7. **`compliance-overview` prompt** — short, links to all tools/resources.
8. **Plugin marketplace + two plugins** — manifests, `.mcp.json`, skill symlinks, README files, manifest-validation tests.
9. **Wire-up in `main.ts`** — register the compliance surface alongside the existing donations tools.
10. **Docs + final sanity** — update `docs/compliance/PLAN.md` cross-reference, run full `bun typecheck`/`lint`/`test:run`, smoke-test locally.

Each step ends with passing `bun typecheck && bun lint && bun test:run` and a `git commit`. No deploy in this branch — deploy happens in a follow-up after PR review per the project rule of "commit and push before any deploy."

---

## Out of scope (deferred)

- Refactoring local skills (`.claude/skills/compliance-*/SKILL.md`) to delegate through MCP. Decision: unchanged.
- A separate writer-role allowlist on top of OAuth. Decision: same auth + `confirm`.
- Streaming progress notifications. Blocked by Claude client behavior; revisit when SEP-1686 (Tasks) lands.
- Watchdog for orphaned `running` discovery jobs after Cloud Run container restart. Noted as a known operational gap; for now jobs may show stale `running` indefinitely.
- Cleanup of older non-compliance MCP code paths. Out of scope.
