import { describe, test, expect } from 'bun:test'
import { createJmapMailProvider } from '../../../src/provider/jmap/provider.js'
import { RateLimitError, TransportError } from '../../../src/provider/types.js'
import type { FakeResponse } from './fake-fetch.js'
import { SESSION, fakeFetch, jmapResponse, methodCallsOf } from './fake-fetch.js'

const MAILBOXES = [
  { id: 'P-F', name: 'Inbox', parentId: null, role: 'inbox', totalEmails: 12 },
  { id: 'M-ARC', name: 'Archive', parentId: null, role: 'archive', totalEmails: 100 },
  { id: 'M-DEV', name: 'Dev', parentId: 'P-F', role: null, totalEmails: 3 },
  { id: 'M-TRV', name: 'Travel', parentId: 'P-F', role: null, totalEmails: 5 },
]

const mailboxGet = (boxes: unknown[] = MAILBOXES): FakeResponse => {
  return jmapResponse(['Mailbox/get', { accountId: 'acct-1', list: boxes }, '0'])
}

const connected = async (extra: FakeResponse[] = []) => {
  const { fetch, requests } = fakeFetch([{ body: SESSION }, mailboxGet(), ...extra])
  const provider = createJmapMailProvider({ token: 't', fetch })
  await provider.connect()
  return { provider, requests }
}

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  return promise.then(
    () => {
      throw new Error('expected promise to reject')
    },
    (error: unknown) => error,
  )
}

describe('JmapMailProvider basics', () => {
  test('kind and capabilities', () => {
    const provider = createJmapMailProvider({ token: 't', fetch: fakeFetch([]).fetch })
    expect(provider.kind).toBe('jmap')
    expect(provider.caps).toEqual({
      maxPageSize: 100,
      serverSideNotFrom: 'full',
      autoCreatesLabels: false,
      canSetLabelColor: false,
    })
  })

  test('connect fetches session + mailboxes once and is idempotent', async () => {
    const { provider, requests } = await connected()
    expect(requests).toHaveLength(2)
    const [call] = methodCallsOf(requests[1])
    expect(call?.[0]).toBe('Mailbox/get')
    expect(call?.[1]['accountId']).toBe('acct-1')
    expect(call?.[1]['properties']).toEqual(['name', 'parentId', 'role', 'totalEmails'])
    await provider.connect()
    expect(requests).toHaveLength(2)
  })

  test('listLabels refreshes and maps mailboxes with computed paths', async () => {
    const { provider, requests } = await connected([mailboxGet()])
    const labels = await provider.listLabels()
    expect(requests).toHaveLength(3)
    const dev = labels.find((l) => l.name === 'Dev')
    expect(dev).toEqual({
      id: 'M-DEV',
      name: 'Dev',
      path: 'Inbox/Dev',
      parentId: 'P-F',
      role: null,
      totalEmails: 3,
    })
    const inbox = labels.find((l) => l.role === 'inbox')
    expect(inbox?.path).toBe('Inbox')
  })
})

describe('JmapMailProvider.ensureLabels', () => {
  test('all-exist short-circuit: resolves by name or path with no Mailbox/set call', async () => {
    const { provider, requests } = await connected()
    const result = await provider.ensureLabels(['Dev', 'Inbox/Travel'])
    expect(requests).toHaveLength(2)
    expect(result.get('Dev')?.id).toBe('M-DEV')
    expect(result.get('Inbox/Travel')?.id).toBe('M-TRV')
  })

  test('creates bare names under the modal parent of existing user labels', async () => {
    const { provider, requests } = await connected([
      jmapResponse(['Mailbox/set', { created: { c0: { id: 'M-TEL' }, c1: { id: 'M-MED' } } }, '0']),
      mailboxGet([
        ...MAILBOXES,
        { id: 'M-TEL', name: 'Telecom', parentId: 'P-F', role: null, totalEmails: 0 },
        { id: 'M-MED', name: 'Media', parentId: 'P-F', role: null, totalEmails: 0 },
      ]),
    ])
    const result = await provider.ensureLabels(['Telecom', 'Media', 'Dev'])
    const [setCall] = methodCallsOf(requests[2])
    expect(setCall?.[0]).toBe('Mailbox/set')
    // Dev/Travel both live under P-F, so P-F is the modal parent for bare names
    expect(setCall?.[1]['create']).toEqual({
      c0: { name: 'Telecom', parentId: 'P-F' },
      c1: { name: 'Media', parentId: 'P-F' },
    })
    expect(requests).toHaveLength(4)
    expect(result.get('Telecom')).toEqual({
      id: 'M-TEL',
      name: 'Telecom',
      path: 'Inbox/Telecom',
      parentId: 'P-F',
      role: null,
      totalEmails: 0,
    })
    expect(result.get('Media')?.id).toBe('M-MED')
    expect(result.get('Dev')?.id).toBe('M-DEV')
  })

  test("'Inbox/New' path form creates under the named parent", async () => {
    const { provider, requests } = await connected([
      jmapResponse(['Mailbox/set', { created: { c0: { id: 'M-NEW' } } }, '0']),
      mailboxGet([
        ...MAILBOXES,
        { id: 'M-NEW', name: 'New', parentId: 'P-F', role: null, totalEmails: 0 },
      ]),
    ])
    const result = await provider.ensureLabels(['Inbox/New'])
    const [setCall] = methodCallsOf(requests[2])
    expect(setCall?.[1]['create']).toEqual({ c0: { name: 'New', parentId: 'P-F' } })
    expect(result.get('Inbox/New')?.id).toBe('M-NEW')
  })

  test('missing parent in a path is created first and referenced by client id', async () => {
    const { provider, requests } = await connected([
      jmapResponse([
        'Mailbox/set',
        { created: { c0: { id: 'M-PRJ' }, c1: { id: 'M-ACME' } } },
        '0',
      ]),
      mailboxGet([
        ...MAILBOXES,
        { id: 'M-PRJ', name: 'Projects', parentId: 'P-F', role: null, totalEmails: 0 },
        { id: 'M-ACME', name: 'Acme', parentId: 'M-PRJ', role: null, totalEmails: 0 },
      ]),
    ])
    const result = await provider.ensureLabels(['Projects/Acme'])
    const [setCall] = methodCallsOf(requests[2])
    expect(setCall?.[1]['create']).toEqual({
      c0: { name: 'Projects', parentId: 'P-F' },
      c1: { name: 'Acme', parentId: '#c0' },
    })
    expect(result.get('Projects/Acme')?.id).toBe('M-ACME')
  })

  test('notCreated → TransportError naming the failed label', async () => {
    const { provider } = await connected([
      jmapResponse([
        'Mailbox/set',
        { created: {}, notCreated: { c0: { type: 'forbidden', description: 'quota reached' } } },
        '0',
      ]),
    ])
    const error = await rejectionOf(provider.ensureLabels(['Telecom']))
    expect(error).toBeInstanceOf(TransportError)
    expect((error as Error).message).toContain('Telecom')
    expect((error as Error).message).toContain('forbidden')
  })
})

const EMAIL_1 = {
  id: 'e1',
  threadId: 't1',
  subject: 'Trip receipt',
  from: [{ name: 'Booking', email: 'NoReply@Booking.COM' }],
  receivedAt: '2026-06-20T08:30:00Z',
  keywords: { $answered: true },
  mailboxIds: { 'P-F': true, 'M-TRV': true },
  preview: 'Your receipt is attached',
}
const EMAIL_2 = {
  id: 'e2',
  subject: 'Deploy done',
  from: [],
  receivedAt: '2026-06-21T09:00:00Z',
  keywords: { $seen: true },
  mailboxIds: { 'M-DEV': true },
  preview: '',
}

describe('JmapMailProvider.searchEmails', () => {
  test('issues Email/query + back-referenced Email/get and maps EmailMeta', async () => {
    const { provider, requests } = await connected([
      jmapResponse(
        ['Email/query', { ids: ['e1', 'e2'], position: 0, total: 2 }, 'q0'],
        ['Email/get', { list: [EMAIL_1, EMAIL_2] }, 'g0'],
      ),
    ])
    const page = await provider.searchEmails(
      { inMailbox: 'inbox', text: 'receipt' },
      { position: 0, limit: 50 },
    )

    const calls = methodCallsOf(requests[2])
    expect(calls).toHaveLength(2)
    const [queryCall, getCall] = calls
    expect(queryCall?.[0]).toBe('Email/query')
    expect(queryCall?.[1]['filter']).toEqual({ inMailbox: 'P-F', text: 'receipt' })
    expect(queryCall?.[1]['sort']).toEqual([{ property: 'receivedAt', isAscending: false }])
    expect(queryCall?.[1]['position']).toBe(0)
    expect(queryCall?.[1]['limit']).toBe(50)
    expect(getCall?.[0]).toBe('Email/get')
    expect(getCall?.[1]['#ids']).toEqual({
      resultOf: queryCall?.[2] as string,
      name: 'Email/query',
      path: '/ids',
    })
    expect(getCall?.[1]['properties']).toEqual([
      'id',
      'threadId',
      'subject',
      'from',
      'receivedAt',
      'keywords',
      'mailboxIds',
      'preview',
    ])

    expect(page.total).toBe(2)
    expect(page.position).toBe(0)
    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toEqual({
      id: 'e1',
      threadId: 't1',
      subject: 'Trip receipt',
      from: { name: 'Booking', email: 'noreply@booking.com' },
      receivedAt: '2026-06-20T08:30:00Z',
      isUnread: true,
      isAnswered: true,
      labels: ['Inbox', 'Travel'],
      snippet: 'Your receipt is attached',
    })
    expect(page.items[1]).toEqual({
      id: 'e2',
      threadId: undefined,
      subject: 'Deploy done',
      from: { name: '', email: '' },
      receivedAt: '2026-06-21T09:00:00Z',
      isUnread: false,
      isAnswered: false,
      labels: ['Dev'],
      snippet: '',
    })
  })

  test('resolves a label-name inMailbox to its mailbox id', async () => {
    const { provider, requests } = await connected([
      jmapResponse(
        ['Email/query', { ids: [], position: 0, total: 0 }, 'q0'],
        ['Email/get', { list: [] }, 'g0'],
      ),
    ])
    await provider.searchEmails({ inMailbox: 'Dev' }, { position: 0, limit: 10 })
    const [queryCall] = methodCallsOf(requests[2])
    expect(queryCall?.[1]['filter']).toEqual({ inMailbox: 'M-DEV' })
  })

  test('unknown inMailbox label → TransportError without fetching', async () => {
    const { provider, requests } = await connected()
    const error = await rejectionOf(
      provider.searchEmails({ inMailbox: 'Nope' }, { position: 0, limit: 10 }),
    )
    expect(error).toBeInstanceOf(TransportError)
    expect(requests).toHaveLength(2)
  })
})

describe('JmapMailProvider.getEmail', () => {
  test('fetches one email by id', async () => {
    const { provider } = await connected([jmapResponse(['Email/get', { list: [EMAIL_1] }, 'g0'])])
    const email = await provider.getEmail('e1')
    expect(email.subject).toBe('Trip receipt')
    expect(email.labels).toEqual(['Inbox', 'Travel'])
  })

  test('not found → TransportError', async () => {
    const { provider } = await connected([
      jmapResponse(['Email/get', { list: [], notFound: ['e9'] }, 'g0']),
    ])
    const error = await rejectionOf(provider.getEmail('e9'))
    expect(error).toBeInstanceOf(TransportError)
    expect((error as Error).message).toContain('e9')
  })
})

describe('JmapMailProvider.addLabels', () => {
  test('patches mailboxIds/<id>: true for every email in one request', async () => {
    const { provider, requests } = await connected([
      jmapResponse(['Email/set', { updated: { e1: null, e2: null } }, '0']),
    ])
    await provider.addLabels(['e1', 'e2'], ['Dev', 'Travel'])
    expect(requests).toHaveLength(3)
    const [setCall] = methodCallsOf(requests[2])
    expect(setCall?.[0]).toBe('Email/set')
    expect(setCall?.[1]['update']).toEqual({
      e1: { 'mailboxIds/M-DEV': true, 'mailboxIds/M-TRV': true },
      e2: { 'mailboxIds/M-DEV': true, 'mailboxIds/M-TRV': true },
    })
  })

  test('missing label → TransportError pointing at ensureLabels, before any fetch', async () => {
    const { provider, requests } = await connected()
    const error = await rejectionOf(provider.addLabels(['e1'], ['Nope']))
    expect(error).toBeInstanceOf(TransportError)
    expect((error as Error).message).toContain('Nope')
    expect((error as Error).message).toContain('ensureLabels')
    expect(requests).toHaveLength(2)
  })

  test('notUpdated with a non-rate-limit SetError → TransportError naming the email', async () => {
    const { provider } = await connected([
      jmapResponse(['Email/set', { notUpdated: { e1: { type: 'notFound' } } }, '0']),
    ])
    const error = await rejectionOf(provider.addLabels(['e1'], ['Dev']))
    expect(error).toBeInstanceOf(TransportError)
    expect((error as Error).message).toContain('e1')
    expect((error as Error).message).toContain('notFound')
  })
})

describe('JmapMailProvider.archive', () => {
  test('patch removes inbox and adds archive, touching nothing else', async () => {
    const { provider, requests } = await connected([
      jmapResponse(['Email/set', { updated: { e1: null, e2: null } }, '0']),
    ])
    await provider.archive(['e1', 'e2'])
    const [setCall] = methodCallsOf(requests[2])
    expect(setCall?.[0]).toBe('Email/set')
    expect(setCall?.[1]['update']).toEqual({
      e1: { 'mailboxIds/P-F': null, 'mailboxIds/M-ARC': true },
      e2: { 'mailboxIds/P-F': null, 'mailboxIds/M-ARC': true },
    })
  })
})

describe('JmapMailProvider rate limiting', () => {
  test('HTTP 429 on Email/set → RateLimitError', async () => {
    const { provider } = await connected([{ status: 429, body: {} }])
    const error = await rejectionOf(provider.archive(['e1']))
    expect(error).toBeInstanceOf(RateLimitError)
  })

  test('notUpdated SetError of type rateLimit → RateLimitError', async () => {
    const { provider } = await connected([
      jmapResponse(['Email/set', { notUpdated: { e1: { type: 'rateLimit' } } }, '0']),
    ])
    const error = await rejectionOf(provider.addLabels(['e1'], ['Dev']))
    expect(error).toBeInstanceOf(RateLimitError)
  })

  test('notCreated SetError of type rateLimit in ensureLabels → RateLimitError', async () => {
    const { provider } = await connected([
      jmapResponse([
        'Mailbox/set',
        { created: {}, notCreated: { c0: { type: 'rateLimit' } } },
        '0',
      ]),
    ])
    const error = await rejectionOf(provider.ensureLabels(['Telecom']))
    expect(error).toBeInstanceOf(RateLimitError)
  })
})
