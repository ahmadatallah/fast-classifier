import type { MailProvider } from '../provider/types.js'
import { MUTATING_METHODS } from '../provider/types.js'

/** Thrown when pipeline code calls a mutating provider method in dry-run mode. */
export class DryRunViolation extends Error {
  constructor(method: string) {
    super(`dry-run violation: ${method}() called on a read-only provider`)
    this.name = 'DryRunViolation'
  }
}

const MUTATING = new Set<PropertyKey>(MUTATING_METHODS)

/**
 * Wraps a provider so every method in MUTATING_METHODS throws DryRunViolation.
 * Enforced at the transport boundary: a bug anywhere upstream physically
 * cannot mutate mail in dry-run mode.
 */
export function readOnlyProvider(provider: MailProvider): MailProvider {
  return new Proxy(provider, {
    get(target, prop) {
      if (MUTATING.has(prop)) {
        return () => {
          throw new DryRunViolation(String(prop))
        }
      }
      // read against the real provider so getters (kind, caps) and methods
      // keep their original `this`
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
