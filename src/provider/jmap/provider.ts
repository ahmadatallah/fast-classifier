import type { EmailMeta, Label, SearchPage, SearchQuery } from '../../types.js'
import type { MailProvider, PageRequest, ProviderCapabilities } from '../types.js'
import { TransportError } from '../types.js'
import type { JmapClientOptions, JmapMethodResponse } from './client.js'
import { JmapClient, throwIfRateLimited } from './client.js'
import { buildEmailFilter } from './query.js'

export type JmapProviderOptions = JmapClientOptions

const MAILBOX_PROPERTIES = ['name', 'parentId', 'role', 'totalEmails']
const EMAIL_PROPERTIES = [
  'id',
  'threadId',
  'subject',
  'from',
  'receivedAt',
  'keywords',
  'mailboxIds',
  'preview',
]

interface JmapMailbox {
  id: string
  name: string
  parentId: string | null
  role: string | null
  totalEmails: number | undefined
  path: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function setErrorText(error: unknown): string {
  const rec = asRecord(error)
  const type = typeof rec['type'] === 'string' ? rec['type'] : 'unknown error'
  const description = typeof rec['description'] === 'string' ? ` (${rec['description']})` : ''
  return `${type}${description}`
}

function computePath(box: JmapMailbox, byId: Map<string, JmapMailbox>): string {
  const parts = [box.name]
  const seen = new Set([box.id])
  let parentId = box.parentId
  while (parentId !== null) {
    const parent = byId.get(parentId)
    if (parent === undefined || seen.has(parent.id)) break
    parts.unshift(parent.name)
    seen.add(parent.id)
    parentId = parent.parentId
  }
  return parts.join('/')
}

function toLabel(box: JmapMailbox): Label {
  return {
    id: box.id,
    name: box.name,
    path: box.path,
    parentId: box.parentId,
    role: box.role,
    totalEmails: box.totalEmails,
  }
}

export class JmapMailProvider implements MailProvider {
  readonly kind = 'jmap' as const
  readonly caps: ProviderCapabilities = {
    maxPageSize: 100,
    serverSideNotFrom: 'full',
    autoCreatesLabels: false,
    canSetLabelColor: false,
  }

  private readonly client: JmapClient
  private byId = new Map<string, JmapMailbox>()
  private byName = new Map<string, JmapMailbox>()
  private byPath = new Map<string, JmapMailbox>()
  private inbox: JmapMailbox | null = null
  private archiveBox: JmapMailbox | null = null
  private ready = false

  constructor(opts: JmapProviderOptions) {
    this.client = new JmapClient(opts)
  }

  async connect(): Promise<void> {
    if (this.ready) return
    await this.client.connect()
    await this.refreshMailboxes()
    this.ready = true
  }

  async listLabels(): Promise<Label[]> {
    await this.connect()
    await this.refreshMailboxes()
    return [...this.byId.values()].map(toLabel)
  }

  async ensureLabels(names: string[]): Promise<Map<string, Label>> {
    await this.connect()
    const missing = [...new Set(names)].filter((name) => this.resolveMailbox(name) === undefined)
    const createdBySpec =
      missing.length > 0 ? await this.createMailboxes(missing) : new Map<string, JmapMailbox>()
    const result = new Map<string, Label>()
    for (const name of names) {
      const box = createdBySpec.get(name) ?? this.resolveMailbox(name)
      if (box === undefined) {
        throw new TransportError(`label '${name}' still missing after ensureLabels`)
      }
      result.set(name, toLabel(box))
    }
    return result
  }

  async searchEmails(query: SearchQuery, page: PageRequest): Promise<SearchPage> {
    await this.connect()
    let resolved = query
    if (query.inMailbox !== undefined && query.inMailbox !== 'inbox') {
      const box = this.resolveMailbox(query.inMailbox)
      if (box === undefined) {
        throw new TransportError(`unknown mailbox '${query.inMailbox}' in search query`)
      }
      resolved = { ...query, inMailbox: box.id }
    }
    const accountId = this.client.accountId
    const filter = buildEmailFilter(resolved, this.inbox?.id ?? null)
    const responses = await this.client.request([
      [
        'Email/query',
        {
          accountId,
          filter,
          // KNOWN LIMITATION: no total-order tiebreaker exists among JMAP's
          // standard sort properties, so equal receivedAt values at a page
          // boundary can reorder between calls; the Pager's audit-resume
          // pattern recovers anything stepped over.
          sort: [{ property: 'receivedAt', isAscending: false }],
          position: page.position,
          limit: page.limit,
          calculateTotal: true,
        },
        'q0',
      ],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
          properties: EMAIL_PROPERTIES,
        },
        'g0',
      ],
    ])
    const queryArgs = this.pickResponse(responses, 'Email/query', 'q0')
    const getArgs = this.pickResponse(responses, 'Email/get', 'g0')
    const list = Array.isArray(getArgs['list']) ? (getArgs['list'] as unknown[]) : []
    return {
      items: list.map((raw) => this.toEmailMeta(asRecord(raw))),
      position: typeof queryArgs['position'] === 'number' ? queryArgs['position'] : page.position,
      total: typeof queryArgs['total'] === 'number' ? queryArgs['total'] : undefined,
    }
  }

  async getEmail(id: string): Promise<EmailMeta> {
    await this.connect()
    const responses = await this.client.request([
      [
        'Email/get',
        { accountId: this.client.accountId, ids: [id], properties: EMAIL_PROPERTIES },
        'g0',
      ],
    ])
    const getArgs = this.pickResponse(responses, 'Email/get', 'g0')
    const list = Array.isArray(getArgs['list']) ? (getArgs['list'] as unknown[]) : []
    const raw = list.map(asRecord).find((entry) => entry['id'] === id)
    if (raw === undefined) throw new TransportError(`email '${id}' not found`)
    return this.toEmailMeta(raw)
  }

  async addLabels(emailIds: string[], labelNames: string[]): Promise<void> {
    await this.connect()
    const boxes = labelNames.map((name) => {
      const box = this.resolveMailbox(name)
      if (box === undefined) {
        throw new TransportError(
          `label '${name}' does not exist — run ensureLabels first (JMAP does not auto-create labels)`,
        )
      }
      return box
    })
    if (emailIds.length === 0 || boxes.length === 0) return
    const update: Record<string, Record<string, unknown>> = {}
    for (const id of emailIds) {
      const patch: Record<string, unknown> = {}
      for (const box of boxes) patch[`mailboxIds/${box.id}`] = true
      update[id] = patch
    }
    await this.emailSet(update)
  }

  async archive(emailIds: string[]): Promise<void> {
    await this.connect()
    if (emailIds.length === 0) return
    if (this.inbox === null) throw new TransportError('no mailbox with role inbox')
    if (this.archiveBox === null) throw new TransportError('no mailbox with role archive')
    // Always pair inbox:null with archive:true so no email can end up in zero
    // mailboxes; the patch touches only these two keys, preserving labels.
    const update: Record<string, Record<string, unknown>> = {}
    for (const id of emailIds) {
      update[id] = {
        [`mailboxIds/${this.inbox.id}`]: null,
        [`mailboxIds/${this.archiveBox.id}`]: true,
      }
    }
    await this.emailSet(update)
  }

  private async emailSet(update: Record<string, Record<string, unknown>>): Promise<void> {
    const responses = await this.client.request([
      ['Email/set', { accountId: this.client.accountId, update }, '0'],
    ])
    const setResponse = this.pickTuple(responses, 'Email/set', '0')
    throwIfRateLimited(setResponse)
    const notUpdated = Object.entries(asRecord(setResponse[1]['notUpdated']))
    if (notUpdated.length > 0) {
      const detail = notUpdated.map(([id, err]) => `${id}: ${setErrorText(err)}`).join('; ')
      throw new TransportError(`Email/set failed for ${notUpdated.length} email(s): ${detail}`)
    }
  }

  private async createMailboxes(missing: string[]): Promise<Map<string, JmapMailbox>> {
    const modalParent = this.modalParentId()
    const create: Record<string, { name: string; parentId: string | null }> = {}
    const cidBySpec = new Map<string, string>()
    let counter = 0
    // Returns an existing mailbox id or a '#cX' reference to a pending create,
    // creating missing parents first so references point backwards.
    const refFor = (spec: string): string => {
      const existing = this.resolveMailbox(spec)
      if (existing !== undefined) return existing.id
      const pending = cidBySpec.get(spec)
      if (pending !== undefined) return `#${pending}`
      const slash = spec.lastIndexOf('/')
      const parentId = slash >= 0 ? refFor(spec.slice(0, slash)) : modalParent
      const cid = `c${counter++}`
      cidBySpec.set(spec, cid)
      create[cid] = { name: slash >= 0 ? spec.slice(slash + 1) : spec, parentId }
      return `#${cid}`
    }
    for (const spec of missing) refFor(spec)

    const responses = await this.client.request([
      ['Mailbox/set', { accountId: this.client.accountId, create }, '0'],
    ])
    const setResponse = this.pickTuple(responses, 'Mailbox/set', '0')
    throwIfRateLimited(setResponse)
    const created = asRecord(setResponse[1]['created'])
    const notCreated = Object.entries(asRecord(setResponse[1]['notCreated']))
    if (notCreated.length > 0) {
      const specByCid = new Map([...cidBySpec].map(([spec, cid]) => [cid, spec]))
      const detail = notCreated
        .map(([cid, err]) => `'${specByCid.get(cid) ?? cid}': ${setErrorText(err)}`)
        .join('; ')
      throw new TransportError(
        `ensureLabels could not create ${notCreated.length} label(s): ${detail}`,
      )
    }
    await this.refreshMailboxes()
    const bySpec = new Map<string, JmapMailbox>()
    for (const [spec, cid] of cidBySpec) {
      const id = asRecord(created[cid])['id']
      const box = typeof id === 'string' ? this.byId.get(id) : undefined
      if (box !== undefined) bySpec.set(spec, box)
    }
    return bySpec
  }

  /** Most common parentId among existing user labels (non-role mailboxes), else top level. */
  private modalParentId(): string | null {
    const counts = new Map<string | null, number>()
    for (const box of this.byId.values()) {
      if (box.role !== null) continue
      counts.set(box.parentId, (counts.get(box.parentId) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [parentId, count] of counts) {
      if (count > bestCount) {
        best = parentId
        bestCount = count
      }
    }
    return best
  }

  private resolveMailbox(name: string): JmapMailbox | undefined {
    return this.byName.get(name) ?? this.byPath.get(name) ?? this.byPath.get(`Inbox/${name}`)
  }

  private async refreshMailboxes(): Promise<void> {
    const responses = await this.client.request([
      ['Mailbox/get', { accountId: this.client.accountId, properties: MAILBOX_PROPERTIES }, '0'],
    ])
    const getArgs = this.pickResponse(responses, 'Mailbox/get', '0')
    const list = Array.isArray(getArgs['list']) ? (getArgs['list'] as unknown[]) : []
    const byId = new Map<string, JmapMailbox>()
    for (const entry of list) {
      const raw = asRecord(entry)
      if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') continue
      byId.set(raw['id'], {
        id: raw['id'],
        name: raw['name'],
        parentId: typeof raw['parentId'] === 'string' ? raw['parentId'] : null,
        role: typeof raw['role'] === 'string' ? raw['role'] : null,
        totalEmails: typeof raw['totalEmails'] === 'number' ? raw['totalEmails'] : undefined,
        path: '',
      })
    }
    this.byId = byId
    this.byName = new Map()
    this.byPath = new Map()
    this.inbox = null
    this.archiveBox = null
    for (const box of byId.values()) {
      box.path = computePath(box, byId)
      if (!this.byName.has(box.name)) this.byName.set(box.name, box)
      if (!this.byPath.has(box.path)) this.byPath.set(box.path, box)
      if (box.role === 'inbox') this.inbox = box
      if (box.role === 'archive') this.archiveBox = box
    }
  }

  private toEmailMeta(raw: Record<string, unknown>): EmailMeta {
    const keywords = asRecord(raw['keywords'])
    const fromList = Array.isArray(raw['from']) ? (raw['from'] as unknown[]) : []
    const sender = asRecord(fromList[0])
    const mailboxIds = asRecord(raw['mailboxIds'])
    const labels = Object.entries(mailboxIds)
      .filter(([, present]) => present === true)
      .map(([id]) => this.byId.get(id)?.name)
      .filter((name): name is string => name !== undefined)
    return {
      id: typeof raw['id'] === 'string' ? raw['id'] : '',
      threadId: typeof raw['threadId'] === 'string' ? raw['threadId'] : undefined,
      subject: typeof raw['subject'] === 'string' ? raw['subject'] : '',
      from: {
        name: typeof sender['name'] === 'string' ? sender['name'] : '',
        email: typeof sender['email'] === 'string' ? sender['email'].toLowerCase() : '',
      },
      receivedAt: typeof raw['receivedAt'] === 'string' ? raw['receivedAt'] : '',
      isUnread: keywords['$seen'] !== true,
      isAnswered: keywords['$answered'] === true,
      labels,
      snippet: typeof raw['preview'] === 'string' ? raw['preview'] : undefined,
    }
  }

  private pickTuple(
    responses: JmapMethodResponse[],
    method: string,
    callId: string,
  ): JmapMethodResponse {
    const found = responses.find((r) => r[0] === method && r[2] === callId)
    if (found === undefined) {
      throw new TransportError(`JMAP response missing ${method} (callId '${callId}')`)
    }
    return found
  }

  private pickResponse(
    responses: JmapMethodResponse[],
    method: string,
    callId: string,
  ): Record<string, unknown> {
    return this.pickTuple(responses, method, callId)[1]
  }
}
