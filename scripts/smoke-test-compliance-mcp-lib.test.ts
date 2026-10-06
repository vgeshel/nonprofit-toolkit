/**
 * Tests for the compliance MCP smoke test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { McpInstallation } from '../apps/mcp/src/auth/storage.ts'
import {
  EXPECTED_TOOLS,
  callRpc,
  extractRpcPayload,
  parseArgs,
  runChecks,
  runSmokeTest,
  type FetchLike,
  type InstallationStore,
  type SmokeTestOptions,
} from './smoke-test-compliance-mcp-lib'

const BASE_URL = 'https://mcp.example.com'
const NOW = Date.parse('2026-01-15T12:00:00.000Z')
const LEGAL_NAME = 'Example Charity'

function rpcJson(id: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const statusResource = {
  overall: 'attention_required',
  now: '2026-01-15T12:00:05.000Z',
  entity: { legal_name: LEGAL_NAME, ein: '00-0000000' },
  identifiers: { 'us-federal': { ein: '00-0000000' } },
  sources: [
    {
      sourceId: 'irs-teos',
      agency: 'IRS',
      accessUrl: 'https://irs.example.gov/teos',
      tosUrl: 'https://irs.example.gov/tos',
      automationAllowed: true,
    },
    {
      sourceId: 'ca-ftb-myftb',
      agency: 'CA FTB',
      accessUrl: 'https://ftb.example.gov/myftb',
      tosUrl: 'https://ftb.example.gov/tos',
      automationAllowed: false,
      auth: {
        loginUrl: 'https://ftb.example.gov/login',
        instructions: ['Sign in'],
        extra: 'kept',
      },
    },
  ],
}

type Responses = Record<string, () => Response | Promise<Response>>

/**
 * A fake MCP endpoint keyed by JSON-RPC method (tools/call by tool name).
 */
function fakeServer(overrides: Responses = {}) {
  const defaults: Responses = {
    initialize: () =>
      rpcJson(1, { result: { serverInfo: { name: 'nonprofit-toolkit' } } }),
    'tools/list': () =>
      rpcJson(2, {
        result: {
          tools: [...EXPECTED_TOOLS, 'query-bigquery'].map((name) => ({
            name,
          })),
        },
      }),
    'tools/call': () =>
      rpcJson(3, {
        result: {
          content: [
            {
              type: 'text',
              text: `# Compliance Status: ${LEGAL_NAME}\n\nAll good.`,
            },
          ],
        },
      }),
    'resources/read': () =>
      rpcJson(4, {
        result: {
          contents: [
            {
              uri: 'compliance://status',
              mimeType: 'application/json',
              text: JSON.stringify(statusResource),
            },
          ],
        },
      }),
  }
  const routes = { ...defaults, ...overrides }
  const requests: {
    url: string
    headers: Record<string, string>
    body: unknown
  }[] = []
  const fetchFn = vi.fn<FetchLike>((url, init) => {
    const body: unknown = JSON.parse(init.body)
    requests.push({ url, headers: init.headers, body })
    const method =
      typeof body === 'object' && body !== null && 'method' in body
        ? String(body.method)
        : ''
    const route = routes[method]
    return route === undefined
      ? Promise.resolve(new Response('no route', { status: 404 }))
      : Promise.resolve(route())
  })
  return { fetchFn, requests }
}

describe('parseArgs', () => {
  it('parses options and derives the user domain', () => {
    const result = parseArgs([
      '--base-url',
      'https://mcp.example.com/',
      '--project',
      'demo-project',
      '--user-email',
      'ops@example.org',
    ])
    expect(result._unsafeUnwrap()).toEqual({
      baseUrl: 'https://mcp.example.com',
      projectId: 'demo-project',
      userEmail: 'ops@example.org',
      userDomain: 'example.org',
    })
  })

  it('returns the usage text for --help', () => {
    const error = parseArgs(['--help'])._unsafeUnwrapErr()
    expect(error.step).toBe('args')
    expect(error.message).toContain(
      'Usage: smoke-test-compliance-mcp [options]',
    )
    expect(error.message).toContain('--user-email <email>')
  })

  it('rejects a missing required option', () => {
    const result = parseArgs(['--project', 'demo-project'])
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'args',
      message: "error: required option '--base-url <url>' not specified",
    })
  })

  it('rejects an invalid email', () => {
    const result = parseArgs([
      '--base-url',
      BASE_URL,
      '--project',
      'demo-project',
      '--user-email',
      'not-an-email',
    ])
    const error = result._unsafeUnwrapErr()
    expect(error.step).toBe('args')
    expect(error.message).toContain('userEmail')
  })
})

describe('extractRpcPayload', () => {
  it('parses a plain JSON body', () => {
    expect(
      extractRpcPayload('application/json', '{"a":1}')._unsafeUnwrap(),
    ).toEqual({ a: 1 })
  })

  it('parses the first data event of an SSE body', () => {
    const body = 'event: message\ndata: {"id":7}\n\ndata: {"id":8}\n'
    expect(
      extractRpcPayload('text/event-stream', body)._unsafeUnwrap(),
    ).toEqual({ id: 7 })
  })

  it('fails on an SSE body without a data event', () => {
    expect(
      extractRpcPayload(
        'text/event-stream',
        'event: ping\n',
      )._unsafeUnwrapErr(),
    ).toBe('SSE response contained no data event')
  })

  it('fails on invalid JSON', () => {
    expect(
      extractRpcPayload('application/json', 'nope')._unsafeUnwrapErr(),
    ).toMatch(/^invalid JSON: /)
  })
})

describe('callRpc', () => {
  it('posts a JSON-RPC request with MCP headers and returns the result', async () => {
    const { fetchFn, requests } = fakeServer()
    const result = await callRpc(fetchFn, BASE_URL, 'token-1', {
      id: 2,
      method: 'tools/list',
    })
    expect(result.isOk()).toBe(true)
    expect(requests).toEqual([
      {
        url: `${BASE_URL}/mcp`,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer token-1',
          'mcp-protocol-version': '2025-06-18',
        },
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      },
    ])
  })

  it('reads an SSE response', async () => {
    const { fetchFn } = fakeServer({
      initialize: () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    const result = await callRpc(fetchFn, BASE_URL, 't', {
      id: 1,
      method: 'initialize',
    })
    expect(result._unsafeUnwrap()).toEqual({ ok: true })
  })

  it('fails on a transport error', async () => {
    const fetchFn = vi.fn<FetchLike>(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    )
    const result = await callRpc(fetchFn, BASE_URL, 't', {
      id: 1,
      method: 'initialize',
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'initialize',
      message: 'ECONNREFUSED',
    })
  })

  it('fails on a non-2xx status with the body', async () => {
    const { fetchFn } = fakeServer({
      initialize: () => new Response('unauthorized', { status: 401 }),
    })
    const result = await callRpc(fetchFn, BASE_URL, 't', {
      id: 1,
      method: 'initialize',
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'initialize',
      message: 'HTTP 401: unauthorized',
    })
  })

  it('fails when the response has no content type and is not JSON', async () => {
    const fetchFn = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('<html>'),
      }),
    )
    const result = await callRpc(fetchFn, BASE_URL, 't', {
      id: 1,
      method: 'initialize',
    })
    expect(result._unsafeUnwrapErr().message).toMatch(/^invalid JSON: /)
  })

  it('fails when the body is not a JSON-RPC response', async () => {
    const { fetchFn } = fakeServer({
      initialize: () => new Response('{"hello":"world"}', { status: 200 }),
    })
    const result = await callRpc(fetchFn, BASE_URL, 't', {
      id: 1,
      method: 'initialize',
    })
    expect(result._unsafeUnwrapErr().message).toMatch(
      /^not a JSON-RPC response: /,
    )
  })

  it('fails on a JSON-RPC error', async () => {
    const { fetchFn } = fakeServer({
      initialize: () =>
        rpcJson(1, { error: { code: -32600, message: 'Bad request' } }),
    })
    const result = await callRpc(fetchFn, BASE_URL, 't', {
      id: 1,
      method: 'initialize',
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'initialize',
      message: '{"code":-32600,"message":"Bad request"}',
    })
  })
})

describe('runChecks', () => {
  const now = () => NOW

  it('passes every check against a healthy server', async () => {
    const { fetchFn, requests } = fakeServer()
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrap()).toEqual([
      'initialize: serverInfo.name=nonprofit-toolkit',
      'tools/list: 8 tools advertised',
      `compliance-status: Markdown report (${String(`# Compliance Status: ${LEGAL_NAME}\n\nAll good.`.length)} chars)`,
      'compliance://status: overall=attention_required, sources=2, withAuth=1, now-drift=5000ms',
    ])
    expect(requests.map((r) => r.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.0' },
        },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'compliance-status', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'compliance://status' },
      },
    ])
  })

  it('stops at the first failing request', async () => {
    const { fetchFn } = fakeServer({
      initialize: () => new Response('down', { status: 503 }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'initialize',
      message: 'HTTP 503: down',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('fails on a malformed initialize result', async () => {
    const { fetchFn } = fakeServer({
      initialize: () => rpcJson(1, { result: {} }),
    })
    const error = (
      await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    )._unsafeUnwrapErr()
    expect(error.step).toBe('initialize')
    expect(error.message).toMatch(/^unexpected response: /)
  })

  it('names missing compliance tools', async () => {
    const { fetchFn } = fakeServer({
      'tools/list': () =>
        rpcJson(2, {
          result: {
            tools: EXPECTED_TOOLS.filter(
              (tool) =>
                tool !== 'compliance-discover-start' &&
                tool !== 'compliance-record-evidence',
            ).map((name) => ({ name })),
          },
        }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'tools/list',
      message:
        'missing tools: compliance-discover-start, compliance-record-evidence',
    })
  })

  it('fails when compliance-status reports a tool error', async () => {
    const { fetchFn } = fakeServer({
      'tools/call': () =>
        rpcJson(3, {
          result: {
            isError: true,
            content: [{ type: 'text', text: 'No entity configured' }],
          },
        }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'compliance-status',
      message: 'tool returned isError=true: No entity configured',
    })
  })

  it('fails when compliance-status returns no Markdown report', async () => {
    const { fetchFn } = fakeServer({
      'tools/call': () => rpcJson(3, { result: { content: [] } }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'compliance-status',
      message:
        'expected a Markdown report starting with "# Compliance Status:", got: ',
    })
  })

  it('fails when the status resource is not JSON', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': () =>
        rpcJson(4, {
          result: { contents: [{ uri: 'compliance://status', text: 'oops' }] },
        }),
    })
    const error = (
      await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    )._unsafeUnwrapErr()
    expect(error.step).toBe('compliance://status')
    expect(error.message).toMatch(/^invalid JSON: /)
  })

  it('fails when the status resource has no contents', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': () => rpcJson(4, { result: { contents: [] } }),
    })
    const error = (
      await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    )._unsafeUnwrapErr()
    expect(error.step).toBe('compliance://status')
    expect(error.message).toMatch(/^unexpected response: /)
  })

  function resourceWith(patch: Record<string, unknown>): () => Response {
    return () =>
      rpcJson(4, {
        result: {
          contents: [
            {
              uri: 'compliance://status',
              text: JSON.stringify({ ...statusResource, ...patch }),
            },
          ],
        },
      })
  }

  it('fails when the status resource does not match the schema', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': resourceWith({ overall: 'fine' }),
    })
    const error = (
      await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    )._unsafeUnwrapErr()
    expect(error.step).toBe('compliance://status')
    expect(error.message).toMatch(/^unexpected response: /)
  })

  it('fails on server clock drift', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': resourceWith({ now: '2026-01-15T12:05:00.000Z' }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'compliance://status',
      message: '"now" is 2026-01-15T12:05:00.000Z, 300000ms from local time',
    })
  })

  it('fails when "now" is not a timestamp', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': resourceWith({ now: 'yesterday' }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'compliance://status',
      message: '"now" is yesterday, NaNms from local time',
    })
  })

  it('fails when no source carries auth metadata', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': resourceWith({
        sources: [statusResource.sources[0]],
      }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'compliance://status',
      message: 'expected at least one source to carry auth metadata',
    })
  })

  it('fails when the report names a different entity', async () => {
    const { fetchFn } = fakeServer({
      'resources/read': resourceWith({
        entity: { legal_name: 'Other Org' },
      }),
    })
    const result = await runChecks({ fetch: fetchFn, now }, BASE_URL, 't')
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'compliance-status',
      message: 'Markdown report does not mention entity "Other Org"',
    })
  })
})

describe('runSmokeTest', () => {
  const options: SmokeTestOptions = {
    baseUrl: BASE_URL,
    projectId: 'demo-project',
    userEmail: 'ops@example.org',
    userDomain: 'example.org',
  }

  function fakeStore(overrides: Partial<InstallationStore> = {}) {
    const saved: McpInstallation[] = []
    const deleted: string[] = []
    const store: InstallationStore = {
      saveInstallation: vi.fn<InstallationStore['saveInstallation']>(
        (installation) => {
          saved.push(installation)
          return Promise.resolve()
        },
      ),
      deleteInstallation: vi.fn<InstallationStore['deleteInstallation']>(
        (token) => {
          deleted.push(token)
          return Promise.resolve()
        },
      ),
      ...overrides,
    }
    return { store, saved, deleted }
  }

  function tokens() {
    let n = 0
    return vi.fn<() => string>(() => {
      n += 1
      return `token-${String(n)}`
    })
  }

  it('saves a synthetic installation, runs the checks, and deletes it', async () => {
    const { store, saved, deleted } = fakeStore()
    const { fetchFn, requests } = fakeServer()
    const result = await runSmokeTest(options, {
      store,
      generateToken: tokens(),
      fetch: fetchFn,
      now: () => NOW,
    })
    expect(result._unsafeUnwrap()).toHaveLength(4)
    expect(saved).toEqual([
      {
        accessToken: 'token-1',
        refreshToken: 'token-2',
        clientId: 'smoke-test-client',
        userId: 'smoke-test-user',
        userEmail: 'ops@example.org',
        userDomain: 'example.org',
        issuedAt: NOW,
        expiresAt: NOW + 60 * 60 * 1000,
      },
    ])
    expect(requests[0]?.headers.authorization).toBe('Bearer token-1')
    expect(deleted).toEqual(['token-1'])
  })

  it('deletes the installation and reports the check failure', async () => {
    const { store, deleted } = fakeStore()
    const { fetchFn } = fakeServer({
      initialize: () => new Response('down', { status: 503 }),
    })
    const result = await runSmokeTest(options, {
      store,
      generateToken: tokens(),
      fetch: fetchFn,
      now: () => NOW,
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'initialize',
      message: 'HTTP 503: down',
    })
    expect(deleted).toEqual(['token-1'])
  })

  it('prefers the check failure over a cleanup failure', async () => {
    const { store } = fakeStore({
      deleteInstallation: () => Promise.reject(new Error('permission denied')),
    })
    const { fetchFn } = fakeServer({
      initialize: () => new Response('down', { status: 503 }),
    })
    const result = await runSmokeTest(options, {
      store,
      generateToken: tokens(),
      fetch: fetchFn,
      now: () => NOW,
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'initialize',
      message: 'HTTP 503: down',
    })
  })

  it('reports a cleanup failure after passing checks', async () => {
    const { store } = fakeStore({
      deleteInstallation: () => Promise.reject(new Error('permission denied')),
    })
    const { fetchFn } = fakeServer()
    const result = await runSmokeTest(options, {
      store,
      generateToken: tokens(),
      fetch: fetchFn,
      now: () => NOW,
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'cleanup',
      message: 'permission denied',
    })
  })

  it('does not call the server when the installation cannot be saved', async () => {
    const { store, deleted } = fakeStore({
      saveInstallation: () =>
        Promise.reject(new Error('firestore unavailable')),
    })
    const { fetchFn } = fakeServer()
    const result = await runSmokeTest(options, {
      store,
      generateToken: tokens(),
      fetch: fetchFn,
      now: () => NOW,
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'provision',
      message: 'firestore unavailable',
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(deleted).toEqual([])
  })

  it('describes a rejection that is not an Error instance', async () => {
    // Error-shaped but not an Error instance, as some SDKs reject with.
    const plainObject: Error = { name: 'GrpcStatus', message: 'denied' }
    const { store } = fakeStore({
      saveInstallation: () => Promise.reject(plainObject),
    })
    const { fetchFn } = fakeServer()
    const result = await runSmokeTest(options, {
      store,
      generateToken: tokens(),
      fetch: fetchFn,
      now: () => NOW,
    })
    expect(result._unsafeUnwrapErr()).toEqual({
      step: 'provision',
      message: '[object Object]',
    })
  })
})
