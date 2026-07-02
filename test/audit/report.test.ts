import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { writeReport } from '../../src/audit/report.js'

const TOKEN = 'fmu1-999-deadbeef-cafe-4444-8888-0123456789ab'

describe('writeReport', () => {
  test('creates nested dir, writes redacted pretty JSON, returns absolute path', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'report-')), 'runs', 'today')
    const path = await writeReport(dir, 'sweep', {
      meta: { command: `sweep --token ${TOKEN}`, dryRun: false },
      moved: 5,
    })
    expect(path).toBe(join(dir, 'sweep-report.json'))
    expect(isAbsolute(path)).toBe(true)

    const content = readFileSync(path, 'utf8')
    expect(content).not.toContain(TOKEN)
    expect(content).not.toContain('fmu1-')
    expect(content).toContain('[REDACTED]')
    // pretty-printed with 2-space indent
    expect(content).toContain('\n  "meta"')

    const parsed = JSON.parse(content) as { meta: { command: string }; moved: number }
    expect(parsed.moved).toBe(5)
    expect(parsed.meta.command).toBe('sweep --token [REDACTED]')
  })

  test('overwrites a previous report of the same name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-'))
    const first = await writeReport(dir, 'filer', { filed: 1 })
    const second = await writeReport(dir, 'filer', { filed: 2 })
    expect(second).toBe(first)
    const parsed = JSON.parse(readFileSync(second, 'utf8')) as { filed: number }
    expect(parsed.filed).toBe(2)
  })
})
