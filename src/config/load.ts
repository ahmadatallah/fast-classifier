import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classifierConfigSchema, type ClassifierConfig } from './schema.js'

const CONFIG_BASENAMES = [
  'fast-classifier.config.ts',
  'fast-classifier.config.mjs',
  'fast-classifier.config.js',
  'fast-classifier.config.json',
]

/** Raised when a config file smells like it contains a credential. */
export class ConfigSecretError extends Error {
  constructor(keyPath: string, reason: string) {
    super(
      `config must never contain credentials (${reason} at '${keyPath}'). ` +
        'Put tokens in the environment instead: FASTMAIL_API_TOKEN / FASTMAIL_MCP_TOKEN.',
    )
    this.name = 'ConfigSecretError'
  }
}

const SECRET_KEY = /^(token|api[-_]?token|api[-_]?key|secret|password|bearer)$/i
const SECRET_VALUE = /fmu1-[0-9]+-[a-f0-9]+|^Bearer\s+\S{16,}/

/** Recursively reject secret-shaped keys/values BEFORE schema parsing. */
export const assertNoSecrets = (value: unknown, keyPath = 'config'): void => {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) throw new ConfigSecretError(keyPath, 'token-shaped value')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${keyPath}[${i}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) throw new ConfigSecretError(`${keyPath}.${k}`, 'secret-named key')
      assertNoSecrets(v, `${keyPath}.${k}`)
    }
  }
}

export interface LoadedConfig {
  config: ClassifierConfig
  /** absolute path, or null when running on pure defaults */
  path: string | null
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const readConfigFile = async (absPath: string): Promise<unknown> => {
  if (absPath.endsWith('.json')) {
    return JSON.parse(await readFile(absPath, 'utf8'))
  }
  try {
    const mod = (await import(pathToFileURL(absPath).href)) as { default?: unknown }
    if (mod.default === undefined) {
      throw new Error(`${absPath} must have a default export (use defineConfig())`)
    }
    return mod.default
  } catch (err) {
    if (
      absPath.endsWith('.ts') &&
      err instanceof Error &&
      /Unknown file extension|ERR_UNSUPPORTED/.test(err.message)
    ) {
      throw new Error(
        `cannot load TypeScript config on this runtime — use bun, Node >= 22.6 ` +
          `(type stripping), or a .mjs/.json config instead: ${absPath}`,
        { cause: err },
      )
    }
    throw err
  }
}

/**
 * Load + validate config. Discovery: explicit path > fast-classifier.config.ts
 * > .mjs > .js > .json in cwd > built-in defaults. Tokens are refused in files
 * (env-only) and validation is zod-strict.
 */
export const loadConfig = async (
  explicitPath?: string,
  cwd: string = process.cwd(),
): Promise<LoadedConfig> => {
  let path: string | null = null
  if (explicitPath) {
    path = resolve(cwd, explicitPath)
    if (!(await exists(path))) throw new Error(`config file not found: ${path}`)
  } else {
    for (const base of CONFIG_BASENAMES) {
      const candidate = resolve(cwd, base)
      if (await exists(candidate)) {
        path = candidate
        break
      }
    }
  }

  const raw = path ? await readConfigFile(path) : {}
  assertNoSecrets(raw)
  const config = classifierConfigSchema.parse(raw)
  return { config, path }
}

/** Read the transport credential from the environment (never from config). */
export const tokenFromEnv = (
  provider: 'jmap' | 'mcp',
  env: Record<string, string | undefined> = process.env,
): string => {
  const name = provider === 'jmap' ? 'FASTMAIL_API_TOKEN' : 'FASTMAIL_MCP_TOKEN'
  const token = env[name]
  if (!token) {
    throw new Error(
      `${name} is not set. Create a scoped token at Fastmail -> Settings -> ` +
        `Privacy & Security -> Integrations -> API tokens, then export ${name}. ` +
        `Note: JMAP and MCP tokens are distinct credentials.`,
    )
  }
  return token
}
