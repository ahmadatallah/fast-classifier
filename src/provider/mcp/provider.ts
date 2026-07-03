import type { EmailMeta, Label, SearchPage, SearchQuery, SenderInfo } from '../../types.js'
import { labelMatches } from '../../types.js'
import type { MailProvider, PageRequest, ProviderCapabilities } from '../types.js'
import { TransportError } from '../types.js'
import { createMcpHttpClient } from './http-client.js'
import type { McpHttpClientOptions } from './http-client.js'
import { buildSearchString } from './query.js'

interface RawSender {
  name?: string
  email?: string
}

interface RawEmail {
  id: string
  threadId?: string
  subject?: string
  from?: RawSender[]
  receivedAt?: string
  isRead?: boolean
  isAnswered?: boolean
  labels?: string[]
  mailboxes?: string[]
  preview?: string
}

interface RawLabel {
  id?: string
  name?: string
  path?: string
  parentId?: string | null
  role?: string | null
  totalEmails?: number
}

/** The server answers EITHER with a bare array OR { items: [...] } — the session hit both. */
const toArray = <T>(r: unknown): T[] => {
  if (Array.isArray(r)) return r as T[]
  const items = (r as { items?: unknown } | null | undefined)?.items
  if (Array.isArray(items)) return items as T[]
  return []
}

const toEmailMeta = (raw: RawEmail): EmailMeta => {
  const sender = raw.from?.[0]
  const from: SenderInfo = {
    name: sender?.name ?? '',
    email: (sender?.email ?? '').toLowerCase(),
  }
  return {
    id: raw.id,
    threadId: raw.threadId,
    subject: raw.subject ?? '',
    from,
    receivedAt: raw.receivedAt ?? '',
    isUnread: !raw.isRead,
    isAnswered: raw.isAnswered,
    labels: raw.labels ?? raw.mailboxes ?? [],
    snippet: raw.preview,
  }
}

const toLabel = (raw: RawLabel): Label => {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    path: raw.path,
    parentId: raw.parentId,
    role: raw.role,
    totalEmails: raw.totalEmails,
  }
}

export interface McpMailProvider extends MailProvider {
  readonly kind: 'mcp'
}

export const createMcpMailProvider = (opts: McpHttpClientOptions): McpMailProvider => {
  const caps: ProviderCapabilities = {
    // Hard server cap on search_email
    maxPageSize: 50,
    serverSideNotFrom: 'address-only',
    autoCreatesLabels: true,
    canSetLabelColor: false,
  }

  const client = createMcpHttpClient(opts)

  const connect = async (): Promise<void> => {
    await client.init()
  }

  const searchEmails = async (query: SearchQuery, page: PageRequest): Promise<SearchPage> => {
    const r = await client.callTool('search_email', {
      query: buildSearchString(query),
      limit: Math.min(page.limit, caps.maxPageSize),
      position: page.position,
    })
    return { items: toArray<RawEmail>(r).map(toEmailMeta), position: page.position }
  }

  const getEmail = async (id: string): Promise<EmailMeta> => {
    const r = await client.callTool('read_email', { ids: [id] })
    const first = toArray<RawEmail>(r)[0]
    if (!first) throw new TransportError(`email not found: ${id}`)
    return toEmailMeta(first)
  }

  const listLabels = async (): Promise<Label[]> => {
    const r = await client.callTool('list_labels', {})
    return toArray<RawLabel>(r).map(toLabel)
  }

  /**
   * Fastmail's MCP has NO create-label tool, but update_email addLabels
   * AUTO-CREATES missing labels (session-proven — hence caps.autoCreatesLabels).
   * Missing names therefore get a placeholder Label { id: '', name } instead of
   * a throw; the real label materializes on the first addLabels call.
   */
  const ensureLabels = async (names: string[]): Promise<Map<string, Label>> => {
    const labels = await listLabels()
    const out = new Map<string, Label>()
    for (const name of names) {
      const found = labels.find((l) => labelMatches(l, name))
      out.set(name, found ?? { id: '', name })
    }
    return out
  }

  const addLabels = async (emailIds: string[], labelNames: string[]): Promise<void> => {
    await client.callTool('update_email', { ids: emailIds, addLabels: labelNames })
  }

  const archive = async (emailIds: string[]): Promise<void> => {
    // The sanctioned "remove from Inbox, keep labels". NEVER use
    // update_email removeLabels: ['Inbox'] — the server rejects it.
    await client.callTool('archive_email', { ids: emailIds })
  }

  return {
    kind: 'mcp' as const,
    caps,
    connect,
    searchEmails,
    getEmail,
    listLabels,
    ensureLabels,
    addLabels,
    archive,
  }
}
