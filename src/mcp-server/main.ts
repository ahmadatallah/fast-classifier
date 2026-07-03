#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { compileConfig } from '../config/compile.js'
import { loadConfig, tokenFromEnv } from '../config/load.js'
import type { ClassifierConfig } from '../config/schema.js'
import { JmapMailProvider } from '../provider/jmap/index.js'
import { McpMailProvider } from '../provider/mcp/index.js'
import type { MailProvider } from '../provider/types.js'
import { redactError } from '../safety/redact.js'
import { createServer } from './server.js'

/** Local factory — the lint boundary keeps shells (cli/, mcp-server/) from importing each other. */
function makeProvider(config: ClassifierConfig): MailProvider {
  const type = config.provider.type
  const token = tokenFromEnv(type)
  const baseUrl = config.provider.baseUrl
  if (type === 'mcp') {
    return new McpMailProvider(baseUrl === undefined ? { token } : { token, endpoint: baseUrl })
  }
  return new JmapMailProvider(baseUrl === undefined ? { token } : { token, sessionUrl: baseUrl })
}

async function main(): Promise<void> {
  // stdout carries the MCP protocol — every human-facing line goes to stderr
  const log = (message: string) => process.stderr.write(`${message}\n`)
  const { config, path } = await loadConfig()
  const compiled = compileConfig(config)
  const allowExecute =
    process.argv.includes('--allow-execute') || process.env.FAST_CLASSIFIER_ALLOW_WRITES === '1'
  const provider = makeProvider(config)
  await provider.connect()
  const server = createServer({ provider, config, compiled, allowExecute, log })
  await server.connect(new StdioServerTransport())
  log(
    `fast-classifier mcp server ready (config: ${path ?? 'built-in defaults'}, ` +
      `provider: ${provider.kind}, ${allowExecute ? 'execution ENABLED' : 'dry-run only'})`,
  )
}

main().catch((err: unknown) => {
  process.stderr.write(`${redactError(err).message}\n`)
  process.exitCode = 1
})
