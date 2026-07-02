import type { EmailMeta, Label, SearchPage, SearchQuery } from '../types.js'
import type { MailProvider, PageRequest, ProviderCapabilities } from './types.js'

export interface MemoryOptions {
  labels?: string[]
  caps?: Partial<ProviderCapabilities>
}

const DEFAULT_CAPS: ProviderCapabilities = {
  maxPageSize: 50,
  serverSideNotFrom: 'full',
  autoCreatesLabels: true,
  canSetLabelColor: false,
}

/** Test-helper email with sane defaults; override anything via `partial`. */
export function makeEmail(partial: Partial<EmailMeta> & { id: string }): EmailMeta {
  return {
    subject: '',
    snippet: '',
    from: { name: '', email: 'sender@example.com' },
    receivedAt: '2026-01-01T00:00:00Z',
    isUnread: true,
    labels: ['Inbox'],
    ...partial,
  }
}

/**
 * In-memory MailProvider. searchEmails slices [position, position+limit] of
 * the CURRENT filtered list, so it faithfully reproduces paging-under-mutation:
 * archiving shifts the window exactly like the real transports do.
 */
export class MemoryMailProvider implements MailProvider {
  readonly kind = 'memory' as const
  readonly caps: ProviderCapabilities

  private readonly emails: EmailMeta[]
  /** requested name/path -> Label */
  private readonly registered = new Map<string, Label>()
  private nextLabelId = 1

  constructor(emails: EmailMeta[], opts: MemoryOptions = {}) {
    this.emails = emails
    this.caps = { ...DEFAULT_CAPS, ...opts.caps }
    for (const name of opts.labels ?? []) this.register(name)
  }

  async connect(): Promise<void> {}

  async listLabels(): Promise<Label[]> {
    for (const email of this.emails) for (const name of email.labels) this.register(name)
    const counts = new Map<string, number>()
    for (const email of this.emails) {
      for (const name of email.labels) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...this.registered.entries()].map(([name, label]) => ({
      ...label,
      totalEmails: counts.get(name) ?? 0,
    }))
  }

  async ensureLabels(names: string[]): Promise<Map<string, Label>> {
    const out = new Map<string, Label>()
    for (const name of names) out.set(name, this.register(name))
    return out
  }

  async searchEmails(query: SearchQuery, page: PageRequest): Promise<SearchPage> {
    const filtered = this.emails.filter((email) => this.matches(email, query))
    return {
      items: filtered.slice(page.position, page.position + page.limit),
      position: page.position,
      total: filtered.length,
    }
  }

  async getEmail(id: string): Promise<EmailMeta> {
    const email = this.emails.find((e) => e.id === id)
    if (!email) throw new Error(`unknown email id: ${id}`)
    return email
  }

  async addLabels(emailIds: string[], labelNames: string[]): Promise<void> {
    const targets = await Promise.all(emailIds.map((id) => this.getEmail(id)))
    for (const name of labelNames) this.register(name) // Fastmail auto-creates on addLabels
    for (const email of targets) {
      for (const name of labelNames) {
        if (!email.labels.includes(name)) email.labels.push(name)
      }
    }
  }

  async archive(emailIds: string[]): Promise<void> {
    const targets = await Promise.all(emailIds.map((id) => this.getEmail(id)))
    for (const email of targets) {
      email.labels = email.labels.filter((name) => name !== 'Inbox')
    }
  }

  private matches(email: EmailMeta, query: SearchQuery): boolean {
    if (query.inMailbox !== undefined) {
      const label = query.inMailbox === 'inbox' ? 'Inbox' : query.inMailbox
      if (!email.labels.includes(label)) return false
    }
    if (query.text !== undefined) {
      const haystack = `${email.subject} ${email.snippet ?? ''}`.toLowerCase()
      if (!haystack.includes(query.text.toLowerCase())) return false
    }
    if (query.from !== undefined && email.from.email !== query.from) return false
    // 'address-only' caps behave identically here — the distinction matters to
    // CALLERS, who must re-check keep-lists client-side rather than rely on it.
    if (query.notFrom !== undefined && query.notFrom.includes(email.from.email)) return false
    if (query.after !== undefined) {
      if (new Date(email.receivedAt).getTime() < new Date(query.after).getTime()) return false
    }
    if (query.unreadOnly === true && !email.isUnread) return false
    return true
  }

  private register(name: string): Label {
    const existing = this.registered.get(name)
    if (existing) return existing
    const slash = name.lastIndexOf('/')
    const label: Label = {
      id: `L${this.nextLabelId++}`,
      name: slash === -1 ? name : name.slice(slash + 1),
      path: slash === -1 ? undefined : name,
    }
    this.registered.set(name, label)
    return label
  }
}
