import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEmail } from '../../src/provider/memory.js'
import type { EmailMeta } from '../../src/types.js'
import { inboxLabels, makeHarness } from './helpers.js'

function newsletterInbox(): EmailMeta[] {
  return [
    makeEmail({
      id: 'n1',
      from: { name: 'Shop News', email: 'news@shop.example' },
      subject: 'Big sale',
      snippet: 'click here to unsubscribe',
    }),
    makeEmail({
      id: 'n2',
      from: { name: 'Shop News', email: 'news@shop.example' },
      subject: 'Weekly deals',
      snippet: 'unsubscribe at any time',
    }),
    makeEmail({
      id: 'p1',
      from: { name: 'Alice', email: 'alice@example.org' },
      subject: 'lunch tomorrow?',
      snippet: 'see you then',
    }),
  ]
}

describe('sweep', () => {
  test('without --execute: dry-run banner, provider unmutated, report written', async () => {
    const h = await makeHarness(newsletterInbox())
    await h.run('sweep')

    expect(h.stderrText()).toContain('DRY RUN — no changes will be made (pass --execute to apply)')
    expect(await inboxLabels(h.provider, 'n1')).toEqual(['Inbox'])
    expect(await inboxLabels(h.provider, 'n2')).toEqual(['Inbox'])

    const reportPath = join(h.reportDir, 'sweep-report.json')
    expect(existsSync(reportPath)).toBe(true)
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      meta: { dryRun: boolean; command: string }
      planned: number
      executed: number
    }
    expect(report.meta.command).toBe('sweep')
    expect(report.meta.dryRun).toBe(true)
    expect(report.planned).toBe(2)
    expect(report.executed).toBe(0)
    expect(h.exitCodes).toEqual([])
  })

  test('--execute --yes mutates: labels + archives swept mail, audits, no banner', async () => {
    const h = await makeHarness(newsletterInbox())
    await h.run('sweep', '--execute', '--yes')

    expect(h.stderrText()).not.toContain('DRY RUN')
    expect(await inboxLabels(h.provider, 'n1')).toEqual(['Promotion'])
    expect(await inboxLabels(h.provider, 'n2')).toEqual(['Promotion'])
    expect(await inboxLabels(h.provider, 'p1')).toEqual(['Inbox'])

    const report = JSON.parse(readFileSync(join(h.reportDir, 'sweep-report.json'), 'utf8')) as {
      executed: number
      meta: { dryRun: boolean }
    }
    expect(report.executed).toBe(2)
    expect(report.meta.dryRun).toBe(false)

    const audit = readFileSync(join(h.reportDir, 'sweep.log.tsv'), 'utf8')
    const lines = audit.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('news@shop.example')
    expect(h.exitCodes).toEqual([])
  })

  test('--execute above the confirm threshold without --yes aborts with exit code 1', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      makeEmail({
        id: `bulk-${i}`,
        from: { name: 'Bulk', email: 'bulk@flood.example' },
        snippet: 'unsubscribe',
      }),
    )
    const h = await makeHarness(many)
    await h.run('sweep', '--execute')

    const report = JSON.parse(readFileSync(join(h.reportDir, 'sweep-report.json'), 'utf8')) as {
      executed: number
      skippedByConfirm: boolean
    }
    expect(report.skippedByConfirm).toBe(true)
    expect(report.executed).toBe(0)
    expect(await inboxLabels(h.provider, 'bulk-0')).toEqual(['Inbox'])
    expect(h.exitCodes).toEqual([1])
    expect(h.stderrText()).toContain('confirmation declined')
  })

  test('--json prints the parseable report to stdout', async () => {
    const h = await makeHarness(newsletterInbox())
    await h.run('sweep', '--json')

    const report = JSON.parse(h.stdoutText()) as { planned: number; meta: { dryRun: boolean } }
    expect(report.planned).toBe(2)
    expect(report.meta.dryRun).toBe(true)
  })
})
