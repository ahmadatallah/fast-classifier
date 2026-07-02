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

/**
 * Hand-rolled MCP-over-HTTP client for Fastmail's official endpoint
 * (Streamable HTTP with SSE-framed responses). Deliberately dependency-free —
 * a faithful, typed port of the proven session script (reference/mcp.mjs).
 */
export class McpHttpClient {
  private readonly token: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly clientInfo: { name: string; version: string }
  private sessionId: string | null = null
  private initialized = false

  constructor(opts: McpHttpClientOptions) {
    this.token = opts.token
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    })
    await this.notify('notifications/initialized', {})
    this.initialized = true
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    const res = await this.post({
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
      throw new TransportError(`MCP error: ${JSON.stringify(envelope.error)}`, envelope.error)
    }
    return envelope.result
  }

  async notify(method: string, params: unknown): Promise<void> {
    // Notifications carry no id and expect no result
    await this.post({ jsonrpc: '2.0', method, params })
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = (await this.rpc('tools/call', { name, arguments: args })) as ToolCallResult | null
    if (r && r.isError) {
      const et = (r.content ?? []).find((c) => c.type === 'text')
      const text = et?.text ?? JSON.stringify(r)
      // The server reports rate limiting as a tool error, not HTTP 429
      if (/rate.?limit/i.test(text)) throw new RateLimitError(text)
      throw new TransportError('TOOL_ERROR: ' + text)
    }
    if (r && r.structuredContent !== undefined) return r.structuredContent as T
    const t = (r?.content ?? []).find((c) => c.type === 'text')
    if (!t || t.text === undefined) return r as T
    try {
      return JSON.parse(t.text) as T
    } catch {
      return t.text as T
    }
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      // The server rejects requests unless BOTH accept types are present
      Accept: 'application/json, text/event-stream',
    }
    // Session dance: echo the server-issued session id on every later call
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        throw new RateLimitError('MCP rate limited (HTTP 429)', retryAfter * 1000)
      }
      throw new RateLimitError('MCP rate limited (HTTP 429)')
    }
    if (!res.ok) {
      // Redact BEFORE slicing so a token straddling the cut cannot leak
      const snippet = this.redact(await res.text()).slice(0, 300)
      throw new TransportError(`MCP HTTP ${res.status}: ${snippet}`)
    }
    return res
  }

  // Error bodies may echo request headers back; the bearer token must never
  // appear in a thrown message.
  private redact(s: string): string {
    return s.split(this.token).join('[redacted]')
  }
}
