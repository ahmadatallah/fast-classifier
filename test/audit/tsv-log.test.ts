import { describe, test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTsvAudit } from '../../src/audit/tsv-log.js'

const tempDir = (): string => {
  return mkdtempSync(join(tmpdir(), 'tsv-audit-'))
}

describe('openTsvAudit', () => {
  test('creates parent dirs and an empty file when missing', async () => {
    const path = join(tempDir(), 'deeply', 'nested', 'audit.tsv')
    const audit = await openTsvAudit(path)
    expect(existsSync(audit.path)).toBe(true)
    expect(readFileSync(audit.path, 'utf8')).toBe('')
    expect(audit.processedIds.size).toBe(0)
  })

  test('append then re-open loads the ids (resume)', async () => {
    const path = join(tempDir(), 'audit.tsv')
    const first = await openTsvAudit(path)
    first.append({ id: 'm1', action: 'file', category: 'Dev', sender: 'a@b.c' })
    first.append({ id: 'm2', action: 'sweep', sender: 'news@x.y' })

    const resumed = await openTsvAudit(path)
    expect(resumed.has('m1')).toBe(true)
    expect(resumed.has('m2')).toBe(true)
    expect(resumed.processedIds).toEqual(new Set(['m1', 'm2']))
  })

  test('tolerates legacy 2-column and 3-column session logs', async () => {
    const path = join(tempDir(), 'moved.log')
    writeFileSync(
      path,
      'legacy2\tsender@example.com\n' + // sweep.mjs: id\tfrom
        'legacy3\tDev\tsender@example.com\n' + // filer.mjs: id\tcategory\tfrom
        'modern\tfile\tDev\tsender@example.com\n',
    )
    const audit = await openTsvAudit(path)
    expect(audit.has('legacy2')).toBe(true)
    expect(audit.has('legacy3')).toBe(true)
    expect(audit.has('modern')).toBe(true)
    expect(audit.processedIds.size).toBe(3)
  })
})

describe('TsvAudit.append', () => {
  test('writes one 4-column line per record', async () => {
    const audit = await openTsvAudit(join(tempDir(), 'audit.tsv'))
    audit.append({ id: 'm1', action: 'file', category: 'Dev', sender: 'a@b.c' })
    audit.append({ id: 'm2', action: 'archive' })
    expect(readFileSync(audit.path, 'utf8')).toBe('m1\tfile\tDev\ta@b.c\nm2\tarchive\t\t\n')
  })

  test('sanitizes tabs and newlines inside values', async () => {
    const audit = await openTsvAudit(join(tempDir(), 'audit.tsv'))
    audit.append({ id: 'm1', action: 'file', category: 'Dev', sender: 'evil\tsender\nname' })
    const lines = readFileSync(audit.path, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.split('\t')).toEqual(['m1', 'file', 'Dev', 'evil sender name'])
  })
})

describe('TsvAudit.has', () => {
  test('true for appended ids, false otherwise', async () => {
    const audit = await openTsvAudit(join(tempDir(), 'audit.tsv'))
    expect(audit.has('m1')).toBe(false)
    audit.append({ id: 'm1', action: 'file' })
    expect(audit.has('m1')).toBe(true)
    expect(audit.has('m2')).toBe(false)
  })

  test('processedIds is a copy — mutating it does not affect the audit', async () => {
    const audit = await openTsvAudit(join(tempDir(), 'audit.tsv'))
    audit.append({ id: 'm1', action: 'file' })
    audit.processedIds.delete('m1')
    expect(audit.has('m1')).toBe(true)
  })
})
