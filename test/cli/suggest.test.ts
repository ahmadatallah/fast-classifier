import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliDeps } from '../../src/cli/main.js'
import { buildProgram } from '../../src/cli/main.js'
import { compileConfig } from '../../src/config/compile.js'
import { loadConfig } from '../../src/config/load.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import { SUGGESTED_CATEGORIES } from '../../src/suggest/index.js'
import type { RuleSuggestion, SuggestionResult } from '../../src/suggest/index.js'
import type { EmailMeta } from '../../src/types.js'
import { inboxLabels, makeHarness, TEST_ENV } from './helpers.js'

/**
 * Seeded inbox: github.com is a catalog hit (Development), zephyrletter.example
 * is unknown, ci.example is covered by SEED_CONFIG. minCount is 2, so every
 * domain appears at least twice.
 */
const seededInbox = (): EmailMeta[] => [
  makeEmail({ id: 'g1', from: { name: 'GitHub', email: 'notifications@github.com' } }),
  makeEmail({ id: 'g2', from: { name: 'GitHub', email: 'noreply@github.com' } }),
  makeEmail({ id: 'u1', from: { name: 'Zephyr', email: 'updates@zephyrletter.example' } }),
  makeEmail({ id: 'u2', from: { name: 'Zephyr', email: 'updates@zephyrletter.example' } }),
  makeEmail({ id: 'u3', from: { name: 'Zephyr', email: 'digest@zephyrletter.example' } }),
  makeEmail({ id: 'c1', from: { name: 'CI', email: 'builds@ci.example' } }),
  makeEmail({ id: 'c2', from: { name: 'CI', email: 'builds@ci.example' } }),
]

const SEED_CONFIG = {
  categories: [{ name: 'Dev', label: 'Inbox/Dev' }],
  rules: [{ kind: 'domain', domain: 'ci.example', category: 'Dev' }],
}

/** Rewrites the package import to the local source so bun can load the file. */
const roundTrip = async (dir: string) => {
  const localIndex = fileURLToPath(new URL('../../src/config/index.ts', import.meta.url))
  const localized = readFileSync(join(dir, 'fast-classifier.config.ts'), 'utf8').replace(
    "'fast-classifier/config'",
    `'${localIndex}'`,
  )
  const rewritten = join(dir, 'roundtrip.config.ts')
  writeFileSync(rewritten, localized)
  const { config } = await loadConfig(rewritten)
  return { config, compiled: compileConfig(config) }
}

/** makeHarness variant with a scripted prompt — mirrors test/cli/helpers.ts. */
const makePromptHarness = async (emails: EmailMeta[], config: unknown, answers: string[]) => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fc-suggest-'))
  const configPath = join(tmpDir, 'fast-classifier.config.json')
  await writeFile(configPath, JSON.stringify(config))

  const provider = createMemoryMailProvider(emails)
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCodes: number[] = []
  const questions: string[] = []
  const queue = [...answers]
  const deps: CliDeps = {
    providerFactory: () => provider,
    env: TEST_ENV,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    exitOverride: true,
    setExitCode: (code) => exitCodes.push(code),
    prompt: (question: string) => {
      questions.push(question)
      return Promise.resolve(queue.shift() ?? 'q')
    },
  }
  return {
    provider,
    tmpDir,
    exitCodes,
    questions,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
    run: async (...args: string[]) => {
      const argv = ['-c', configPath, '--report-dir', join(tmpDir, 'reports'), ...args]
      await buildProgram(deps).parseAsync(argv, { from: 'user' })
    },
  }
}

describe('suggest report', () => {
  test('non-interactive: tables, covered count and paste-ready fragment; read-only', async () => {
    const h = await makeHarness(seededInbox(), { config: SEED_CONFIG })
    await h.run('suggest', '--no-interactive')

    const out = h.stdoutText()
    expect(out).toContain('already covered by your config: 1 domain(s)')
    expect(out).toContain('Catalog suggestions (1):')
    expect(out).toContain('github.com')
    expect(out).toContain('Development')
    expect(out).toContain('Unknown domains (1)')
    expect(out).toContain('zephyrletter.example')
    // the fragment covers ALL catalog suggestions, ready to paste
    expect(out).toContain("{ kind: 'domain', domain: 'github.com', category: 'Development' },")
    expect(out).toContain("{ name: 'Development', label: 'Development'")

    // read-only: nothing was labeled or archived
    expect(await inboxLabels(h.provider, 'g1')).toEqual(['Inbox'])
    expect(await inboxLabels(h.provider, 'u1')).toEqual(['Inbox'])
    expect(h.exitCodes).toEqual([])
  })

  test('--json emits the parseable SuggestionResult', async () => {
    const h = await makeHarness(seededInbox(), { config: SEED_CONFIG })
    await h.run('suggest', '--json')

    const result = JSON.parse(h.stdoutText()) as SuggestionResult
    expect(result.alreadyCovered).toBe(1)
    expect(result.suggestions).toHaveLength(1)
    const first: Partial<RuleSuggestion> | undefined = result.suggestions[0]
    expect(first).toMatchObject({
      domain: 'github.com',
      category: 'Development',
      count: 2,
      source: 'catalog',
    })
    expect(result.unknown).toEqual([
      {
        domain: 'zephyrletter.example',
        count: 3,
        sampleSenders: ['updates@zephyrletter.example', 'digest@zephyrletter.example'],
      },
    ])
    expect(result.categories.map((c) => c.name)).toEqual(['Development'])
  })
})

describe('suggest --write', () => {
  test('writes fast-classifier.config.ts that round-trips through loadConfig+compileConfig', async () => {
    const h = await makeHarness(seededInbox(), { config: SEED_CONFIG })
    const dir = join(h.tmpDir, 'fresh-project')
    await h.run('suggest', dir, '--no-interactive', '--write')

    const target = join(dir, 'fast-classifier.config.ts')
    expect(existsSync(target)).toBe(true)
    const content = readFileSync(target, 'utf8')
    expect(content).toContain("import { defineConfig } from 'fast-classifier/config'")
    expect(content).toContain('export default defineConfig({')
    expect(content).not.toMatch(/FASTMAIL_(API|MCP)_TOKEN\s*[:=]/)
    expect(h.stdoutText()).toContain(`wrote ${target}`)
    expect(h.exitCodes).toEqual([])

    const { config, compiled } = await roundTrip(dir)
    expect(config.categories.map((c) => c.name)).toEqual(['Development'])
    expect(compiled.domainMap.get('github.com')).toBe('Development')
    // unknown domains are never written without an explicit assignment
    expect(compiled.domainMap.has('zephyrletter.example')).toBe(false)
  })

  test('refuses to touch an existing config but prints the fragment, exit 0', async () => {
    const h = await makeHarness(seededInbox(), { config: SEED_CONFIG })
    const dir = join(h.tmpDir, 'existing-project')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'fast-classifier.config.ts')
    const original = '// pre-existing user config — must never change\n'
    writeFileSync(target, original)

    await h.run('suggest', dir, '--no-interactive', '--write')

    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(h.stderrText()).toContain(`refusing to modify existing config: ${target}`)
    expect(h.stdoutText()).toContain(
      "{ kind: 'domain', domain: 'github.com', category: 'Development' },",
    )
    expect(h.exitCodes).toEqual([])
  })
})

describe('suggest --interactive', () => {
  test('scripted session: catalog batch accepted, one unknown domain assigned by number', async () => {
    const newsNumber = String(SUGGESTED_CATEGORIES.findIndex((c) => c.name === 'News') + 1)
    const h = await makePromptHarness(seededInbox(), SEED_CONFIG, ['y', newsNumber])
    const dir = join(h.tmpDir, 'interactive-project')
    await h.run('suggest', dir, '--interactive', '--write')

    expect(h.questions[0]).toBe('Accept 1 catalog suggestion(s)? [Y/n] ')
    expect(h.questions[1]).toContain('zephyrletter.example (3 emails; updates@zephyrletter.example')
    // the menu offers the suggested categories plus the user's own config categories
    expect(h.stdoutText()).toContain('7. News')
    expect(h.stdoutText()).toContain('13. Dev')

    const { config, compiled } = await roundTrip(dir)
    expect(compiled.domainMap.get('github.com')).toBe('Development')
    expect(compiled.domainMap.get('zephyrletter.example')).toBe('News')
    expect(config.categories.map((c) => c.name).sort()).toEqual(['Development', 'News'])
    expect(h.exitCodes).toEqual([])
  })

  test("declining the catalog batch and quitting the walk writes nothing ('q')", async () => {
    const h = await makePromptHarness(seededInbox(), SEED_CONFIG, ['n', 'q'])
    const dir = join(h.tmpDir, 'declined-project')
    await h.run('suggest', dir, '--interactive', '--write')

    expect(existsSync(join(dir, 'fast-classifier.config.ts'))).toBe(false)
    expect(h.stdoutText()).toContain('no suggestions accepted — no config written')
    expect(h.exitCodes).toEqual([])
  })
})

describe('init --from-inbox', () => {
  test('writes a config built from the inbox suggestions', async () => {
    const h = await makePromptHarness(seededInbox(), SEED_CONFIG, ['y', 'q'])
    const dir = join(h.tmpDir, 'init-project')
    await h.run('init', dir, '--from-inbox')

    const target = join(dir, 'fast-classifier.config.ts')
    expect(existsSync(target)).toBe(true)
    expect(h.stdoutText()).toContain(`wrote ${target}`)
    expect(h.stdoutText()).toContain('FASTMAIL_API_TOKEN')

    const { compiled } = await roundTrip(dir)
    expect(compiled.domainMap.get('github.com')).toBe('Development')
    expect(compiled.domainMap.has('zephyrletter.example')).toBe(false)
    expect(await inboxLabels(h.provider, 'g1')).toEqual(['Inbox'])
    expect(h.exitCodes).toEqual([])
  })

  test('refuses to overwrite an existing config, exit 1', async () => {
    const h = await makePromptHarness(seededInbox(), SEED_CONFIG, ['y', 'q'])
    const dir = join(h.tmpDir, 'init-existing')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'fast-classifier.config.ts')
    writeFileSync(target, '// keep me\n')

    await h.run('init', dir, '--from-inbox')

    expect(readFileSync(target, 'utf8')).toBe('// keep me\n')
    expect(h.stderrText()).toContain('refusing to overwrite')
    expect(h.exitCodes).toEqual([1])
  })
})
