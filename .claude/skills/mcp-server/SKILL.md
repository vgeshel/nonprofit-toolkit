---
name: mcp-server
description: Create and deploy MCP servers with tools, prompts, and OAuth authentication. Use when building, deploying, or debugging an MCP server, adding OAuth to one, or connecting an MCP client (Claude.ai, Claude Code, ChatGPT) to a custom backend.
---

# MCP Server Creation and Deployment

Build production MCP servers that work with Claude.ai, Claude Code, ChatGPT, and any other MCP-capable client. This skill covers the full stack: tool registration, authentication (including OAuth proxy for public servers), deployment, and the non-obvious pitfalls that are easy to miss.

MCP is a young protocol and its spec has been evolving rapidly. Before writing any code, verify you're looking at the current version of the `@modelcontextprotocol/sdk` TypeScript package (search the web or read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/` directly) — the training data is almost certainly behind. The same goes for the client-side configuration format for Claude Code, Claude.ai, and similar tools.

## Step 1: Understand what you're building

Before touching code, get concrete answers from the user:

1. **What tools/prompts/resources should this server expose?** List them with inputs and outputs.
2. **Who are the clients?** This drives auth:
   - **You control the clients** (internal scripts, CI, your own code) → simple API key or pre-validated token
   - **Claude Code with a fixed token** (single developer, local dev) → bearer token env var
   - **Claude.ai, ChatGPT, Claude Code for multiple users** → full OAuth flow with Dynamic Client Registration
3. **Where will it run?** Cloud Run, Lambda, a VM, Cloudflare Workers, local only? This affects transport choice.
4. **What language/runtime?** TypeScript/Node.js/Bun is the best-supported (official SDK). Python has a SDK too. Others are uncommon.
5. **Does it need persistent state?** OAuth proxy does. Simple tool servers often don't.

Write down the answers. They drive every subsequent decision.

## Step 2: Choose the architecture

There are three common shapes. Pick one deliberately.

### Shape A: No auth (local/private)

For local dev or servers you run behind a trusted network. Just register tools and serve them. Fast to build, zero OAuth complexity. Do NOT deploy this to a public URL.

### Shape B: Resource server with pre-shared tokens

You validate incoming Bearer tokens against a simple secret or a token your identity provider issues. Good when:

- You have a fixed list of clients that can get tokens out-of-band
- You're comfortable telling users to paste a token into their MCP client config

Not good for Claude.ai or other public clients — they expect to register themselves via Dynamic Client Registration.

### Shape C: Full OAuth proxy (Authorization Server + upstream IdP)

Your MCP server acts as its own OAuth 2.1 Authorization Server from the client's perspective. It:

- Accepts Dynamic Client Registration from any MCP client (Claude.ai, ChatGPT, etc.)
- Redirects the user to an upstream identity provider (Google, GitHub, Okta, Auth0, your own) for the actual login
- Issues its own access and refresh tokens after upstream login succeeds
- Validates those tokens on incoming requests

This is what you need for any public MCP server that should work with Claude.ai. It's more work but the SDK provides most of the machinery. See `references/oauth-proxy.md` for the implementation walkthrough.

**The critical insight:** most identity providers (Google, GitHub, Auth0) don't support Dynamic Client Registration. MCP clients do. The proxy pattern bridges that gap — your server is a DCR-compliant AS on one side and a standard OAuth client on the other.

## Step 3: Pick the transport

The MCP SDK offers multiple server transports. The choice has big consequences.

### `StreamableHTTPServerTransport` — use with Express

- Works with Node.js/Bun via Express
- **The SDK's OAuth helpers (`mcpAuthRouter`, `requireBearerAuth`) are Express middleware** — they only work with this transport in a natural way
- If you're doing OAuth proxy (Shape C), you almost certainly want this
- Runs fine on Bun — Express works on Bun, you don't need Node.js

### `WebStandardStreamableHTTPServerTransport` — for Web Standard environments

- Works with Cloudflare Workers, Deno, Hono, and Bun's native `Bun.serve()`
- You'll need to implement OAuth yourself (or wire the SDK helpers manually) — no Express middleware
- Use when you specifically need edge runtimes or when auth is trivial

### `StdioServerTransport` — local only

- For MCP servers invoked as a subprocess (the original MCP pattern)
- No HTTP, no network, no auth. Client launches the server as a child process.
- Only relevant for Claude Code local configs with `command`/`args` — not for remote servers.

**Default recommendation:** if you're building a remote server with auth, use `StreamableHTTPServerTransport` with Express. Everything else is a special case.

## Step 4: Scaffold the server

Set up the project:

```bash
bun add @modelcontextprotocol/sdk zod
# For OAuth proxy / Express-based:
bun add express
# Use whatever logger/storage you prefer:
bun add pino
```

Create `src/main.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import { z } from 'zod'

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Session-aware transport pool. One transport per MCP session.
const transports = new Map<string, StreamableHTTPServerTransport>()

function createMcpInstance() {
  const mcp = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {} } },
  )

  mcp.registerTool(
    'my-tool',
    {
      title: 'My Tool',
      description:
        'Does a thing. The description is what the host LLM sees — write it for a reader who has never used this tool.',
      inputSchema: {
        arg: z.string().describe('What the argument is for'),
      },
    },
    async ({ arg }) => {
      // Your logic here.
      return { content: [{ type: 'text', text: `You said: ${arg}` }] }
    },
  )

  return mcp
}

// CRITICAL: express.json() must be mounted on /mcp, and you MUST pass req.body
// as the third argument to transport.handleRequest. The third arg is parsedBody,
// not an options object. This is non-obvious from the SDK docs.
app.all('/mcp', express.json(), async (req, res) => {
  const sessionId =
    typeof req.headers['mcp-session-id'] === 'string'
      ? req.headers['mcp-session-id']
      : undefined

  const existing = sessionId ? transports.get(sessionId) : undefined
  if (existing) {
    await existing.handleRequest(req, res, req.body)
    return
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport)
    },
    onsessionclosed: (id) => {
      transports.delete(id)
    },
  })
  const mcp = createMcpInstance()
  await mcp.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

app.listen(8080, () => console.log('MCP server listening on :8080'))
```

That's a working no-auth MCP server. Test it:

```bash
curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

You should get back a `text/event-stream` response with the server's capabilities.

## Step 5: Add authentication (if needed)

- **Shape A (no auth):** skip.
- **Shape B (pre-shared token):** read `references/simple-auth.md`.
- **Shape C (OAuth proxy):** read `references/oauth-proxy.md`. This is a dense topic — the reference walks through every piece and highlights the traps.

## Step 6: Write the tools properly

Tool handlers are the heart of the server. A few patterns that pay off:

### Dependency injection

Don't reach out to external state from inside the tool callback. Pass dependencies in:

```typescript
interface ToolDeps {
  config: Config
  logger: Logger
  db: DatabaseClient
}

export async function handleMyTool(args: { arg: string }, deps: ToolDeps) {
  // Pure function of (args, deps). Testable in isolation.
}
```

Then in `main.ts`:

```typescript
mcp.registerTool('my-tool', { ... }, async (args) => {
  const result = await handleMyTool(args, { config, logger, db })
  // Map result to MCP content
})
```

This lets you unit-test the tool handler without touching the MCP layer.

### Return errors via `isError`, not exceptions

The SDK will turn uncaught exceptions into generic errors that the host LLM sees as raw stack traces. Instead, catch known failure modes and return:

```typescript
return {
  content: [{ type: 'text', text: `Error: ${reason}` }],
  isError: true,
}
```

The host LLM sees this as a normal tool result with `isError: true` and can recover (e.g., ask the user for different input).

### Tool descriptions are LLM-facing

The `description` field is what the calling LLM reads when deciding whether to use the tool. Write it like a docstring for a stranger. Bad: `"Query tool"`. Good: `"Execute a read-only BigQuery SQL query against the donations table. Write SQL using the schema from the donations-schema prompt. Returns result rows or an error."` The more concrete, the better.

## Step 7: Test end-to-end

Before deploying, exercise the full MCP protocol:

```bash
# 1. Initialize — should return capabilities and set mcp-session-id header
curl -s -i -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# 2. Send initialized notification — no response expected
curl -s -X POST http://localhost:8080/mcp \
  -H "mcp-session-id: $SESSION_ID" \
  ... \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

# 3. List tools
curl -s ... -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 4. Call a tool
curl -s ... -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"my-tool","arguments":{"arg":"hello"}}}'
```

**If auth is OAuth proxy, write a script that injects a test installation directly into your storage** so you can skip the browser-based OAuth flow while iterating on `/mcp` bugs. This is by far the fastest feedback loop for debugging tool registration and transport issues. See `references/oauth-proxy.md` for how to do this.

## Step 8: Deploy

See `references/deployment.md` for the checklist. The short version:

1. Trust proxy headers if you're behind a load balancer (Cloud Run, ALB, Cloudflare, etc.). `app.set('trust proxy', 1)` for Express.
2. Set `BASE_URL` to the server's public HTTPS URL. If the URL isn't known at deploy time (Cloud Run auto-generates it), use a two-phase deploy: deploy with a placeholder, read back the actual URL, then update the env var.
3. Make sure the runtime has network access to both your storage backend and whatever upstream IdP you're proxying to.
4. `/health` must work without auth. Load balancers need it.
5. If you're using an OAuth upstream (Google, GitHub, etc.), add your server's callback URL to that provider's allowed redirect URIs. This usually has to be done manually — most providers don't expose this via API.

## Step 9: Wire up clients

After deploy, tell Claude (or whatever host) how to find the server. For Claude Code project config, create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://my-server.example.com/mcp"
    }
  }
}
```

This repo is public and forkable, so its `.mcp.json` never contains a deployment's real URL. The `donations` entry reads it from the environment — `"url": "${DONATIONS_MCP_URL:-https://donations-mcp.invalid/mcp}"` — and falls back to an unresolvable placeholder. To connect Claude Code to the deployed server, run this yourself (it writes to the user's untracked `~/.claude.json`, and a local-scope entry takes precedence over the project one):

```bash
claude mcp add --transport http --scope local donations "$SERVICE_URL/mcp"
```

Setting `DONATIONS_MCP_URL` in the shell that launches Claude Code works too. Never commit the real URL to `.mcp.json`.

For Claude.ai remote connectors, paste the URL in the UI. If OAuth is enabled, the client will discover the auth endpoints via `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` and walk the user through the flow.

**Exact config format changes across Claude Code versions.** If things don't show up, verify the current file location (project `.mcp.json`, user `~/.claude.json`, or settings.json) and key name (`type: "http"` vs `type: "url"` vs `type: "sse"`) by checking the current Claude Code docs, not your training data.

## The pitfalls reference

Before you commit, read `references/pitfalls.md`. It's a list of specific bugs that are easy to hit and hard to diagnose. Things like:

- The SDK's OAuth handlers silently swallow provider errors — you have to log around them or debug blind
- Provider methods must throw `InvalidTokenError` / `InvalidGrantError`, not plain `Error`, or clients see 500s
- `transport.handleRequest(req, res, req.body)` — the third arg is `parsedBody`, not options
- Don't delete pending authorizations in the OAuth callback — the SDK's `/token` handler needs them
- When Claude.ai registers itself, it omits `client_secret` (public client). Some storage backends reject `undefined` values.

These are all things you can only learn by debugging in production. The reference captures them so you don't have to.

## References

- `references/oauth-proxy.md` — Full walkthrough of the OAuth proxy pattern with the MCP SDK (`mcpAuthRouter`, `OAuthServerProvider`, storage interface)
- `references/simple-auth.md` — Bearer token validation for Shape B
- `references/storage.md` — Pluggable storage interface with examples for in-memory, Firestore, Redis, Postgres
- `references/deployment.md` — Deployment checklist for common platforms
- `references/pitfalls.md` — The non-obvious bugs. Read this before debugging.
