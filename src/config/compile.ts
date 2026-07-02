import type { WeightedKeyword } from './defaults.js'
import type { CategoryDef, ClassifierConfig, OpsConfig } from './schema.js'

export interface NameRule {
  pattern: RegExp
  category: string
  /** null = only for detection.relayDomains (the default) */
  onlyForDomains: Set<string> | null
}

export interface CompiledNeedsAction {
  label: string
  threshold: number
  unreadBonus: number
  personalNeedsReplyBonus: number
  windowDays: number
  /** phrases pre-lowercased; trailing spaces preserved */
  high: WeightedKeyword[]
  exclusion: WeightedKeyword[]
}

/** Precompiled, lookup-optimized view of ClassifierConfig. Everything lowercased. */
export interface CompiledRules {
  senderMap: Map<string, string>
  domainMap: Map<string, string>
  nameRules: NameRule[]
  relayDomains: Set<string>
  accountDomains: Set<string>
  accountCategory: string
  personalProviderDomains: Set<string>
  personalCategory: string
  personalDomains: Set<string>
  keepSet: Set<string>
  automatedRe: RegExp
  brandRe: RegExp
  personalProviderRe: RegExp
  categories: Map<string, CategoryDef>
  needsAction: CompiledNeedsAction
  sweep: { targetLabel: string; textHeuristic: string; after?: string | undefined }
  ops: OpsConfig
}

const lower = (s: string) => s.toLowerCase()

export function compileConfig(config: ClassifierConfig): CompiledRules {
  const senderMap = new Map<string, string>()
  const domainMap = new Map<string, string>()
  const nameRules: NameRule[] = []

  for (const rule of config.rules) {
    switch (rule.kind) {
      case 'sender':
        senderMap.set(lower(rule.address), rule.category)
        break
      case 'domain':
        domainMap.set(lower(rule.domain), rule.category)
        break
      case 'name':
        nameRules.push({
          pattern: new RegExp(rule.pattern, 'i'),
          category: rule.category,
          onlyForDomains: rule.onlyForDomains
            ? new Set(rule.onlyForDomains.map(lower))
            : null,
        })
        break
    }
  }

  const d = config.detection
  const lowerKeywords = (list: WeightedKeyword[]) =>
    list.map(({ phrase, weight }) => ({ phrase: phrase.toLowerCase(), weight }))

  return {
    senderMap,
    domainMap,
    nameRules,
    relayDomains: new Set(d.relayDomains.map(lower)),
    accountDomains: new Set(d.accountDomains.map(lower)),
    accountCategory: d.accountCategory,
    personalProviderDomains: new Set(d.personalProviderDomains.map(lower)),
    personalCategory: d.personalCategory,
    personalDomains: new Set(d.personalDomains.map(lower)),
    keepSet: new Set(config.keepList.map(lower)),
    automatedRe: new RegExp(d.automatedNamePattern, 'i'),
    brandRe: new RegExp(d.brandNamePattern, 'i'),
    personalProviderRe: new RegExp(d.personalProviderPattern, 'i'),
    categories: new Map(config.categories.map((c) => [c.name, c])),
    needsAction: {
      label: config.needsAction.label,
      threshold: config.needsAction.threshold,
      unreadBonus: config.needsAction.unreadBonus,
      personalNeedsReplyBonus: config.needsAction.personalNeedsReplyBonus,
      windowDays: config.needsAction.windowDays,
      high: lowerKeywords(config.needsAction.highKeywords),
      exclusion: lowerKeywords(config.needsAction.exclusionKeywords),
    },
    sweep: config.sweep,
    ops: config.ops,
  }
}
