import type { TsvAudit } from '../audit/index.js'
import { classify } from '../classify/rules.js'
import { paginate } from '../provider/paging.js'
import type { PlannedAction } from './actions.js'
import { executeActions } from './actions.js'
import type { PipelineContext, RunMeta } from './context.js'
import { readProvider, scanOptions, withMeta } from './context.js'
import type { SenderTally } from './plan.js'
import { bumpSender, coveragePercent, topSenderTally } from './plan.js'

export interface FileOptions {
  /** only act on these categories (others still count as matched) */
  categories?: string[]
  audit?: TsvAudit
}

export interface FileReport {
  meta: RunMeta
  scanned: number
  planned: number
  executed: number
  skippedByConfirm: boolean
  keptOut: number
  /** planned actions per category, insertion order = count desc */
  tally: Record<string, number>
  unmatched: number
  unmatchedTopSenders: SenderTally[]
  coveragePercent: number
}

/** File classified mail out of the inbox: label per category, then archive. */
export const fileInbox = async (
  ctx: PipelineContext,
  opts: FileOptions = {},
): Promise<FileReport> => {
  return withMeta('file', ctx, async () => {
    const only = opts.categories === undefined ? null : new Set(opts.categories)
    let scanned = 0
    let matched = 0
    let keptOut = 0
    let unmatched = 0
    const tally = new Map<string, number>()
    const unmatchedSenders = new Map<string, { name: string; count: number }>()
    const actions: PlannedAction[] = []

    const pager = paginate(
      readProvider(ctx),
      { inMailbox: 'inbox' },
      scanOptions(ctx, opts.audit?.processedIds),
    )
    for await (const email of pager) {
      scanned++
      const address = email.from.email.toLowerCase()
      // keep-listed senders are never archived, even when a rule matches them
      if (ctx.compiled.keepSet.has(address)) {
        keptOut++
        continue
      }
      const match = classify(email.from, ctx.compiled)
      if (match === null) {
        unmatched++
        bumpSender(unmatchedSenders, address, email.from.name)
        continue
      }
      matched++
      if (only !== null && !only.has(match.category)) continue
      // detection fallback categories (Accounts/Personal) may have no
      // CategoryDef — the category name doubles as the label
      const label = ctx.compiled.categories.get(match.category)?.label ?? match.category
      tally.set(match.category, (tally.get(match.category) ?? 0) + 1)
      actions.push({
        emailId: email.id,
        sender: address,
        addLabels: [label],
        archive: true,
        reason: match.reason,
      })
    }

    const { executed, skippedByConfirm } = await executeActions(ctx, 'file', actions, opts.audit)

    return {
      scanned,
      planned: actions.length,
      executed,
      skippedByConfirm,
      keptOut,
      tally: Object.fromEntries(
        [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      unmatched,
      unmatchedTopSenders: topSenderTally(unmatchedSenders, 20),
      coveragePercent: coveragePercent(matched, scanned),
    }
  })
}
