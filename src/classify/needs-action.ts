import type { CompiledRules } from '../config/compile.js'
import type { EmailMeta } from '../types.js'

export interface NeedsActionScore {
  score: number
  signals: string[]
  needsAction: boolean
}

/**
 * Keyword-weighted needs-action score over subject + snippet + sender name.
 * Phrases in compiled are pre-lowercased; trailing spaces are significant
 * ('sign ' avoids matching bare 'design').
 */
export function scoreNeedsAction(email: EmailMeta, compiled: CompiledRules): NeedsActionScore {
  const na = compiled.needsAction
  const haystack = (
    email.subject +
    ' ' +
    (email.snippet ?? '') +
    ' ' +
    email.from.name
  ).toLowerCase()

  let score = 0
  const signals: string[] = []

  for (const { phrase, weight } of na.high) {
    if (haystack.includes(phrase)) {
      score += weight
      signals.push(phrase.trim())
    }
  }
  for (const { phrase, weight } of na.exclusion) {
    if (haystack.includes(phrase)) score += weight
  }
  if (email.isUnread) score += na.unreadBonus

  // personal sender with a real name, unanswered -> likely needs a reply
  const person =
    compiled.personalProviderRe.test(email.from.email) &&
    /\s/.test(email.from.name.trim()) &&
    !compiled.automatedRe.test(email.from.email)
  if (person && email.isAnswered !== true) {
    score += na.personalNeedsReplyBonus
    signals.push('personal')
  }

  return { score, signals: [...new Set(signals)], needsAction: score >= na.threshold }
}
