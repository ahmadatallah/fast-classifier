import type { TsvAudit } from '../audit/index.js'
import type { BatchOptions } from '../provider/batching.js'
import { batchExecute } from '../provider/batching.js'
import { needsConfirmation } from '../safety/confirm.js'
import type { PipelineContext } from './context.js'

export interface PlannedAction {
  emailId: string
  sender: string
  addLabels: string[]
  archive: boolean
  reason: string
}

export interface ExecuteResult {
  executed: number
  skippedByConfirm: boolean
}

const summarize = (actions: PlannedAction[]): string => {
  const tally = new Map<string, number>()
  for (const action of actions) {
    for (const label of action.addLabels) tally.set(label, (tally.get(label) ?? 0) + 1)
  }
  const top = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => `${label}: ${count}`)
    .join(', ')
  return top === ''
    ? `${actions.length} planned mutations`
    : `${actions.length} planned mutations (${top})`
}

const batchOptions = (
  ctx: PipelineContext,
  onProgress: (done: number, total: number) => void,
): BatchOptions => {
  const opts: BatchOptions = {
    batchSize: ctx.config.ops.batchSize,
    delayMs: ctx.config.ops.batchDelayMs,
    onProgress,
  }
  if (ctx.sleep !== undefined) opts.sleep = ctx.sleep
  return opts
}

/** onProgress fires once per chunk; log every ops.progressEvery chunks. */
const progressLogger = (
  ctx: PipelineContext,
  what: string,
): ((done: number, total: number) => void) => {
  let chunks = 0
  return (done, total) => {
    chunks++
    if (chunks % ctx.config.ops.progressEvery === 0) ctx.log(`${what}: ${done}/${total}`)
  }
}

/**
 * The ONLY write path of every pipeline. Order of defenses:
 * dry-run short-circuit (callers report the plan instead), confirmation gate
 * above the threshold, ensureLabels pre-flight (typo guard — labels are
 * asserted before any email moves), then grouped bulk addLabels and one
 * archive pass. Each successful addLabels chunk is audited BEFORE the next
 * chunk runs, so an interrupted run resumes without duplicating work.
 */
export const executeActions = async (
  ctx: PipelineContext,
  command: string,
  actions: PlannedAction[],
  audit?: TsvAudit,
): Promise<ExecuteResult> => {
  if (ctx.dryRun || actions.length === 0) return { executed: 0, skippedByConfirm: false }

  if (needsConfirmation(actions.length, ctx.confirmThreshold)) {
    const approved = await ctx.confirm(summarize(actions))
    if (!approved) return { executed: 0, skippedByConfirm: true }
  }

  const provider = ctx.provider
  const allLabels = [...new Set(actions.flatMap((a) => a.addLabels))]
  if (allLabels.length > 0) await provider.ensureLabels(allLabels)

  // one bulk run per distinct label set keeps addLabels a batched call
  const groups = new Map<string, { labels: string[]; members: PlannedAction[] }>()
  for (const action of actions) {
    if (action.addLabels.length === 0) continue
    const labels = [...action.addLabels].sort()
    const key = labels.join('\n')
    let group = groups.get(key)
    if (group === undefined) {
      group = { labels, members: [] }
      groups.set(key, group)
    }
    group.members.push(action)
  }

  for (const { labels, members } of groups.values()) {
    const byId = new Map(members.map((action) => [action.emailId, action]))
    const category = labels.join('+')
    await batchExecute(
      members.map((action) => action.emailId),
      async (chunk) => {
        await provider.addLabels(chunk, labels)
        for (const id of chunk) {
          audit?.append({ id, action: command, category, sender: byId.get(id)?.sender })
        }
      },
      batchOptions(ctx, progressLogger(ctx, `${command}: label ${category}`)),
    )
  }

  const archiveIds = actions.filter((action) => action.archive).map((action) => action.emailId)
  if (archiveIds.length > 0) {
    await batchExecute(
      archiveIds,
      (chunk) => provider.archive(chunk),
      batchOptions(ctx, progressLogger(ctx, `${command}: archive`)),
    )
  }

  return { executed: actions.length, skippedByConfirm: false }
}
