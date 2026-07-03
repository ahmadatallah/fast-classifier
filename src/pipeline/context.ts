import type { CompiledRules } from '../config/compile.js'
import type { ClassifierConfig } from '../config/schema.js'
import type { PagerOptions } from '../provider/paging.js'
import type { MailProvider } from '../provider/types.js'
import type { ConfirmFn } from '../safety/confirm.js'
import { readOnlyProvider } from '../safety/index.js'

export interface PipelineContext {
  /** always the RAW provider — pipelines derive the read side via readProvider() */
  provider: MailProvider
  config: ClassifierConfig
  compiled: CompiledRules
  dryRun: boolean
  /** cap on emails scanned per run */
  max?: number | undefined
  confirm: ConfirmFn
  /** planned mutations above this require confirm() (default 100) */
  confirmThreshold?: number | undefined
  log: (message: string) => void
  /** threaded into paging/batching so tests never wait on real timers */
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/**
 * The ONLY way pipelines obtain a provider to read from: in dry-run mode every
 * mutator throws DryRunViolation, so a planning-pass bug physically cannot
 * mutate mail.
 */
export function readProvider(ctx: PipelineContext): MailProvider {
  return ctx.dryRun ? readOnlyProvider(ctx.provider) : ctx.provider
}

/**
 * Scan-mode PagerOptions for the collect phase. MODE CONTRACT (paging.ts):
 * collect passes never mutate, so they must never drain — 'scan' makes plan
 * and execute see the identical email set in dry and wet runs alike.
 */
export function scanOptions(ctx: PipelineContext, seen?: Set<string>): PagerOptions {
  const opts: PagerOptions = {
    mode: 'scan',
    stallLimit: ctx.config.ops.stallLimit,
    stallBackoffMs: ctx.config.ops.stallBackoffMs,
  }
  if (ctx.max !== undefined) opts.max = ctx.max
  if (ctx.sleep !== undefined) opts.sleep = ctx.sleep
  if (seen !== undefined) opts.seen = seen
  return opts
}

export interface RunMeta {
  command: string
  dryRun: boolean
  startedAt: string
  finishedAt: string
}

/** Stamps ISO timestamps around fn and injects the meta block into its report. */
export async function withMeta<T extends object>(
  command: string,
  ctx: PipelineContext,
  fn: () => Promise<T>,
): Promise<T & { meta: RunMeta }> {
  const startedAt = new Date().toISOString()
  const body = await fn()
  const finishedAt = new Date().toISOString()
  return { ...body, meta: { command, dryRun: ctx.dryRun, startedAt, finishedAt } }
}
