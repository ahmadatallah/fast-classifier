import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { compileConfig } from '../../src/config/compile.js'
import type { ClassifierConfigInput } from '../../src/config/schema.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import { createServer } from '../../src/mcp-server/server.js'
import { createMemoryMailProvider, makeEmail } from '../../src/provider/memory.js'
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

const RULE_CONFIG: ClassifierConfigInput = {
  categories: [{ name: 'Shopping', label: 'Shopping' }],
  rules: [{ kind: 'domain', domain: 'shop.example', category: 'Shopping' }],
}

const ALL_TOOLS = [
  'classify_sender',
  'analyze_inbox',
  'plan_classification',
  'suggest_rules',
  'sweep_newsletters',
  'file_inbox',
  'score_needs_action',
  'list_labels',
  'ensure_labels',
  'verify_run',
  'get_effective_config',
]

const READ_ONLY_TOOLS = [
  'classify_sender',
  'analyze_inbox',
  'plan_classification',
  'suggest_rules',
  'list_labels',
  'get_effective_config',
  'verify_run',
]

describe('createServer', () => {
  test('lists every tool with honest annotations', async () => {
    const { client, close } = await connect(createMemoryMailProvider([]))
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))

      expect([...byName.keys()].sort()).toEqual([...ALL_TOOLS].sort())
      for (const name of READ_ONLY_TOOLS) {
        expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true)
      }
      for (const name of ALL_TOOLS) {
        const tool = byName.get(name)
        expect(tool?.annotations?.destructiveHint).toBe(false)
        expect(tool?.inputSchema).toBeDefined()
        if (!READ_ONLY_TOOLS.includes(name)) {
          expect(tool?.annotations?.readOnlyHint).toBe(false)
        }
      }
    } finally {
      await close()
    }
  })

  test('classify_sender matches a domain rule without touching the provider', async () => {
    const { client, close } = await connect(createMemoryMailProvider([]), { config: RULE_CONFIG })
    try {
      const result = await client.callTool({
        name: 'classify_sender',
        arguments: { email: 'orders@shop.example', name: 'Shop Orders' },
      })
      expect(result.isError).toBeFalsy()
      const report = result.structuredContent as {
        match: { category: string; rule: string } | null
      }
      expect(report.match?.category).toBe('Shopping')
      expect(report.match?.rule).toBe('domain')

      // text content mirrors structuredContent exactly
      const text = (result.content as { type: string; text: string }[])[0]
      expect(JSON.parse(text?.text ?? '')).toEqual(report)
    } finally {
      await close()
    }
  })

  test('classify_sender returns null for an unmatched sender', async () => {
    const { client, close } = await connect(createMemoryMailProvider([]), { config: RULE_CONFIG })
    try {
      const result = await client.callTool({
        name: 'classify_sender',
        arguments: { email: 'stranger@unknown.example' },
      })
      expect((result.structuredContent as { match: unknown }).match).toBeNull()
    } finally {
      await close()
    }
  })

  test('analyze_inbox tallies senders read-only', async () => {
    const provider = createMemoryMailProvider([
      makeEmail({ id: 'a', from: { name: 'A', email: 'a@one.example' } }),
      makeEmail({ id: 'b', from: { name: 'A', email: 'a@one.example' } }),
      makeEmail({ id: 'c', from: { name: 'B', email: 'b@two.example' } }),
    ])
    const { client, close } = await connect(provider)
    try {
      const result = await client.callTool({ name: 'analyze_inbox', arguments: {} })
      const report = result.structuredContent as {
        scanned: number
        senders: { email: string; count: number }[]
        meta: { dryRun: boolean }
      }
      expect(report.scanned).toBe(3)
      expect(report.senders[0]).toMatchObject({ email: 'a@one.example', count: 2 })
      expect(report.meta.dryRun).toBe(true)
    } finally {
      await close()
    }
  })

  test('suggest_rules suggests catalog rules from a seeded inbox without mutating anything', async () => {
    const provider = createMemoryMailProvider([
      // catalog domain, uncovered -> suggestion (test fixture; brand domains are the subject matter)
      makeEmail({ id: 'g1', from: { name: 'GitHub', email: 'notifications@github.com' } }),
      makeEmail({ id: 'g2', from: { name: 'GitHub', email: 'notifications@github.com' } }),
      // no catalog entry -> unknown
      makeEmail({ id: 'u1', from: { name: 'Startup', email: 'news@somestartup.example' } }),
      makeEmail({ id: 'u2', from: { name: 'Startup', email: 'news@somestartup.example' } }),
      // covered by the config's domain rule -> alreadyCovered
      makeEmail({ id: 's1', from: { name: 'Shop', email: 'orders@shop.example' } }),
      // below the default minCount of 2 -> dropped entirely
      makeEmail({ id: 'once', from: { name: 'Once', email: 'hi@once.example' } }),
    ])
    const mutations: string[] = []
    provider.ensureLabels = () => {
      mutations.push('ensureLabels')
      return Promise.reject(new Error('mutated'))
    }
    provider.addLabels = () => {
      mutations.push('addLabels')
      return Promise.reject(new Error('mutated'))
    }
    provider.archive = () => {
      mutations.push('archive')
      return Promise.reject(new Error('mutated'))
    }
    const { client, close } = await connect(provider, { config: RULE_CONFIG })
    try {
      const result = await client.callTool({ name: 'suggest_rules', arguments: {} })
      expect(result.isError).toBeFalsy()
      const report = result.structuredContent as {
        scanned: number
        suggestions: {
          domain: string
          category: string
          count: number
          source: string
          sampleSenders: string[]
        }[]
        unknown: { domain: string; count: number; sampleSenders: string[] }[]
        alreadyCovered: number
        categories: { name: string }[]
        configFragment: string
      }
      expect(report.scanned).toBe(6)
      expect(report.suggestions).toEqual([
        {
          domain: 'github.com',
          category: 'Development',
          count: 2,
          source: 'catalog',
          sampleSenders: ['notifications@github.com'],
        },
      ])
      expect(report.unknown).toEqual([
        { domain: 'somestartup.example', count: 2, sampleSenders: ['news@somestartup.example'] },
      ])
      expect(report.alreadyCovered).toBe(1)
      expect(report.categories.map((c) => c.name)).toEqual(['Development'])
      expect(report.configFragment).toContain(
        "{ kind: 'domain', domain: 'github.com', category: 'Development' },",
      )
      expect(mutations).toEqual([])
    } finally {
      await close()
    }
  })

  describe('get_effective_config', () => {
    const TOKEN_VAR = 'FASTMAIL_API_TOKEN'
    const original = process.env[TOKEN_VAR]

    afterEach(() => {
      if (original === undefined) delete process.env[TOKEN_VAR]
      else process.env[TOKEN_VAR] = original
    })

    test('output contains no token-looking strings', async () => {
      const secret = 'test-secret-token-value-9f8e7d'
      process.env[TOKEN_VAR] = secret
      const { client, close } = await connect(createMemoryMailProvider([]), {
        // smuggle the env token value into a config field to prove redaction
        config: { sweep: { textHeuristic: secret } },
      })
      try {
        const result = await client.callTool({ name: 'get_effective_config', arguments: {} })
        const serialized = JSON.stringify(result.structuredContent)
        expect(serialized).not.toContain(secret)
        expect(serialized).toContain('[REDACTED]')
        // untouched fields survive redaction
        const config = result.structuredContent as { sweep: { targetLabel: string } }
        expect(config.sweep.targetLabel).toBe('Promotion')
      } finally {
        await close()
      }
    })
  })

  test('tool failures come back as redacted isError results, not protocol errors', async () => {
    const provider = createMemoryMailProvider([])
    provider.listLabels = () => Promise.reject(new Error('boom Bearer abc123secret'))
    const { client, close } = await connect(provider)
    try {
      const result = await client.callTool({ name: 'list_labels', arguments: {} })
      expect(result.isError).toBe(true)
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
      expect(text).toContain('boom')
      expect(text).not.toContain('abc123secret')
    } finally {
      await close()
    }
  })
})
