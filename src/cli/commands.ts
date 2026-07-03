import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { InvalidArgumentError, type Command } from 'commander'
import { TsvAudit, writeReport } from '../audit/index.js'
import { compileConfig } from '../config/compile.js'
import { loadConfig } from '../config/load.js'
import type { LabelExpectation, PipelineContext, VerifyExpectations } from '../pipeline/index.js'
import {
  analyzeInbox,
  fileInbox,
  planClassification,
  scoreInboxNeedsAction,
  sweepNewsletters,
  verifyRun,
} from '../pipeline/index.js'
import { allowAll, denyAll, interactiveConfirm } from '../safety/index.js'
import {
  formatAnalyze,
  formatEnsured,
  formatEnsurePlan,
  formatFile,
  formatLabels,
  formatNeedsAction,
  formatPlan,
  formatSweep,
  formatVerify,
} from './output.js'
import type { ProviderFactory } from './provider-factory.js'

export interface CliDeps {
  providerFactory: ProviderFactory
  env: Record<string, string | undefined>
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** commander throws instead of calling process.exit — set by tests */
  exitOverride?: boolean
  /** failure-code sink; defaults to assigning process.exitCode */
  setExitCode?: (code: number) => void
}

interface GlobalOpts {
  config?: string
  provider?: string
  execute?: boolean
  max?: number
  yes?: boolean
  json?: boolean
  reportDir: string
}

export const DRY_RUN_BANNER = 'DRY RUN — no changes will be made (pass --execute to apply)'

function parsePositiveInt(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer')
  return n
}

/**
 * The shared options live on the program AND on every leaf subcommand, so both
 * `fast-classifier --execute sweep` and `fast-classifier sweep --execute`
 * parse. Defaults exist only at the program level — a subcommand default would
 * shadow an explicitly-set program value in optsWithGlobals().
 */
export function addGlobalOptions(cmd: Command, withDefaults: boolean): Command {
  cmd
    .option('-c, --config <path>', 'path to fast-classifier.config.{ts,mjs,js,json}')
    .option('-p, --provider <type>', "mail transport: 'jmap' or 'mcp' (default: from config)")
    .option('--execute', 'apply changes — mutating commands are DRY-RUN by default')
    .option('--max <n>', 'cap on emails scanned per run', parsePositiveInt)
    .option('--yes', 'skip confirmation prompts for large mutation batches')
    .option('--json', 'print the full report JSON to stdout instead of a summary')
  if (withDefaults) {
    cmd.option('--report-dir <dir>', 'directory for reports and audit logs', './.fast-classifier')
  } else {
    cmd.option('--report-dir <dir>', 'directory for reports and audit logs')
  }
  return cmd
}

function exitWith(deps: CliDeps, code: number): void {
  if (deps.setExitCode) deps.setExitCode(code)
  else process.exitCode = code
}

/** Expected failures (missing token, bad config…) print one line, never a stack. */
function wrap<A extends unknown[]>(
  deps: CliDeps,
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (err) {
      deps.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      exitWith(deps, 1)
    }
  }
}

interface CommandRuntime {
  ctx: PipelineContext
  opts: GlobalOpts
}

async function createContext(
  cmd: Command,
  deps: CliDeps,
  mutating: boolean,
): Promise<CommandRuntime> {
  const opts = cmd.optsWithGlobals() as GlobalOpts
  const { config } = await loadConfig(opts.config)
  const provider = deps.providerFactory(opts.provider ?? config.provider.type, config, deps.env)
  await provider.connect()
  const dryRun = opts.execute !== true
  if (mutating && dryRun) deps.stderr.write(`\n${DRY_RUN_BANNER}\n\n`)
  const ctx: PipelineContext = {
    provider,
    config,
    compiled: compileConfig(config),
    dryRun,
    max: opts.max,
    confirm: opts.yes === true ? allowAll : process.stdin.isTTY ? interactiveConfirm() : denyAll,
    confirmThreshold: 100,
    log: (message) => deps.stderr.write(`${message}\n`),
  }
  return { ctx, opts }
}

async function emit(
  deps: CliDeps,
  opts: GlobalOpts,
  name: string,
  report: unknown,
  human: string,
): Promise<void> {
  const path = await writeReport(opts.reportDir, name, report)
  if (opts.json === true) deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else deps.stdout.write(human)
  deps.stderr.write(`report: ${path}\n`)
}

function abortedByConfirm(deps: CliDeps, command: string): void {
  deps.stderr.write(`${command} aborted: confirmation declined (pass --yes to approve)\n`)
  exitWith(deps, 1)
}

/** `Name` = exists, `Name=N` = exactly N emails, `Name>=N` = at least N. */
export function parseLabelExpectation(spec: string): LabelExpectation {
  const m = /^(.*?)(>=|=)(\d+)$/.exec(spec)
  const name = m?.[1] ?? ''
  if (m && name !== '') {
    const count = Number(m[3])
    return m[2] === '>=' ? { name, minTotal: count } : { name, exactTotal: count }
  }
  return { name: spec }
}

const STARTER_CONFIG = `// fast-classifier starter config — edit the maps to your senders.
// Tokens NEVER go in this file: export FASTMAIL_API_TOKEN (JMAP) or
// FASTMAIL_MCP_TOKEN (MCP) in your shell instead.
import { defineConfig } from 'fast-classifier/config'

const domains = (map: Record<string, string[]>) =>
  Object.entries(map).flatMap(([category, list]) =>
    list.map((domain) => ({ kind: 'domain' as const, domain, category })),
  )

export default defineConfig({
  categories: [
    { name: 'Finance', label: 'Inbox/Finance' },
    { name: 'Dev', label: 'Inbox/Dev' },
    { name: 'Travel', label: 'Inbox/Travel' },
    { name: 'Stores', label: 'Inbox/Stores' },
    { name: 'Media', label: 'Inbox/Media' },
    { name: 'Accounts', label: 'Inbox/Accounts', description: 'sign-in and account notices' },
    { name: 'Personal', label: 'Inbox/Personal' },
  ],

  rules: [
    ...domains({
      Finance: ['paypal.com', 'revolut.com', 'klarna.com', 'wise.com'],
      Dev: ['github.com', 'gitlab.com', 'vercel.com', 'cloudflare.com'],
      Travel: ['airbnb.com', 'bahn.de', 'uber.com'],
      Stores: ['amazon.com', 'dhl.de'],
      Media: ['substack.com', 'netflix.com'],
    }),
  ],

  // exact senders that must never be swept, even when they say "unsubscribe"
  keepList: [],

  sweep: { targetLabel: 'Promotion' },
  needsAction: { label: 'Needs action', windowDays: 60 },
})
`

const INIT_GUIDANCE = `
Next steps:
  1. Edit fast-classifier.config.ts — map your senders to categories.
  2. Export a token (tokens are refused inside config files):
       export FASTMAIL_API_TOKEN=...   # JMAP transport (the default)
       export FASTMAIL_MCP_TOKEN=...   # MCP transport (-p mcp)
  3. Recon first: fast-classifier analyze, then plan, then sweep/file.
     Mutating commands are dry-run until you pass --execute.
`

export function registerCommands(program: Command, deps: CliDeps): void {
  const sub = (parent: Command, name: string, description: string): Command =>
    addGlobalOptions(parent.command(name).description(description), false)

  sub(program, 'analyze', 'read-only recon: who fills the inbox, by sender and root domain').action(
    wrap(deps, async (_opts: unknown, cmd: Command) => {
      const { ctx, opts } = await createContext(cmd, deps, false)
      const report = await analyzeInbox(ctx)
      await emit(deps, opts, 'analyze', report, formatAnalyze(report))
    }),
  )

  sub(program, 'plan', 'classify without touching anything: coverage + unmatched senders').action(
    wrap(deps, async (_opts: unknown, cmd: Command) => {
      const { ctx, opts } = await createContext(cmd, deps, false)
      const report = await planClassification(ctx)
      await emit(deps, opts, 'plan', report, formatPlan(report))
    }),
  )

  sub(program, 'sweep', 'label + archive bulk mail (keep-list wins; dry-run by default)').action(
    wrap(deps, async (_opts: unknown, cmd: Command) => {
      const { ctx, opts } = await createContext(cmd, deps, true)
      const audit = await TsvAudit.open(join(opts.reportDir, 'sweep.log.tsv'))
      const report = await sweepNewsletters(ctx, { audit })
      await emit(deps, opts, 'sweep', report, formatSweep(report))
      if (report.skippedByConfirm) abortedByConfirm(deps, 'sweep')
    }),
  )

  sub(program, 'file', 'file classified mail into per-category labels (dry-run by default)').action(
    wrap(deps, async (_opts: unknown, cmd: Command) => {
      const { ctx, opts } = await createContext(cmd, deps, true)
      const audit = await TsvAudit.open(join(opts.reportDir, 'file.log.tsv'))
      const report = await fileInbox(ctx, { audit })
      await emit(deps, opts, 'file', report, formatFile(report))
      if (report.skippedByConfirm) abortedByConfirm(deps, 'file')
    }),
  )

  sub(program, 'needs-action', 'score the recent window for mail needing a human response')
    .option('--apply', 'tag candidates with the needs-action label (never archives)')
    .action(
      wrap(deps, async (cmdOpts: { apply?: boolean }, cmd: Command) => {
        const apply = cmdOpts.apply === true
        const { ctx, opts } = await createContext(cmd, deps, apply)
        const report = await scoreInboxNeedsAction(ctx, { apply })
        await emit(deps, opts, 'needs-action', report, formatNeedsAction(report))
      }),
    )

  const labels = program.command('labels').description('inspect and create Fastmail labels')

  sub(labels, 'list', 'list labels with email totals').action(
    wrap(deps, async (_opts: unknown, cmd: Command) => {
      const { ctx, opts } = await createContext(cmd, deps, false)
      const list = await ctx.provider.listLabels()
      const report = { labels: list }
      await emit(deps, opts, 'labels-list', report, formatLabels(list))
    }),
  )

  sub(labels, 'ensure', 'create the given labels if missing (dry-run by default)')
    .argument('<names...>', "label names, nested as 'Parent/Child'")
    .action(
      wrap(deps, async (names: string[], _opts: unknown, cmd: Command) => {
        const { ctx, opts } = await createContext(cmd, deps, true)
        if (ctx.dryRun) {
          const report = { dryRun: true, requested: names, ensured: [] }
          await emit(deps, opts, 'labels-ensure', report, formatEnsurePlan(names))
          return
        }
        const ensured = [...(await ctx.provider.ensureLabels(names)).values()]
        const report = { dryRun: false, requested: names, ensured }
        await emit(deps, opts, 'labels-ensure', report, formatEnsured(ensured))
      }),
    )

  sub(program, 'verify', 'post-run assertions over labels and inbox state')
    .option('--contains <addrs...>', 'senders that must still have inbox mail')
    .option('--cleared <addrs...>', 'senders that must have no inbox mail left')
    .option('--label <specs...>', "label expectations: 'Name', 'Name=N', or 'Name>=N'")
    .action(
      wrap(
        deps,
        async (
          cmdOpts: { contains?: string[]; cleared?: string[]; label?: string[] },
          cmd: Command,
        ) => {
          const { ctx, opts } = await createContext(cmd, deps, false)
          const expectations: VerifyExpectations = {
            labels: (cmdOpts.label ?? []).map(parseLabelExpectation),
            inboxContainsSenders: cmdOpts.contains ?? [],
            inboxClearedSenders: cmdOpts.cleared ?? [],
          }
          const report = await verifyRun(ctx, expectations)
          await emit(deps, opts, 'verify', report, formatVerify(report))
          if (!report.passed) exitWith(deps, 1)
        },
      ),
    )

  program
    .command('init')
    .description('write a starter fast-classifier.config.ts (refuses to overwrite)')
    .argument('[dir]', 'directory to write the config into', '.')
    .action(
      wrap(deps, async (dir: string) => {
        const target = resolve(dir, 'fast-classifier.config.ts')
        if (existsSync(target)) {
          throw new Error(`refusing to overwrite existing config: ${target}`)
        }
        await mkdir(resolve(dir), { recursive: true })
        // 'wx' re-checks atomically in case the file appeared since existsSync
        await writeFile(target, STARTER_CONFIG, { flag: 'wx' })
        deps.stdout.write(`wrote ${target}\n${INIT_GUIDANCE}`)
      }),
    )

  program
    .command('mcp')
    .description('run the fast-classifier MCP server on stdio (bin: fast-classifier-mcp)')
    .action(
      wrap(deps, async () => {
        deps.stderr.write('starting MCP server on stdio (also available as fast-classifier-mcp)\n')
        // computed specifier: the server module is an optional sibling build
        const specifier = ['..', 'mcp-server', 'server.js'].join('/')
        let mod: { startStdio?: () => Promise<void> }
        try {
          mod = (await import(specifier)) as { startStdio?: () => Promise<void> }
        } catch {
          throw new Error(
            'MCP server module not available in this build — run the fast-classifier-mcp bin',
          )
        }
        if (typeof mod.startStdio !== 'function') {
          throw new Error('MCP server module does not export startStdio()')
        }
        await mod.startStdio()
      }),
    )
}
