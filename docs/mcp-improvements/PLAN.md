# MCP Server Improvements — Plan

Branch: `mcp/improvements-disconnects-and-compliance-distribution`

**Stabilize the deployed MCP server** so adding it as a Claude.ai/Cowork connector doesn't lead to frequent disconnects. **Effectively shipped 2026-05-20 — observing in production.**

Acceptance gates from `.claude/rules/*` apply throughout: TDD, 100% coverage on new code, `bun typecheck`/`lint`/`test:run` all green, no `any`, no `as` (except documented JSONB), Zod on all external data.

---

## Status

| Item                                                                 | State                                 | Where                                  |
| -------------------------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| Diagnostic logging on the OAuth flow                                 | **Shipped**                           | commit `66dd3c6`, revision `00022-6mm` |
| Access-token TTL 1h → 7d                                             | **Shipped**                           | commit `b244572`, revision `00023-b7z` |
| Draft PR opened                                                      | **Open**                              | #18                                    |
| Cloud Run session affinity                                           | **Deferred** — not needed in practice | —                                      |
| `no-cpu-throttling`                                                  | **Deferred** — not needed in practice | —                                      |
| Stateless `StreamableHTTPServerTransport`                            | **Deferred** — not needed in practice | —                                      |
| Resource-metadata 404 on `/.well-known/oauth-protected-resource/mcp` | **Open, low priority**                | —                                      |

## What I originally hypothesized

The deployed Cloud Run service `mcp-server` keeps an in-memory `Map<sessionId, transport>` (`apps/mcp/src/main.ts:68`), has no Cloud Run session-affinity annotation, and CPU is throttled between requests. The initial reading of the logs interpreted repeated `MCP session started` events as the wrong-instance bug — sessions lost when Cloud Run round-robins between instances. That story was wrong for the actual symptom the user described (overnight connector "disabled").

## What we actually found, after shipping diagnostic logging

Today's logs (2026-05-20) showed:

- **The refresh flow works correctly.** A token issued the previous day refreshed cleanly: every `exchangeRefreshToken:*` log line fired in order — `start` → `refresh mapping found` → `installation found` → `success`. No 400s.
- **Claude.ai does not auto-refresh on background 401s.** Two separate 401 bursts on `/mcp` (12:14 and 14:57) saw no follow-up `/token` request. Claude.ai kept hammering `/mcp` with the expired access token, getting 401s, never attempting a refresh.
- **The refresh only happens when the user opens the Connections page.** At 16:49 the user opened Connections; claude.ai immediately sent a `/token` request; refresh succeeded; tools resumed. No re-auth, no Google sign-in, just a successful token rotation.

The earlier 400 bursts (05-14, 05-18 04:06) seen in the older logs were probably a separate, transient cause — possibly DCR client expiry on the claude.ai side, or local state churn. They have not recurred since the instrumentation went in.

## Actual root cause

**Short access-token TTL × claude.ai's 401 polling behavior.** With `TOKEN_LIFETIME_S = 3600` (1h), the access token expires every hour during normal idle. Claude.ai's background `/mcp` polls hit 401, and after enough of them claude.ai's UI flags the connector as broken — without ever attempting the refresh that would fix it. The "broken" state is only cleared by a user-initiated Connections-page visit.

This is the dominant disconnect signal. Session routing and CPU throttling may still matter in edge cases (SSE streams in particular), but they're not what was making the connector look broken overnight.

## What shipped

1. **Diagnostic logging** (commit `66dd3c6`)
   - New `tokenFingerprint(token)` helper (first 12 hex of SHA256, matches Firestore doc-id prefix for cross-reference).
   - `apps/mcp/src/auth/provider.ts`: structured logs at every decision point in `exchangeRefreshToken`, `exchangeAuthorizationCode`, `verifyAccessToken`, `revokeToken`.
   - `apps/mcp/src/auth/audit-log.ts` (new): `tokenAuditLogger` middleware mounted before `mcpAuthRouter` for `/token`. Captures the redacted request shape on entry and the response status on finish — catches errors the SDK swallows in `authenticateClient` before our provider sees them.

2. **Access-token TTL 1h → 7d** (commit `b244572`)
   - `TOKEN_LIFETIME_S = 7 * 24 * 60 * 60`.
   - Comment in the code documents the claude.ai behavior + the security tradeoff (single-tenant server, scope of leaked-token impact bounded by `MCP_ALLOWED_DOMAIN`).
   - Refresh tokens still rotate on every use; effective leak window is `min(7d, next-refresh)`.

3. **No behavior change to the transport, session map, or Cloud Run config.** The session-affinity / no-cpu-throttling / stateless-transport changes from the original plan are not needed if the 7-day TTL kills the disconnect signal in practice.

## What's still open (low priority)

- **Resource-metadata 404** on `GET /.well-known/oauth-protected-resource/mcp` — some clients probe a path-suffixed metadata URL per RFC 9728. The SDK only serves the canonical path. Investigate whether claude.ai uses the suffixed URL and whether the 404 has any user-visible effect. Probably harmless. Easy fix if needed: route the suffix to the canonical handler.

## Verification

- ✅ Unit tests for new logging + new TTL constant. `bun test:coverage` 100% on all changed files. 2447 tests pass.
- ⏳ **Production observation.** Watch the deployed mcp-server over the next 1–2 weeks. Success criterion: no spontaneous "connector disabled" reports from teammates, no daily 400-burst pattern in `/token` logs.
- 🔍 **If a disconnect does recur**, the diagnostic logging will show exactly which path failed (audit-only / `refresh mapping not found` / `installation not found` / `verifyAccessToken: token expired`). The fix then follows from the signal.

## Out of scope

- Migrating session state to Firestore. Not needed for our tool surface (no notifications, no resource subscriptions, no progress streams).
- Switching to stateless `StreamableHTTPServerTransport`. Was on the original plan as a belt-and-suspenders; deferred unless production observation shows it's needed.
- Cloud Run session affinity. Same rationale — only worth doing if production observation surfaces a residual problem.
- Changing the OAuth flow itself or rotating to Firestore-TTL'd documents.

## Promotion gate

Promote PR #18 out of draft once production observation passes (no spontaneous disconnects for 1–2 weeks).
