import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliDeps } from '../../src/cli/main.js'
import { buildProgram } from '../../src/cli/main.js'
import type { ProviderFactory } from '../../src/cli/provider-factory.js'
import { createMemoryMailProvider, type MemoryMailProvider } from '../../src/provider/memory.js'
import type { EmailMeta } from '../../src/types.js'

export interface Harness {
  provider: MemoryMailProvider
  stdoutText: () => string
  stderrText: () => string
  exitCodes: number[]
  reportDir: string
  tmpDir: string
  /** parses a fresh program per call; -c and --report-dir are pre-wired */
  run: (...args: string[]) => Promise<void>
}

export interface HarnessOptions {
  factory?: ProviderFactory
  env?: Record<string, string | undefined>
  config?: unknown
  runCsvViewer?: CliDeps['runCsvViewer']
}

export const TEST_ENV = {
  FASTMAIL_API_TOKEN: 'test-jmap-token',
  FASTMAIL_MCP_TOKEN: 'test-mcp-token',
}

export const makeHarness = async (
  emails: EmailMeta[],
  options: HarnessOptions = {},
): Promise<Harness> => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fc-cli-'))
  const reportDir = join(tmpDir, 'reports')
  const configPath = join(tmpDir, 'fast-classifier.config.json')
  await writeFile(configPath, JSON.stringify(options.config ?? {}))

  const provider = createMemoryMailProvider(emails)
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCodes: number[] = []
  const deps: CliDeps = {
    providerFactory: options.factory ?? (() => provider),
    env: options.env ?? TEST_ENV,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    exitOverride: true,
    setExitCode: (code) => exitCodes.push(code),
    ...(options.runCsvViewer ? { runCsvViewer: options.runCsvViewer } : {}),
  }

  return {
    provider,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
    exitCodes,
    reportDir,
    tmpDir,
    run: async (...args: string[]) => {
      await buildProgram(deps).parseAsync(['-c', configPath, '--report-dir', reportDir, ...args], {
        from: 'user',
      })
    },
  }
}

export const inboxLabels = async (
  provider: MemoryMailProvider,
  id: string,
): Promise<readonly string[]> => {
  const email = await provider.getEmail(id)
  return email.labels
}
