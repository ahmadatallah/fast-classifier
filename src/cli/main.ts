#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { addGlobalOptions, registerCommands } from './commands.js'
import type { CliDeps } from './commands.js'
import { defaultProviderFactory } from './provider-factory.js'

export type { CliDeps } from './commands.js'
export { defaultProviderFactory } from './provider-factory.js'
export type { ProviderFactory } from './provider-factory.js'

export const buildProgram = (deps: CliDeps): Command => {
  const program = new Command()
  program
    .name('fast-classifier')
    .description('rule-first email classifier for Fastmail — dry-run first, never deletes')
    .version('0.1.0')
    .configureOutput({
      writeOut: (str) => void deps.stdout.write(str),
      writeErr: (str) => void deps.stderr.write(str),
    })
  if (deps.exitOverride === true) program.exitOverride()
  addGlobalOptions(program, true)
  // subcommands inherit exitOverride/configureOutput — register them last
  registerCommands(program, deps)
  return program
}

const invokedAsBin = (): boolean => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  try {
    // bin shims are symlinks; node resolves the module to its realpath
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (invokedAsBin()) {
  buildProgram({
    providerFactory: defaultProviderFactory,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}
