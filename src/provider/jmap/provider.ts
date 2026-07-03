import type { EmailMeta, Label, SearchPage, SearchQuery } from '../../types.js'
import type { MailProvider, PageRequest, ProviderCapabilities } from '../types.js'
import { TransportError } from '../types.js'
import type { JmapClientOptions, JmapMethodResponse } from './client.js'
import { createJmapClient, throwIfRateLimited } from './client.js'
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

const asRecord = (value: unknown): Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const setErrorText = (error: unknown): string => {
  const rec = asRecord(error)
  const type = typeof rec['type'] === 'string' ? rec['type'] : 'unknown error'
  const description = typeof rec['description'] === 'string' ? ` (${rec['description']})` : ''
  return `${type}${description}`
}

const computePath = (box: JmapMailbox, byId: Map<string, JmapMailbox>): string => {
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

const toLabel = (box: JmapMailbox): Label => {
  return {
    id: box.id,
    name: box.name,
    path: box.path,
    parentId: box.parentId,
    role: box.role,
    totalEmails: box.totalEmails,
  }
}

export const createJmapMailProvider = (opts: JmapProviderOptions): MailProvider => {
  const caps: ProviderCapabilities = {
    maxPageSize: 100,
    serverSideNotFrom: 'full',
    autoCreatesLabels: false,
    canSetLabelColor: false,
  }

  const client = createJmapClient(opts)
  let byId = new Map<string, JmapMailbox>()
  let byName = new Map<string, JmapMailbox>()
  let byPath = new Map<string, JmapMailbox>()
  let inbox: JmapMailbox | null = null
  let archiveBox: JmapMailbox | null = null
  let ready = false

  const pickTuple = (
    responses: JmapMethodResponse[],
    method: string,
    callId: string,
  ): JmapMethodResponse => {
    const found = responses.find((r) => r[0] === method && r[2] === callId)
    if (found === undefined) {
      throw new TransportError(`JMAP response missing ${method} (callId '${callId}')`)
    }
    return found
  }

  const pickResponse = (
    responses: JmapMethodResponse[],
    method: string,
    callId: string,
  ): Record<string, unknown> => {
    return pickTuple(responses, method, callId)[1]
  }

  const resolveMailbox = (name: string): JmapMailbox | undefined => {
    return byName.get(name) ?? byPath.get(name) ?? byPath.get(`Inbox/${name}`)
  }

  const refreshMailboxes = async (): Promise<void> => {
    const responses = await client.request([
      ['Mailbox/get', { accountId: client.accountId, properties: MAILBOX_PROPERTIES }, '0'],
    ])
    const getArgs = pickResponse(responses, 'Mailbox/get', '0')
    const list = Array.isArray(getArgs['list']) ? (getArgs['list'] as unknown[]) : []
    const nextById = new Map<string, JmapMailbox>()
    for (const entry of list) {
      const raw = asRecord(entry)
      if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') continue
      nextById.set(raw['id'], {
        id: raw['id'],
        name: raw['name'],
        parentId: typeof raw['parentId'] === 'string' ? raw['parentId'] : null,
        role: typeof raw['role'] === 'string' ? raw['role'] : null,
        totalEmails: typeof raw['totalEmails'] === 'number' ? raw['totalEmails'] : undefined,
        path: '',
      })
    }
    byId = nextById
    byName = new Map()
    byPath = new Map()
    inbox = null
    archiveBox = null
    for (const box of nextById.values()) {
      box.path = computePath(box, nextById)
      if (!byName.has(box.name)) byName.set(box.name, box)
      if (!byPath.has(box.path)) byPath.set(box.path, box)
      if (box.role === 'inbox') inbox = box
      if (box.role === 'archive') archiveBox = box
    }
  }

  const toEmailMeta = (raw: Record<string, unknown>): EmailMeta => {
    const keywords = asRecord(raw['keywords'])
    const fromList = Array.isArray(raw['from']) ? (raw['from'] as unknown[]) : []
    const sender = asRecord(fromList[0])
    const mailboxIds = asRecord(raw['mailboxIds'])
    const labels = Object.entries(mailboxIds)
      .filter(([, present]) => present === true)
      .map(([id]) => byId.get(id)?.name)
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

  /** Most common parentId among existing user labels (non-role mailboxes), else top level. */
  const modalParentId = (): string | null => {
    const counts = new Map<string | null, number>()
    for (const box of byId.values()) {
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

  const emailSet = async (update: Record<string, Record<string, unknown>>): Promise<void> => {
    const responses = await client.request([
      ['Email/set', { accountId: client.accountId, update }, '0'],
    ])
    const setResponse = pickTuple(responses, 'Email/set', '0')
    throwIfRateLimited(setResponse)
    const notUpdated = Object.entries(asRecord(setResponse[1]['notUpdated']))
    if (notUpdated.length > 0) {
      const detail = notUpdated.map(([id, err]) => `${id}: ${setErrorText(err)}`).join('; ')
      throw new TransportError(`Email/set failed for ${notUpdated.length} email(s): ${detail}`)
    }
  }

  const createMailboxes = async (missing: string[]): Promise<Map<string, JmapMailbox>> => {
    const modalParent = modalParentId()
    const create: Record<string, { name: string; parentId: string | null }> = {}
    const cidBySpec = new Map<string, string>()
    let counter = 0
    // Returns an existing mailbox id or a '#cX' reference to a pending create,
    // creating missing parents first so references point backwards.
    const refFor = (spec: string): string => {
      const existing = resolveMailbox(spec)
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

    const responses = await client.request([
      ['Mailbox/set', { accountId: client.accountId, create }, '0'],
    ])
    const setResponse = pickTuple(responses, 'Mailbox/set', '0')
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
    await refreshMailboxes()
    const bySpec = new Map<string, JmapMailbox>()
    for (const [spec, cid] of cidBySpec) {
      const id = asRecord(created[cid])['id']
      const box = typeof id === 'string' ? byId.get(id) : undefined
      if (box !== undefined) bySpec.set(spec, box)
    }
    return bySpec
  }

  const connect = async (): Promise<void> => {
    if (ready) return
    await client.connect()
    await refreshMailboxes()
    ready = true
  }

  const listLabels = async (): Promise<Label[]> => {
    await connect()
    await refreshMailboxes()
    return [...byId.values()].map(toLabel)
  }

  const ensureLabels = async (names: string[]): Promise<Map<string, Label>> => {
    await connect()
    const missing = [...new Set(names)].filter((name) => resolveMailbox(name) === undefined)
    const createdBySpec =
      missing.length > 0 ? await createMailboxes(missing) : new Map<string, JmapMailbox>()
    const result = new Map<string, Label>()
    for (const name of names) {
      const box = createdBySpec.get(name) ?? resolveMailbox(name)
      if (box === undefined) {
        throw new TransportError(`label '${name}' still missing after ensureLabels`)
      }
      result.set(name, toLabel(box))
    }
    return result
  }

  const searchEmails = async (query: SearchQuery, page: PageRequest): Promise<SearchPage> => {
    await connect()
    let resolved = query
    if (query.inMailbox !== undefined && query.inMailbox !== 'inbox') {
      const box = resolveMailbox(query.inMailbox)
      if (box === undefined) {
        throw new TransportError(`unknown mailbox '${query.inMailbox}' in search query`)
      }
      resolved = { ...query, inMailbox: box.id }
    }
    const accountId = client.accountId
    const filter = buildEmailFilter(resolved, inbox?.id ?? null)
    const responses = await client.request([
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
    const queryArgs = pickResponse(responses, 'Email/query', 'q0')
    const getArgs = pickResponse(responses, 'Email/get', 'g0')
    const list = Array.isArray(getArgs['list']) ? (getArgs['list'] as unknown[]) : []
    return {
      items: list.map((raw) => toEmailMeta(asRecord(raw))),
      position: typeof queryArgs['position'] === 'number' ? queryArgs['position'] : page.position,
      total: typeof queryArgs['total'] === 'number' ? queryArgs['total'] : undefined,
    }
  }

  const getEmail = async (id: string): Promise<EmailMeta> => {
    await connect()
    const responses = await client.request([
      ['Email/get', { accountId: client.accountId, ids: [id], properties: EMAIL_PROPERTIES }, 'g0'],
    ])
    const getArgs = pickResponse(responses, 'Email/get', 'g0')
    const list = Array.isArray(getArgs['list']) ? (getArgs['list'] as unknown[]) : []
    const raw = list.map(asRecord).find((entry) => entry['id'] === id)
    if (raw === undefined) throw new TransportError(`email '${id}' not found`)
    return toEmailMeta(raw)
  }

  const addLabels = async (emailIds: string[], labelNames: string[]): Promise<void> => {
    await connect()
    const boxes = labelNames.map((name) => {
      const box = resolveMailbox(name)
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
    await emailSet(update)
  }

  const archive = async (emailIds: string[]): Promise<void> => {
    await connect()
    if (emailIds.length === 0) return
    if (inbox === null) throw new TransportError('no mailbox with role inbox')
    if (archiveBox === null) throw new TransportError('no mailbox with role archive')
    // Always pair inbox:null with archive:true so no email can end up in zero
    // mailboxes; the patch touches only these two keys, preserving labels.
    const update: Record<string, Record<string, unknown>> = {}
    for (const id of emailIds) {
      update[id] = {
        [`mailboxIds/${inbox.id}`]: null,
        [`mailboxIds/${archiveBox.id}`]: true,
      }
    }
    await emailSet(update)
  }

  return {
    kind: 'jmap',
    caps,
    connect,
    listLabels,
    ensureLabels,
    searchEmails,
    getEmail,
    addLabels,
    archive,
  }
}
