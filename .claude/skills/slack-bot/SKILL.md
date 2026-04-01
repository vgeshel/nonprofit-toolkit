---
name: slack-bot
description: Build Slack bots with Bolt for JavaScript on Bun. Use this skill whenever the user wants to add a Slack command, event handler, assistant, modal, interactive component, or any Slack integration. Also triggers on "add a slash command", "Slack notification", "Slack bot", "app_mention", "Assistant API", "Slack event", "weekly digest", "scheduled message", or "reaction handler". Covers both real-time handlers (commands, events, modals) and scheduled/proactive messages.
---

# Building Slack Bots with Bolt

This skill guides you through building Slack bot features using the Bolt framework on Bun.

## Architecture: Two Apps, Two Purposes

This project has two apps that interact with Slack. Choosing the right one is critical:

|                  | `apps/service/`                                                                  | `apps/runner/`                                                |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **What it is**   | Long-running HTTP server (Cloud Run Service)                                     | One-shot CLI (Cloud Run Job)                                  |
| **Use for**      | Real-time Slack interactions: commands, events, modals, Assistant API, @mentions | Scheduled/proactive messages: reports, digests, notifications |
| **Triggered by** | Slack sending HTTP requests                                                      | Cloud Scheduler on a cron                                     |
| **Pattern**      | Event handler calls `ack()`, does work, posts response                           | CLI command runs, queries data, posts to Slack, exits         |
| **Examples**     | `/donor-letter`, `app_mention`, `reaction_added`, Assistant DMs                  | Weekly reports, monthly reports, new-donor digests            |

**Rule of thumb**: If the feature responds to a user action in Slack, it goes in `apps/service/`.
If it runs on a schedule and posts proactively, it goes in `apps/runner/` with a Cloud Scheduler
job (see `apps/runner/src/report.ts` and `infra/provision.sh` for the pattern).

## Real-Time Handlers (apps/service/)

### Request Routing

```
Bun.serve() → routes requests:
  /slack/commands      → Bolt receiver → command handlers
  /slack/interactivity → Bolt receiver → modal/action handlers
  /slack/events        → Bolt receiver → event handlers (app_mention, reaction_added, assistant)
  /api/*               → REST handlers
  /health              → health check
```

See `apps/service/src/main.ts` for the server setup and `apps/service/src/slack/receiver.ts`
for the custom BunReceiver.

### Async Ack Pattern

Slack requires a 200 response within 3 seconds. For handlers that do slow work (AI, database),
the BunReceiver returns the HTTP response as soon as `ack()` is called, while the handler
continues in the background. See `receiver.ts` for the `Promise.race()` pattern.

Always drop Slack retries at the entry point to prevent duplicate processing:

```typescript
if (request.headers.get('x-slack-retry-num')) {
  return new Response('', { status: 200 })
}
```

### Slash Commands

For commands that show status/info to the requesting user, use `respond()` for an ephemeral
message (only visible to that user) rather than `say()` which posts to the whole channel.

See `apps/service/src/slack/commands/donor-letter.ts` for the command handler pattern.

### Event Handlers

Register with `app.event('event_name', handler)`. Common events:

- `app_mention` — user @mentions the bot in a channel
- `reaction_added` — user adds an emoji reaction
- `message.im` — DM to the bot

All events come through `/slack/events`. The url_verification challenge must be handled
before forwarding to Bolt (see `main.ts`).

### Assistant API (DM Side-Panel)

For AI assistant conversations in DMs, use Slack's `Assistant` class:

```typescript
const assistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts, setTitle }) => { ... },
  userMessage: async ({ message, say, setStatus, client }) => { ... },
})
app.assistant(assistant)
```

The Assistant API is DM-only. For channel visibility, also register an `app_mention` handler.
See `apps/service/src/slack/app.ts` for both patterns side by side.

### Conversation History in Threads

For follow-up questions, fetch thread history and pass as multi-turn context:

```typescript
const thread = await client.conversations.replies({
  channel,
  ts: threadTs,
  limit: 20,
})
// Filter: skip current message, skip bot infrastructure messages (e.g. SQL replies)
// Map: bot_id present → assistant role, otherwise → user role
```

The thread is the conversation store — no server-side state needed.

## Scheduled/Proactive Messages (apps/runner/)

For messages that post on a schedule (not in response to a user action):

1. Add a CLI command to `apps/runner/src/cli.ts` (e.g., `weekly-digest`)
2. Implement the logic in `apps/runner/src/` — query data, format, post via `WebClient`
3. Add a Cloud Scheduler job in `infra/provision.sh` with container arg overrides
4. The runner already has `SLACK_BOT_TOKEN` and `REPORT_SLACK_CHANNEL` configured

See `apps/runner/src/report.ts` and `apps/runner/src/report-formatter.ts` for a complete
reference. The Cloud Scheduler pattern in `provision.sh` uses container overrides to pass
different CLI args to the same Cloud Run Job.

Do NOT use `setInterval` or in-process schedulers in the service — it doesn't persist across
cold starts and duplicates across instances.

## Slack App Configuration

Required scopes depend on features used:

| Feature        | Scopes                               |
| -------------- | ------------------------------------ |
| Slash commands | `commands`                           |
| Post messages  | `chat:write`                         |
| DMs            | `im:write`, `im:history`             |
| File uploads   | `files:write`                        |
| @mentions      | `app_mentions:read`                  |
| Thread history | `channels:history`, `groups:history` |
| Reactions      | `reactions:read`, `reactions:write`  |
| Assistant API  | `assistant:write`, `im:history`      |

Event Subscriptions (set Request URL to `https://<service>/slack/events`):

- `app_mention` — for channel @mentions
- `reaction_added` — for emoji reaction handlers
- `assistant_thread_started`, `assistant_thread_context_changed`, `message.im` — for Assistant API

## url_verification Challenge

When enabling Event Subscriptions, Slack sends a verification challenge. Handle it before
forwarding to Bolt:

```typescript
if (url.pathname === '/slack/events') {
  const ChallengeSchema = z.object({
    type: z.literal('url_verification'),
    challenge: z.string(),
  })
  // Try parsing; if it matches, respond with the challenge
  // If not, fall through to Bolt
}
```

## File References

| File                                  | Purpose                                          |
| ------------------------------------- | ------------------------------------------------ |
| `apps/service/src/slack/app.ts`       | App setup, Assistant + @mention + event handlers |
| `apps/service/src/slack/receiver.ts`  | Custom BunReceiver with async ack                |
| `apps/service/src/main.ts`            | HTTP server, retry filter, url_verification      |
| `apps/service/src/slack/commands/`    | Slash command handlers                           |
| `apps/service/src/slack/views/`       | Modal handlers                                   |
| `apps/service/src/slack/formatters/`  | Message formatting utilities                     |
| `apps/service/src/config.ts`          | Config with Slack env vars                       |
| `apps/runner/src/report.ts`           | Scheduled report pattern (proactive messages)    |
| `apps/runner/src/report-formatter.ts` | Block Kit formatting for reports                 |
| `infra/provision.sh`                  | Cloud Scheduler jobs for proactive messages      |

## Common Gotchas

1. **Duplicate messages**: Slack retries if no 200 within 3s. Filter `x-slack-retry-num` header.
2. **Cold start retries**: Cloud Run cold starts delay the first ack. The retry filter is essential.
3. **Assistant API is DM-only**: Cannot be used in channels. Use @mention for shared visibility.
4. **Thread history scopes**: `channels:history` for public channels, `groups:history` for private channels. Both are needed to read thread replies.
5. **Bun receiver, not Bolt server**: Bolt's built-in server doesn't run — Bun.serve() handles HTTP.
6. **Scheduled messages go in the runner**: Not the service. Use Cloud Scheduler, not `setInterval`.
7. **Ephemeral vs public**: Use `respond()` for status/info commands visible only to the requester.
