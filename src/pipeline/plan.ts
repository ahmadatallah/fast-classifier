import { classify } from '../classify/rules.js'
import { paginate } from '../provider/paging.js'
import type { PipelineContext, RunMeta } from './context.js'
import { readProvider, scanOptions, withMeta } from './context.js'

export interface SenderTally {
  email: string
  name: string
  count: number
}

interface SenderEntry {
  name: string
  count: number
}

export const bumpSender = (map: Map<string, SenderEntry>, email: string, name: string): void => {
  let entry = map.get(email)
  if (entry === undefined) {
    entry = { name, count: 0 }
    map.set(email, entry)
  }
  entry.count++
  if (entry.name === '' && name !== '') entry.name = name
}

export const topSenderTally = (map: Map<string, SenderEntry>, top?: number): SenderTally[] => {
  const sorted = [...map.entries()]
    .map(([email, { name, count }]) => ({ email, name, count }))
    .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email))
  return top === undefined ? sorted : sorted.slice(0, top)
}

export const coveragePercent = (matched: number, scanned: number): number => {
  return scanned === 0 ? 0 : Math.round((matched / scanned) * 1000) / 10
}

export interface PlanReport {
  meta: RunMeta
  scanned: number
  matched: number
  coveragePercent: number
  /** category -> count, insertion order = count desc */
  distribution: Record<string, number>
  unmatchedTopSenders: SenderTally[]
}

/**
 * The iterate-rules-to-coverage flywheel: run, add rules for the top unmatched
 * senders, re-run — no mutations at any point.
 */
export const planClassification = async (ctx: PipelineContext): Promise<PlanReport> => {
  return withMeta('plan', ctx, async () => {
    let scanned = 0
    let matched = 0
    const distribution = new Map<string, number>()
    const unmatched = new Map<string, SenderEntry>()

    const pager = paginate(readProvider(ctx), { inMailbox: 'inbox' }, scanOptions(ctx))
    for await (const email of pager) {
      scanned++
      const match = classify(email.from, ctx.compiled)
      if (match === null) {
        bumpSender(unmatched, email.from.email.toLowerCase(), email.from.name)
        continue
      }
      matched++
      distribution.set(match.category, (distribution.get(match.category) ?? 0) + 1)
    }

    return {
      scanned,
      matched,
      coveragePercent: coveragePercent(matched, scanned),
      distribution: Object.fromEntries(
        [...distribution.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      unmatchedTopSenders: topSenderTally(unmatched, 40),
    }
  })
}
