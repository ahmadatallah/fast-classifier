import { describe, expect, test } from 'bun:test'
import { paginate } from '../../src/provider/paging.js'
import { MemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { EmailMeta } from '../../src/types.js'
import type { PageRequest } from '../../src/provider/types.js'
import type { SearchQuery } from '../../src/types.js'

function recordingSleep() {
  const calls: number[] = []
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms)
    return Promise.resolve()
  }
  return { calls, sleep }
}

function inboxEmails(count: number): EmailMeta[] {
  return Array.from({ length: count }, (_, i) => makeEmail({ id: `e${i}` }))
}

function spyRequests(provider: MemoryMailProvider): PageRequest[] {
  const requests: PageRequest[] = []
  const original = provider.searchEmails.bind(provider)
  provider.searchEmails = (query: SearchQuery, page: PageRequest) => {
    requests.push(page)
    return original(query, page)
  }
  return requests
}

async function inboxIds(provider: MemoryMailProvider): Promise<string[]> {
  const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 0, limit: 1000 })
  return page.items.map((e) => e.id)
}

describe('Pager drain mode (paging under mutation)', () => {
  test('archiving consumer with skips: every eligible email yielded exactly once', async () => {
    const emails = inboxEmails(120)
    const provider = new MemoryMailProvider(emails)
    const { calls, sleep } = recordingSleep()
    const pager = paginate(provider, { inMailbox: 'inbox' }, { pageLimit: 10, sleep })

    // like the filer: unmatched (every 4th) stays in the inbox, the rest is
    // labeled+archived — which shifts the offset window under the pager
    const shouldSkip = (id: string) => Number(id.slice(1)) % 4 === 0
    const yielded: string[] = []
    for await (const email of pager) {
      yielded.push(email.id)
      if (shouldSkip(email.id)) pager.skip(email.id)
      else await provider.archive([email.id])
    }

    // no email yielded twice — the seen-set defeats the shifting window
    expect(new Set(yielded).size).toBe(yielded.length)
    // everything eligible yielded exactly once
    expect(yielded.length).toBe(120)
    expect([...yielded].sort()).toEqual(emails.map((e) => e.id).sort())
    // skipped items were stepped over (position = skippedCount), and remain in the inbox
    const remaining = await inboxIds(provider)
    expect(remaining.sort()).toEqual(
      emails
        .map((e) => e.id)
        .filter(shouldSkip)
        .sort(),
    )
    // 12 full pages of fresh items + 1 empty page past the 30 skipped
    expect(pager.stats).toEqual({ yielded: 120, skipped: 30, pages: 13, stalledOut: false })
    // never stalled, so backoff never slept
    expect(calls).toEqual([])
  })

  test('drain requests always use position = skippedCount', async () => {
    const provider = new MemoryMailProvider(inboxEmails(9))
    const requests = spyRequests(provider)
    const { sleep } = recordingSleep()
    const pager = paginate(provider, { inMailbox: 'inbox' }, { pageLimit: 3, sleep })

    for await (const email of pager) {
      // skip one email per page, archive the rest
      if (Number(email.id.slice(1)) % 3 === 0) pager.skip(email.id)
      else await provider.archive([email.id])
    }

    // skipped count after each page: 0, 1, 2 — then the empty probe at 3
    expect(requests.map((r) => r.position)).toEqual([0, 1, 2, 3])
    expect(pager.stats.yielded).toBe(9)
    expect(pager.stats.skipped).toBe(3)
  })

  test('non-mutating consumer stalls out after stallLimit all-seen passes', async () => {
    const provider = new MemoryMailProvider(inboxEmails(5))
    const { calls, sleep } = recordingSleep()
    const pager = paginate(
      provider,
      { inMailbox: 'inbox' },
      { stallLimit: 4, stallBackoffMs: 777, sleep },
    )

    const yielded: string[] = []
    for await (const email of pager) yielded.push(email.id) // no archive, no skip

    expect(yielded).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    expect(pager.stats.stalledOut).toBe(true)
    // 1 fresh page + (stallLimit + 1) all-seen pages, backoff slept stallLimit times
    expect(pager.stats.pages).toBe(6)
    expect(calls).toEqual([777, 777, 777, 777])
    expect(pager.stats.yielded).toBe(5)
    expect(pager.stats.skipped).toBe(0)
  })

  test('resume: pre-seeded seen ids are never yielded and eventually stall the drain', async () => {
    const provider = new MemoryMailProvider(inboxEmails(6))
    const { sleep } = recordingSleep()
    const seen = new Set(['e1', 'e4']) // "already handled" per a previous run's audit log
    const pager = paginate(provider, { inMailbox: 'inbox' }, { seen, stallLimit: 2, sleep })

    const yielded: string[] = []
    for await (const email of pager) {
      yielded.push(email.id)
      await provider.archive([email.id])
    }

    expect(yielded).toEqual(['e0', 'e2', 'e3', 'e5'])
    // the pre-seeded ids still sit in the inbox; only stall detection ends the loop
    expect(pager.stats.stalledOut).toBe(true)
    expect((await inboxIds(provider)).sort()).toEqual(['e1', 'e4'])
    expect(seen.size).toBe(6)
  })
})

describe('Pager scan mode', () => {
  test('positions advance by items.length over a static mailbox', async () => {
    const provider = new MemoryMailProvider(inboxEmails(25))
    const requests = spyRequests(provider)
    const pager = paginate(provider, { inMailbox: 'inbox' }, { mode: 'scan', pageLimit: 10 })

    const yielded: string[] = []
    for await (const email of pager) yielded.push(email.id)

    expect(yielded).toEqual(Array.from({ length: 25 }, (_, i) => `e${i}`))
    expect(requests.map((r) => r.position)).toEqual([0, 10, 20, 25])
    expect(pager.stats).toEqual({ yielded: 25, skipped: 0, pages: 4, stalledOut: false })
  })

  test('max cap stops yielding mid-page', async () => {
    const provider = new MemoryMailProvider(inboxEmails(25))
    const pager = paginate(
      provider,
      { inMailbox: 'inbox' },
      { mode: 'scan', pageLimit: 10, max: 13 },
    )

    const yielded: string[] = []
    for await (const email of pager) yielded.push(email.id)

    expect(yielded).toEqual(Array.from({ length: 13 }, (_, i) => `e${i}`))
    expect(pager.stats.yielded).toBe(13)
    expect(pager.stats.pages).toBe(2)
  })

  test('resume: pre-seeded seen ids are filtered out of a scan', async () => {
    const provider = new MemoryMailProvider(inboxEmails(10))
    const seen = new Set(['e0', 'e3', 'e7'])
    const pager = paginate(provider, { inMailbox: 'inbox' }, { mode: 'scan', seen })

    const yielded: string[] = []
    for await (const email of pager) yielded.push(email.id)

    expect(yielded).toEqual(['e1', 'e2', 'e4', 'e5', 'e6', 'e8', 'e9'])
  })
})

describe('Pager page limit clamping', () => {
  test('requested limit is clamped to caps.maxPageSize', async () => {
    const provider = new MemoryMailProvider(inboxEmails(7), { caps: { maxPageSize: 3 } })
    const requests = spyRequests(provider)
    const pager = paginate(provider, { inMailbox: 'inbox' }, { mode: 'scan', pageLimit: 50 })

    const yielded: string[] = []
    for await (const email of pager) yielded.push(email.id)

    expect(yielded.length).toBe(7)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((r) => r.limit === 3)).toBe(true)
  })

  test('a pageLimit below the cap is used as-is', async () => {
    const provider = new MemoryMailProvider(inboxEmails(4), { caps: { maxPageSize: 3 } })
    const requests = spyRequests(provider)
    const pager = paginate(provider, { inMailbox: 'inbox' }, { mode: 'scan', pageLimit: 2 })

    const yielded: string[] = []
    for await (const email of pager) yielded.push(email.id)
    expect(yielded.length).toBe(4)

    expect(requests.every((r) => r.limit === 2)).toBe(true)
  })
})

describe('mode contract: non-mutating (dry-run) consumers (review finding)', () => {
  test('scan mode yields EVERY page for a non-mutating consumer over a large inbox', async () => {
    const provider = new MemoryMailProvider(inboxEmails(120))
    const { sleep } = recordingSleep()
    const pager = paginate(provider, { inMailbox: 'inbox' }, { mode: 'scan', pageLimit: 50, sleep })
    const ids: string[] = []
    for await (const email of pager) ids.push(email.id) // reads only — a dry-run planning pass
    expect(ids).toHaveLength(120)
    expect(new Set(ids).size).toBe(120)
    expect(pager.stats.stalledOut).toBe(false)
  })

  test('drain mode with a non-mutating consumer stalls out and under-reports — the documented trap', async () => {
    const provider = new MemoryMailProvider(inboxEmails(120))
    const { sleep } = recordingSleep()
    const pager = paginate(
      provider,
      { inMailbox: 'inbox' },
      { mode: 'drain', pageLimit: 50, sleep },
    )
    const ids: string[] = []
    for await (const email of pager) ids.push(email.id)
    // page 1 only, then stall-out: this is WHY pipelines must derive
    // mode from their dryRun flag
    expect(ids).toHaveLength(50)
    expect(pager.stats.stalledOut).toBe(true)
  })
})
