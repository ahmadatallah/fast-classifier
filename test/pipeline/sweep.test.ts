import { describe, expect, test } from 'bun:test'
import { sweepNewsletters } from '../../src/pipeline/index.js'
import type { MemoryMailProvider } from '../../src/provider/memory.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { PageRequest } from '../../src/provider/types.js'
import type { EmailMeta, SearchPage, SearchQuery } from '../../src/types.js'
import { expectMeta, inboxIds, makeCtx } from './helpers.js'

const KEEP = 'friend@example.com'

/**
 * Simulates the MCP quirk at its worst: caps say 'address-only' and the
 * server-side notFrom filter is deliberately DROPPED, so keep-listed senders
 * come back from search and only the client-side re-check protects them.
 */
const createNotFromIgnoringProvider = (emails: EmailMeta[]): MemoryMailProvider => {
  const inner = createMemoryMailProvider(emails, { caps: { serverSideNotFrom: 'address-only' } })
  return {
    ...inner,
    searchEmails: (query: SearchQuery, page: PageRequest): Promise<SearchPage> =>
      inner.searchEmails({ ...query, notFrom: undefined }, page),
  }
}

const sweepInbox = (): EmailMeta[] => {
  return [
    makeEmail({
      id: 'k1',
      from: { name: 'Friend', email: KEEP },
      subject: 'my little newsletter',
      snippet: 'unsubscribe link at the bottom',
    }),
    makeEmail({
      id: 'n1',
      from: { name: 'Deals', email: 'deals@shop.example' },
      snippet: 'unsubscribe',
    }),
    makeEmail({
      id: 'n2',
      from: { name: 'Deals', email: 'deals@shop.example' },
      snippet: 'unsubscribe',
    }),
    makeEmail({
      id: 'n3',
      from: { name: 'News', email: 'news@paper.example' },
      snippet: 'click to unsubscribe',
    }),
    makeEmail({
      id: 'p1',
      from: { name: 'Human', email: 'human@example.org' },
      subject: 'lunch tomorrow?',
      snippet: 'see you there',
    }),
  ]
}

describe('sweepNewsletters', () => {
  test('client-side keep re-check protects keep-listed senders even when notFrom is ignored', async () => {
    const provider = createNotFromIgnoringProvider(sweepInbox())
    const { ctx } = makeCtx(provider, { config: { keepList: [KEEP] } })

    const report = await sweepNewsletters(ctx)

    expectMeta(report.meta, 'sweep', false)
    // k1 matches the text heuristic and IS returned by search — the re-check catches it
    expect(report.scanned).toBe(4)
    expect(report.keptOut).toBe(1)
    expect(report.planned).toBe(3)
    expect(report.executed).toBe(3)
    expect(report.skippedByConfirm).toBe(false)

    expect((await inboxIds(provider)).sort()).toEqual(['k1', 'p1'])
    const swept = await provider.getEmail('n1')
    expect(swept.labels).toContain('Promotion')
    expect(swept.labels).not.toContain('Inbox')
    // the keep-listed email is completely untouched
    expect((await provider.getEmail('k1')).labels).toEqual(['Inbox'])

    expect(report.topSenders).toEqual([
      { email: 'deals@shop.example', count: 2 },
      { email: 'news@paper.example', count: 1 },
    ])
  })

  test('warns when keepList is empty', async () => {
    const provider = createMemoryMailProvider(sweepInbox())
    const { ctx, logs } = makeCtx(provider)

    await sweepNewsletters(ctx)

    expect(logs.some((line) => line.includes('keepList is empty'))).toBe(true)
  })

  test('does not warn when keepList is populated', async () => {
    const provider = createMemoryMailProvider(sweepInbox())
    const { ctx, logs } = makeCtx(provider, { config: { keepList: [KEEP] } })

    await sweepNewsletters(ctx)

    expect(logs.some((line) => line.includes('keepList is empty'))).toBe(false)
  })

  test('targetLabel and after overrides are honored', async () => {
    const emails = [
      ...sweepInbox(),
      makeEmail({
        id: 'old1',
        from: { name: 'Ancient', email: 'ancient@paper.example' },
        snippet: 'unsubscribe',
        receivedAt: '2020-06-01T00:00:00Z',
      }),
    ]
    const provider = createMemoryMailProvider(emails)
    const { ctx } = makeCtx(provider, { config: { keepList: [KEEP] } })

    const report = await sweepNewsletters(ctx, { targetLabel: 'Bulk', after: '2025-01-01' })

    // old1 falls outside the after window; k1 is filtered server-side here
    // because MemoryMailProvider honors notFrom in full
    expect(report.scanned).toBe(3)
    expect(report.keptOut).toBe(0)
    expect(report.planned).toBe(3)
    expect((await provider.getEmail('n1')).labels).toContain('Bulk')
    expect((await provider.getEmail('old1')).labels).toEqual(['Inbox'])
  })
})
