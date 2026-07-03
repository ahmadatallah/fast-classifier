import { scoreNeedsAction } from '../classify/needs-action.js'
import { paginate } from '../provider/paging.js'
import type { SenderInfo } from '../types.js'
import type { PlannedAction } from './actions.js'
import { executeActions } from './actions.js'
import type { PipelineContext, RunMeta } from './context.js'
import { readProvider, scanOptions, withMeta } from './context.js'

export interface NeedsActionCandidate {
  id: string
  receivedAt: string
  from: SenderInfo
  subject: string
  score: number
  signals: string[]
}

export interface NeedsActionOptions {
  /** tag candidates with the needs-action label (never archives) */
  apply?: boolean
  /** injectable clock for the windowDays cutoff */
  now?: Date
}

export interface NeedsActionReport {
  meta: RunMeta
  scanned: number
  candidates: NeedsActionCandidate[]
  tagged: number
}

const DAY_MS = 86_400_000

/** Score the recent inbox window for mail that likely needs a human response. */
export async function scoreInboxNeedsAction(
  ctx: PipelineContext,
  opts: NeedsActionOptions = {},
): Promise<NeedsActionReport> {
  return withMeta('needs-action', ctx, async () => {
    const now = opts.now ?? new Date()
    const after = new Date(now.getTime() - ctx.compiled.needsAction.windowDays * DAY_MS)
      .toISOString()
      .slice(0, 10)

    let scanned = 0
    const candidates: NeedsActionCandidate[] = []
    const pager = paginate(readProvider(ctx), { inMailbox: 'inbox', after }, scanOptions(ctx))
    for await (const email of pager) {
      scanned++
      const { score, signals, needsAction } = scoreNeedsAction(email, ctx.compiled)
      if (!needsAction) continue
      candidates.push({
        id: email.id,
        receivedAt: email.receivedAt,
        from: email.from,
        subject: email.subject,
        score,
        signals,
      })
    }
    candidates.sort(
      (a, b) =>
        b.score - a.score || new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    )

    let tagged = 0
    if (opts.apply === true && !ctx.dryRun) {
      // tagging is an overlay: archive stays false, the email keeps its inbox place
      const actions: PlannedAction[] = candidates.map((candidate) => ({
        emailId: candidate.id,
        sender: candidate.from.email,
        addLabels: [ctx.compiled.needsAction.label],
        archive: false,
        reason: `needs-action score ${candidate.score} (${candidate.signals.join(', ')})`,
      }))
      const result = await executeActions(ctx, 'needs-action', actions)
      tagged = result.executed
    }

    return { scanned, candidates, tagged }
  })
}
