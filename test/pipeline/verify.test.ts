import { describe, expect, test } from 'bun:test'
import { verifyRun } from '../../src/pipeline/index.js'
import type { MemoryMailProvider } from '../../src/provider/memory.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import { expectMeta, makeCtx } from './helpers.js'

const verifiedMailbox = (): MemoryMailProvider => {
  return createMemoryMailProvider([
    makeEmail({ id: 'v1', from: { name: 'Alice', email: 'alice@example.com' } }),
    // bob was swept: labeled and archived
    makeEmail({
      id: 'v2',
      from: { name: 'Bob', email: 'bob@example.com' },
      labels: ['Promotion'],
    }),
    makeEmail({
      id: 'v3',
      from: { name: 'Bank', email: 'billing@bank.example' },
      labels: ['Inbox', 'Inbox/Finance'],
    }),
  ])
}

describe('verifyRun', () => {
  test('passing expectations across labels and sender checks', async () => {
    const { ctx } = makeCtx(verifiedMailbox())

    const report = await verifyRun(ctx, {
      labels: [
        { name: 'Finance', minTotal: 1 },
        { name: 'Promotion', exactTotal: 1 },
        { name: 'Inbox' },
      ],
      inboxContainsSenders: ['alice@example.com'],
      inboxClearedSenders: ['bob@example.com'],
    })

    expectMeta(report.meta, 'verify', false)
    expect(report.passed).toBe(true)
    expect(report.checks).toHaveLength(5)
    expect(report.checks.every((check) => check.ok)).toBe(true)
    expect(report.checks.map((check) => check.name)).toEqual([
      'label Finance',
      'label Promotion',
      'label Inbox',
      'inbox contains alice@example.com',
      'inbox cleared of bob@example.com',
    ])
  })

  test('failing expectations produce actionable detail messages', async () => {
    const { ctx } = makeCtx(verifiedMailbox())

    const report = await verifyRun(ctx, {
      labels: [
        { name: 'Ghost', minTotal: 1 },
        { name: 'Promotion', exactTotal: 5 },
        { name: 'Finance', minTotal: 2 },
      ],
      inboxContainsSenders: ['bob@example.com'],
      inboxClearedSenders: ['alice@example.com'],
    })

    expect(report.passed).toBe(false)
    expect(report.checks.map((check) => check.ok)).toEqual([false, false, false, false, false])

    const [ghost, promotion, finance, contains, cleared] = report.checks
    expect(ghost?.detail).toContain("label 'Ghost' not found")
    expect(promotion?.detail).toBe('expected exactly 5 emails, found 1')
    expect(finance?.detail).toBe('expected at least 2 emails, found 1')
    expect(contains?.detail).toContain('no inbox messages from bob@example.com')
    expect(cleared?.detail).toContain('inbox still has messages from alice@example.com')
  })

  test('a single failing check fails the run while others still pass', async () => {
    const { ctx } = makeCtx(verifiedMailbox())

    const report = await verifyRun(ctx, {
      labels: [{ name: 'Promotion', exactTotal: 1 }],
      inboxClearedSenders: ['alice@example.com'],
    })

    expect(report.passed).toBe(false)
    expect(report.checks[0]?.ok).toBe(true)
    expect(report.checks[1]?.ok).toBe(false)
  })

  test('no expectations means a vacuously passing report', async () => {
    const { ctx } = makeCtx(verifiedMailbox())
    const report = await verifyRun(ctx, {})
    expect(report.passed).toBe(true)
    expect(report.checks).toEqual([])
  })
})
