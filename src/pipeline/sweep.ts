import type { TsvAudit } from '../audit/index.js'
import { paginate } from '../provider/paging.js'
import type { SearchQuery } from '../types.js'
import type { PlannedAction } from './actions.js'
import { executeActions } from './actions.js'
import type { PipelineContext, RunMeta } from './context.js'
import { readProvider, scanOptions, withMeta } from './context.js'

export interface SweepOptions {
  targetLabel?: string
  /** ISO date YYYY-MM-DD; overrides config.sweep.after */
  after?: string
  audit?: TsvAudit
}

export interface SweptSender {
  email: string
  count: number
}

export interface SweepReport {
  meta: RunMeta
  scanned: number
  planned: number
  executed: number
  skippedByConfirm: boolean
  keptOut: number
  topSenders: SweptSender[]
}

/** Bulk-mail sweep: full-text heuristic in, keep-list out, label + archive. */
export const sweepNewsletters = async (
  ctx: PipelineContext,
  opts: SweepOptions = {},
): Promise<SweepReport> => {
  return withMeta('sweep', ctx, async () => {
    const { config, compiled } = ctx
    if (config.keepList.length === 0) {
      ctx.log('warning: keepList is empty — every sender matching the sweep heuristic is swept')
    }
    const targetLabel = opts.targetLabel ?? config.sweep.targetLabel
    const query: SearchQuery = {
      inMailbox: 'inbox',
      text: config.sweep.textHeuristic,
      notFrom: config.keepList.length > 0 ? config.keepList : undefined,
      after: opts.after ?? config.sweep.after,
    }

    let scanned = 0
    let keptOut = 0
    const actions: PlannedAction[] = []
    const senderCounts = new Map<string, number>()

    const pager = paginate(readProvider(ctx), query, scanOptions(ctx, opts.audit?.processedIds))
    for await (const email of pager) {
      scanned++
      const address = email.from.email.toLowerCase()
      // MANDATORY re-check: the server-side -from: negation is address-only on
      // MCP (caps.serverSideNotFrom), so the keep-list must be enforced here —
      // keep hits are counted and NEVER acted on
      if (compiled.keepSet.has(address)) {
        keptOut++
        continue
      }
      senderCounts.set(address, (senderCounts.get(address) ?? 0) + 1)
      actions.push({
        emailId: email.id,
        sender: address,
        addLabels: [targetLabel],
        archive: true,
        reason: 'unsubscribe heuristic',
      })
    }

    const { executed, skippedByConfirm } = await executeActions(ctx, 'sweep', actions, opts.audit)

    return {
      scanned,
      planned: actions.length,
      executed,
      skippedByConfirm,
      keptOut,
      topSenders: [...senderCounts.entries()]
        .map(([email, count]) => ({ email, count }))
        .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email))
        .slice(0, 15),
    }
  })
}
