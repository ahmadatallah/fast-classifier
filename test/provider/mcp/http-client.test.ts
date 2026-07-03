import { describe, test, expect } from 'bun:test'
import { createMcpHttpClient } from '../../../src/provider/mcp/http-client.js'
import { RateLimitError, TransportError } from '../../../src/provider/types.js'

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

interface FakeResponse {
  status?: number
  body?: string
  headers?: Record<string, string>
}

const makeFakeFetch = (responder: (req: RecordedRequest, index: number) => FakeResponse) => {
  const requests: RecordedRequest[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v]),
    )
    const req: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    }
    requests.push(req)
    const r = responder(req, requests.length - 1)
    return Promise.resolve(
      new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} }),
    )
  }) as typeof fetch
  return { fetchImpl, requests }
}

const envelope = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 7, result })
const sse = (json: string) => `event: message\ndata: ${json}\n\n`

const TOKEN = 'fmu1-secret-token-abc123'

const makeClient = (responder: (req: RecordedRequest, index: number) => FakeResponse) => {
  const { fetchImpl, requests } = makeFakeFetch(responder)
  const client = createMcpHttpClient({ token: TOKEN, fetch: fetchImpl })
  return { client, requests }
}

describe('McpHttpClient init handshake', () => {
  test('sends initialize with protocolVersion 2025-06-18 then notifications/initialized without id', async () => {
    const { client, requests } = makeClient((req) =>
      (req.body['method'] as string) === 'initialize'
        ? { body: sse(envelope({ capabilities: {} })), headers: { 'mcp-session-id': 'sess-42' } }
        : { status: 202, body: '' },
    )
    await client.init()

    expect(requests).toHaveLength(2)
    const init = requests[0]
    const notified = requests[1]
    if (!init || !notified) throw new Error('missing requests')

    expect(init.method).toBe('POST')
    expect(init.body['jsonrpc']).toBe('2.0')
    expect(init.body['method']).toBe('initialize')
    expect(typeof init.body['id']).toBe('number')
    const params = init.body['params'] as Record<string, unknown>
    expect(params['protocolVersion']).toBe('2025-06-18')
    expect(params['clientInfo']).toEqual({ name: 'fast-classifier', version: '0.1.0' })

    expect(notified.body['method']).toBe('notifications/initialized')
    expect('id' in notified.body).toBe(false)
  })

  test('every POST carries Authorization, Content-Type, and the dual Accept header', async () => {
    const { client, requests } = makeClient(() => ({ body: sse(envelope({})) }))
    await client.init()
    for (const req of requests) {
      expect(req.headers['authorization']).toBe(`Bearer ${TOKEN}`)
      expect(req.headers['content-type']).toBe('application/json')
      expect(req.headers['accept']).toBe('application/json, text/event-stream')
    }
  })

  test('init is idempotent', async () => {
    const { client, requests } = makeClient(() => ({ body: sse(envelope({})) }))
    await client.init()
    await client.init()
    expect(requests).toHaveLength(2)
  })

  test('session id captured from response header appears on every subsequent request', async () => {
    const { client, requests } = makeClient((_req, index) =>
      index === 0
        ? { body: sse(envelope({})), headers: { 'mcp-session-id': 'sess-42' } }
        : { body: sse(envelope({ ok: true })) },
    )
    await client.init()
    await client.rpc('tools/list', {})
    await client.callTool('list_labels', {})

    const first = requests[0]
    if (!first) throw new Error('missing request')
    expect(first.headers['mcp-session-id']).toBeUndefined()
    for (const req of requests.slice(1)) {
      expect(req.headers['mcp-session-id']).toBe('sess-42')
    }
    expect(requests.length).toBeGreaterThanOrEqual(4)
  })
})

describe('McpHttpClient response parsing', () => {
  test('multi-frame SSE body with keep-alive comments: last JSON line wins', async () => {
    const body = [
      ': keep-alive',
      '',
      'data: {"jsonrpc":"2.0","id":1,"result":{"stale":true}}',
      '',
      ': another comment',
      `data: ${envelope({ fresh: true })}`,
      '',
    ].join('\n')
    const { client } = makeClient(() => ({ body }))
    const result = await client.rpc('x', {})
    expect(result).toEqual({ fresh: true })
  })

  test('plain JSON body parses with the same algorithm', async () => {
    const { client } = makeClient(() => ({ body: envelope({ plain: 1 }) }))
    const result = await client.rpc('x', {})
    expect(result).toEqual({ plain: 1 })
  })

  test('JSON-RPC error envelope throws TransportError', async () => {
    const { client } = makeClient(() => ({
      body: sse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } })),
    }))
    const err = await client.rpc('x', {}).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).message).toContain('bad')
    expect((err as TransportError).detail).toEqual({ code: -32600, message: 'bad' })
  })

  test('HTTP 429 throws RateLimitError', async () => {
    const { client } = makeClient(() => ({ status: 429, body: 'slow down' }))
    const err = await client.rpc('x', {}).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(RateLimitError)
  })

  test('HTTP 500 throws TransportError with status and never leaks the token', async () => {
    // A hostile/echoing server reflects the auth header into the error body
    const { client } = makeClient((req) => ({
      status: 500,
      body: `internal error while handling auth ${req.headers['authorization'] ?? ''}`,
    }))
    const err = await client.rpc('x', {}).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TransportError)
    const message = (err as TransportError).message
    expect(message).toContain('500')
    expect(message).not.toContain(TOKEN)
  })
})

describe('McpHttpClient.callTool', () => {
  test('unwraps structuredContent when present', async () => {
    const { client } = makeClient(() => ({
      body: sse(
        envelope({
          structuredContent: { items: [1, 2] },
          content: [{ type: 'text', text: 'ignored' }],
        }),
      ),
    }))
    const result = await client.callTool('search_email', {})
    expect(result).toEqual({ items: [1, 2] })
  })

  test('falls back to JSON.parse of the content[] text item', async () => {
    const { client } = makeClient(() => ({
      body: sse(envelope({ content: [{ type: 'text', text: '{"b":2}' }] })),
    }))
    const result = await client.callTool('search_email', {})
    expect(result).toEqual({ b: 2 })
  })

  test('returns the raw text when it is not JSON', async () => {
    const { client } = makeClient(() => ({
      body: sse(envelope({ content: [{ type: 'text', text: 'archived 3 emails' }] })),
    }))
    const result = await client.callTool('archive_email', {})
    expect(result).toBe('archived 3 emails')
  })

  test('returns the raw result when there is no text content', async () => {
    const { client } = makeClient(() => ({ body: sse(envelope({ content: [] })) }))
    const result = await client.callTool('x', {})
    expect(result).toEqual({ content: [] })
  })

  test('sends tools/call with name and arguments', async () => {
    const { client, requests } = makeClient(() => ({
      body: sse(envelope({ content: [{ type: 'text', text: '[]' }] })),
    }))
    await client.callTool('search_email', { query: 'in:inbox', limit: 50 })
    const req = requests[0]
    if (!req) throw new Error('missing request')
    expect(req.body['method']).toBe('tools/call')
    expect(req.body['params']).toEqual({
      name: 'search_email',
      arguments: { query: 'in:inbox', limit: 50 },
    })
  })

  test('isError result throws TransportError with TOOL_ERROR prefix', async () => {
    const { client } = makeClient(() => ({
      body: sse(envelope({ isError: true, content: [{ type: 'text', text: 'no such tool' }] })),
    }))
    const err = await client.callTool('nope', {}).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).message).toBe('TOOL_ERROR: no such tool')
  })

  test('isError result mentioning a rate limit throws RateLimitError', async () => {
    const { client } = makeClient(() => ({
      body: sse(
        envelope({ isError: true, content: [{ type: 'text', text: 'rate limit exceeded' }] }),
      ),
    }))
    const err = await client.callTool('search_email', {}).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(RateLimitError)
  })
})

describe('redaction on non-HTTP error paths (review finding)', () => {
  test('JSON-RPC error envelope echoing the token throws redacted, including detail', async () => {
    const { client } = makeClient(() => ({
      body: sse(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          error: { code: -32000, message: `bad auth header Bearer ${TOKEN}` },
        }),
      ),
    }))
    try {
      await client.rpc('tools/list', {})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError)
      expect((err as Error).message).not.toContain(TOKEN)
      expect(JSON.stringify((err as TransportError).detail)).not.toContain(TOKEN)
    }
  })

  test('tool isError text echoing the token throws redacted', async () => {
    const { client } = makeClient(() => ({
      body: sse(
        envelope({ isError: true, content: [{ type: 'text', text: `boom ${TOKEN} boom` }] }),
      ),
    }))
    try {
      await client.callTool('search_email', {})
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('TOOL_ERROR')
      expect((err as Error).message).not.toContain(TOKEN)
    }
  })
})

describe('protocol version header + structuredContent fallthrough (review findings)', () => {
  test('MCP-Protocol-Version header appears on every post-initialize request', async () => {
    const { client, requests } = makeClient((req) =>
      (req.body['method'] as string) === 'initialize'
        ? { body: sse(envelope({ capabilities: {} })), headers: { 'mcp-session-id': 's1' } }
        : { body: sse(envelope({ ok: true })) },
    )
    await client.init()
    await client.rpc('tools/list', {})
    expect(requests[0]?.headers['mcp-protocol-version']).toBeUndefined()
    // notifications/initialized and later calls carry it
    expect(requests[1]?.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(requests[2]?.headers['mcp-protocol-version']).toBe('2025-06-18')
  })

  test('present-but-null structuredContent falls through to the text body', async () => {
    const { client } = makeClient(() => ({
      body: sse(
        envelope({
          structuredContent: null,
          content: [{ type: 'text', text: JSON.stringify({ items: [1, 2] }) }],
        }),
      ),
    }))
    const result = await client.callTool<{ items: number[] }>('search_email', {})
    expect(result).toEqual({ items: [1, 2] })
  })
})
