/** Shared vocabulary used by every layer (classify, providers, pipelines). */

export interface SenderInfo {
  /** display name as sent, may be empty */
  name: string
  /** address, lowercased by adapters */
  email: string
}

export interface EmailMeta {
  id: string
  threadId?: string | undefined
  subject: string
  from: SenderInfo
  /** ISO 8601 */
  receivedAt: string
  isUnread: boolean
  /** true when the user already replied; drives the needs-reply heuristic */
  isAnswered?: boolean | undefined
  /** label NAMES (adapters map ids/paths to names) */
  labels: string[]
  snippet?: string | undefined
}

export interface Label {
  id: string
  /** leaf name, e.g. 'Dev' */
  name: string
  /** full path for nested labels, e.g. 'Inbox/Dev' */
  path?: string | undefined
  parentId?: string | null | undefined
  /** JMAP role, e.g. 'inbox', 'archive' */
  role?: string | null | undefined
  totalEmails?: number | undefined
}

/**
 * Transport-neutral search. Adapters compile this to a JMAP filter tree or a
 * Fastmail search string, degrading per their capabilities (see
 * ProviderCapabilities.serverSideNotFrom).
 */
export interface SearchQuery {
  inMailbox?: 'inbox' | (string & {}) | undefined
  /** full-text term, e.g. 'unsubscribe' */
  text?: string | undefined
  from?: string | undefined
  /** literal addresses only — domain negation is not supported by Fastmail search */
  notFrom?: string[] | undefined
  /** ISO date YYYY-MM-DD; the only date operator Fastmail search reliably accepts */
  after?: string | undefined
  unreadOnly?: boolean | undefined
}

export interface SearchPage {
  items: EmailMeta[]
  /** offset this page started at */
  position: number
  total?: number | undefined
}

/** Does a label list/name match `name`, which may be a leaf name or a 'Parent/Child' path? */
export function labelMatches(label: Label, name: string): boolean {
  return label.name === name || label.path === name || label.path === `Inbox/${name}`
}
