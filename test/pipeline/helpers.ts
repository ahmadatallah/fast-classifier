import type { PipelineContext } from '../../src/pipeline/context.js'
import { compileConfig } from '../../src/config/compile.js'
import type { ClassifierConfigInput } from '../../src/config/schema.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import type { MailProvider } from '../../src/provider/types.js'
import { MUTATING_METHODS } from '../../src/provider/types.js'
import type { ConfirmFn } from '../../src/safety/confirm.js'
import { allowAll } from '../../src/safety/confirm.js'

export interface CtxOverrides {
  config?: ClassifierConfigInput
  dryRun?: boolean
  max?: number
  confirm?: ConfirmFn
  confirmThreshold?: number
}

export function makeCtx(
  provider: MailProvider,
  overrides: CtxOverrides = {},
): { ctx: PipelineContext; logs: string[] } {
  const config = classifierConfigSchema.parse(overrides.config ?? {})
  const logs: string[] = []
  const ctx: PipelineContext = {
    provider,
    config,
    compiled: compileConfig(config),
    dryRun: overrides.dryRun ?? false,
    max: overrides.max,
    confirm: overrides.confirm ?? allowAll,
    confirmThreshold: overrides.confirmThreshold,
    log: (message) => logs.push(message),
    sleep: () => Promise.resolve(),
  }
  return { ctx, logs }
}

const MUTATING = new Set<PropertyKey>(MUTATING_METHODS)

/** Delegating proxy that records the name of every mutating call. */
export function recordingProvider(inner: MailProvider): {
  provider: MailProvider
  mutations: string[]
} {
  const mutations: string[] = []
  const provider = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => unknown
      if (MUTATING.has(prop)) {
        return (...args: unknown[]) => {
          mutations.push(String(prop))
          return fn.apply(target, args)
        }
      }
      return fn.bind(target)
    },
  })
  return { provider, mutations }
}

export async function inboxIds(provider: MailProvider): Promise<string[]> {
  const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 0, limit: 10_000 })
  return page.items.map((email) => email.id)
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

export function expectMeta(
  meta: { command: string; dryRun: boolean; startedAt: string; finishedAt: string },
  command: string,
  dryRun: boolean,
): void {
  if (meta.command !== command) throw new Error(`meta.command ${meta.command} !== ${command}`)
  if (meta.dryRun !== dryRun) throw new Error(`meta.dryRun ${meta.dryRun} !== ${dryRun}`)
  if (!ISO_RE.test(meta.startedAt)) throw new Error(`startedAt not ISO: ${meta.startedAt}`)
  if (!ISO_RE.test(meta.finishedAt)) throw new Error(`finishedAt not ISO: ${meta.finishedAt}`)
  if (meta.finishedAt < meta.startedAt) throw new Error('finishedAt precedes startedAt')
}
