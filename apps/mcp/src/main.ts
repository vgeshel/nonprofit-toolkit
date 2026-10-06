#!/usr/bin/env bun
/**
 * MCP server for donations ETL.
 *
 * Exposes donation querying and letter generation as MCP tools
 * over Streamable HTTP transport, authenticated via Google OAuth
 * with Workspace domain restriction.
 *
 * Uses Express for compatibility with the MCP SDK's auth router.
 */
import { closeBrowser, launchBrowser } from '@donations-etl/letter'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import { z } from 'zod'
import { tokenAuditLogger } from './auth/audit-log'
import { GoogleOAuthProvider } from './auth/provider'
import { FirestoreOAuthStorage } from './auth/storage'
import { loadConfig } from './config'
import { createLogger } from './logger'
import { registerComplianceSurface } from './tools/compliance/index'
import { buildDonationsPrompt } from './tools/donations-prompt'
import { handleGenerateLetter } from './tools/generate-letter'
import { handleQueryBigQuery } from './tools/query-bigquery'

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch (error) {
    console.error(
      'Configuration Error:',
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  }

  const logger = createLogger(config)

  // Launch browser for PDF generation (non-fatal)
  const browserResult = await launchBrowser()
  if (browserResult.isErr()) {
    logger.warn(
      { error: browserResult.error },
      'Browser not available — PDF letter generation will be disabled',
    )
  } else {
    logger.info('Browser launched for PDF generation')
  }

  // Set up OAuth storage and provider
  const storage = new FirestoreOAuthStorage(config.PROJECT_ID)
  const oauthProvider = new GoogleOAuthProvider({
    googleClientId: config.GOOGLE_CLIENT_ID,
    googleClientSecret: config.GOOGLE_CLIENT_SECRET,
    allowedDomain: config.MCP_ALLOWED_DOMAIN,
    baseUrl: config.BASE_URL,
    storage,
    logger,
  })

  const baseUrl = new URL(config.BASE_URL)

  // The MCP transport runs in stateless mode (sessionIdGenerator: undefined)
  // because Cloud Run scales to zero. Stateful mode kept session state in an
  // in-memory map keyed by session id, which was lost on every cold start —
  // every subsequent request from a still-connected Claude.ai client got 400
  // (session not found). Stateless: each request creates a fresh transport +
  // McpServer, handles the message, and the GC takes care of the rest. We do
  // not use server-initiated notifications, so the loss of session-scoped
  // state has no functional impact.

  /**
   * Create and configure a new MCP server instance.
   */
  function createMcpServerInstance(): McpServer {
    const mcp = new McpServer(
      { name: 'nonprofit-toolkit', version: '1.0.0' },
      {
        capabilities: { tools: {}, prompts: {}, resources: {} },
      },
    )

    // Prompt: schema and SQL rules for the host LLM
    mcp.registerPrompt(
      'donations-schema',
      {
        title: 'Donations Schema',
        description:
          'BigQuery table schema and SQL rules for querying donation data. Use this context when writing SQL for the query-bigquery tool.',
      },
      () => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: buildDonationsPrompt(config),
            },
          },
        ],
      }),
    )

    // Tool: execute read-only SQL against BigQuery
    mcp.registerTool(
      'query-bigquery',
      {
        title: 'Query BigQuery',
        description:
          'Execute a read-only BigQuery SQL query against the donations table. Write SQL using the schema from the donations-schema prompt. Returns result rows or an error.',
        inputSchema: {
          sql: z.string().describe('BigQuery SQL SELECT query to execute'),
        },
      },
      async ({ sql }) => {
        const result = await handleQueryBigQuery({ sql }, { config, logger })

        if (result.isErr()) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error.message}` }],
            isError: true,
          }
        }

        const { rows, totalRows } = result.value
        const text =
          rows.length === 0
            ? 'Query returned no results.'
            : `${totalRows} row(s) returned${totalRows > 50 ? ' (showing first 50)' : ''}:\n\n${JSON.stringify(rows, null, 2)}`

        return { content: [{ type: 'text', text }] }
      },
    )

    // Tool: generate donor confirmation letter
    mcp.registerTool(
      'generate-letter',
      {
        title: 'Generate Donor Letter',
        description:
          'Generate a donor confirmation letter (PDF or HTML) for one or more email addresses. Returns the letter content.',
        inputSchema: {
          emails: z
            .array(z.string().email())
            .min(1)
            .describe('Donor email addresses'),
          from: z
            .string()
            .optional()
            .describe('Start date filter (ISO format, e.g. 2025-01-01)'),
          to: z
            .string()
            .optional()
            .describe('End date filter (ISO format, e.g. 2025-12-31)'),
          format: z
            .enum(['pdf', 'html'])
            .optional()
            .describe('Output format (default: pdf)'),
          signerName: z.string().optional().describe('Letter signer name'),
          signerTitle: z.string().optional().describe('Letter signer title'),
        },
      },
      async ({ emails, from, to, format, signerName, signerTitle }) => {
        const result = await handleGenerateLetter(
          { emails, from, to, format, signerName, signerTitle },
          { config, logger },
        )

        if (result.isErr()) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error.message}` }],
            isError: true,
          }
        }

        const { value } = result

        if (value.format === 'html') {
          return {
            content: [
              {
                type: 'text',
                text: `Generated HTML letter for ${value.donorName}`,
              },
              {
                type: 'resource',
                resource: {
                  uri: `data:text/html;base64,${Buffer.from(value.content).toString('base64')}`,
                  mimeType: 'text/html',
                  text: value.content,
                },
              },
            ],
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `Generated PDF letter for ${value.donorName}`,
            },
            {
              type: 'resource',
              resource: {
                uri: `data:application/pdf;base64,${value.content}`,
                mimeType: 'application/pdf',
                blob: value.content,
              },
            },
          ],
        }
      },
    )

    // Compliance surface — tools, resources, and the overview prompt.
    // See `docs/compliance-mcp/PLAN.md` for the full design.
    registerComplianceSurface(mcp, {
      config,
      logger,
      firestore: storage.client,
    })

    return mcp
  }

  // ── Express app ────────────────────────────────────────────────

  const app = express()

  // Cloud Run terminates TLS and forwards via a proxy; trust one hop
  // so express-rate-limit and req.ip work correctly
  app.set('trust proxy', 1)

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // Diagnostic audit logging for /token requests. Mounted BEFORE the
  // SDK auth router so we capture the request shape (redacted) even
  // when the SDK rejects it in middleware (e.g. invalid client_secret).
  // The SDK's tokenHandler runs urlencoded() itself; running it here
  // first is idempotent — once req.body is set, the second parser
  // no-ops. This is how we see what claude.ai actually sent when a
  // refresh fails.
  app.use(
    '/token',
    express.urlencoded({ extended: false }),
    tokenAuditLogger(logger),
  )

  // Mount OAuth auth router (DCR, authorize, token, metadata)
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: baseUrl,
      resourceServerUrl: baseUrl,
      resourceName: 'Donations ETL MCP Server',
    }),
  )

  // Google OAuth callback
  app.get('/oauth/google/callback', async (req, res) => {
    try {
      const code = req.query.code
      const state = req.query.state

      if (typeof code !== 'string' || typeof state !== 'string') {
        res.status(400).send('Missing code or state parameter')
        return
      }

      const { redirectUrl } = await oauthProvider.handleGoogleCallback(
        code,
        state,
      )
      res.redirect(redirectUrl)
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed')
      res
        .status(403)
        .send(err instanceof Error ? err.message : 'Authentication failed')
    }
  })

  // Bearer auth middleware for MCP endpoints
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(baseUrl),
  })

  // MCP Streamable HTTP endpoint. Stateless: each request gets a fresh
  // transport + McpServer; nothing is tracked between requests. Body is
  // parsed by express.json() so we can pass it as parsedBody to the
  // transport (the SDK supports either the raw stream or a pre-parsed body).
  app.all('/mcp', bearerAuth, express.json(), async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    const mcp = createMcpServerInstance()
    await mcp.connect(transport)
    try {
      await transport.handleRequest(req, res, req.body)
    } finally {
      await transport.close()
    }
  })

  // Error handler — log unhandled errors with full stack
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error(
        { err: { message: err.message, stack: err.stack } },
        'Unhandled error',
      )
      if (!res.headersSent) {
        res.status(500).json({
          error: 'server_error',
          error_description: err.message,
        })
      }
    },
  )

  // Start server
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, baseUrl: config.BASE_URL },
      'MCP server started',
    )
  })

  // Graceful shutdown. Stateless transport means there are no per-session
  // resources to drain — just stop accepting new requests and tear down
  // the browser.
  const shutdown = async () => {
    logger.info('Shutting down...')
    server.close()
    await closeBrowser()
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}

main().catch((error) => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
