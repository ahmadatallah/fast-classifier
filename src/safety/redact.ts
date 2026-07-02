/** Single chokepoint keeping credentials out of logs, errors, and reports. */

const REDACTED = '[REDACTED]'

/** Env vars whose current values are scrubbed wherever they appear. */
const TOKEN_ENV_VARS = ['FASTMAIL_API_TOKEN', 'FASTMAIL_MCP_TOKEN'] as const

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redact(text: string): string {
  let out = text
    .replace(/fmu1-[0-9]+-[a-f0-9-]+/g, REDACTED)
    .replace(/(Bearer\s+)\S+/g, `$1${REDACTED}`)
  for (const name of TOKEN_ENV_VARS) {
    // read at call time so tokens set after module load are still caught
    const value = process.env[name]
    if (!value) continue
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED)
  }
  return out
}

/** Returns a NEW Error with redacted message and stack; original is untouched. */
export function redactError(err: unknown): Error {
  if (err instanceof Error) {
    const clean = new Error(redact(err.message))
    clean.name = err.name
    if (err.stack !== undefined) clean.stack = redact(err.stack)
    return clean
  }
  return new Error(redact(String(err)))
}

/** Structural clone applying redact() to every string; other primitives pass through. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item)
    return out as T
  }
  return value
}
