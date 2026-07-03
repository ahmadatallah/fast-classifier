import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEmail } from '../../src/provider/memory.js'
import { inboxLabels, makeHarness } from './helpers.js'

const FILE_CONFIG = {
  categories: [{ name: 'Dev', label: 'Inbox/Dev' }],
  rules: [{ kind: 'domain', domain: 'ci.example', category: 'Dev' }],
}

describe('analyze / plan', () => {
  test('analyze --json prints a parseable report and writes the report file', async () => {
    const h = await makeHarness([
      makeEmail({ id: 'a1', from: { name: 'CI', email: 'builds@ci.example' } }),
      makeEmail({ id: 'a2', from: { name: 'CI', email: 'builds@ci.example' } }),
    ])
    await h.run('analyze', '--json')

    const report = JSON.parse(h.stdoutText()) as {
      scanned: number
      senders: { email: string; count: number }[]
    }
    expect(report.scanned).toBe(2)
    expect(report.senders[0]).toMatchObject({ email: 'builds@ci.example', count: 2 })
    const onDisk = JSON.parse(readFileSync(join(h.reportDir, 'analyze-report.json'), 'utf8')) as {
      scanned: number
    }
    expect(onDisk.scanned).toBe(2)
  })

  test('plan reports coverage without mutating', async () => {
    const h = await makeHarness(
      [
        makeEmail({ id: 'p1', from: { name: 'CI', email: 'builds@ci.example' } }),
        makeEmail({ id: 'p2', from: { name: 'Stranger', email: 'someone@nowhere.example' } }),
      ],
      { config: FILE_CONFIG },
    )
    await h.run('plan', '--json')

    const report = JSON.parse(h.stdoutText()) as {
      matched: number
      coveragePercent: number
      distribution: Record<string, number>
    }
    expect(report.matched).toBe(1)
    expect(report.coveragePercent).toBe(50)
    expect(report.distribution['Dev']).toBe(1)
    expect(await inboxLabels(h.provider, 'p1')).toEqual(['Inbox'])
  })
})

describe('file', () => {
  test('--execute --yes files matched mail into the category label', async () => {
    const h = await makeHarness(
      [
        makeEmail({ id: 'f1', from: { name: 'CI', email: 'builds@ci.example' } }),
        makeEmail({ id: 'f2', from: { name: 'Stranger', email: 'someone@nowhere.example' } }),
      ],
      { config: FILE_CONFIG },
    )
    await h.run('file', '--execute', '--yes')

    expect(await inboxLabels(h.provider, 'f1')).toEqual(['Inbox/Dev'])
    expect(await inboxLabels(h.provider, 'f2')).toEqual(['Inbox'])
    const audit = readFileSync(join(h.reportDir, 'file.log.tsv'), 'utf8')
    expect(audit).toContain('f1\tfile\tInbox/Dev\tbuilds@ci.example')
  })
})

describe('needs-action', () => {
  test('--apply --execute tags candidates without archiving', async () => {
    const h = await makeHarness([
      makeEmail({
        id: 'na1',
        from: { name: 'Compliance', email: 'kyc@bank.example' },
        subject: 'Action required: please confirm your identity',
        receivedAt: new Date().toISOString(),
      }),
      makeEmail({
        id: 'na2',
        from: { name: 'Shop', email: 'news@shop.example' },
        subject: 'your order has shipped',
        receivedAt: new Date().toISOString(),
      }),
    ])
    await h.run('needs-action', '--apply', '--execute', '--yes')

    expect(await inboxLabels(h.provider, 'na1')).toEqual(['Inbox', 'Needs action'])
    expect(await inboxLabels(h.provider, 'na2')).toEqual(['Inbox'])
    const report = JSON.parse(
      readFileSync(join(h.reportDir, 'needs-action-report.json'), 'utf8'),
    ) as { tagged: number; candidates: { id: string }[] }
    expect(report.tagged).toBe(1)
    expect(report.candidates[0]?.id).toBe('na1')
  })

  test('--apply without --execute stays a dry run with banner', async () => {
    const h = await makeHarness([
      makeEmail({
        id: 'na1',
        from: { name: 'Compliance', email: 'kyc@bank.example' },
        subject: 'Action required: please confirm your identity',
        receivedAt: new Date().toISOString(),
      }),
    ])
    await h.run('needs-action', '--apply')

    expect(h.stderrText()).toContain('DRY RUN')
    expect(await inboxLabels(h.provider, 'na1')).toEqual(['Inbox'])
  })
})

describe('labels', () => {
  test('list prints label totals', async () => {
    const h = await makeHarness([
      makeEmail({ id: 'l1', labels: ['Inbox', 'Promotion'] }),
      makeEmail({ id: 'l2', labels: ['Inbox'] }),
    ])
    await h.run('labels', 'list', '--json')

    const report = JSON.parse(h.stdoutText()) as {
      labels: { name: string; totalEmails: number }[]
    }
    const promo = report.labels.find((label) => label.name === 'Promotion')
    expect(promo?.totalEmails).toBe(1)
  })

  test('ensure is dry-run by default and creates with --execute', async () => {
    const h = await makeHarness([])
    await h.run('labels', 'ensure', 'Inbox/Test')
    expect(h.stderrText()).toContain('DRY RUN')
    expect((await h.provider.listLabels()).map((l) => l.path ?? l.name)).not.toContain('Inbox/Test')

    await h.run('labels', 'ensure', 'Inbox/Test', '--execute')
    expect((await h.provider.listLabels()).map((l) => l.path ?? l.name)).toContain('Inbox/Test')
  })
})
