import type { SearchQuery } from '../../types.js'

/**
 * Compile the transport-neutral SearchQuery into a JMAP Email/query filter
 * tree. `query.inMailbox === 'inbox'` resolves to the passed inboxId; any
 * other value must already be a mailbox id (the provider resolves label
 * names before calling).
 */
export function buildEmailFilter(
  query: SearchQuery,
  inboxId: string | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (query.inMailbox !== undefined) {
    const id = query.inMailbox === 'inbox' ? inboxId : query.inMailbox
    if (id !== null) base['inMailbox'] = id
  }
  if (query.text !== undefined) base['text'] = query.text
  if (query.from !== undefined) base['from'] = query.from
  if (query.unreadOnly) base['notKeyword'] = '$seen'
  if (query.after !== undefined) base['after'] = `${query.after}T00:00:00Z`

  const notFrom = query.notFrom ?? []
  if (notFrom.length === 0) return base
  const negation = {
    operator: 'NOT',
    conditions: notFrom.map((from) => ({ from })),
  }
  if (Object.keys(base).length === 0) return negation
  return { operator: 'AND', conditions: [base, negation] }
}
