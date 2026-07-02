import { describe, test, expect } from 'bun:test'
import { McpMailProvider } from '../../../src/provider/mcp/provider.js'

interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

/**
 * Fake fetch that speaks just enough MCP: answers initialize/notifications,
 * routes tools/call by tool name to canned data (wrapped as content[] text),
 * and records every JSON-RPC call.
 */
function makeProvider(routes: Record<string, unknown>) {
  const calls: RecordedCall[] = []
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string
      params?: Record<string, unknown>
    }
    calls.push({ method: body.method, params: body.params ?? {} })
    let result: unknown = {}
    if (body.method === 'tools/call') {
      const name = body.params?.['name'] as string
      if (!(name in routes)) throw new Error(`unrouted tool: ${name}`)
      result = { content: [{ type: 'text', text: JSON.stringify(routes[name]) }] }
    }
    const sse = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`
    return Promise.resolve(
      new Response(sse, { status: 200, headers: { 'mcp-session-id': 'sess-1' } }),
    )
  }) as typeof fetch
  const provider = new McpMailProvider({ token: 'test-token', fetch: fetchImpl })
  const toolCalls = () =>
    calls
      .filter((c) => c.method === 'tools/call')
      .map((c) => ({
        name: c.params['name'] as string,
        args: c.params['arguments'] as Record<string, unknown>,
      }))
  return { provider, calls, toolCalls }
}

const rawEmail = {
  id: 'M1',
  threadId: 'T1',
  subject: 'Hello',
  from: [{ name: 'Alice', email: 'Alice@Example.COM' }],
  receivedAt: '2026-06-01T10:00:00Z',
  isRead: true,
  isAnswered: false,
  labels: ['Inbox'],
  preview: 'hey there',
}

describe('McpMailProvider basics', () => {
  test('kind and capabilities', () => {
    const { provider } = makeProvider({})
    expect(provider.kind).toBe('mcp')
    expect(provider.caps).toEqual({
      maxPageSize: 50,
      serverSideNotFrom: 'address-only',
      autoCreatesLabels: true,
      canSetLabelColor: false,
    })
  })

  test('connect performs the initialize handshake', async () => {
    const { provider, calls } = makeProvider({})
    await provider.connect()
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized'])
  })
})

describe('McpMailProvider.searchEmails', () => {
  test('normalizes an array-shaped response', async () => {
    const { provider } = makeProvider({ search_email: [rawEmail] })
    const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 0, limit: 50 })
    expect(page.items).toHaveLength(1)
    expect(page.position).toBe(0)
    expect(page.items[0]?.id).toBe('M1')
  })

  test('normalizes an {items}-shaped response', async () => {
    const { provider } = makeProvider({ search_email: { items: [rawEmail], total: 1 } })
    const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 10, limit: 50 })
    expect(page.items).toHaveLength(1)
    expect(page.position).toBe(10)
  })

  test('compiles the query and clamps limit to 50 even when caller passes 100', async () => {
    const { provider, toolCalls } = makeProvider({ search_email: [] })
    await provider.searchEmails(
      { inMailbox: 'inbox', text: 'unsubscribe' },
      { position: 25, limit: 100 },
    )
    expect(toolCalls()).toEqual([
      {
        name: 'search_email',
        args: { query: 'in:inbox unsubscribe', limit: 50, position: 25 },
      },
    ])
  })

  test('maps EmailMeta: isRead inverted, from[0] lowercased, preview becomes snippet', async () => {
    const { provider } = makeProvider({ search_email: [rawEmail] })
    const page = await provider.searchEmails({}, { position: 0, limit: 10 })
    expect(page.items[0]).toEqual({
      id: 'M1',
      threadId: 'T1',
      subject: 'Hello',
      from: { name: 'Alice', email: 'alice@example.com' },
      receivedAt: '2026-06-01T10:00:00Z',
      isUnread: false,
      isAnswered: false,
      labels: ['Inbox'],
      snippet: 'hey there',
    })
  })

  test('tolerates missing from/subject/labels', async () => {
    const { provider } = makeProvider({
      search_email: [{ id: 'M2', receivedAt: '2026-06-02T00:00:00Z', isRead: false }],
    })
    const page = await provider.searchEmails({}, { position: 0, limit: 10 })
    expect(page.items[0]).toEqual({
      id: 'M2',
      threadId: undefined,
      subject: '',
      from: { name: '', email: '' },
      receivedAt: '2026-06-02T00:00:00Z',
      isUnread: true,
      isAnswered: undefined,
      labels: [],
      snippet: undefined,
    })
  })
})

describe('McpMailProvider.getEmail', () => {
  test('reads by id and maps the first result', async () => {
    const { provider, toolCalls } = makeProvider({ read_email: { items: [rawEmail] } })
    const email = await provider.getEmail('M1')
    expect(email.from.email).toBe('alice@example.com')
    expect(toolCalls()).toEqual([{ name: 'read_email', args: { ids: ['M1'] } }])
  })

  test('not found throws TransportError', async () => {
    const { provider } = makeProvider({ read_email: [] })
    const err = await provider.getEmail('missing').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('TransportError')
  })
})

describe('McpMailProvider labels', () => {
  const serverLabels = [
    { id: 'L1', name: 'Dev', path: 'Inbox/Dev', parentId: 'inbox-id', totalEmails: 12 },
    { id: 'L2', name: 'Promotion', path: 'Promotion', role: null },
  ]

  test('listLabels maps to Label', async () => {
    const { provider } = makeProvider({ list_labels: serverLabels })
    const labels = await provider.listLabels()
    expect(labels).toHaveLength(2)
    expect(labels[0]).toEqual({
      id: 'L1',
      name: 'Dev',
      path: 'Inbox/Dev',
      parentId: 'inbox-id',
      role: undefined,
      totalEmails: 12,
    })
  })

  test('ensureLabels matches bare names against nested paths', async () => {
    const { provider } = makeProvider({ list_labels: serverLabels })
    const map = await provider.ensureLabels(['Dev', 'Inbox/Dev', 'Promotion'])
    expect(map.get('Dev')?.id).toBe('L1')
    expect(map.get('Inbox/Dev')?.id).toBe('L1')
    expect(map.get('Promotion')?.id).toBe('L2')
  })

  test('ensureLabels returns a placeholder for missing labels without throwing', async () => {
    const { provider, toolCalls } = makeProvider({ list_labels: serverLabels })
    const map = await provider.ensureLabels(['Dev', 'Brand-New'])
    // No create-label tool exists; the label materializes on first addLabels
    expect(map.get('Brand-New')).toEqual({ id: '', name: 'Brand-New' })
    expect(map.get('Dev')?.id).toBe('L1')
    expect(toolCalls().map((c) => c.name)).toEqual(['list_labels'])
  })

  test('addLabels calls update_email with ids and addLabels', async () => {
    const { provider, toolCalls } = makeProvider({ update_email: 'updated 2 emails' })
    await provider.addLabels(['M1', 'M2'], ['Dev', 'Work'])
    expect(toolCalls()).toEqual([
      { name: 'update_email', args: { ids: ['M1', 'M2'], addLabels: ['Dev', 'Work'] } },
    ])
  })
})

describe('McpMailProvider.archive', () => {
  test('uses archive_email with ids only — never update_email removeLabels', async () => {
    const { provider, toolCalls } = makeProvider({ archive_email: 'archived 2 emails' })
    await provider.archive(['M1', 'M2'])
    expect(toolCalls()).toEqual([{ name: 'archive_email', args: { ids: ['M1', 'M2'] } }])
  })
})
