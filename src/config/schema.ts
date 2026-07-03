import { z } from 'zod'
import {
  DEFAULT_ACCOUNT_DOMAINS,
  DEFAULT_AUTOMATED_PATTERN,
  DEFAULT_BRAND_PATTERN,
  DEFAULT_EXCLUSION_KEYWORDS,
  DEFAULT_HIGH_KEYWORDS,
  DEFAULT_OPS,
  DEFAULT_PERSONAL_PROVIDER_DOMAINS,
  DEFAULT_PERSONAL_PROVIDER_PATTERN,
  DEFAULT_PERSONAL_REPLY_EXCLUSION_PATTERN,
  DEFAULT_RELAY_DOMAINS,
} from './defaults.js'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

export const weightedKeywordSchema = z.object({
  phrase: z.string().min(1),
  weight: z.number(),
})

export const categorySchema = z.object({
  /** category name referenced by rules, e.g. 'Finance' */
  name: z.string().min(1),
  /** Fastmail label; may be a nested path like 'Inbox/Finance' */
  label: z.string().min(1),
  description: z.string().optional(),
})

export const ruleSchema = z.discriminatedUnion('kind', [
  /** exact sender address — wins first */
  z.object({ kind: z.literal('sender'), address: z.string().email(), category: z.string() }),
  /** registrable root domain (public-suffix aware), e.g. 'paypal.de' */
  z.object({ kind: z.literal('domain'), domain: z.string().min(3), category: z.string() }),
  /**
   * display-name regex fallback; by default only consulted for relay/aggregator
   * domains (appleid/google/gmail/hotmail) where the address carries no signal
   */
  z.object({
    kind: z.literal('name'),
    pattern: z.string().min(1),
    category: z.string(),
    onlyForDomains: z.array(z.string()).optional(),
  }),
])

export const detectionSchema = z
  .object({
    relayDomains: z.array(z.string()).default([...DEFAULT_RELAY_DOMAINS]),
    accountDomains: z.array(z.string()).default([...DEFAULT_ACCOUNT_DOMAINS]),
    accountCategory: z.string().default('Accounts'),
    personalProviderDomains: z.array(z.string()).default([...DEFAULT_PERSONAL_PROVIDER_DOMAINS]),
    personalCategory: z.string().default('Personal'),
    /** the user's own domains — anything sent from them files as personal */
    personalDomains: z.array(z.string()).default([]),
    /** regex source, case-insensitive, matched against the from ADDRESS */
    automatedNamePattern: z.string().default(DEFAULT_AUTOMATED_PATTERN),
    /** regex source, case-insensitive, matched against address + display name */
    brandNamePattern: z.string().default(DEFAULT_BRAND_PATTERN),
    /** regex source, case-insensitive: freemail providers (needs-action heuristic) */
    personalProviderPattern: z.string().default(DEFAULT_PERSONAL_PROVIDER_PATTERN),
    /** regex source, case-insensitive: senders excluded from the needs-reply bonus */
    personalReplyExclusionPattern: z.string().default(DEFAULT_PERSONAL_REPLY_EXCLUSION_PATTERN),
  })
  .default({})

export const sweepSchema = z
  .object({
    targetLabel: z.string().default('Promotion'),
    /** full-text heuristic identifying bulk mail */
    textHeuristic: z.string().default('unsubscribe'),
    after: isoDate.optional(),
  })
  .default({})

export const needsActionSchema = z
  .object({
    label: z.string().default('Needs action'),
    threshold: z.number().default(3),
    highKeywords: z.array(weightedKeywordSchema).default([...DEFAULT_HIGH_KEYWORDS]),
    exclusionKeywords: z.array(weightedKeywordSchema).default([...DEFAULT_EXCLUSION_KEYWORDS]),
    unreadBonus: z.number().default(1),
    personalNeedsReplyBonus: z.number().default(4),
    /** how far back to scan */
    windowDays: z.number().int().positive().default(60),
  })
  .default({})

export const opsSchema = z
  .object({
    batchSize: z.number().int().positive().max(50).default(DEFAULT_OPS.batchSize),
    batchDelayMs: z.number().nonnegative().default(DEFAULT_OPS.batchDelayMs),
    stallBackoffMs: z.number().nonnegative().default(DEFAULT_OPS.stallBackoffMs),
    stallLimit: z.number().int().positive().default(DEFAULT_OPS.stallLimit),
    progressEvery: z.number().int().positive().default(DEFAULT_OPS.progressEvery),
    maxItems: z.number().int().positive().optional(),
  })
  .default({})

export const classifierConfigSchema = z
  .object({
    provider: z
      .object({
        type: z.enum(['jmap', 'mcp']).default('jmap'),
        /** override endpoints (testing / self-hosted JMAP) */
        baseUrl: z.string().url().optional(),
      })
      .default({}),
    categories: z.array(categorySchema).default([]),
    rules: z.array(ruleSchema).default([]),
    /** exact sender addresses that must never be swept (checked twice) */
    keepList: z.array(z.string().email()).default([]),
    sweep: sweepSchema,
    needsAction: needsActionSchema,
    detection: detectionSchema,
    ops: opsSchema,
  })
  .superRefine((config, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })

    // rule -> category references
    const names = new Set(config.categories.map((c) => c.name))
    config.rules.forEach((rule, i) => {
      if (!names.has(rule.category)) {
        issue(
          ['rules', i, 'category'],
          `rule references unknown category '${rule.category}' — add it to categories[]`,
        )
      }
    })

    // duplicates would otherwise resolve last-wins silently in compileConfig
    const seenCategories = new Set<string>()
    config.categories.forEach((c, i) => {
      if (seenCategories.has(c.name))
        issue(['categories', i, 'name'], `duplicate category '${c.name}'`)
      seenCategories.add(c.name)
    })
    const seenDomains = new Set<string>()
    const seenSenders = new Set<string>()
    config.rules.forEach((rule, i) => {
      if (rule.kind === 'domain') {
        const d = rule.domain.toLowerCase()
        if (seenDomains.has(d)) issue(['rules', i, 'domain'], `duplicate domain rule '${d}'`)
        seenDomains.add(d)
      } else if (rule.kind === 'sender') {
        const a = rule.address.toLowerCase()
        if (seenSenders.has(a)) issue(['rules', i, 'address'], `duplicate sender rule '${a}'`)
        seenSenders.add(a)
      }
    })

    // every regex source must compile — a bad pattern must fail here, not
    // as a raw SyntaxError inside compileConfig
    const checkRegex = (source: string, path: (string | number)[]) => {
      try {
        new RegExp(source, 'i')
      } catch (err) {
        issue(path, `invalid regex: ${(err as Error).message}`)
      }
    }
    for (const [i, rule] of config.rules.entries()) {
      if (rule.kind === 'name') checkRegex(rule.pattern, ['rules', i, 'pattern'])
    }
    checkRegex(config.detection.automatedNamePattern, ['detection', 'automatedNamePattern'])
    checkRegex(config.detection.brandNamePattern, ['detection', 'brandNamePattern'])
    checkRegex(config.detection.personalProviderPattern, ['detection', 'personalProviderPattern'])
    checkRegex(config.detection.personalReplyExclusionPattern, [
      'detection',
      'personalReplyExclusionPattern',
    ])
  })

export type ClassifierConfig = z.output<typeof classifierConfigSchema>
export type ClassifierConfigInput = z.input<typeof classifierConfigSchema>
export type CategoryDef = z.output<typeof categorySchema>
export type Rule = z.output<typeof ruleSchema>
export type NeedsActionConfig = ClassifierConfig['needsAction']
export type DetectionConfig = ClassifierConfig['detection']
export type OpsConfig = ClassifierConfig['ops']
