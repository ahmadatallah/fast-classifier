import { describe, expect, test } from 'bun:test'
import { scoreInboxNeedsAction } from '../../src/pipeline/index.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { EmailMeta } from '../../src/types.js'
import { expectMeta, inboxIds, makeCtx, recordingProvider } from './helpers.js'

const NOW = new Date('2026-03-01T00:00:00Z')

const needsActionInbox = (): EmailMeta[] => {
  return [
    // 'action required' +3, 'verify your' +3, unread +1 = 7
    makeEmail({
      id: 'a1',
      subject: 'Action required: verify your account',
      from: { name: 'Service', email: 'service@bank.example' },
      receivedAt: '2026-02-20T10:00:00Z',
    }),
    // 'deadline' +3, unread +1 = 4
    makeEmail({
      id: 'a2',
      subject: 'Deadline approaching',
      from: { name: 'Service', email: 'service@bank.example' },
      receivedAt: '2026-02-25T10:00:00Z',
    }),
    // same score as a2 but newer — must sort before it
    makeEmail({
      id: 'a3',
      subject: 'Deadline approaching',
      from: { name: 'Service', email: 'service@bank.example' },
      receivedAt: '2026-02-26T10:00:00Z',
    }),
    // outside the 60-day window — never even scanned
    makeEmail({
      id: 'old1',
      subject: 'Action required: ancient business',
      from: { name: 'Service', email: 'service@bank.example' },
      receivedAt: '2025-11-01T00:00:00Z',
    }),
    // 'newsletter' -2, 'unsubscribe' -2, unread +1 = -3
    makeEmail({
      id: 'n1',
      subject: 'Weekly newsletter',
      snippet: 'unsubscribe anytime',
      from: { name: 'Paper', email: 'news@paper.example' },
      receivedAt: '2026-02-22T10:00:00Z',
    }),
  ]
}

describe('scoreInboxNeedsAction', () => {
  test('window filtering, scoring, and sort order (score desc, then receivedAt desc)', async () => {
    const provider = createMemoryMailProvider(needsActionInbox())
    const { ctx } = makeCtx(provider)

    const report = await scoreInboxNeedsAction(ctx, { now: NOW })

    expectMeta(report.meta, 'needs-action', false)
    expect(report.scanned).toBe(4) // old1 excluded by the after cutoff
    expect(report.candidates.map((c) => c.id)).toEqual(['a1', 'a3', 'a2'])
    expect(report.tagged).toBe(0)

    const top = report.candidates[0]
    expect(top?.score).toBe(7)
    expect(top?.signals).toContain('action required')
    expect(top?.signals).toContain('verify your')
    expect(top?.subject).toBe('Action required: verify your account')
    expect(top?.from.email).toBe('service@bank.example')
  })

  test('apply tags candidates without archiving them', async () => {
    const provider = createMemoryMailProvider(needsActionInbox())
    const { ctx } = makeCtx(provider)

    const report = await scoreInboxNeedsAction(ctx, { apply: true, now: NOW })

    expect(report.tagged).toBe(3)
    for (const id of ['a1', 'a2', 'a3']) {
      const email = await provider.getEmail(id)
      expect(email.labels).toContain('Needs action')
      // tagging never archives
      expect(email.labels).toContain('Inbox')
    }
    expect((await provider.getEmail('n1')).labels).toEqual(['Inbox'])
    expect(await inboxIds(provider)).toHaveLength(5)
  })

  test('apply in dry-run tags nothing and never calls a mutator', async () => {
    const inner = createMemoryMailProvider(needsActionInbox())
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider, { dryRun: true })

    const report = await scoreInboxNeedsAction(ctx, { apply: true, now: NOW })

    expect(report.meta.dryRun).toBe(true)
    expect(report.candidates).toHaveLength(3)
    expect(report.tagged).toBe(0)
    expect(mutations).toEqual([])
    expect((await inner.getEmail('a1')).labels).toEqual(['Inbox'])
  })

  test('windowDays config moves the after cutoff', async () => {
    const provider = createMemoryMailProvider(needsActionInbox())
    const { ctx } = makeCtx(provider, { config: { needsAction: { windowDays: 365 } } })

    const report = await scoreInboxNeedsAction(ctx, { now: NOW })

    // old1 is now inside the window and scores as a candidate
    expect(report.scanned).toBe(5)
    expect(report.candidates.map((c) => c.id)).toContain('old1')
  })
})
