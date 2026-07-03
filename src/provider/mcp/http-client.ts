import { RateLimitError, TransportError } from '../types.js'

const DEFAULT_ENDPOINT = 'https://api.fastmail.com/mcp'
const DEFAULT_CLIENT_INFO = { name: 'fast-classifier', version: '0.1.0' }
export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpHttpClientOptions {
  token: string
  endpoint?: string
  fetch?: typeof globalThis.fetch
  clientInfo?: { name: string; version: string }
}

interface ToolContentItem {
  type?: string
  text?: string
}

interface ToolCallResult {
  isError?: boolean
  content?: ToolContentItem[]
  structuredContent?: unknown
}

export interface McpHttpClient {
  init(): Promise<void>
  rpc(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): Promise<void>
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>
}

const safeParse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

/**
 * Hand-rolled MCP-over-HTTP client for Fastmail's official endpoint
 * (Streamable HTTP with SSE-framed responses). Deliberately dependency-free —
 * a faithful, typed port of the proven session script (reference/mcp.mjs).
 */
export const createMcpHttpClient = (opts: McpHttpClientOptions): McpHttpClient => {
  const token = opts.token
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO
  let sessionId: string | null = null
  let initialized = false
  let negotiated = false

  // Error bodies may echo request headers back; the bearer token must never
  // appear in a thrown message.
  const redact = (s: string): string => {
    return s.split(token).join('[redacted]')
  }

  const post = async (body: Record<string, unknown>): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // The server rejects requests unless BOTH accept types are present
      Accept: 'application/json, text/event-stream',
    }
    // Session dance: echo the server-issued session id on every later call
    if (sessionId) headers['mcp-session-id'] = sessionId
    // Streamable HTTP spec (2025-06-18): declare the negotiated protocol
    // version on every post-initialize request
    if (negotiated) headers['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        throw new RateLimitError('MCP rate limited (HTTP 429)', retryAfter * 1000)
      }
      throw new RateLimitError('MCP rate limited (HTTP 429)')
    }
    if (!res.ok) {
      // Redact BEFORE slicing so a token straddling the cut cannot leak
      const snippet = redact(await res.text()).slice(0, 300)
      throw new TransportError(`MCP HTTP ${res.status}: ${snippet}`)
    }
    return res
  }

  const rpc = async (method: string, params: unknown): Promise<unknown> => {
    const res = await post({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method,
      params,
    })
    const text = await res.text()
    // Fastmail wraps even single results in SSE frames: strip 'data: ' prefixes
    // and take the LAST JSON line (earlier lines are keep-alives/comments).
    // The same algorithm handles plain-JSON bodies.
    const line = text
      .split('\n')
      .map((l) => l.replace(/^data: /, ''))
      .reverse()
      .find((l) => l.trim().startsWith('{'))
    if (line === undefined) {
      throw new TransportError('MCP response contained no JSON payload')
    }
    const envelope = JSON.parse(line) as { error?: unknown; result?: unknown }
    if (envelope.error) {
      // Error payloads can echo request contents — redact before surfacing
      const safe = redact(JSON.stringify(envelope.error))
      throw new TransportError(`MCP error: ${safe}`, safeParse(safe))
    }
    return envelope.result
  }

  const notify = async (method: string, params: unknown): Promise<void> => {
    // Notifications carry no id and expect no result
    await post({ jsonrpc: '2.0', method, params })
  }

  const init = async (): Promise<void> => {
    if (initialized) return
    await rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    })
    negotiated = true
    await notify('notifications/initialized', {})
    initialized = true
  }

  const callTool = async <T = unknown>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = (await rpc('tools/call', { name, arguments: args })) as ToolCallResult | null
    if (r && r.isError) {
      const et = (r.content ?? []).find((c) => c.type === 'text')
      const text = redact(et?.text ?? JSON.stringify(r))
      // The server reports rate limiting as a tool error, not HTTP 429
      if (/rate.?limit/i.test(text)) throw new RateLimitError(text)
      throw new TransportError('TOOL_ERROR: ' + text)
    }
    // Truthiness on purpose (reference-faithful): a present-but-null
    // structuredContent must fall through to the text body.
    if (r && r.structuredContent) return r.structuredContent as T
    const t = (r?.content ?? []).find((c) => c.type === 'text')
    if (!t || t.text === undefined) return r as T
    try {
      return JSON.parse(t.text) as T
    } catch {
      return t.text as T
    }
  }

  return { init, rpc, notify, callTool }
}
