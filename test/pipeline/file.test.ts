import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTsvAudit } from '../../src/audit/index.js'
import { fileInbox } from '../../src/pipeline/index.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { ClassifierConfigInput } from '../../src/config/schema.js'
import type { EmailMeta } from '../../src/types.js'
import { expectMeta, inboxIds, makeCtx } from './helpers.js'

const FILE_CONFIG: ClassifierConfigInput = {
  categories: [
    { name: 'Finance', label: 'Inbox/Finance' },
    { name: 'Dev', label: 'Dev' },
  ],
  rules: [
    { kind: 'domain', domain: 'bank.example', category: 'Finance' },
    { kind: 'domain', domain: 'code.example', category: 'Dev' },
  ],
  keepList: ['boss@bank.example'],
}

const fileEmails = (): EmailMeta[] => {
  return [
    makeEmail({ id: 'f1', from: { name: 'Bank', email: 'billing@bank.example' } }),
    makeEmail({ id: 'f2', from: { name: 'Bank', email: 'billing@bank.example' } }),
    makeEmail({ id: 'f3', from: { name: 'Bank Alerts', email: 'alerts@bank.example' } }),
    makeEmail({ id: 'd1', from: { name: 'Code', email: 'noreply@code.example' } }),
    makeEmail({ id: 'd2', from: { name: 'Code', email: 'noreply@code.example' } }),
    makeEmail({ id: 'kf1', from: { name: 'Boss', email: 'boss@bank.example' } }),
    makeEmail({ id: 'u1', from: { name: 'Mystery', email: 'mystery@unknown.example' } }),
    makeEmail({ id: 'u2', from: { name: 'Other', email: 'other@unknown.example' } }),
  ]
}

describe('fileInbox', () => {
  test('mixed inbox files into per-category labels; unmatched and keep-listed stay', async () => {
    const provider = createMemoryMailProvider(fileEmails())
    const { ctx } = makeCtx(provider, { config: FILE_CONFIG })

    const report = await fileInbox(ctx)

    expectMeta(report.meta, 'file', false)
    expect(report.scanned).toBe(8)
    expect(report.keptOut).toBe(1)
    expect(report.planned).toBe(5)
    expect(report.executed).toBe(5)
    expect(report.skippedByConfirm).toBe(false)
    expect(report.tally).toEqual({ Finance: 3, Dev: 2 })
    expect(report.unmatched).toBe(2)
    expect(report.unmatchedTopSenders).toEqual([
      { email: 'mystery@unknown.example', name: 'Mystery', count: 1 },
      { email: 'other@unknown.example', name: 'Other', count: 1 },
    ])
    // 5 matched of 8 scanned, 1 decimal
    expect(report.coveragePercent).toBe(62.5)

    expect((await inboxIds(provider)).sort()).toEqual(['kf1', 'u1', 'u2'])
    expect((await provider.getEmail('f1')).labels).toEqual(['Inbox/Finance'])
    expect((await provider.getEmail('d1')).labels).toEqual(['Dev'])
    expect((await provider.getEmail('kf1')).labels).toEqual(['Inbox'])
  })

  test('falls back to the category name when no CategoryDef exists', async () => {
    const provider = createMemoryMailProvider([
      makeEmail({ id: 'p1', from: { name: 'Me Elsewhere', email: 'me@home.example' } }),
    ])
    const { ctx } = makeCtx(provider, {
      config: { detection: { personalDomains: ['home.example'] } },
    })

    const report = await fileInbox(ctx)

    // 'Personal' has no CategoryDef — the name doubles as the label
    expect(report.tally).toEqual({ Personal: 1 })
    expect((await provider.getEmail('p1')).labels).toEqual(['Personal'])
  })

  test('categories filter restricts actions but not coverage', async () => {
    const provider = createMemoryMailProvider(fileEmails())
    const { ctx } = makeCtx(provider, { config: FILE_CONFIG })

    const report = await fileInbox(ctx, { categories: ['Finance'] })

    expect(report.planned).toBe(3)
    expect(report.tally).toEqual({ Finance: 3 })
    // Dev emails matched but were not acted on
    expect(report.coveragePercent).toBe(62.5)
    expect((await inboxIds(provider)).sort()).toEqual(['d1', 'd2', 'kf1', 'u1', 'u2'])
  })

  test('audit rows are appended and a resumed run plans zero duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc-pipeline-'))
    const auditPath = join(dir, 'file-audit.tsv')

    const audit = await openTsvAudit(auditPath)
    const provider = createMemoryMailProvider(fileEmails())
    const { ctx } = makeCtx(provider, { config: FILE_CONFIG })
    const first = await fileInbox(ctx, { audit })
    expect(first.executed).toBe(5)

    const lines = (await readFile(auditPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(5)
    const rows = lines.map((line) => line.split('\t'))
    expect(new Set(rows.map((row) => row[0]))).toEqual(new Set(['f1', 'f2', 'f3', 'd1', 'd2']))
    expect(rows.every((row) => row[1] === 'file')).toBe(true)
    const f1Row = rows.find((row) => row[0] === 'f1')
    expect(f1Row?.[2]).toBe('Inbox/Finance')
    expect(f1Row?.[3]).toBe('billing@bank.example')

    // resume after an "interruption": same mailbox state, same audit file —
    // processedIds pre-seed the pager's seen-set, so nothing is re-planned
    const resumedAudit = await openTsvAudit(auditPath)
    const provider2 = createMemoryMailProvider(fileEmails())
    const { ctx: ctx2 } = makeCtx(provider2, { config: FILE_CONFIG })
    const second = await fileInbox(ctx2, { audit: resumedAudit })

    expect(second.planned).toBe(0)
    expect(second.executed).toBe(0)
    // only the never-audited emails were scanned at all
    expect(second.scanned).toBe(3)
    expect((await readFile(auditPath, 'utf8')).trim().split('\n')).toHaveLength(5)
  })

  test('ctx.max caps scanning and planning', async () => {
    const provider = createMemoryMailProvider(fileEmails())
    const { ctx } = makeCtx(provider, { config: FILE_CONFIG, max: 4 })

    const report = await fileInbox(ctx)

    // first four emails are f1..f3, d1 — all matched
    expect(report.scanned).toBe(4)
    expect(report.planned).toBe(4)
    expect(report.executed).toBe(4)
    expect(report.tally).toEqual({ Finance: 3, Dev: 1 })
    expect((await inboxIds(provider)).sort()).toEqual(['d2', 'kf1', 'u1', 'u2'])
  })
})
