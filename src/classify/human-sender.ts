import type { CompiledRules } from '../config/compile.js'
import type { SenderInfo } from '../types.js'

/**
 * "A human probably wrote this": a spaced display name ('First Last'), an
 * address that does not look automated, and no big-brand token in either.
 */
export const isHumanSender = (sender: SenderInfo, compiled: CompiledRules): boolean => {
  const name = sender.name.trim()
  if (!/\s/.test(name)) return false
  if (compiled.automatedRe.test(sender.email)) return false
  if (compiled.brandRe.test(sender.email + ' ' + name)) return false
  return true
}
