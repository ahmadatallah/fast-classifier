import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../src/config/load.js'
import { makeHarness } from './helpers.js'

describe('init', () => {
  test('writes the starter config with package import and env guidance', async () => {
    const h = await makeHarness([])
    const dir = join(h.tmpDir, 'project')
    await h.run('init', dir)

    const content = readFileSync(join(dir, 'fast-classifier.config.ts'), 'utf8')
    expect(content).toContain("import { defineConfig } from 'fast-classifier/config'")
    expect(content).toContain('export default defineConfig({')
    expect(content).toContain("targetLabel: 'Promotion'")
    // tokens must never be scaffolded into the config file
    expect(content).not.toMatch(/FASTMAIL_(API|MCP)_TOKEN\s*[:=]/)
    expect(h.stdoutText()).toContain('FASTMAIL_API_TOKEN')
    expect(h.exitCodes).toEqual([])
  })

  test('the starter config passes schema validation end-to-end', async () => {
    const h = await makeHarness([])
    const dir = join(h.tmpDir, 'project')
    await h.run('init', dir)

    // point the package import at the local source so bun can load the file
    const localIndex = fileURLToPath(new URL('../../src/config/index.ts', import.meta.url))
    const localized = readFileSync(join(dir, 'fast-classifier.config.ts'), 'utf8').replace(
      "'fast-classifier/config'",
      `'${localIndex}'`,
    )
    const rewritten = join(dir, 'starter-localized.config.ts')
    writeFileSync(rewritten, localized)

    const { config } = await loadConfig(rewritten)
    expect(config.categories.map((c) => c.name)).toContain('Finance')
    expect(config.rules).toHaveLength(15)
    expect(config.sweep.targetLabel).toBe('Promotion')
  })

  test('refuses to overwrite an existing config', async () => {
    const h = await makeHarness([])
    const dir = join(h.tmpDir, 'project')
    await h.run('init', dir)
    const before = readFileSync(join(dir, 'fast-classifier.config.ts'), 'utf8')

    await h.run('init', dir)
    expect(h.exitCodes).toEqual([1])
    expect(h.stderrText()).toContain('refusing to overwrite')
    const after = readFileSync(join(dir, 'fast-classifier.config.ts'), 'utf8')
    expect(after).toBe(before)
  })
})
