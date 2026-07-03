import { describe, test, expect } from 'bun:test'
import { createJmapClient, throwIfRateLimited } from '../../../src/provider/jmap/client.js'
import type { JmapMethodResponse } from '../../../src/provider/jmap/client.js'
import {
  NeverDeleteViolation,
  RateLimitError,
  TransportError,
} from '../../../src/provider/types.js'
import { SESSION, fakeFetch, jmapResponse } from './fake-fetch.js'

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  return promise.then(
    () => {
      throw new Error('expected promise to reject')
    },
    (error: unknown) => error,
  )
}

describe('JmapClient.connect', () => {
  test('parses session doc: apiUrl + primary mail account, Bearer auth on default URL', async () => {
    const { fetch, requests } = fakeFetch([{ body: SESSION }])
    const client = createJmapClient({ token: 'tok-1', fetch })
    await client.connect()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.fastmail.com/jmap/session')
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.headers['authorization']).toBe('Bearer tok-1')
    expect(client.accountId).toBe('acct-1')
  })

  test('is idempotent: second connect does not refetch the session', async () => {
    const { fetch, requests } = fakeFetch([{ body: SESSION }])
    const client = createJmapClient({ token: 't', fetch })
    await client.connect()
    await client.connect()
    expect(requests).toHaveLength(1)
  })

  test('respects a custom sessionUrl', async () => {
    const { fetch, requests } = fakeFetch([{ body: SESSION }])
    const client = createJmapClient({ token: 't', sessionUrl: 'https://alt.test/session', fetch })
    await client.connect()
    expect(requests[0]?.url).toBe('https://alt.test/session')
  })

  test('401 → TransportError carrying status and body snippet', async () => {
    const { fetch } = fakeFetch([{ status: 401, body: { detail: 'bad token' } }])
    const client = createJmapClient({ token: 'bad', fetch })
    const error = await rejectionOf(client.connect())
    expect(error).toBeInstanceOf(TransportError)
    expect((error as Error).message).toContain('401')
    expect((error as Error).message).toContain('bad token')
  })

  test('accountId throws before connect', () => {
    const client = createJmapClient({ token: 't', fetch: fakeFetch([]).fetch })
    expect(() => client.accountId).toThrow(TransportError)
  })
})

describe('JmapClient.request', () => {
  test('POSTs methodCalls to session apiUrl with core+mail capabilities', async () => {
    const { fetch, requests } = fakeFetch([
      { body: SESSION },
      jmapResponse(['Mailbox/get', { list: [] }, '0']),
    ])
    const client = createJmapClient({ token: 'tok-2', fetch })
    await client.connect()
    const responses = await client.request([['Mailbox/get', { accountId: 'acct-1' }, '0']])
    expect(requests[1]?.url).toBe(SESSION.apiUrl)
    expect(requests[1]?.method).toBe('POST')
    expect(requests[1]?.headers['authorization']).toBe('Bearer tok-2')
    expect(requests[1]?.body).toEqual({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Mailbox/get', { accountId: 'acct-1' }, '0']],
    })
    expect(responses).toEqual([['Mailbox/get', { list: [] }, '0']])
  })

  test('never-delete: destroy in args → NeverDeleteViolation before any fetch', async () => {
    const { fetch, requests } = fakeFetch([{ body: SESSION }])
    const client = createJmapClient({ token: 't', fetch })
    await client.connect()
    expect(requests).toHaveLength(1)
    const error = await rejectionOf(
      client.request([['Email/set', { accountId: 'acct-1', destroy: ['e1'] }, '0']]),
    )
    expect(error).toBeInstanceOf(NeverDeleteViolation)
    expect(requests).toHaveLength(1)
  })

  test('never-delete: onDestroyRemoveEmails in args → NeverDeleteViolation before any fetch', async () => {
    const { fetch, requests } = fakeFetch([{ body: SESSION }])
    const client = createJmapClient({ token: 't', fetch })
    await client.connect()
    const error = await rejectionOf(
      client.request([['Mailbox/set', { accountId: 'acct-1', onDestroyRemoveEmails: true }, '0']]),
    )
    expect(error).toBeInstanceOf(NeverDeleteViolation)
    expect(requests).toHaveLength(1)
  })

  test('method-level error response → TransportError including the JMAP error type', async () => {
    const { fetch } = fakeFetch([
      { body: SESSION },
      jmapResponse(['error', { type: 'unknownMethod' }, '0']),
    ])
    const client = createJmapClient({ token: 't', fetch })
    await client.connect()
    const error = await rejectionOf(client.request([['Nope/get', {}, '0']]))
    expect(error).toBeInstanceOf(TransportError)
    expect((error as Error).message).toContain('unknownMethod')
  })

  test('HTTP 429 → RateLimitError with retryAfterMs from Retry-After header', async () => {
    const { fetch } = fakeFetch([
      { body: SESSION },
      { status: 429, body: {}, headers: { 'retry-after': '3' } },
    ])
    const client = createJmapClient({ token: 't', fetch })
    await client.connect()
    const error = await rejectionOf(client.request([['Email/query', {}, '0']]))
    expect(error).toBeInstanceOf(RateLimitError)
    expect((error as RateLimitError).retryAfterMs).toBe(3000)
  })

  test('request before connect throws TransportError without fetching', async () => {
    const { fetch, requests } = fakeFetch([])
    const client = createJmapClient({ token: 't', fetch })
    const error = await rejectionOf(client.request([['Email/query', {}, '0']]))
    expect(error).toBeInstanceOf(TransportError)
    expect(requests).toHaveLength(0)
  })
})

describe('throwIfRateLimited', () => {
  test('notUpdated SetError of type rateLimit → RateLimitError', () => {
    const response: JmapMethodResponse = [
      'Email/set',
      { notUpdated: { e1: { type: 'rateLimit' } } },
      '0',
    ]
    expect(() => throwIfRateLimited(response)).toThrow(RateLimitError)
  })

  test('notCreated SetError of type rateLimit → RateLimitError', () => {
    const response: JmapMethodResponse = [
      'Mailbox/set',
      { notCreated: { c0: { type: 'rateLimit' } } },
      '0',
    ]
    expect(() => throwIfRateLimited(response)).toThrow(RateLimitError)
  })

  test('other SetError types and clean responses pass through', () => {
    const failed: JmapMethodResponse = [
      'Email/set',
      { updated: { e1: null }, notUpdated: { e2: { type: 'notFound' } } },
      '0',
    ]
    expect(() => throwIfRateLimited(failed)).not.toThrow()
    const clean: JmapMethodResponse = ['Email/set', { updated: { e1: null } }, '0']
    expect(() => throwIfRateLimited(clean)).not.toThrow()
  })
})
