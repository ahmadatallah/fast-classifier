import { describe, expect, test } from 'bun:test'
import { executeActions, sweepNewsletters } from '../../src/pipeline/index.js'
import type { PlannedAction } from '../../src/pipeline/index.js'
import { MemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import { denyAll } from '../../src/safety/confirm.js'
import type { EmailMeta } from '../../src/types.js'
import { inboxIds, makeCtx, recordingProvider } from './helpers.js'

function emailsAndActions(
  count: number,
  label = 'Bulk',
): {
  emails: EmailMeta[]
  actions: PlannedAction[]
} {
  const emails = Array.from({ length: count }, (_, i) =>
    makeEmail({ id: `e${i}`, from: { name: 'S', email: 'sender@example.com' } }),
  )
  const actions = emails.map((email) => ({
    emailId: email.id,
    sender: email.from.email,
    addLabels: [label],
    archive: true,
    reason: 'test',
  }))
  return { emails, actions }
}

describe('executeActions confirmation gate', () => {
  test('denyAll above the default threshold skips without a single mutating call', async () => {
    const { emails, actions } = emailsAndActions(101)
    const inner = new MemoryMailProvider(emails)
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider, { confirm: denyAll })

    const result = await executeActions(ctx, 'test', actions)

    expect(result).toEqual({ executed: 0, skippedByConfirm: true })
    expect(mutations).toEqual([])
    expect(await inboxIds(inner)).toHaveLength(101)
  })

  test('exactly at the threshold no confirmation is needed — denyAll still proceeds', async () => {
    const { emails, actions } = emailsAndActions(5)
    const provider = new MemoryMailProvider(emails)
    let confirmCalls = 0
    const { ctx } = makeCtx(provider, {
      confirmThreshold: 5,
      confirm: () => {
        confirmCalls++
        return Promise.resolve(false)
      },
    })

    const result = await executeActions(ctx, 'test', actions)

    expect(confirmCalls).toBe(0)
    expect(result).toEqual({ executed: 5, skippedByConfirm: false })
    expect(await inboxIds(provider)).toHaveLength(0)
  })

  test('one above a custom threshold triggers the gate', async () => {
    const { emails, actions } = emailsAndActions(6)
    const provider = new MemoryMailProvider(emails)
    const { ctx } = makeCtx(provider, { confirmThreshold: 5, confirm: denyAll })

    const result = await executeActions(ctx, 'test', actions)

    expect(result).toEqual({ executed: 0, skippedByConfirm: true })
    expect(await inboxIds(provider)).toHaveLength(6)
  })

  test('an approving confirm sees the count and top-5 label tally, then execution proceeds', async () => {
    const { emails } = emailsAndActions(101)
    const actions: PlannedAction[] = emails.map((email, i) => ({
      emailId: email.id,
      sender: email.from.email,
      addLabels: [i < 60 ? 'Big' : 'Small'],
      archive: true,
      reason: 'test',
    }))
    const provider = new MemoryMailProvider(emails)
    const summaries: string[] = []
    const { ctx } = makeCtx(provider, {
      confirm: (summary) => {
        summaries.push(summary)
        return Promise.resolve(true)
      },
    })

    const result = await executeActions(ctx, 'test', actions)

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('101 planned mutations')
    expect(summaries[0]).toContain('Big: 60')
    expect(summaries[0]).toContain('Small: 41')
    expect(result).toEqual({ executed: 101, skippedByConfirm: false })
    expect(await inboxIds(provider)).toHaveLength(0)
    expect((await provider.getEmail('e0')).labels).toEqual(['Big'])
    expect((await provider.getEmail('e100')).labels).toEqual(['Small'])
  })

  test('a denied sweep reports skippedByConfirm and leaves the inbox intact', async () => {
    const emails = Array.from({ length: 3 }, (_, i) =>
      makeEmail({
        id: `n${i}`,
        from: { name: 'Deals', email: 'deals@shop.example' },
        snippet: 'unsubscribe',
      }),
    )
    const inner = new MemoryMailProvider(emails)
    const { provider, mutations } = recordingProvider(inner)
    const { ctx } = makeCtx(provider, { confirm: denyAll, confirmThreshold: 2 })

    const report = await sweepNewsletters(ctx)

    expect(report.planned).toBe(3)
    expect(report.executed).toBe(0)
    expect(report.skippedByConfirm).toBe(true)
    expect(mutations).toEqual([])
    expect(await inboxIds(inner)).toHaveLength(3)
  })
})
