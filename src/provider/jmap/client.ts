import { NeverDeleteViolation, RateLimitError, TransportError } from '../types.js'

export type JmapMethodCall = [name: string, args: Record<string, unknown>, callId: string]
export type JmapMethodResponse = [name: string, args: Record<string, unknown>, callId: string]

export interface JmapClientOptions {
  token: string
  sessionUrl?: string
  fetch?: typeof globalThis.fetch
}

const DEFAULT_SESSION_URL = 'https://api.fastmail.com/jmap/session'
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

/** Top-level args keys that would destroy mail. Checked on every request. */
const FORBIDDEN_ARG_KEYS = ['destroy', 'onDestroyRemoveEmails'] as const

/**
 * Thin JMAP-over-fetch client (hand-rolled on purpose). Owns session
 * discovery, Bearer auth, batching of method calls, and the never-delete
 * runtime guard.
 */
export class JmapClient {
  private readonly token: string
  private readonly sessionUrl: string
  private readonly fetchImpl: typeof globalThis.fetch
  private apiUrl: string | null = null
  private account: string | null = null

  constructor(options: JmapClientOptions) {
    this.token = options.token
    this.sessionUrl = options.sessionUrl ?? DEFAULT_SESSION_URL
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  get accountId(): string {
    if (this.account === null) {
      throw new TransportError('JMAP client not connected: call connect() first')
    }
    return this.account
  }

  async connect(): Promise<void> {
    if (this.apiUrl !== null && this.account !== null) return
    const res = await this.fetchImpl(this.sessionUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new TransportError(`JMAP session request failed: ${res.status} ${body.slice(0, 200)}`)
    }
    const session = (await res.json()) as {
      apiUrl?: unknown
      primaryAccounts?: Record<string, unknown>
    }
    if (typeof session.apiUrl !== 'string') {
      throw new TransportError('JMAP session document has no apiUrl')
    }
    const account = session.primaryAccounts?.['urn:ietf:params:jmap:mail']
    if (typeof account !== 'string') {
      throw new TransportError('JMAP session document has no primary mail account')
    }
    this.apiUrl = session.apiUrl
    this.account = account
  }

  async request(methodCalls: JmapMethodCall[]): Promise<JmapMethodResponse[]> {
    // The never-delete guarantee: refuse before any bytes leave the process.
    for (const [name, args] of methodCalls) {
      for (const key of FORBIDDEN_ARG_KEYS) {
        if (Object.hasOwn(args, key)) throw new NeverDeleteViolation(name)
      }
    }
    if (this.apiUrl === null) {
      throw new TransportError('JMAP client not connected: call connect() first')
    }
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: USING, methodCalls }),
    })
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      throw new RateLimitError(
        'JMAP rate limited (HTTP 429)',
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      )
    }
    if (!res.ok) {
      const body = await res.text()
      throw new TransportError(`JMAP request failed: ${res.status} ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { methodResponses?: unknown }
    const responses = Array.isArray(json.methodResponses)
      ? (json.methodResponses as JmapMethodResponse[])
      : []
    for (const [name, args] of responses) {
      if (name === 'error') {
        const type = typeof args['type'] === 'string' ? args['type'] : 'unknown'
        throw new TransportError(`JMAP method error: ${type}`, args)
      }
    }
    return responses
  }
}

/**
 * Fastmail signals per-record throttling as a SetError of type 'rateLimit' in
 * notUpdated/notCreated rather than an HTTP 429 — surface it the same way.
 */
export function throwIfRateLimited(response: JmapMethodResponse): void {
  const args = response[1]
  for (const key of ['notUpdated', 'notCreated']) {
    const errors = args[key]
    if (errors === null || typeof errors !== 'object') continue
    for (const setError of Object.values(errors)) {
      if (
        setError !== null &&
        typeof setError === 'object' &&
        (setError as { type?: unknown }).type === 'rateLimit'
      ) {
        throw new RateLimitError(`JMAP ${response[0]} rate limited (SetError rateLimit)`)
      }
    }
  }
}
