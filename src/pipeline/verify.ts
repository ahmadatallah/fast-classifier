import { labelMatches } from '../types.js'
import type { PipelineContext, RunMeta } from './context.js'
import { withMeta } from './context.js'

export interface LabelExpectation {
  name: string
  minTotal?: number | undefined
  exactTotal?: number | undefined
}

export interface VerifyExpectations {
  labels?: LabelExpectation[] | undefined
  inboxContainsSenders?: string[] | undefined
  inboxClearedSenders?: string[] | undefined
}

export interface VerifyCheck {
  name: string
  ok: boolean
  detail: string
}

export interface VerifyReport {
  meta: RunMeta
  passed: boolean
  checks: VerifyCheck[]
}

/**
 * Post-run assertions. Read-only by construction (listLabels/searchEmails
 * only), so it runs against the raw provider and behaves identically in
 * dry-run mode.
 */
export async function verifyRun(
  ctx: PipelineContext,
  expectations: VerifyExpectations,
): Promise<VerifyReport> {
  return withMeta('verify', ctx, async () => {
    const provider = ctx.provider
    const checks: VerifyCheck[] = []

    const labelExpectations = expectations.labels ?? []
    if (labelExpectations.length > 0) {
      const labels = await provider.listLabels()
      for (const expected of labelExpectations) {
        const name = `label ${expected.name}`
        const found = labels.find((label) => labelMatches(label, expected.name))
        if (found === undefined) {
          checks.push({
            name,
            ok: false,
            detail: `label '${expected.name}' not found — check the name or run ensureLabels`,
          })
          continue
        }
        const total = found.totalEmails ?? 0
        if (expected.exactTotal !== undefined) {
          checks.push({
            name,
            ok: total === expected.exactTotal,
            detail: `expected exactly ${expected.exactTotal} emails, found ${total}`,
          })
        } else if (expected.minTotal !== undefined) {
          checks.push({
            name,
            ok: total >= expected.minTotal,
            detail: `expected at least ${expected.minTotal} emails, found ${total}`,
          })
        } else {
          checks.push({ name, ok: true, detail: `exists with ${total} emails` })
        }
      }
    }

    for (const sender of expectations.inboxContainsSenders ?? []) {
      const page = await provider.searchEmails(
        { inMailbox: 'inbox', from: sender },
        { position: 0, limit: 1 },
      )
      const ok = page.items.length >= 1
      checks.push({
        name: `inbox contains ${sender}`,
        ok,
        detail: ok
          ? 'at least one message still in inbox'
          : `no inbox messages from ${sender} — expected at least one to remain`,
      })
    }

    for (const sender of expectations.inboxClearedSenders ?? []) {
      const page = await provider.searchEmails(
        { inMailbox: 'inbox', from: sender },
        { position: 0, limit: 1 },
      )
      const ok = page.items.length === 0
      const remaining = page.total !== undefined ? ` (${page.total} remaining)` : ''
      checks.push({
        name: `inbox cleared of ${sender}`,
        ok,
        detail: ok
          ? 'no messages left in inbox'
          : `inbox still has messages from ${sender}${remaining} — expected none`,
      })
    }

    return { passed: checks.every((check) => check.ok), checks }
  })
}
