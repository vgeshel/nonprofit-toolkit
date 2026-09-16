#!/usr/bin/env bun
/**
 * Smoke-test the deployed compliance MCP surface end-to-end.
 *
 * What this does:
 *   1. Mints a synthetic MCP access token directly via the production
 *      Firestore OAuth storage (writes a McpInstallation row).
 *   2. Calls the deployed MCP HTTP endpoint with that token to:
 *      a. initialize
 *      b. tools/list (confirm compliance tools are advertised)
 *      c. tools/call compliance-status
 *      d. resources/read compliance://status
 *   3. Asserts the responses parse, the overall flag is one of the
 *      expected values, and the entity is correct.
 *   4. Cleans up the installation.
 *
 * Bypasses Google OAuth so the test doesn't need a browser redirect.
 * The same SA-backed Secret Manager + BigQuery calls run under the
 * hood, so an IAM regression on either backend would surface here.
 *
 * Run with: bun scripts/smoke-test-compliance-mcp.ts \
 *   --base-url https://mcp-server-u5atmmvqqq-uc.a.run.app \
 *   --project leleka-data-373104 \
 *   --user-email vadim@leleka.care
 */
import { Command } from 'commander'
import { z } from 'zod'
import {
  FirestoreOAuthStorage,
  generateToken,
  tokenFingerprint,
} from '../apps/mcp/src/auth/storage.ts'

const OptionsSchema = z.object({
  baseUrl: z.string().url(),
  projectId: z.string().min(1),
  userEmail: z.string().email(),
})
type Options = z.infer<typeof OptionsSchema>

const RawOptsSchema = z.object({
  baseUrl: z.string(),
  project: z.string(),
  userEmail: z.string(),
})

function parseOpts(argv: readonly string[]): Options {
  const program = new Command()
    .option('--base-url <url>', 'Cloud Run service URL (no trailing slash)')
    .option('--project <id>', 'GCP project id for Firestore')
    .option(
      '--user-email <email>',
      'Email to embed in the synthetic installation',
    )
    .allowExcessArguments(false)
  program.parse([...argv], { from: 'user' })
  const opts = RawOptsSchema.parse(program.opts())
  return OptionsSchema.parse({
    baseUrl: opts.baseUrl,
    projectId: opts.project,
    userEmail: opts.userEmail,
  })
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result?: unknown
  readonly error?: { code: number; message: string; data?: unknown }
}

/**
 * Issue one JSON-RPC over Streamable HTTP. The MCP SDK accepts
 * `application/json` (single response) when no SSE is needed.
 */
async function rpc(
  baseUrl: string,
  accessToken: string,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Streamable HTTP REQUIRES this dual-accept header.
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify(request),
  })
  const ct = r.headers.get('content-type') ?? ''
  if (!r.ok) {
    const body = await r.text()
    throw new Error(
      `HTTP ${String(r.status)} from /mcp for ${request.method}: ${body}`,
    )
  }
  const RpcResponseSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.number(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  let raw: unknown
  if (ct.includes('text/event-stream')) {
    const text = await r.text()
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
    if (dataLine === undefined) {
      throw new Error(
        `SSE response for ${request.method} contained no data event:\n${text}`,
      )
    }
    raw = JSON.parse(dataLine.slice('data: '.length))
  } else {
    raw = await r.json()
  }
  return RpcResponseSchema.parse(raw)
}

function ok(label: string, message: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}: ${message}`)
}

function fail(label: string, message: string): never {
  console.error(`  \x1b[31m✗\x1b[0m ${label}: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const opts = parseOpts(process.argv.slice(2))
  const domain = opts.userEmail.split('@')[1] ?? ''
  if (domain === '') {
    fail('arg', 'userEmail must contain a domain part')
  }

  const storage = new FirestoreOAuthStorage(opts.projectId)
  const accessToken = generateToken()
  const refreshToken = generateToken()
  const fingerprint = tokenFingerprint(accessToken)

  console.log(`\x1b[36m▶\x1b[0m Provisioning synthetic installation`)
  console.log(`    fingerprint: ${fingerprint}`)
  console.log(`    user:        ${opts.userEmail}`)
  console.log(`    project:     ${opts.projectId}`)
  console.log(`    baseUrl:     ${opts.baseUrl}`)

  await storage.saveInstallation({
    accessToken,
    refreshToken,
    clientId: 'smoke-test-client',
    userId: 'smoke-test-user',
    userEmail: opts.userEmail,
    userDomain: domain,
    issuedAt: Date.now(),
    // 1 hour TTL; clean up at end either way.
    expiresAt: Date.now() + 60 * 60 * 1000,
  })

  let exitCode = 0
  try {
    console.log(`\n\x1b[36m▶\x1b[0m initialize`)
    const init = await rpc(opts.baseUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' },
      },
    })
    if (init.error !== undefined) {
      fail('initialize', JSON.stringify(init.error))
    }
    const initResult = z
      .object({
        serverInfo: z.object({ name: z.string() }),
        capabilities: z.unknown(),
      })
      .parse(init.result)
    ok('initialize', `serverInfo.name=${initResult.serverInfo.name}`)

    console.log(`\n\x1b[36m▶\x1b[0m tools/list`)
    const toolsRpc = await rpc(opts.baseUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    if (toolsRpc.error !== undefined) {
      fail('tools/list', JSON.stringify(toolsRpc.error))
    }
    const toolsResult = z
      .object({
        tools: z.array(z.object({ name: z.string() })),
      })
      .parse(toolsRpc.result)
    const toolNames = toolsResult.tools.map((t) => t.name).sort()
    const expectedTools = [
      'compliance-status',
      'compliance-onboard',
      'compliance-onboard-update',
      'compliance-discover-start',
      'compliance-discover-status',
      'compliance-discover-result',
      'compliance-record-evidence',
    ]
    const missing = expectedTools.filter((t) => !toolNames.includes(t))
    if (missing.length > 0) {
      fail('tools/list', `missing tools: ${missing.join(', ')}`)
    }
    ok('tools/list', `${String(toolNames.length)} tools advertised`)

    console.log(`\n\x1b[36m▶\x1b[0m tools/call compliance-status`)
    const statusRpc = await rpc(opts.baseUrl, accessToken, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'compliance-status', arguments: {} },
    })
    if (statusRpc.error !== undefined) {
      fail('compliance-status', JSON.stringify(statusRpc.error))
    }
    const statusResult = z
      .object({
        isError: z.boolean().optional(),
        content: z.array(
          z.object({
            type: z.literal('text'),
            text: z.string(),
          }),
        ),
      })
      .parse(statusRpc.result)
    if (statusResult.isError === true) {
      fail(
        'compliance-status',
        `tool returned isError=true:\n${statusResult.content[0]?.text ?? '(no text)'}`,
      )
    }
    // The tool now returns ONLY the server-rendered Markdown report
    // (the structured JSON lives on the compliance://status resource,
    // verified below). Assert the Markdown is well-formed rather than
    // JSON.parse-ing it.
    const statusMarkdown = statusResult.content[0]?.text ?? ''
    if (!statusMarkdown.startsWith('# Compliance Status:')) {
      fail(
        'compliance-status',
        `expected Markdown report starting with "# Compliance Status:", got:\n${statusMarkdown.slice(0, 200)}`,
      )
    }
    ok(
      'compliance-status',
      `Markdown report (${String(statusMarkdown.length)} chars)`,
    )

    console.log(`\n\x1b[36m▶\x1b[0m resources/read compliance://status`)
    const resourceRpc = await rpc(opts.baseUrl, accessToken, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'compliance://status' },
    })
    if (resourceRpc.error !== undefined) {
      fail('compliance://status', JSON.stringify(resourceRpc.error))
    }
    const resourceResult = z
      .object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string(),
          }),
        ),
      })
      .parse(resourceRpc.result)
    // Full structured validation happens here against the JSON the
    // resource returns.
    const resourceBody = z
      .object({
        overall: z.enum(['clear', 'attention_required', 'unknown']),
        now: z.string().min(1),
        entity: z.object({ legal_name: z.string() }).loose(),
        identifiers: z.record(z.string(), z.unknown()),
        sources: z
          .array(
            z.object({
              sourceId: z.string(),
              agency: z.string(),
              accessUrl: z.string().url(),
              tosUrl: z.string().url(),
              automationAllowed: z.boolean(),
              auth: z
                .object({
                  loginUrl: z.string().url(),
                  instructions: z.array(z.string()).min(1),
                })
                .loose()
                .optional(),
            }),
          )
          .min(1),
      })
      .parse(JSON.parse(resourceResult.contents[0]?.text ?? '{}'))
    // Verify the enrichment landed: every source has a URL, at least
    // one source carries auth metadata, and `now` is the current ISO.
    const nowParsed = new Date(resourceBody.now)
    const drift = Math.abs(nowParsed.getTime() - Date.now())
    if (drift > 60_000) {
      fail(
        'compliance://status',
        `now drift ${String(drift)}ms — server clock skew?`,
      )
    }
    const withAuth = resourceBody.sources.filter((s) => s.auth !== undefined)
    if (withAuth.length === 0) {
      fail(
        'compliance://status',
        'expected at least one source to carry auth metadata',
      )
    }
    // Cross-check: the tool's Markdown report names the same entity the
    // resource reports structurally.
    if (!statusMarkdown.includes(resourceBody.entity.legal_name)) {
      fail(
        'compliance-status',
        `Markdown report does not mention entity "${resourceBody.entity.legal_name}"`,
      )
    }
    ok(
      'compliance://status',
      `overall=${resourceBody.overall}, entity=${resourceBody.entity.legal_name}, sources=${String(resourceBody.sources.length)}, withAuth=${String(withAuth.length)}, now-drift=${String(drift)}ms, uri=${resourceResult.contents[0]?.uri ?? ''}`,
    )

    console.log(`\n\x1b[32m✓ all checks passed\x1b[0m`)
  } catch (err) {
    console.error(`\n\x1b[31m✗ smoke test failed\x1b[0m`)
    console.error(err instanceof Error ? err.message : String(err))
    exitCode = 1
  } finally {
    await storage.deleteInstallation(accessToken)
    console.log(`\n\x1b[36m▶\x1b[0m Cleaned up installation (${fingerprint})`)
  }
  process.exit(exitCode)
}

await main()
