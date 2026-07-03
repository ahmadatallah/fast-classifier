import { describe, expect, test } from 'bun:test'
import { defaultProviderFactory } from '../../src/cli/provider-factory.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import { makeHarness, TEST_ENV } from './helpers.js'

describe('cli error handling', () => {
  test('unknown provider type is a friendly one-liner, exit code 1', async () => {
    const h = await makeHarness([], { factory: defaultProviderFactory, env: TEST_ENV })
    await h.run('-p', 'imap', 'analyze')

    expect(h.exitCodes).toEqual([1])
    expect(h.stderrText()).toContain("unknown provider type 'imap'")
    expect(h.stderrText()).not.toMatch(/\n\s+at /)
  })

  test('missing token surfaces the tokenFromEnv message without stack spam', async () => {
    const h = await makeHarness([], { factory: defaultProviderFactory, env: {} })
    await h.run('analyze')

    expect(h.exitCodes).toEqual([1])
    expect(h.stderrText()).toContain('error: FASTMAIL_API_TOKEN is not set')
    expect(h.stderrText()).toContain('JMAP and MCP tokens are distinct credentials')
    expect(h.stderrText()).not.toMatch(/\n\s+at /)
  })

  test('defaultProviderFactory builds the transport matching the type', () => {
    const config = classifierConfigSchema.parse({})
    expect(defaultProviderFactory('jmap', config, TEST_ENV).kind).toBe('jmap')
    expect(defaultProviderFactory('mcp', config, TEST_ENV).kind).toBe('mcp')
    expect(() => defaultProviderFactory('mcp', config, { FASTMAIL_API_TOKEN: 'x' })).toThrow(
      /FASTMAIL_MCP_TOKEN/,
    )
  })
})
