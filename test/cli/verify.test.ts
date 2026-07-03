import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseLabelExpectation } from '../../src/cli/commands.js'
import { makeEmail } from '../../src/provider/memory.js'
import type { EmailMeta } from '../../src/types.js'
import { makeHarness } from './helpers.js'

function verifiableInbox(): EmailMeta[] {
  return [
    makeEmail({
      id: 'v1',
      from: { name: 'Bulk', email: 'bulk@promo.example' },
      labels: ['Inbox'],
    }),
    makeEmail({
      id: 'v2',
      from: { name: 'Keep', email: 'keep@example.org' },
      labels: ['Inbox'],
    }),
    makeEmail({
      id: 'v3',
      from: { name: 'Old', email: 'old@promo.example' },
      labels: ['Promotion'],
    }),
    makeEmail({
      id: 'v4',
      from: { name: 'Old', email: 'old@promo.example' },
      labels: ['Promotion'],
    }),
  ]
}

describe('verify', () => {
  test('--cleared fails when the sender still has inbox mail: exit code 1 + FAIL line', async () => {
    const h = await makeHarness(verifiableInbox())
    await h.run('verify', '--cleared', 'bulk@promo.example')

    expect(h.exitCodes).toEqual([1])
    expect(h.stdoutText()).toContain('FAIL')
    expect(h.stdoutText()).toContain('verify: FAILED')
    expect(existsSync(join(h.reportDir, 'verify-report.json'))).toBe(true)
  })

  test('--cleared passes when the inbox has nothing from the sender', async () => {
    const h = await makeHarness(verifiableInbox())
    await h.run('verify', '--cleared', 'old@promo.example', '--contains', 'keep@example.org')

    expect(h.exitCodes).toEqual([])
    expect(h.stdoutText()).toContain('verify: all checks passed')
  })

  test('--label expectations: exact and minimum totals', async () => {
    const h = await makeHarness(verifiableInbox())
    await h.run('verify', '--label', 'Promotion=2', 'Promotion>=1')
    expect(h.exitCodes).toEqual([])

    const failing = await makeHarness(verifiableInbox())
    await failing.run('verify', '--label', 'Promotion=3')
    expect(failing.exitCodes).toEqual([1])
    expect(failing.stdoutText()).toContain('expected exactly 3')
  })

  test('--json prints the parseable verify report', async () => {
    const h = await makeHarness(verifiableInbox())
    await h.run('verify', '--json', '--cleared', 'bulk@promo.example')

    const report = JSON.parse(h.stdoutText()) as {
      passed: boolean
      checks: { ok: boolean }[]
    }
    expect(report.passed).toBe(false)
    expect(report.checks).toHaveLength(1)
    expect(h.exitCodes).toEqual([1])
  })

  test('parseLabelExpectation handles bare, exact, and minimum specs', () => {
    expect(parseLabelExpectation('Promotion')).toEqual({ name: 'Promotion' })
    expect(parseLabelExpectation('Promotion=7')).toEqual({ name: 'Promotion', exactTotal: 7 })
    expect(parseLabelExpectation('Inbox/Dev>=2')).toEqual({ name: 'Inbox/Dev', minTotal: 2 })
    expect(parseLabelExpectation('=5')).toEqual({ name: '=5' })
  })
})
