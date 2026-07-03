import type { SearchQuery } from '../../types.js'

/**
 * Compile a SearchQuery to Fastmail's Gmail-style search DSL.
 *
 * Session-proven quirks encoded here:
 * - `-from:` takes LITERAL addresses only — domain negation is silently
 *   ignored by the server, so callers must re-check keep-lists client-side
 *   (caps.serverSideNotFrom === 'address-only').
 * - `after:YYYY-MM-DD` is the only date operator that works.
 * - Operator values are whitespace-tokenized by the server: an unquoted
 *   spaced label (`in:Needs action`) parses as `in:Needs` plus the free-text
 *   term `action` — silently wrong scope. Values containing whitespace are
 *   therefore double-quoted. `text` stays unquoted on purpose: it is a bag of
 *   free-text terms, not a phrase.
 *
 * Parts are space-joined in stable order: in, text, from, notFrom…, after,
 * is:unread.
 */
export function buildSearchString(query: SearchQuery): string {
  const parts: string[] = []
  if (query.inMailbox) parts.push(`in:${quote(query.inMailbox)}`)
  if (query.text) parts.push(query.text)
  if (query.from) parts.push(`from:${quote(query.from)}`)
  for (const addr of query.notFrom ?? []) parts.push(`-from:${quote(addr)}`)
  if (query.after) parts.push(`after:${query.after}`)
  if (query.unreadOnly) parts.push('is:unread')
  return parts.join(' ')
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '')}"` : value
}
