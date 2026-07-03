import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerDeps } from './tools.js'
import { registerTools } from './tools.js'

const INSTRUCTIONS = `fast-classifier: deterministic, rule-first email classifier for Fastmail.
Mutating tools (sweep_newsletters, file_inbox, score_needs_action with apply, ensure_labels) default to dryRun: true — call them once dry, inspect the report, then pass dryRun: false to execute.
If the server was started without execution enabled, dryRun is forced true regardless of arguments and results carry forcedDryRun: true.
Nothing here can delete mail: archiving only removes the Inbox label.`

export const createServer = (deps: ServerDeps): McpServer => {
  const server = new McpServer(
    { name: 'fast-classifier', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )
  registerTools(server, deps)
  return server
}

export type { ServerDeps } from './tools.js'
