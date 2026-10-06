/**
 * Smoke test for a deployed compliance MCP surface.
 *
 * Mints a short-lived MCP installation directly in OAuth storage (bypassing
 * the Google OAuth redirect), then calls the deployed `/mcp` endpoint to:
 *   1. initialize
 *   2. tools/list — every compliance tool is advertised
 *   3. tools/call compliance-status — returns the Markdown report
 *   4. resources/read compliance://status — returns the structured status
 * and always deletes the installation afterwards.
 *
 * `scripts/smoke-test-compliance-mcp.ts` wires this to Firestore and the
 * global `fetch`.
 */
import { Command, CommanderError } from 'commander'
import { Result, ResultAsync, err, ok } from 'neverthrow'
import { z } from 'zod'
import type { McpInstallation } from '../apps/mcp/src/auth/storage.ts'

export interface SmokeTestError {
  readonly step: string
  readonly message: string
}

export interface SmokeTestOptions {
  readonly baseUrl: string
  readonly projectId: string
  readonly userEmail: string
  readonly userDomain: string
}

export const EXPECTED_TOOLS = [
  'compliance-status',
  'compliance-onboard',
  'compliance-onboard-update',
  'compliance-discover-start',
  'compliance-discover-status',
  'compliance-discover-result',
  'compliance-record-evidence',
] as const

const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_CLOCK_DRIFT_MS = 60_000
const INSTALLATION_TTL_MS = 60 * 60 * 1000

const ArgsSchema = z.object({
  baseUrl: z.url(),
  project: z.string().min(1),
  userEmail: z.email(),
})

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const silent = (): void => undefined

/**
 * Parse CLI arguments. `--help` comes back as an error carrying the usage.
 */
export function parseArgs(
  argv: readonly string[],
): Result<SmokeTestOptions, SmokeTestError> {
  const program = new Command()
    .name('smoke-test-compliance-mcp')
    .requiredOption('--base-url <url>', 'MCP service URL (no trailing slash)')
    .requiredOption('--project <id>', 'GCP project ID that holds Firestore')
    .requiredOption(
      '--user-email <email>',
      'Email to record on the synthetic installation',
    )
    .exitOverride()
    .configureOutput({ writeErr: silent, writeOut: silent })

  return Result.fromThrowable(
    (): unknown => program.parse([...argv], { from: 'user' }).opts(),
    (error): SmokeTestError => ({
      step: 'args',
      message:
        error instanceof CommanderError &&
        error.code === 'commander.helpDisplayed'
          ? program.helpInformation()
          : describeError(error),
    }),
  )()
    .andThen((opts) => {
      const parsed = ArgsSchema.safeParse(opts)
      return parsed.success
        ? ok(parsed.data)
        : err<z.infer<typeof ArgsSchema>, SmokeTestError>({
            step: 'args',
            message: parsed.error.message,
          })
    })
    .map((args) => ({
      baseUrl: args.baseUrl.replace(/\/+$/, ''),
      projectId: args.project,
      userEmail: args.userEmail,
      userDomain: args.userEmail.slice(args.userEmail.indexOf('@') + 1),
    }))
}

const JsonRpcResponseSchema = z.object({
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

export interface JsonRpcRequest {
  readonly id: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: string
  },
) => Promise<HttpResponseLike>

function parseJson(text: string): Result<unknown, string> {
  return Result.fromThrowable(
    (): unknown => JSON.parse(text),
    (error) => `invalid JSON: ${describeError(error)}`,
  )()
}

/**
 * Pull the JSON-RPC payload out of a Streamable HTTP response body, which is
 * either plain JSON or an SSE stream whose first `data:` line carries it.
 */
export function extractRpcPayload(
  contentType: string,
  body: string,
): Result<unknown, string> {
  if (!contentType.includes('text/event-stream')) {
    return parseJson(body)
  }
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '))
  return dataLine === undefined
    ? err('SSE response contained no data event')
    : parseJson(dataLine.slice('data: '.length))
}

/**
 * Issue one JSON-RPC request and return its `result`, failing on transport,
 * parse, or JSON-RPC errors.
 */
export function callRpc(
  fetchFn: FetchLike,
  baseUrl: string,
  accessToken: string,
  request: JsonRpcRequest,
): ResultAsync<unknown, SmokeTestError> {
  const step = request.method
  const fail = (message: string): SmokeTestError => ({ step, message })
  return ResultAsync.fromPromise(
    fetchFn(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...request }),
    }).then(async (response) => ({ response, body: await response.text() })),
    (error) => fail(describeError(error)),
  ).andThen(({ response, body }) => {
    if (!response.ok) {
      return err(fail(`HTTP ${String(response.status)}: ${body}`))
    }
    return extractRpcPayload(response.headers.get('content-type') ?? '', body)
      .mapErr(fail)
      .andThen((payload) => {
        const parsed = JsonRpcResponseSchema.safeParse(payload)
        if (!parsed.success) {
          return err(fail(`not a JSON-RPC response: ${parsed.error.message}`))
        }
        return parsed.data.error === undefined
          ? ok(parsed.data.result)
          : err(fail(JSON.stringify(parsed.data.error)))
      })
  })
}

function parseWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
  step: string,
): Result<T, SmokeTestError> {
  const parsed = schema.safeParse(value)
  return parsed.success
    ? ok(parsed.data)
    : err({ step, message: `unexpected response: ${parsed.error.message}` })
}

const InitializeResultSchema = z.object({
  serverInfo: z.object({ name: z.string() }),
})

const ToolsListResultSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
})

const ToolCallResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
})

const ResourceContentSchema = z.object({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string(),
})

const ResourceReadResultSchema = z.object({
  contents: z.tuple([ResourceContentSchema], ResourceContentSchema),
})

const StatusResourceSchema = z.object({
  overall: z.enum(['clear', 'attention_required', 'unknown']),
  now: z.string().min(1),
  entity: z.looseObject({ legal_name: z.string() }),
  identifiers: z.record(z.string(), z.unknown()),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        agency: z.string(),
        accessUrl: z.url(),
        tosUrl: z.url(),
        automationAllowed: z.boolean(),
        auth: z
          .looseObject({
            loginUrl: z.url(),
            instructions: z.array(z.string()).min(1),
          })
          .optional(),
      }),
    )
    .min(1),
})

export interface SmokeCheckDeps {
  readonly fetch: FetchLike
  readonly now: () => number
}

/**
 * Run the four MCP checks. Returns one human-readable line per passed check.
 */
export function runChecks(
  deps: SmokeCheckDeps,
  baseUrl: string,
  accessToken: string,
): ResultAsync<string[], SmokeTestError> {
  const rpc = (request: JsonRpcRequest): ResultAsync<unknown, SmokeTestError> =>
    callRpc(deps.fetch, baseUrl, accessToken, request)

  const initialize = rpc({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.0' },
    },
  })
    .andThen((result) =>
      parseWith(InitializeResultSchema, result, 'initialize'),
    )
    .map((init) => `initialize: serverInfo.name=${init.serverInfo.name}`)

  const listTools = (): ResultAsync<string, SmokeTestError> =>
    rpc({ id: 2, method: 'tools/list' })
      .andThen((result) =>
        parseWith(ToolsListResultSchema, result, 'tools/list'),
      )
      .andThen((list) => {
        const names = new Set(list.tools.map((tool) => tool.name))
        const missing = EXPECTED_TOOLS.filter((tool) => !names.has(tool))
        return missing.length === 0
          ? ok(`tools/list: ${String(names.size)} tools advertised`)
          : err({
              step: 'tools/list',
              message: `missing tools: ${missing.join(', ')}`,
            })
      })

  const callStatus = (): ResultAsync<string, SmokeTestError> =>
    rpc({
      id: 3,
      method: 'tools/call',
      params: { name: 'compliance-status', arguments: {} },
    })
      .andThen((result) =>
        parseWith(ToolCallResultSchema, result, 'compliance-status'),
      )
      .andThen((call) => {
        const text = call.content[0]?.text ?? ''
        if (call.isError === true) {
          return err({
            step: 'compliance-status',
            message: `tool returned isError=true: ${text}`,
          })
        }
        return text.startsWith('# Compliance Status:')
          ? ok(text)
          : err({
              step: 'compliance-status',
              message: `expected a Markdown report starting with "# Compliance Status:", got: ${text.slice(0, 200)}`,
            })
      })

  const readStatus = (
    markdown: string,
  ): ResultAsync<string, SmokeTestError> => {
    const step = 'compliance://status'
    return rpc({
      id: 4,
      method: 'resources/read',
      params: { uri: 'compliance://status' },
    })
      .andThen((result) => parseWith(ResourceReadResultSchema, result, step))
      .andThen((read) =>
        parseJson(read.contents[0].text)
          .mapErr((message) => ({ step, message }))
          .andThen((body) => parseWith(StatusResourceSchema, body, step)),
      )
      .andThen((status) => {
        const drift = Math.abs(Date.parse(status.now) - deps.now())
        if (!(drift <= MAX_CLOCK_DRIFT_MS)) {
          return err({
            step,
            message: `"now" is ${status.now}, ${String(drift)}ms from local time`,
          })
        }
        const withAuth = status.sources.filter(
          (source) => source.auth !== undefined,
        ).length
        if (withAuth === 0) {
          return err({
            step,
            message: 'expected at least one source to carry auth metadata',
          })
        }
        if (!markdown.includes(status.entity.legal_name)) {
          return err({
            step: 'compliance-status',
            message: `Markdown report does not mention entity "${status.entity.legal_name}"`,
          })
        }
        return ok(
          `${step}: overall=${status.overall}, sources=${String(status.sources.length)}, withAuth=${String(withAuth)}, now-drift=${String(drift)}ms`,
        )
      })
  }

  return initialize.andThen((initLine) =>
    listTools().andThen((toolsLine) =>
      callStatus().andThen((markdown) =>
        readStatus(markdown).map((statusLine) => [
          initLine,
          toolsLine,
          `compliance-status: Markdown report (${String(markdown.length)} chars)`,
          statusLine,
        ]),
      ),
    ),
  )
}

export interface InstallationStore {
  saveInstallation(installation: McpInstallation): Promise<void>
  deleteInstallation(accessToken: string): Promise<void>
}

export interface SmokeTestDeps extends SmokeCheckDeps {
  readonly store: InstallationStore
  readonly generateToken: () => string
}

/**
 * Create a synthetic installation, run the checks, and delete the
 * installation whether or not the checks passed.
 */
export function runSmokeTest(
  options: SmokeTestOptions,
  deps: SmokeTestDeps,
): ResultAsync<string[], SmokeTestError> {
  const accessToken = deps.generateToken()
  const issuedAt = deps.now()
  const installation: McpInstallation = {
    accessToken,
    refreshToken: deps.generateToken(),
    clientId: 'smoke-test-client',
    userId: 'smoke-test-user',
    userEmail: options.userEmail,
    userDomain: options.userDomain,
    issuedAt,
    expiresAt: issuedAt + INSTALLATION_TTL_MS,
  }
  const cleanup = (): ResultAsync<void, SmokeTestError> =>
    ResultAsync.fromPromise(
      deps.store.deleteInstallation(accessToken),
      (error) => ({ step: 'cleanup', message: describeError(error) }),
    )

  return ResultAsync.fromPromise(
    deps.store.saveInstallation(installation),
    (error): SmokeTestError => ({
      step: 'provision',
      message: describeError(error),
    }),
  )
    .andThen(() =>
      ResultAsync.fromSafePromise(
        Promise.resolve(runChecks(deps, options.baseUrl, accessToken)),
      ),
    )
    .andThen((checks) =>
      // Prefer reporting a failed check over a failed cleanup.
      cleanup()
        .andThen(() => checks)
        .orElse((cleanupError) => checks.andThen(() => err(cleanupError))),
    )
}
