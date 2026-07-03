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
export const makeEmail = (partial: Partial<EmailMeta> & { id: string }): EmailMeta => {
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

export interface MemoryMailProvider extends MailProvider {
  readonly kind: 'memory'
}

/**
 * In-memory MailProvider. searchEmails slices [position, position+limit] of
 * the CURRENT filtered list, so it faithfully reproduces paging-under-mutation:
 * archiving shifts the window exactly like the real transports do.
 */
export const createMemoryMailProvider = (
  emails: EmailMeta[],
  opts: MemoryOptions = {},
): MemoryMailProvider => {
  const caps: ProviderCapabilities = { ...DEFAULT_CAPS, ...opts.caps }
  /** requested name/path -> Label */
  const registered = new Map<string, Label>()
  let nextLabelId = 1

  const register = (name: string): Label => {
    const existing = registered.get(name)
    if (existing) return existing
    const slash = name.lastIndexOf('/')
    const label: Label = {
      id: `L${nextLabelId++}`,
      name: slash === -1 ? name : name.slice(slash + 1),
      path: slash === -1 ? undefined : name,
    }
    registered.set(name, label)
    return label
  }

  const matches = (email: EmailMeta, query: SearchQuery): boolean => {
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

  const getEmail = async (id: string): Promise<EmailMeta> => {
    const email = emails.find((e) => e.id === id)
    if (!email) throw new Error(`unknown email id: ${id}`)
    return email
  }

  for (const name of opts.labels ?? []) register(name)

  return {
    kind: 'memory',
    caps,

    async connect(): Promise<void> {},

    async listLabels(): Promise<Label[]> {
      for (const email of emails) for (const name of email.labels) register(name)
      const counts = new Map<string, number>()
      for (const email of emails) {
        for (const name of email.labels) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      return [...registered.entries()].map(([name, label]) => ({
        ...label,
        totalEmails: counts.get(name) ?? 0,
      }))
    },

    async ensureLabels(names: string[]): Promise<Map<string, Label>> {
      const out = new Map<string, Label>()
      for (const name of names) out.set(name, register(name))
      return out
    },

    async searchEmails(query: SearchQuery, page: PageRequest): Promise<SearchPage> {
      const filtered = emails.filter((email) => matches(email, query))
      return {
        items: filtered.slice(page.position, page.position + page.limit),
        position: page.position,
        total: filtered.length,
      }
    },

    getEmail,

    async addLabels(emailIds: string[], labelNames: string[]): Promise<void> {
      const targets = await Promise.all(emailIds.map((id) => getEmail(id)))
      for (const name of labelNames) register(name) // Fastmail auto-creates on addLabels
      for (const email of targets) {
        for (const name of labelNames) {
          if (!email.labels.includes(name)) email.labels.push(name)
        }
      }
    },

    async archive(emailIds: string[]): Promise<void> {
      const targets = await Promise.all(emailIds.map((id) => getEmail(id)))
      for (const email of targets) {
        email.labels = email.labels.filter((name) => name !== 'Inbox')
      }
    },
  }
}
