import type { EmailMeta, SearchQuery } from '../types.js'
import type { MailProvider } from './types.js'

export interface PagerOptions {
  /** pre-seeded from the audit log for resume; yielded ids are added to it */
  seen?: Set<string>
  /** stop after yielding this many */
  max?: number
  /** clamped to provider.caps.maxPageSize */
  pageLimit?: number
  /** consecutive all-seen pages tolerated before stopping (default 6) */
  stallLimit?: number
  stallBackoffMs?: number
  mode?: 'drain' | 'scan'
  /** injectable for tests; default real setTimeout sleep */
  sleep?: (ms: number) => Promise<void>
}

export interface PagerStats {
  yielded: number
  skipped: number
  pages: number
  stalledOut: boolean
}

export interface Pager extends AsyncIterable<EmailMeta> {
  /** Mark a yielded email as deliberately left in place; drain mode steps over it. */
  skip(id: string): void
  readonly stats: PagerStats
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The shared read loop. Offset paging is UNSTABLE when the consumer mutates the
 * mailbox it is paging: archiving shifts the window and the search re-returns
 * already-processed ids. Three defenses, learned the hard way:
 *
 * - a seen-set, so nothing is ever yielded twice;
 * - stall detection: > stallLimit consecutive pages with nothing new → stop;
 * - in 'drain' mode the cursor only advances past items deliberately left in
 *   place (position = count of skip() calls) — consumed items are assumed
 *   removed from the query result by the caller's own mutation.
 *
 * 'scan' mode is for read-only recon over a static result: position advances
 * by items.length per page.
 *
 * MODE CONTRACT (review finding, load-bearing): 'drain' ASSUMES every yielded
 * item is either removed from the query result by the consumer's mutation or
 * marked skip(). A consumer that does neither — e.g. a DRY-RUN planning pass —
 * re-reads page 1 until stall-out and silently misses every later page. Any
 * non-mutating pass MUST use mode: 'scan' (pipelines derive this from their
 * dryRun flag centrally, not per call site).
 */
export const paginate = (
  provider: MailProvider,
  query: SearchQuery,
  opts: PagerOptions = {},
): Pager => {
  const stats: PagerStats = { yielded: 0, skipped: 0, pages: 0, stalledOut: false }
  const seen = opts.seen ?? new Set<string>()
  const skipped = new Set<string>()
  const max = opts.max ?? Infinity
  const limit = Math.min(opts.pageLimit ?? provider.caps.maxPageSize, provider.caps.maxPageSize)
  const stallLimit = opts.stallLimit ?? 6
  const stallBackoffMs = opts.stallBackoffMs ?? 1200
  const mode = opts.mode ?? 'drain'
  const sleep = opts.sleep ?? realSleep

  return {
    stats,

    skip(id: string): void {
      if (skipped.has(id)) return
      skipped.add(id)
      stats.skipped++
    },

    async *[Symbol.asyncIterator](): AsyncIterator<EmailMeta> {
      let scanPosition = 0
      let stall = 0
      while (stats.yielded < max) {
        // drain: skipped items stay at the head of the (shrinking) result — step
        // over exactly them. skipped.size may grow mid-page; sampled per request.
        const position = mode === 'drain' ? skipped.size : scanPosition
        const page = await provider.searchEmails(query, { position, limit })
        stats.pages++
        if (page.items.length === 0) return

        let anyNew = false
        for (const item of page.items) {
          if (seen.has(item.id)) continue
          anyNew = true
          seen.add(item.id)
          stats.yielded++
          yield item
          if (stats.yielded >= max) return
        }
        if (mode === 'scan') scanPosition += page.items.length

        if (anyNew) {
          stall = 0
        } else {
          stall++
          if (stall > stallLimit) {
            stats.stalledOut = true
            return
          }
          await sleep(stallBackoffMs)
        }
      }
    },
  }
}
