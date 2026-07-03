import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { compileConfig } from '../../src/config/compile.js'
import type { ClassifierConfigInput } from '../../src/config/schema.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import { createServer } from '../../src/mcp-server/server.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
import type { MemoryMailProvider } from '../../src/provider/memory.js'
import type { MailProvider } from '../../src/provider/types.js'

interface Connected {
  client: Client
  close: () => Promise<void>
}

const connect = async (
  provider: MailProvider,
  opts: { config?: ClassifierConfigInput; allowExecute?: boolean } = {},
): Promise<Connected> => {
  const config = classifierConfigSchema.parse(opts.config ?? {})
  const server = createServer({
    provider,
    config,
    compiled: compileConfig(config),
    allowExecute: opts.allowExecute ?? false,
  })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

const sampleMailbox = (): MemoryMailProvider => {
  return createMemoryMailProvider([
    makeEmail({
      id: 'n1',
      from: { name: 'Deals Daily', email: 'news@deals.example' },
      subject: 'Weekly deals',
      snippet: 'Click unsubscribe to stop',
    }),
    makeEmail({
      id: 'n2',
      from: { name: 'Deals Daily', email: 'news@deals.example' },
      subject: 'More deals',
      snippet: 'unsubscribe here',
    }),
    makeEmail({
      id: 'k1',
      from: { name: 'Old Friend', email: 'friend@example.org' },
      subject: 'The newsletter I actually read',
      snippet: 'unsubscribe link at the bottom',
    }),
    makeEmail({
      id: 's1',
      from: { name: 'Shop', email: 'orders@shop.example' },
      subject: 'Your order',
    }),
    makeEmail({
      id: 'a1',
      from: { name: 'Registry Office', email: 'admin@registry.example' },
      subject: 'Action required: please confirm your appointment',
      // must fall inside the needsAction.windowDays cutoff, which uses the real clock
      receivedAt: new Date().toISOString(),
    }),
  ])
}

const SAMPLE_CONFIG: ClassifierConfigInput = {
  categories: [{ name: 'Shopping', label: 'Shopping' }],
  rules: [{ kind: 'domain', domain: 'shop.example', category: 'Shopping' }],
  keepList: ['friend@example.org'],
}

const inboxIds = async (provider: MailProvider): Promise<string[]> => {
  const page = await provider.searchEmails({ inMailbox: 'inbox' }, { position: 0, limit: 1000 })
  return page.items.map((email) => email.id).sort()
}

describe('allowExecute gating', () => {
  test('sweep_newsletters with dryRun:false is forced dry when execution is locked', async () => {
    const provider = sampleMailbox()
    const before = await inboxIds(provider)
    const { client, close } = await connect(provider, { config: SAMPLE_CONFIG })
    try {
      const result = await client.callTool({
        name: 'sweep_newsletters',
        arguments: { dryRun: false },
      })
      expect(result.isError).toBeFalsy()
      const report = result.structuredContent as {
        planned: number
        executed: number
        forcedDryRun: boolean
        meta: { dryRun: boolean }
      }
      expect(report.forcedDryRun).toBe(true)
      expect(report.meta.dryRun).toBe(true)
      expect(report.planned).toBe(2)
      expect(report.executed).toBe(0)
      expect(await inboxIds(provider)).toEqual(before)
    } finally {
      await close()
    }
  })

  test('sweep_newsletters defaults to dry-run even with execution allowed', async () => {
    const provider = sampleMailbox()
    const before = await inboxIds(provider)
    const { client, close } = await connect(provider, {
      config: SAMPLE_CONFIG,
      allowExecute: true,
    })
    try {
      const result = await client.callTool({ name: 'sweep_newsletters', arguments: {} })
      const report = result.structuredContent as {
        planned: number
        executed: number
        forcedDryRun: boolean
        meta: { dryRun: boolean }
      }
      expect(report.forcedDryRun).toBe(false)
      expect(report.meta.dryRun).toBe(true)
      expect(report.planned).toBe(2)
      expect(report.executed).toBe(0)
      expect(await inboxIds(provider)).toEqual(before)
    } finally {
      await close()
    }
  })

  test('sweep_newsletters executes with allowExecute + dryRun:false, then verify_run passes', async () => {
    const provider = sampleMailbox()
    const { client, close } = await connect(provider, {
      config: SAMPLE_CONFIG,
      allowExecute: true,
    })
    try {
      const result = await client.callTool({
        name: 'sweep_newsletters',
        arguments: { dryRun: false },
      })
      const report = result.structuredContent as {
        executed: number
        forcedDryRun: boolean
        meta: { dryRun: boolean }
        topSenders: { email: string; count: number }[]
      }
      expect(report.forcedDryRun).toBe(false)
      expect(report.meta.dryRun).toBe(false)
      expect(report.executed).toBe(2)
      expect(report.topSenders[0]).toMatchObject({ email: 'news@deals.example', count: 2 })

      // newsletters left the inbox and carry the target label; kept sender remains
      const inbox = await inboxIds(provider)
      expect(inbox).toEqual(['a1', 'k1', 's1'])
      expect((await provider.getEmail('n1')).labels).toContain('Promotion')
      expect((await provider.getEmail('n2')).labels).toContain('Promotion')

      const verify = await client.callTool({
        name: 'verify_run',
        arguments: {
          labels: [{ name: 'Promotion', minTotal: 2 }],
          inboxClearedSenders: ['news@deals.example'],
          inboxContainsSenders: ['friend@example.org'],
        },
      })
      const verifyReport = verify.structuredContent as {
        passed: boolean
        checks: { ok: boolean }[]
      }
      expect(verifyReport.passed).toBe(true)
      expect(verifyReport.checks).toHaveLength(3)
    } finally {
      await close()
    }
  })

  test('file_inbox executes rule filing and honors the keep-list', async () => {
    const provider = sampleMailbox()
    const { client, close } = await connect(provider, {
      config: SAMPLE_CONFIG,
      allowExecute: true,
    })
    try {
      const result = await client.callTool({ name: 'file_inbox', arguments: { dryRun: false } })
      const report = result.structuredContent as {
        executed: number
        keptOut: number
        tally: Record<string, number>
        forcedDryRun: boolean
      }
      expect(report.forcedDryRun).toBe(false)
      expect(report.tally).toEqual({ Shopping: 1 })
      expect(report.executed).toBe(1)
      expect(report.keptOut).toBe(1)

      const filed = await provider.getEmail('s1')
      expect(filed.labels).toContain('Shopping')
      expect(filed.labels).not.toContain('Inbox')
      expect(await inboxIds(provider)).toEqual(['a1', 'k1', 'n1', 'n2'])
    } finally {
      await close()
    }
  })

  test('score_needs_action reports candidates but tags nothing while locked', async () => {
    const provider = sampleMailbox()
    const { client, close } = await connect(provider, { config: SAMPLE_CONFIG })
    try {
      const result = await client.callTool({
        name: 'score_needs_action',
        arguments: { apply: true, dryRun: false },
      })
      const report = result.structuredContent as {
        candidates: { id: string }[]
        tagged: number
        forcedDryRun: boolean
      }
      expect(report.forcedDryRun).toBe(true)
      expect(report.candidates.map((c) => c.id)).toEqual(['a1'])
      expect(report.tagged).toBe(0)
      expect((await provider.getEmail('a1')).labels).toEqual(['Inbox'])
    } finally {
      await close()
    }
  })

  test('score_needs_action apply tags candidates without archiving', async () => {
    const provider = sampleMailbox()
    const { client, close } = await connect(provider, {
      config: SAMPLE_CONFIG,
      allowExecute: true,
    })
    try {
      const result = await client.callTool({
        name: 'score_needs_action',
        arguments: { apply: true, dryRun: false },
      })
      const report = result.structuredContent as { tagged: number; forcedDryRun: boolean }
      expect(report.forcedDryRun).toBe(false)
      expect(report.tagged).toBe(1)
      const tagged = await provider.getEmail('a1')
      expect(tagged.labels).toContain('Needs action')
      expect(tagged.labels).toContain('Inbox')
    } finally {
      await close()
    }
  })

  test('ensure_labels is forced dry while locked and creates labels when allowed', async () => {
    const locked = sampleMailbox()
    const lockedConn = await connect(locked, { config: SAMPLE_CONFIG })
    try {
      const result = await lockedConn.client.callTool({
        name: 'ensure_labels',
        arguments: { names: ['Archive/Receipts'], dryRun: false },
      })
      const report = result.structuredContent as {
        forcedDryRun: boolean
        dryRun: boolean
        requested: string[]
        ensured: unknown[]
      }
      expect(report.forcedDryRun).toBe(true)
      expect(report.dryRun).toBe(true)
      expect(report.requested).toEqual(['Archive/Receipts'])
      expect(report.ensured).toEqual([])
      const labels = await locked.listLabels()
      expect(labels.some((label) => label.path === 'Archive/Receipts')).toBe(false)
    } finally {
      await lockedConn.close()
    }

    const open = sampleMailbox()
    const openConn = await connect(open, { config: SAMPLE_CONFIG, allowExecute: true })
    try {
      const result = await openConn.client.callTool({
        name: 'ensure_labels',
        arguments: { names: ['Archive/Receipts'], dryRun: false },
      })
      const report = result.structuredContent as {
        forcedDryRun: boolean
        ensured: { requested: string; id: string; name: string }[]
      }
      expect(report.forcedDryRun).toBe(false)
      expect(report.ensured).toHaveLength(1)
      expect(report.ensured[0]).toMatchObject({ requested: 'Archive/Receipts', name: 'Receipts' })
      const labels = await open.listLabels()
      expect(labels.some((label) => label.path === 'Archive/Receipts')).toBe(true)
    } finally {
      await openConn.close()
    }
  })
})
