import { describe, test, expect } from 'bun:test'
import { redact, redactError, redactDeep } from '../../src/safety/redact.js'

const TOKEN = 'fmu1-12345-abcdef01-2345-6789-abcd-ef0123456789'

describe('redact', () => {
  test('scrubs an fmu1 token in the middle of a message', () => {
    const out = redact(`request failed with token ${TOKEN} at attempt 3`)
    expect(out).toBe('request failed with token [REDACTED] at attempt 3')
    expect(out).not.toContain('fmu1-')
  })

  test('scrubs Bearer headers, keeping the scheme', () => {
    const out = redact('Authorization: Bearer abc.def-123 rest')
    expect(out).toBe('Authorization: Bearer [REDACTED] rest')
  })

  test('scrubs the current FASTMAIL_API_TOKEN env value, escaping regex chars', () => {
    const prev = process.env.FASTMAIL_API_TOKEN
    process.env.FASTMAIL_API_TOKEN = 'sec.ret+(value)'
    try {
      expect(redact('auth with sec.ret+(value) done')).toBe('auth with [REDACTED] done')
    } finally {
      if (prev === undefined) delete process.env.FASTMAIL_API_TOKEN
      else process.env.FASTMAIL_API_TOKEN = prev
    }
  })

  test('unset env vars are skipped without over-redacting', () => {
    const prev = process.env.FASTMAIL_MCP_TOKEN
    delete process.env.FASTMAIL_MCP_TOKEN
    try {
      expect(redact('nothing secret here')).toBe('nothing secret here')
    } finally {
      if (prev !== undefined) process.env.FASTMAIL_MCP_TOKEN = prev
    }
  })
})

describe('redactError', () => {
  test('preserves name, redacts message and stack, returns a new Error', () => {
    const original = new TypeError(`bad credential ${TOKEN} rejected`)
    const clean = redactError(original)
    expect(clean).not.toBe(original)
    expect(clean.name).toBe('TypeError')
    expect(clean.message).toBe('bad credential [REDACTED] rejected')
    expect(clean.stack ?? '').not.toContain('fmu1-')
    // original stays untouched
    expect(original.message).toContain(TOKEN)
  })

  test('non-Error input becomes a redacted Error', () => {
    const clean = redactError(`string failure with ${TOKEN}`)
    expect(clean).toBeInstanceOf(Error)
    expect(clean.message).toBe('string failure with [REDACTED]')
  })
})

describe('redactDeep', () => {
  test('redacts every string in a nested report object', () => {
    const report = {
      meta: { command: `sweep --token ${TOKEN}`, dryRun: true, batches: 4 },
      items: [`Bearer abc123`, { sender: 'a@b.c', note: `saw ${TOKEN}` }],
      failures: null,
    }
    const clean = redactDeep(report)
    expect(clean.meta.command).toBe('sweep --token [REDACTED]')
    expect(clean.meta.dryRun).toBe(true)
    expect(clean.meta.batches).toBe(4)
    expect(clean.items[0]).toBe('Bearer [REDACTED]')
    expect(clean.items[1]).toEqual({ sender: 'a@b.c', note: 'saw [REDACTED]' })
    expect(clean.failures).toBeNull()
    // structural clone: original untouched
    expect(report.meta.command).toContain(TOKEN)
    expect(JSON.stringify(clean)).not.toContain('fmu1-')
  })
})
