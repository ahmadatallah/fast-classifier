import { rootDomain } from '../classify/domain.js'
import { paginate } from '../provider/paging.js'
import type { SearchQuery } from '../types.js'
import type { PipelineContext, RunMeta } from './context.js'
import { readProvider, scanOptions, withMeta } from './context.js'
import type { SenderTally } from './plan.js'
import { bumpSender, topSenderTally } from './plan.js'

export interface DomainTally {
  domain: string
  count: number
  /** up to 3 distinct sender addresses seen for this root domain */
  sampleSenders: string[]
}

export interface AnalyzeReport {
  meta: RunMeta
  scanned: number
  senders: SenderTally[]
  domains: DomainTally[]
}

/** Read-only recon: who is filling the inbox, by sender and by root domain. */
export const analyzeInbox = async (
  ctx: PipelineContext,
  opts?: { query?: SearchQuery },
): Promise<AnalyzeReport> => {
  return withMeta('analyze', ctx, async () => {
    let scanned = 0
    const senders = new Map<string, { name: string; count: number }>()
    const domains = new Map<string, { count: number; samples: Set<string> }>()

    const query = opts?.query ?? { inMailbox: 'inbox' }
    const pager = paginate(readProvider(ctx), query, scanOptions(ctx))
    for await (const email of pager) {
      scanned++
      const address = email.from.email.toLowerCase()
      bumpSender(senders, address, email.from.name)

      const root = rootDomain(address)
      if (root === null) continue
      let domain = domains.get(root)
      if (domain === undefined) {
        domain = { count: 0, samples: new Set() }
        domains.set(root, domain)
      }
      domain.count++
      if (domain.samples.size < 3) domain.samples.add(address)
    }

    return {
      scanned,
      senders: topSenderTally(senders),
      domains: [...domains.entries()]
        .map(([domain, { count, samples }]) => ({ domain, count, sampleSenders: [...samples] }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)),
    }
  })
}
