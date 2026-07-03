/**
 * Pure suggestion engine: turns the analyze report's domain tallies plus the
 * user's compiled config into (a) catalog-backed rule suggestions, (b) the
 * unknown domains worth asking the user about, and (c) a paste-ready config
 * fragment for whatever the user accepts. No I/O.
 */

import type { CompiledRules } from '../config/compile.js'
import type { CategoryDef } from '../config/schema.js'
import { DOMAIN_CATALOG, SUGGESTED_CATEGORIES } from './catalog.js'

export interface DomainTallyInput {
  domain: string
  count: number
  sampleSenders?: string[]
}

export interface RuleSuggestion {
  domain: string
  category: string
  count: number
  source: 'catalog'
  sampleSenders: string[]
}

export interface UnknownDomain {
  domain: string
  count: number
  sampleSenders: string[]
}

export interface SuggestionResult {
  /** catalog hits NOT already covered by the user's config */
  suggestions: RuleSuggestion[]
  /** top uncovered domains with no catalog entry, sorted by count */
  unknown: UnknownDomain[]
  /** domains the existing compiled config already classifies */
  alreadyCovered: number
  /** SUGGESTED_CATEGORIES entries used by suggestions, minus ones the user already has */
  categories: CategoryDef[]
}

const byCountDesc = (a: { count: number; domain: string }, b: { count: number; domain: string }) =>
  b.count - a.count || a.domain.localeCompare(b.domain)

/**
 * A domain is "already covered" when the compiled config has a domain rule for
 * it, a sender rule for one of its sample senders, or it sits in the user's
 * personal/relay domains — suggesting those would be noise.
 */
const isCovered = (domain: string, samples: string[], compiled: CompiledRules): boolean =>
  compiled.domainMap.has(domain) ||
  compiled.personalDomains.has(domain) ||
  compiled.relayDomains.has(domain) ||
  samples.some((sender) => compiled.senderMap.has(sender))

export const suggestRules = (
  domains: DomainTallyInput[],
  compiled: CompiledRules,
  opts?: { maxUnknown?: number; minCount?: number },
): SuggestionResult => {
  const maxUnknown = opts?.maxUnknown ?? 30
  const minCount = opts?.minCount ?? 2

  const suggestions: RuleSuggestion[] = []
  const unknown: UnknownDomain[] = []
  let alreadyCovered = 0

  for (const tally of domains) {
    const domain = tally.domain.toLowerCase()
    const sampleSenders = (tally.sampleSenders ?? []).map((s) => s.toLowerCase())
    if (isCovered(domain, sampleSenders, compiled)) {
      alreadyCovered++
      continue
    }
    if (tally.count < minCount) continue
    const category = DOMAIN_CATALOG.get(domain)
    if (category !== undefined) {
      suggestions.push({ domain, category, count: tally.count, source: 'catalog', sampleSenders })
    } else {
      unknown.push({ domain, count: tally.count, sampleSenders })
    }
  }

  suggestions.sort(byCountDesc)
  unknown.sort(byCountDesc)

  const usedCategories = new Set(suggestions.map((s) => s.category))
  const categories: CategoryDef[] = SUGGESTED_CATEGORIES.filter(
    (c) => usedCategories.has(c.name) && !compiled.categories.has(c.name),
  ).map(({ name, label, description }) => ({ name, label, description }))

  return { suggestions, unknown: unknown.slice(0, maxUnknown), alreadyCovered, categories }
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/**
 * Renders the accepted suggestions as a paste-ready TypeScript snippet in the
 * project's defineConfig style (2-space indent, single quotes): the needed
 * `categories` entries (only ones the user does not already have, per
 * result.categories) followed by the `rules` entries. Pure string building —
 * the CLI uses it both for file writing and print-to-paste.
 */
export const toConfigFragment = (
  result: SuggestionResult,
  accepted: { domain: string; category: string }[],
): string => {
  if (accepted.length === 0) return ''

  const usedCategories = new Set(accepted.map((a) => a.category))
  const needed = result.categories.filter((c) => usedCategories.has(c.name))

  const lines: string[] = []
  if (needed.length > 0) {
    lines.push('categories: [')
    for (const c of needed) {
      const description =
        c.description === undefined ? '' : `, description: ${quote(c.description)}`
      lines.push(`  { name: ${quote(c.name)}, label: ${quote(c.label)}${description} },`)
    }
    lines.push('],')
  }
  lines.push('rules: [')
  for (const a of accepted) {
    lines.push(
      `  { kind: 'domain', domain: ${quote(a.domain.toLowerCase())}, category: ${quote(a.category)} },`,
    )
  }
  lines.push('],')
  return `${lines.join('\n')}\n`
}
