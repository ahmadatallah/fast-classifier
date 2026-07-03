import { describe, expect, test } from 'bun:test'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { MemoryMailProvider } from '../../src/provider/memory.js'
import type { SearchQuery } from '../../src/types.js'

const searchIds = async (
  provider: MemoryMailProvider,
  query: SearchQuery,
  position = 0,
  limit = 100,
): Promise<string[]> => {
  const page = await provider.searchEmails(query, { position, limit })
  return page.items.map((e) => e.id)
}

describe('makeEmail', () => {
  test('fills sane defaults', () => {
    const email = makeEmail({ id: 'x' })
    expect(email).toEqual({
      id: 'x',
      subject: '',
      snippet: '',
      from: { name: '', email: 'sender@example.com' },
      receivedAt: '2026-01-01T00:00:00Z',
      isUnread: true,
      labels: ['Inbox'],
    })
  })

  test('overrides win', () => {
    const email = makeEmail({ id: 'y', subject: 'Hi', labels: ['Archive'], isUnread: false })
    expect(email.subject).toBe('Hi')
    expect(email.labels).toEqual(['Archive'])
    expect(email.isUnread).toBe(false)
  })
})

describe('MemoryMailProvider search filters', () => {
  const corpus = () => [
    makeEmail({
      id: 'a',
      subject: 'Weekly UNSUBSCRIBE digest',
      from: { name: 'Shop', email: 'news@shop.com' },
      receivedAt: '2026-01-05T10:00:00Z',
    }),
    makeEmail({
      id: 'b',
      snippet: 'click here to unsubscribe from this list',
      from: { name: 'Bank', email: 'alerts@bank.com' },
      receivedAt: '2025-12-30T10:00:00Z',
      isUnread: false,
    }),
    makeEmail({
      id: 'c',
      subject: 'Invoice',
      from: { name: 'Shop', email: 'news@shop.com' },
      labels: ['Promotion'], // archived: not in Inbox
      receivedAt: '2026-01-01T00:00:00Z',
    }),
  ]

  test("inMailbox 'inbox' matches the Inbox label", async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { inMailbox: 'inbox' })).toEqual(['a', 'b'])
  })

  test('inMailbox with any other value matches that label name', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { inMailbox: 'Promotion' })).toEqual(['c'])
  })

  test('text matches subject and snippet, case-insensitively', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { text: 'unsubscribe' })).toEqual(['a', 'b'])
    expect(await searchIds(provider, { text: 'INVOICE' })).toEqual(['c'])
  })

  test('from is an exact address match', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { from: 'news@shop.com' })).toEqual(['a', 'c'])
    expect(await searchIds(provider, { from: 'shop.com' })).toEqual([])
  })

  test('notFrom excludes those addresses', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { notFrom: ['news@shop.com'] })).toEqual(['b'])
  })

  test("notFrom behaves the same under caps.serverSideNotFrom 'address-only'", async () => {
    const provider = createMemoryMailProvider(corpus(), {
      caps: { serverSideNotFrom: 'address-only' },
    })
    expect(provider.caps.serverSideNotFrom).toBe('address-only')
    expect(await searchIds(provider, { notFrom: ['news@shop.com'] })).toEqual(['b'])
  })

  test('after keeps receivedAt >= after (boundary inclusive)', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { after: '2026-01-01' })).toEqual(['a', 'c'])
    expect(await searchIds(provider, { after: '2025-12-01' })).toEqual(['a', 'b', 'c'])
  })

  test('unreadOnly drops read emails', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { unreadOnly: true })).toEqual(['a', 'c'])
  })

  test('filters combine (AND)', async () => {
    const provider = createMemoryMailProvider(corpus())
    expect(await searchIds(provider, { inMailbox: 'inbox', text: 'unsubscribe' })).toEqual([
      'a',
      'b',
    ])
    expect(
      await searchIds(provider, {
        inMailbox: 'inbox',
        text: 'unsubscribe',
        notFrom: ['news@shop.com'],
      }),
    ).toEqual(['b'])
  })

  test('slices [position, position+limit] of the current filtered list', async () => {
    const emails = Array.from({ length: 7 }, (_, i) => makeEmail({ id: `e${i}` }))
    const provider = createMemoryMailProvider(emails)
    const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 2, limit: 3 })
    expect(page.items.map((e) => e.id)).toEqual(['e2', 'e3', 'e4'])
    expect(page.position).toBe(2)
    expect(page.total).toBe(7)
    expect(await searchIds(provider, { inMailbox: 'inbox' }, 6, 3)).toEqual(['e6'])
    expect(await searchIds(provider, { inMailbox: 'inbox' }, 7, 3)).toEqual([])
  })
})

describe('MemoryMailProvider mutations', () => {
  test('archive removes only the Inbox label and is visible to later searches', async () => {
    const provider = createMemoryMailProvider([
      makeEmail({ id: 'a', labels: ['Inbox', 'Dev'] }),
      makeEmail({ id: 'b' }),
    ])
    await provider.archive(['a'])
    expect(await searchIds(provider, { inMailbox: 'inbox' })).toEqual(['b'])
    expect((await provider.getEmail('a')).labels).toEqual(['Dev']) // never deletes other labels
  })

  test('addLabels adds names and auto-creates unknown labels', async () => {
    const provider = createMemoryMailProvider([makeEmail({ id: 'a' })])
    await provider.addLabels(['a'], ['Promotion'])
    expect((await provider.getEmail('a')).labels).toEqual(['Inbox', 'Promotion'])
    // mutation visible in subsequent searches
    expect(await searchIds(provider, { inMailbox: 'Promotion' })).toEqual(['a'])
    const labels = await provider.listLabels()
    expect(labels.some((l) => l.name === 'Promotion')).toBe(true)
  })

  test('addLabels is idempotent per label name', async () => {
    const provider = createMemoryMailProvider([makeEmail({ id: 'a' })])
    await provider.addLabels(['a'], ['Dev'])
    await provider.addLabels(['a'], ['Dev'])
    expect((await provider.getEmail('a')).labels).toEqual(['Inbox', 'Dev'])
  })

  test('addLabels throws on unknown email id', async () => {
    const provider = createMemoryMailProvider([makeEmail({ id: 'a' })])
    await expect(provider.addLabels(['nope'], ['Dev'])).rejects.toThrow('unknown email id')
  })
})

describe('MemoryMailProvider labels', () => {
  test('ensureLabels registers missing names and returns a Label per name', async () => {
    const provider = createMemoryMailProvider([])
    const map = await provider.ensureLabels(['Dev', 'Inbox/Travel'])
    expect(map.get('Dev')?.name).toBe('Dev')
    expect(map.get('Inbox/Travel')?.name).toBe('Travel')
    expect(map.get('Inbox/Travel')?.path).toBe('Inbox/Travel')
    // idempotent: same ids on a second call
    const again = await provider.ensureLabels(['Dev'])
    expect(again.get('Dev')?.id).toBe(map.get('Dev')?.id ?? '')
  })

  test('listLabels returns registered labels plus labels seen on emails, with totalEmails', async () => {
    const provider = createMemoryMailProvider(
      [
        makeEmail({ id: 'a' }),
        makeEmail({ id: 'b', labels: ['Inbox', 'Dev'] }),
        makeEmail({ id: 'c', labels: ['Dev'] }),
      ],
      { labels: ['Finance'] },
    )
    const labels = await provider.listLabels()
    const byName = new Map(labels.map((l) => [l.name, l]))
    expect(byName.get('Inbox')?.totalEmails).toBe(2)
    expect(byName.get('Dev')?.totalEmails).toBe(2)
    expect(byName.get('Finance')?.totalEmails).toBe(0) // registered but unused
  })

  test('caps defaults and overrides', () => {
    const provider = createMemoryMailProvider([])
    expect(provider.kind).toBe('memory')
    expect(provider.caps).toEqual({
      maxPageSize: 50,
      serverSideNotFrom: 'full',
      autoCreatesLabels: true,
      canSetLabelColor: false,
    })
    const tweaked = createMemoryMailProvider([], {
      caps: { maxPageSize: 10, serverSideNotFrom: 'address-only' },
    })
    expect(tweaked.caps.maxPageSize).toBe(10)
    expect(tweaked.caps.serverSideNotFrom).toBe('address-only')
    expect(tweaked.caps.autoCreatesLabels).toBe(true)
  })

  test('getEmail returns known ids and throws on unknown', async () => {
    const provider = createMemoryMailProvider([makeEmail({ id: 'a', subject: 'hey' })])
    expect((await provider.getEmail('a')).subject).toBe('hey')
    await expect(provider.getEmail('zzz')).rejects.toThrow('unknown email id: zzz')
  })
})
