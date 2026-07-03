/** Shared fake fetch for JMAP tests: canned response sequence + request recorder. */

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export interface FakeResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export const SESSION = {
  apiUrl: 'https://api.test/jmap/api',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
}

export const jmapResponse = (...methodResponses: unknown[]): FakeResponse => {
  return { body: { methodResponses } }
}

export const fakeFetch = (
  sequence: FakeResponse[],
): {
  fetch: typeof globalThis.fetch
  requests: RecordedRequest[]
} => {
  const remaining = [...sequence]
  const requests: RecordedRequest[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers).entries()) {
        headers[key.toLowerCase()] = value
      }
    }
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const next = remaining.shift()
    if (next === undefined) {
      throw new Error(`fakeFetch: unexpected request #${requests.length} to ${url}`)
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }
  return { fetch: impl as typeof globalThis.fetch, requests }
}

/** Parsed methodCalls of a recorded JMAP POST body. */
export const methodCallsOf = (
  request: RecordedRequest | undefined,
): [string, Record<string, unknown>, string][] => {
  const body = request?.body as { methodCalls?: unknown } | undefined
  return Array.isArray(body?.methodCalls)
    ? (body.methodCalls as [string, Record<string, unknown>, string][])
    : []
}
