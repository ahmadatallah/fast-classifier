/**
 * Shared logic behind `fast-classifier suggest` and `init --from-inbox`: the
 * interactive/non-interactive selection of suggested rules plus rendering of
 * the paste-ready fragment and the full generated config file. Prompting and
 * output are injected (same pattern as safety/confirm.ts) so tests script the
 * whole session; nothing here talks to a TTY directly.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { CategoryDef, ClassifierConfig } from '../config/schema.js'
import type { SuggestionResult } from '../suggest/index.js'
import { SUGGESTED_CATEGORIES, toConfigFragment } from '../suggest/index.js'

/** One rule the user accepted: a root domain filed into a category. */
export interface AcceptedRule {
  domain: string
  category: string
}

/** Injectable prompt gate; the flow never talks to a TTY directly. */
export type PromptFn = (question: string) => Promise<string>

export interface SuggestIo {
  out: (chunk: string) => unknown
  prompt: PromptFn
}

export const readlinePrompt = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): PromptFn => {
  return async (question) => {
    const rl = createInterface({ input, output })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }
}

const isYes = (answer: string): boolean => {
  const normalized = answer.trim().toLowerCase()
  return normalized === '' || normalized === 'y' || normalized === 'yes'
}

const asCategoryDef = ({ name, label, description }: CategoryDef): CategoryDef =>
  description === undefined ? { name, label } : { name, label, description }

/**
 * The numbered category menu for the unknown-domain walk: the generic
 * suggested categories first, then the user's own config categories that do
 * not shadow a suggested name.
 */
export const menuCategories = (config: ClassifierConfig): CategoryDef[] => {
  const suggested = SUGGESTED_CATEGORIES.map(asCategoryDef)
  const taken = new Set(suggested.map((c) => c.name))
  return [...suggested, ...config.categories.filter((c) => !taken.has(c.name))]
}

/**
 * Turns a SuggestionResult into the set of accepted rules. Non-interactive:
 * every catalog suggestion, no questions asked. Interactive: one Y/n gate for
 * the catalog batch, then a per-domain walk over the unknowns where the user
 * picks a category by number, 's' (or empty) skips, and 'q' stops the walk.
 */
export const selectRules = async (
  result: SuggestionResult,
  config: ClassifierConfig,
  interactive: boolean,
  io: SuggestIo,
): Promise<AcceptedRule[]> => {
  const catalogRules = result.suggestions.map(({ domain, category }) => ({ domain, category }))
  if (!interactive) return catalogRules

  const accepted: AcceptedRule[] = []
  if (catalogRules.length > 0) {
    const answer = await io.prompt(`Accept ${catalogRules.length} catalog suggestion(s)? [Y/n] `)
    if (isYes(answer)) accepted.push(...catalogRules)
  }
  if (result.unknown.length === 0) return accepted

  const choices = menuCategories(config)
  const menu = choices
    .map(
      (c, i) => `  ${i + 1}. ${c.name}${c.description === undefined ? '' : ` — ${c.description}`}`,
    )
    .join('\n')
  io.out(`\nAssign categories to unknown domains (number, 's' skip, 'q' stop):\n${menu}\n\n`)

  for (const unknown of result.unknown) {
    const samples = unknown.sampleSenders.join(', ')
    const question = `${unknown.domain} (${unknown.count} emails${samples === '' ? '' : `; ${samples}`}) > `
    const answer = (await io.prompt(question)).trim().toLowerCase()
    if (answer === 'q') break
    if (answer === '' || answer === 's') continue
    const index = Number(answer)
    const choice = Number.isInteger(index) ? choices[index - 1] : undefined
    if (choice === undefined) {
      io.out(`  unrecognized answer '${answer}' — skipped ${unknown.domain}\n`)
      continue
    }
    accepted.push({ domain: unknown.domain, category: choice.name })
  }
  return accepted
}

/** Category defs the paste fragment must introduce: used, and not already in the config. */
const fragmentCategories = (accepted: AcceptedRule[], config: ClassifierConfig): CategoryDef[] => {
  const used = [...new Set(accepted.map((a) => a.category))]
  const own = new Set(config.categories.map((c) => c.name))
  return used
    .filter((name) => !own.has(name))
    .flatMap((name) => {
      const def = SUGGESTED_CATEGORIES.find((c) => c.name === name)
      return def === undefined ? [] : [asCategoryDef(def)]
    })
}

/**
 * Paste-ready defineConfig fragment for whatever the user accepted, including
 * categories assigned during the unknown-domain walk (which plain
 * result.categories cannot know about).
 */
export const renderFragment = (
  result: SuggestionResult,
  accepted: AcceptedRule[],
  config: ClassifierConfig,
): string => {
  return toConfigFragment({ ...result, categories: fragmentCategories(accepted, config) }, accepted)
}

/**
 * Category defs a freshly WRITTEN config file needs: every category any
 * accepted rule references, preferring the user's own definition, then the
 * suggested catalog's, then a minimal name-as-label fallback — the written
 * file must always pass schema validation.
 */
const configFileCategories = (
  accepted: AcceptedRule[],
  config: ClassifierConfig,
): CategoryDef[] => {
  const used = [...new Set(accepted.map((a) => a.category))]
  return used.map((name) => {
    const own = config.categories.find((c) => c.name === name)
    if (own !== undefined) return asCategoryDef(own)
    const suggested = SUGGESTED_CATEGORIES.find((c) => c.name === name)
    return suggested === undefined ? { name, label: name } : asCategoryDef(suggested)
  })
}

const CONFIG_FILE_HEADER = `// fast-classifier config generated from your own inbox — edit freely.
// Tokens NEVER go in this file: export FASTMAIL_API_TOKEN (JMAP) or
// FASTMAIL_MCP_TOKEN (MCP) in your shell instead.
import { defineConfig } from 'fast-classifier/config'

export default defineConfig({
`

/** Full fast-classifier.config.ts content for the accepted rules. */
export const renderConfigFile = (accepted: AcceptedRule[], config: ClassifierConfig): string => {
  const body =
    accepted.length === 0
      ? 'categories: [],\nrules: [],\n'
      : toConfigFragment(
          {
            suggestions: [],
            unknown: [],
            alreadyCovered: 0,
            categories: configFileCategories(accepted, config),
          },
          accepted,
        )
  const indented = body
    .trimEnd()
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
  return `${CONFIG_FILE_HEADER}${indented}\n})\n`
}

/** Where `suggest --write` and `init` place the generated config. */
export const configTarget = (dir: string): string => resolve(dir, 'fast-classifier.config.ts')

/** Writes the generated config; 'wx' guarantees we never overwrite anything. */
export const writeSuggestedConfig = async (target: string, content: string): Promise<void> => {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, { flag: 'wx' })
}
