import type { EmailMeta, Label, SearchPage, SearchQuery } from '../types.js'

export interface PageRequest {
  position: number
  /** must be <= caps.maxPageSize */
  limit: number
}

/**
 * API quirks expressed as data, so pipelines adapt instead of special-casing
 * transports.
 */
export interface ProviderCapabilities {
  /** Fastmail MCP search hard-caps at 50 */
  maxPageSize: number
  /** 'address-only': -from: takes literal addresses, so keep-lists MUST be re-checked client-side */
  serverSideNotFrom: 'address-only' | 'full'
  /** Fastmail auto-creates labels on addLabels — pre-flight asserts stay as typo protection */
  autoCreatesLabels: boolean
  /** label color is not settable over JMAP */
  canSetLabelColor: boolean
}

/**
 * Deliberately thin: one page, one batch. Iteration, batching, retry, and
 * resumability live in shared machinery (paging.ts / batching.ts), so adapters
 * only encode transport quirks.
 *
 * THE NEVER-DELETE GUARANTEE: this interface has no delete/destroy methods and
 * never will. archive() is the only sanctioned "removal" — it drops the Inbox
 * label and keeps every other label. The worst any bug can do is mislabel or
 * archive mail, never lose it.
 */
export interface MailProvider {
  readonly kind: 'jmap' | 'mcp' | 'memory'
  readonly caps: ProviderCapabilities

  /** JMAP: session discovery; MCP: initialize handshake. Idempotent. */
  connect(): Promise<void>
  listLabels(): Promise<Label[]>
  /**
   * Idempotent bulk create of missing labels (names may be 'Parent/Child'
   * paths). JMAP: single Mailbox/set with client ids c0,c1,… and modal-parent
   * inference for bare names. Returns name -> Label for every requested name.
   */
  ensureLabels(names: string[]): Promise<Map<string, Label>>
  /** One page. Adapters normalize array-vs-{items} response shapes. */
  searchEmails(query: SearchQuery, page: PageRequest): Promise<SearchPage>
  getEmail(id: string): Promise<EmailMeta>
  /** One batch (caller chunks to <= caps.maxPageSize). Labels by name/path. */
  addLabels(emailIds: string[], labelNames: string[]): Promise<void>
  /** Remove from Inbox, keep all other labels. Never `removeLabels: ['Inbox']`. */
  archive(emailIds: string[]): Promise<void>
}

/** Names of MailProvider methods that mutate mail. Used by the dry-run guard. */
export const MUTATING_METHODS = ['ensureLabels', 'addLabels', 'archive'] as const
export type MutatingMethod = (typeof MUTATING_METHODS)[number]

export class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined
  constructor(message = 'rate limited', retryAfterMs?: number) {
    super(message)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

/** Thrown by the JMAP request builder if any methodCall carries a `destroy` key. */
export class NeverDeleteViolation extends Error {
  constructor(method: string) {
    super(`never-delete guarantee violated: ${method} attempted a destroy`)
    this.name = 'NeverDeleteViolation'
  }
}

/** Transport-level failure (MCP isError, JMAP method-level error). */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'TransportError'
  }
}
