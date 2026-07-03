import { describe, expect, test } from 'bun:test'
import { analyzeInbox, planClassification } from '../../src/pipeline/index.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { EmailMeta } from '../../src/types.js'
import { expectMeta, makeCtx, recordingProvider } from './helpers.js'

const reconInbox = (): EmailMeta[] => {
  return [
    makeEmail({ id: 'r1', from: { name: '', email: 'news@shop.example' } }),
    makeEmail({ id: 'r2', from: { name: 'Shop News', email: 'news@shop.example' } }),
    makeEmail({ id: 'r3', from: { name: 'Shop News', email: 'news@shop.example' } }),
    makeEmail({ id: 'r4', from: { name: 'Shop Deals', email: 'deals@shop.example' } }),
    makeEmail({ id: 'r5', from: { name: 'Alice', email: 'alice@friends.example' } }),
    makeEmail({ id: 'r6', from: { name: 'Alice', email: 'alice@friends.example' } }),
    makeEmail({ id: 'r7', from: { name: 'Bank', email: 'billing@bank.example' } }),
  ]
}

describe('analyzeInbox', () => {
  test('aggregates by sender and root domain, sorted desc, never mutating', async () => {
    const inner = createMemoryMailProvider(reconInbox())
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider)

    const report = await analyzeInbox(ctx)

    expectMeta(report.meta, 'analyze', false)
    expect(report.scanned).toBe(7)
    expect(report.senders).toEqual([
      // display name backfilled from the later non-empty sighting
      { email: 'news@shop.example', name: 'Shop News', count: 3 },
      { email: 'alice@friends.example', name: 'Alice', count: 2 },
      { email: 'billing@bank.example', name: 'Bank', count: 1 },
      { email: 'deals@shop.example', name: 'Shop Deals', count: 1 },
    ])
    expect(report.domains).toEqual([
      {
        domain: 'shop.example',
        count: 4,
        sampleSenders: ['news@shop.example', 'deals@shop.example'],
      },
      { domain: 'friends.example', count: 2, sampleSenders: ['alice@friends.example'] },
      { domain: 'bank.example', count: 1, sampleSenders: ['billing@bank.example'] },
    ])
    expect(mutations).toEqual([])
  })

  test('honors a custom query', async () => {
    const emails = [...reconInbox(), makeEmail({ id: 'x1', labels: ['Archive'] })]
    const { ctx } = makeCtx(createMemoryMailProvider(emails))

    const report = await analyzeInbox(ctx, { query: { inMailbox: 'Archive' } })

    expect(report.scanned).toBe(1)
  })

  test('ctx.max caps the scan', async () => {
    const { ctx } = makeCtx(createMemoryMailProvider(reconInbox()), { max: 3 })
    const report = await analyzeInbox(ctx)
    expect(report.scanned).toBe(3)
  })
})

describe('planClassification', () => {
  const PLAN_CONFIG = {
    categories: [
      { name: 'Shopping', label: 'Inbox/Shopping' },
      { name: 'Finance', label: 'Inbox/Finance' },
    ],
    rules: [
      { kind: 'domain' as const, domain: 'shop.example', category: 'Shopping' },
      { kind: 'domain' as const, domain: 'bank.example', category: 'Finance' },
    ],
  }

  test('distribution, coverage to 1 decimal, and unmatched top senders', async () => {
    const inner = createMemoryMailProvider(reconInbox())
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider, { config: PLAN_CONFIG })

    const report = await planClassification(ctx)

    expectMeta(report.meta, 'plan', false)
    expect(report.scanned).toBe(7)
    expect(report.matched).toBe(5)
    // 5/7 = 71.428... -> 71.4
    expect(report.coveragePercent).toBe(71.4)
    expect(report.distribution).toEqual({ Shopping: 4, Finance: 1 })
    expect(Object.keys(report.distribution)).toEqual(['Shopping', 'Finance'])
    expect(report.unmatchedTopSenders).toEqual([
      { email: 'alice@friends.example', name: 'Alice', count: 2 },
    ])
    expect(mutations).toEqual([])
  })

  test('empty inbox yields zero coverage, not NaN', async () => {
    const { ctx } = makeCtx(createMemoryMailProvider([]))
    const report = await planClassification(ctx)
    expect(report).toMatchObject({
      scanned: 0,
      matched: 0,
      coveragePercent: 0,
      distribution: {},
      unmatchedTopSenders: [],
    })
  })
})
