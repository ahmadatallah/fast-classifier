import type { CompiledRules } from '../config/compile.js'
import type { SenderInfo } from '../types.js'
import { rootDomain } from './domain.js'

export type MatchedRuleKind =
  'sender' | 'domain' | 'name' | 'account-root' | 'personal-provider' | 'personal-domain'

export interface RuleMatch {
  category: string
  rule: MatchedRuleKind
  reason: string
}

/**
 * Sender -> category. Precedence (mirrors the origin session's classifier):
 * exact sender, root domain, relay-domain name rules, relay account/personal
 * fallbacks, then the user's own domains. null = leave in inbox.
 */
export function classify(sender: SenderInfo, compiled: CompiledRules): RuleMatch | null {
  const email = sender.email.toLowerCase()
  const name = sender.name

  const senderCategory = compiled.senderMap.get(email)
  if (senderCategory !== undefined) {
    return {
      category: senderCategory,
      rule: 'sender',
      reason: `sender ${email} -> ${senderCategory}`,
    }
  }

  const root = rootDomain(email)
  if (root !== null) {
    const domainCategory = compiled.domainMap.get(root)
    if (domainCategory !== undefined) {
      return {
        category: domainCategory,
        rule: 'domain',
        reason: `domain ${root} -> ${domainCategory}`,
      }
    }

    // relay/aggregator roots carry no domain signal: consult name rules, then fallbacks
    if (compiled.relayDomains.has(root)) {
      for (const nameRule of compiled.nameRules) {
        if (nameRule.onlyForDomains !== null && !nameRule.onlyForDomains.has(root)) continue
        if (nameRule.pattern.test(name)) {
          return {
            category: nameRule.category,
            rule: 'name',
            reason: `name '${name}' matched /${nameRule.pattern.source}/ -> ${nameRule.category}`,
          }
        }
      }
      if (compiled.accountDomains.has(root)) {
        return {
          category: compiled.accountCategory,
          rule: 'account-root',
          reason: `relay root ${root} -> ${compiled.accountCategory}`,
        }
      }
      if (compiled.personalProviderDomains.has(root)) {
        return {
          category: compiled.personalCategory,
          rule: 'personal-provider',
          reason: `personal provider ${root} -> ${compiled.personalCategory}`,
        }
      }
    }
  }

  // the user's own domains match on the FULL domain part, not the root
  const at = email.lastIndexOf('@')
  const domainPart = at >= 0 ? email.slice(at + 1) : ''
  if (domainPart !== '' && compiled.personalDomains.has(domainPart)) {
    return {
      category: compiled.personalCategory,
      rule: 'personal-domain',
      reason: `personal domain ${domainPart} -> ${compiled.personalCategory}`,
    }
  }

  return null
}
