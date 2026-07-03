import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { InvalidArgumentError, type Command } from 'commander'
import { openTsvAudit, writeReport } from '../audit/index.js'
import { compileConfig } from '../config/compile.js'
import { loadConfig } from '../config/load.js'
import type { ClassifierConfig } from '../config/schema.js'
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
import { suggestRules } from '../suggest/index.js'
import type { SuggestionResult } from '../suggest/index.js'
import { reportToCsv } from './csv.js'
import {
  formatAnalyze,
  formatEnsured,
  formatEnsurePlan,
  formatFile,
  formatLabels,
  formatNeedsAction,
  formatPlan,
  formatSuggest,
  formatSweep,
  formatVerify,
} from './output.js'
import type { ProviderFactory } from './provider-factory.js'
import {
  configTarget,
  readlinePrompt,
  renderConfigFile,
  renderFragment,
  selectRules,
  writeSuggestedConfig,
} from './suggest-flow.js'
import type { AcceptedRule, PromptFn, SuggestIo } from './suggest-flow.js'
import { installTennis, TENNIS_VERSION } from './tennis-install.js'
import { runTennis } from './viewer.js'

export interface CliDeps {
  providerFactory: ProviderFactory
  env: Record<string, string | undefined>
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** commander throws instead of calling process.exit — set by tests */
  exitOverride?: boolean
  /** failure-code sink; defaults to assigning process.exitCode */
  setExitCode?: (code: number) => void
  /** injectable question gate for the suggest flow; tests script the answers */
  prompt?: PromptFn
  /** renders `--view` output; defaults to spawning `tennis -` on PATH */
  runCsvViewer?: (csv: string) => Promise<void>
}

interface GlobalOpts {
  config?: string
  provider?: string
  execute?: boolean
  max?: number
  yes?: boolean
  json?: boolean
  csv?: boolean
  csvField?: string
  view?: boolean
  reportDir: string
}

export const DRY_RUN_BANNER = 'DRY RUN — no changes will be made (pass --execute to apply)'

const parsePositiveInt = (value: string): number => {
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
export const addGlobalOptions = (cmd: Command, withDefaults: boolean): Command => {
  cmd
    .option('-c, --config <path>', 'path to fast-classifier.config.{ts,mjs,js,json}')
    .option('-p, --provider <type>', "mail transport: 'jmap' or 'mcp' (default: from config)")
    .option('--execute', 'apply changes — mutating commands are DRY-RUN by default')
    .option('--max <n>', 'cap on emails scanned per run', parsePositiveInt)
    .option('--yes', 'skip confirmation prompts for large mutation batches')
    .option('--json', 'print the full report JSON to stdout instead of a summary')
    .option('--csv', 'print the report as CSV instead of a summary (array field auto-picked)')
    .option('--csv-field <path>', 'dot-path to the array field to flatten, e.g. "domains"')
    .option(
      '--view',
      'render the report as a table via tennis (github.com/gurgeous/tennis) instead of printing',
    )
  if (withDefaults) {
    cmd.option('--report-dir <dir>', 'directory for reports and audit logs', './.fast-classifier')
  } else {
    cmd.option('--report-dir <dir>', 'directory for reports and audit logs')
  }
  return cmd
}

const exitWith = (deps: CliDeps, code: number): void => {
  if (deps.setExitCode) deps.setExitCode(code)
  else process.exitCode = code
}

/** Expected failures (missing token, bad config…) print one line, never a stack. */
const wrap = <A extends unknown[]>(
  deps: CliDeps,
  fn: (...args: A) => Promise<void>,
): ((...args: A) => Promise<void>) => {
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

const createContext = async (
  cmd: Command,
  deps: CliDeps,
  mutating: boolean,
): Promise<CommandRuntime> => {
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

const emit = async (
  deps: CliDeps,
  opts: GlobalOpts,
  name: string,
  report: unknown,
  human: string,
): Promise<void> => {
  // Validate mutually exclusive output flags
  const outputFlags = [opts.view, opts.csv, opts.json].filter((f) => f === true).length
  if (outputFlags > 1) {
    throw new Error('--view, --csv, and --json are mutually exclusive; use only one')
  }
  const path = await writeReport(opts.reportDir, name, report)
  if (opts.view === true) {
    try {
      const runViewer = deps.runCsvViewer ?? runTennis
      await runViewer(reportToCsv(report, opts.csvField))
    } finally {
      // Report file path is always printed, even if viewer fails
      deps.stderr.write(`report: ${path}\n`)
    }
  } else {
    if (opts.csv === true || opts.csvField !== undefined) {
      // a bare --csv-field implies --csv
      deps.stdout.write(reportToCsv(report, opts.csvField))
    } else if (opts.json === true) {
      deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      deps.stdout.write(human)
    }
    deps.stderr.write(`report: ${path}\n`)
  }
}

const abortedByConfirm = (deps: CliDeps, command: string): void => {
  deps.stderr.write(`${command} aborted: confirmation declined (pass --yes to approve)\n`)
  exitWith(deps, 1)
}

const suggestIo = (deps: CliDeps): SuggestIo => ({
  out: (chunk) => deps.stdout.write(chunk),
  prompt: deps.prompt ?? readlinePrompt(),
})

const printFragment = (
  deps: CliDeps,
  result: SuggestionResult,
  accepted: AcceptedRule[],
  config: ClassifierConfig,
): void => {
  const fragment = renderFragment(result, accepted, config)
  if (fragment === '') return
  deps.stdout.write(`\nPaste into your defineConfig({ ... }) config:\n\n${fragment}`)
}

/** `Name` = exists, `Name=N` = exactly N emails, `Name>=N` = at least N. */
export const parseLabelExpectation = (spec: string): LabelExpectation => {
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

export const registerCommands = (program: Command, deps: CliDeps): void => {
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
      const audit = await openTsvAudit(join(opts.reportDir, 'sweep.log.tsv'))
      const report = await sweepNewsletters(ctx, { audit })
      await emit(deps, opts, 'sweep', report, formatSweep(report))
      if (report.skippedByConfirm) abortedByConfirm(deps, 'sweep')
    }),
  )

  sub(program, 'file', 'file classified mail into per-category labels (dry-run by default)').action(
    wrap(deps, async (_opts: unknown, cmd: Command) => {
      const { ctx, opts } = await createContext(cmd, deps, true)
      const audit = await openTsvAudit(join(opts.reportDir, 'file.log.tsv'))
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

  sub(
    program,
    'suggest',
    'read-only scan: suggest config rules for your senders from the built-in domain catalog',
  )
    .argument('[dir]', 'directory --write places fast-classifier.config.ts into', '.')
    .option('--interactive', 'walk suggestions and unknown domains with prompts (default on a TTY)')
    .option('--no-interactive', 'never prompt; accept every catalog suggestion')
    .option('--write', 'write fast-classifier.config.ts when none exists (never overwrites)')
    .action(
      wrap(
        deps,
        async (dir: string, cmdOpts: { interactive?: boolean; write?: boolean }, cmd: Command) => {
          const { ctx, opts } = await createContext(cmd, deps, false)
          const report = await analyzeInbox(ctx)
          const result = suggestRules(report.domains, ctx.compiled)
          await emit(deps, opts, 'suggest', result, formatSuggest(result))

          // machine-readable output only changes the DEFAULT — an explicit
          // --interactive (or --no-interactive) always wins
          const machineReadable =
            opts.json === true ||
            opts.csv === true ||
            opts.csvField !== undefined ||
            opts.view === true
          const interactive =
            cmdOpts.interactive ?? (!machineReadable && process.stdin.isTTY === true)
          const accepted = await selectRules(result, ctx.config, interactive, suggestIo(deps))

          if (cmdOpts.write === true) {
            const target = configTarget(dir)
            if (existsSync(target)) {
              deps.stderr.write(
                `refusing to modify existing config: ${target} — paste the fragment yourself\n`,
              )
              printFragment(deps, result, accepted, ctx.config)
              return
            }
            if (accepted.length === 0) {
              deps.stdout.write('no suggestions accepted — no config written\n')
              return
            }
            await writeSuggestedConfig(target, renderConfigFile(accepted, ctx.config))
            deps.stdout.write(`wrote ${target}\n`)
            return
          }
          // an interactive walk earns its fragment even in --view/--csv mode;
          // only silent machine-readable runs suppress it (keeps pipes clean)
          if (interactive || !machineReadable) printFragment(deps, result, accepted, ctx.config)
        },
      ),
    )

  program
    .command('init')
    .description('write a starter fast-classifier.config.ts (refuses to overwrite)')
    .argument('[dir]', 'directory to write the config into', '.')
    .option('--from-inbox', 'scan your inbox and build the config from suggestions instead')
    .action(
      wrap(deps, async (dir: string, cmdOpts: { fromInbox?: boolean }, cmd: Command) => {
        const target = resolve(dir, 'fast-classifier.config.ts')
        if (existsSync(target)) {
          throw new Error(`refusing to overwrite existing config: ${target}`)
        }
        await mkdir(resolve(dir), { recursive: true })
        if (cmdOpts.fromInbox === true) {
          const { ctx } = await createContext(cmd, deps, false)
          const report = await analyzeInbox(ctx)
          const result = suggestRules(report.domains, ctx.compiled)
          deps.stdout.write(formatSuggest(result))
          const interactive = process.stdin.isTTY === true
          const accepted = await selectRules(result, ctx.config, interactive, suggestIo(deps))
          // 'wx' re-checks atomically in case the file appeared since existsSync
          await writeSuggestedConfig(target, renderConfigFile(accepted, ctx.config))
          deps.stdout.write(`wrote ${target}\n${INIT_GUIDANCE}`)
          return
        }
        // 'wx' re-checks atomically in case the file appeared since existsSync
        await writeFile(target, STARTER_CONFIG, { flag: 'wx' })
        deps.stdout.write(`wrote ${target}\n${INIT_GUIDANCE}`)
      }),
    )

  program
    .command('install-viewer')
    .description(
      `download tennis v${TENNIS_VERSION} (CSV table viewer for --view) into ~/.fast-classifier/bin — checksum-verified`,
    )
    .action(
      wrap(deps, async () => {
        const path = await installTennis({ log: (message) => deps.stderr.write(`${message}\n`) })
        deps.stdout.write(`${path}\n`)
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
