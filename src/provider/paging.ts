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
export class Pager implements AsyncIterable<EmailMeta> {
  readonly stats: PagerStats = { yielded: 0, skipped: 0, pages: 0, stalledOut: false }

  private readonly seen: Set<string>
  private readonly skipped = new Set<string>()
  private readonly max: number
  private readonly limit: number
  private readonly stallLimit: number
  private readonly stallBackoffMs: number
  private readonly mode: 'drain' | 'scan'
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly provider: MailProvider,
    private readonly query: SearchQuery,
    opts: PagerOptions = {},
  ) {
    this.seen = opts.seen ?? new Set()
    this.max = opts.max ?? Infinity
    this.limit = Math.min(opts.pageLimit ?? provider.caps.maxPageSize, provider.caps.maxPageSize)
    this.stallLimit = opts.stallLimit ?? 6
    this.stallBackoffMs = opts.stallBackoffMs ?? 1200
    this.mode = opts.mode ?? 'drain'
    this.sleep = opts.sleep ?? realSleep
  }

  /** Mark a yielded email as deliberately left in place; drain mode steps over it. */
  skip(emailId: string): void {
    if (this.skipped.has(emailId)) return
    this.skipped.add(emailId)
    this.stats.skipped++
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EmailMeta> {
    let scanPosition = 0
    let stall = 0
    while (this.stats.yielded < this.max) {
      // drain: skipped items stay at the head of the (shrinking) result — step
      // over exactly them. skipped.size may grow mid-page; sampled per request.
      const position = this.mode === 'drain' ? this.skipped.size : scanPosition
      const page = await this.provider.searchEmails(this.query, { position, limit: this.limit })
      this.stats.pages++
      if (page.items.length === 0) return

      let anyNew = false
      for (const item of page.items) {
        if (this.seen.has(item.id)) continue
        anyNew = true
        this.seen.add(item.id)
        this.stats.yielded++
        yield item
        if (this.stats.yielded >= this.max) return
      }
      if (this.mode === 'scan') scanPosition += page.items.length

      if (anyNew) {
        stall = 0
      } else {
        stall++
        if (stall > this.stallLimit) {
          this.stats.stalledOut = true
          return
        }
        await this.sleep(this.stallBackoffMs)
      }
    }
  }
}

export function paginate(provider: MailProvider, query: SearchQuery, opts?: PagerOptions): Pager {
  return new Pager(provider, query, opts)
}
