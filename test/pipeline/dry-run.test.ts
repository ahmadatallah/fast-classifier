import { describe, expect, test } from 'bun:test'
import {
  executeActions,
  fileInbox,
  readProvider,
  sweepNewsletters,
} from '../../src/pipeline/index.js'
import type { PlannedAction } from '../../src/pipeline/index.js'
import { MemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import { DryRunViolation } from '../../src/safety/index.js'
import type { EmailMeta } from '../../src/types.js'
import { inboxIds, makeCtx, recordingProvider } from './helpers.js'

function bulkEmails(count: number): EmailMeta[] {
  return Array.from({ length: count }, (_, i) =>
    makeEmail({
      id: `b${i}`,
      from: { name: 'Deals', email: `deals${i % 7}@shop.example` },
      snippet: 'unsubscribe',
    }),
  )
}

describe('dry-run', () => {
  test('sweep dry-run returns the full multi-page plan with zero mutating calls', async () => {
    // 120 emails at pageLimit 10 = 12+ pages; scan mode must see them all
    const inner = new MemoryMailProvider(bulkEmails(120), { caps: { maxPageSize: 10 } })
    const { provider, mutations } = recordingProvider(inner)
    const { ctx, logs } = makeCtx(provider, { dryRun: true })

    const report = await sweepNewsletters(ctx)

    expect(report.meta.dryRun).toBe(true)
    expect(report.scanned).toBe(120)
    expect(report.planned).toBe(120)
    expect(report.executed).toBe(0)
    expect(report.skippedByConfirm).toBe(false)
    expect(report.topSenders).toHaveLength(7)
    expect(mutations).toEqual([])
    expect(await inboxIds(inner)).toHaveLength(120)
    expect(logs.some((line) => line.includes('keepList is empty'))).toBe(true)
  })

  test('file dry-run plans across pages without touching the provider', async () => {
    const emails = Array.from({ length: 30 }, (_, i) =>
      makeEmail({ id: `f${i}`, from: { name: 'Bank', email: 'billing@bank.example' } }),
    )
    const inner = new MemoryMailProvider(emails, { caps: { maxPageSize: 7 } })
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider, {
      dryRun: true,
      config: {
        categories: [{ name: 'Finance', label: 'Inbox/Finance' }],
        rules: [{ kind: 'domain', domain: 'bank.example', category: 'Finance' }],
      },
    })

    const report = await fileInbox(ctx)

    expect(report.scanned).toBe(30)
    expect(report.planned).toBe(30)
    expect(report.executed).toBe(0)
    expect(report.tally).toEqual({ Finance: 30 })
    expect(report.coveragePercent).toBe(100)
    expect(mutations).toEqual([])
    expect(await inboxIds(inner)).toHaveLength(30)
  })

  test('readProvider hands out a provider whose mutators throw DryRunViolation', async () => {
    const { ctx } = makeCtx(new MemoryMailProvider(bulkEmails(2)), { dryRun: true })
    const provider = readProvider(ctx)

    expect(() => provider.addLabels(['b0'], ['X'])).toThrow(DryRunViolation)
    expect(() => provider.archive(['b0'])).toThrow(DryRunViolation)
    expect(() => provider.ensureLabels(['X'])).toThrow(DryRunViolation)
    // reads still work
    const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 0, limit: 10 })
    expect(page.items).toHaveLength(2)
  })

  test('readProvider returns the raw provider when not in dry-run', () => {
    const provider = new MemoryMailProvider([])
    const { ctx } = makeCtx(provider)
    expect(readProvider(ctx)).toBe(provider)
  })

  test('executeActions in dry-run returns immediately, before any provider call', async () => {
    const inner = new MemoryMailProvider(bulkEmails(3))
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider, { dryRun: true })
    const actions: PlannedAction[] = [
      {
        emailId: 'b0',
        sender: 'deals0@shop.example',
        addLabels: ['X'],
        archive: true,
        reason: 'r',
      },
    ]

    const result = await executeActions(ctx, 'test', actions)

    expect(result).toEqual({ executed: 0, skippedByConfirm: false })
    expect(mutations).toEqual([])
  })
})
