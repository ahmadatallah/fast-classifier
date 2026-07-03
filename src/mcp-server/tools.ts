import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { classify } from '../classify/rules.js'
import type { CompiledRules } from '../config/compile.js'
import type { ClassifierConfig } from '../config/schema.js'
import type { PipelineContext } from '../pipeline/context.js'
import {
  analyzeInbox,
  fileInbox,
  planClassification,
  scoreInboxNeedsAction,
  sweepNewsletters,
  verifyRun,
} from '../pipeline/index.js'
import type { VerifyExpectations } from '../pipeline/index.js'
import type { MailProvider } from '../provider/types.js'
import { allowAll } from '../safety/confirm.js'
import { redactDeep, redactError } from '../safety/redact.js'

export interface ServerDeps {
  provider: MailProvider
  config: ClassifierConfig
  compiled: CompiledRules
  /** master write switch: when false, every mutating tool is forced into dry-run */
  allowExecute: boolean
  log?: (message: string) => void
}

/** Effective dry-run state after applying the allowExecute gate. */
interface Gate {
  dryRun: boolean
  /** true whenever the server cannot execute, so agents know dryRun:false is unavailable */
  forcedDryRun: boolean
}

function gateDryRun(deps: ServerDeps, requested: boolean): Gate {
  if (deps.allowExecute) return { dryRun: requested, forcedDryRun: false }
  return { dryRun: true, forcedDryRun: true }
}

function makeContext(deps: ServerDeps, dryRun: boolean, max?: number): PipelineContext {
  return {
    provider: deps.provider,
    config: deps.config,
    compiled: deps.compiled,
    dryRun,
    max,
    // the write gate here is allowExecute, not a TTY prompt
    confirm: allowAll,
    log: deps.log ?? (() => {}),
  }
}

function toolResult(report: object): CallToolResult {
  // interfaces have no implicit index signature, so cast for structuredContent
  const structured = report as Record<string, unknown>
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

/** Failures become isError results with credentials scrubbed — never raw errors. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (err) {
    return { content: [{ type: 'text', text: redactError(err).message }], isError: true }
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const
// nothing destroys: the MailProvider interface has no delete, archive only drops Inbox
const MUTATING = { readOnlyHint: false, destructiveHint: false } as const

const maxParam = z.number().int().positive().optional().describe('cap on emails scanned this run')
const dryRunParam = z
  .boolean()
  .default(true)
  .describe(
    'plan only, write nothing (default true); forced to true unless the server was started with execution enabled',
  )

export function registerTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'classify_sender',
    {
      title: 'Classify a sender',
      description:
        'Pure rule-engine lookup: which category would mail from this sender file into? No mailbox access.',
      inputSchema: {
        email: z.string().min(3).describe('sender address'),
        name: z.string().default('').describe('sender display name'),
      },
      annotations: READ_ONLY,
    },
    async ({ email, name }) =>
      run(async () => toolResult({ email, name, match: classify({ email, name }, deps.compiled) })),
  )

  server.registerTool(
    'analyze_inbox',
    {
      title: 'Analyze inbox',
      description: 'Read-only recon: who fills the inbox, tallied by sender and by root domain.',
      inputSchema: { max: maxParam },
      annotations: READ_ONLY,
    },
    async ({ max }) =>
      run(async () => toolResult(await analyzeInbox(makeContext(deps, true, max)))),
  )

  server.registerTool(
    'plan_classification',
    {
      title: 'Plan classification',
      description:
        'Read-only coverage report: how the current rules would classify the inbox, plus top unmatched senders to write rules for.',
      inputSchema: { max: maxParam },
      annotations: READ_ONLY,
    },
    async ({ max }) =>
      run(async () => toolResult(await planClassification(makeContext(deps, true, max)))),
  )

  server.registerTool(
    'sweep_newsletters',
    {
      title: 'Sweep newsletters',
      description:
        'Label and archive bulk mail matching the sweep heuristic, keep-list excluded. Dry-run by default.',
      inputSchema: {
        dryRun: dryRunParam,
        max: maxParam,
        targetLabel: z.string().min(1).optional().describe('override config.sweep.targetLabel'),
      },
      annotations: MUTATING,
    },
    async ({ dryRun, max, targetLabel }) =>
      run(async () => {
        const gate = gateDryRun(deps, dryRun)
        const report = await sweepNewsletters(
          makeContext(deps, gate.dryRun, max),
          targetLabel === undefined ? {} : { targetLabel },
        )
        return toolResult({ ...report, forcedDryRun: gate.forcedDryRun })
      }),
  )

  server.registerTool(
    'file_inbox',
    {
      title: 'File inbox',
      description:
        'Classify inbox mail by the configured rules, label per category, then archive. Keep-listed senders are never touched. Dry-run by default.',
      inputSchema: {
        dryRun: dryRunParam,
        max: maxParam,
        categories: z.array(z.string().min(1)).optional().describe('only act on these categories'),
      },
      annotations: MUTATING,
    },
    async ({ dryRun, max, categories }) =>
      run(async () => {
        const gate = gateDryRun(deps, dryRun)
        const report = await fileInbox(
          makeContext(deps, gate.dryRun, max),
          categories === undefined ? {} : { categories },
        )
        return toolResult({ ...report, forcedDryRun: gate.forcedDryRun })
      }),
  )

  server.registerTool(
    'score_needs_action',
    {
      title: 'Score needs-action mail',
      description:
        'Score the recent inbox window for mail likely needing a human response. With apply:true (and dryRun:false) tags candidates with the needs-action label; never archives.',
      inputSchema: {
        apply: z.boolean().default(false).describe('tag candidates with the needs-action label'),
        dryRun: dryRunParam,
        max: maxParam,
      },
      annotations: MUTATING,
    },
    async ({ apply, dryRun, max }) =>
      run(async () => {
        const gate = gateDryRun(deps, dryRun)
        const report = await scoreInboxNeedsAction(makeContext(deps, gate.dryRun, max), { apply })
        return toolResult({ ...report, forcedDryRun: gate.forcedDryRun })
      }),
  )

  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description: 'All labels/mailboxes with paths and message totals.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => run(async () => toolResult({ labels: await deps.provider.listLabels() })),
  )

  server.registerTool(
    'ensure_labels',
    {
      title: 'Ensure labels exist',
      description:
        "Idempotent bulk create of missing labels (names may be 'Parent/Child' paths). Dry-run by default.",
      inputSchema: {
        names: z.array(z.string().min(1)).min(1).describe('label names or paths to ensure'),
        dryRun: dryRunParam,
      },
      annotations: { ...MUTATING, idempotentHint: true },
    },
    async ({ names, dryRun }) =>
      run(async () => {
        const gate = gateDryRun(deps, dryRun)
        if (gate.dryRun) {
          return toolResult({
            dryRun: true,
            forcedDryRun: gate.forcedDryRun,
            requested: names,
            ensured: [],
          })
        }
        const byName = await deps.provider.ensureLabels(names)
        const ensured = [...byName.entries()].map(([requested, label]) => ({
          requested,
          id: label.id,
          name: label.name,
          path: label.path,
        }))
        return toolResult({ dryRun: false, forcedDryRun: false, requested: names, ensured })
      }),
  )

  server.registerTool(
    'verify_run',
    {
      title: 'Verify a run',
      description:
        'Post-run assertions: label totals plus per-sender inbox contains/cleared probes. Read-only.',
      inputSchema: {
        labels: z
          .array(
            z.object({
              name: z.string().min(1),
              minTotal: z.number().int().nonnegative().optional(),
              exactTotal: z.number().int().nonnegative().optional(),
            }),
          )
          .optional(),
        inboxContainsSenders: z.array(z.string()).optional(),
        inboxClearedSenders: z.array(z.string()).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ labels, inboxContainsSenders, inboxClearedSenders }) =>
      run(async () => {
        const expectations: VerifyExpectations = {
          labels,
          inboxContainsSenders,
          inboxClearedSenders,
        }
        return toolResult(await verifyRun(makeContext(deps, true), expectations))
      }),
  )

  server.registerTool(
    'get_effective_config',
    {
      title: 'Get effective config',
      description:
        'The fully-resolved classifier config (defaults applied), with credential-looking strings redacted.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => run(async () => toolResult(redactDeep(deps.config))),
  )
}
