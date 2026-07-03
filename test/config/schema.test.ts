// hygiene-allow-token: plants a FAKE fmu1- token to prove config secret rejection
import { describe, expect, test } from 'bun:test'
import { compileConfig } from '../../src/config/compile.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import { assertNoSecrets, ConfigSecretError } from '../../src/config/load.js'

describe('schema validation (review findings)', () => {
  test('parse({}) yields full defaults ready for compileConfig', () => {
    const config = classifierConfigSchema.parse({})
    const compiled = compileConfig(config)
    expect(config.ops.batchSize).toBe(50)
    expect(config.needsAction.threshold).toBe(3)
    expect(compiled.personalReplyExclusionRe.test('support@gmail.com')).toBe(true)
  })

  test('duplicate category names are rejected', () => {
    const r = classifierConfigSchema.safeParse({
      categories: [
        { name: 'Dev', label: 'Dev' },
        { name: 'Dev', label: 'Inbox/Dev' },
      ],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("duplicate category 'Dev'")
  })

  test('duplicate domain and sender rules are rejected (would be silent last-wins)', () => {
    const r = classifierConfigSchema.safeParse({
      categories: [
        { name: 'A', label: 'A' },
        { name: 'B', label: 'B' },
      ],
      rules: [
        { kind: 'domain', domain: 'paypal.de', category: 'A' },
        { kind: 'domain', domain: 'PAYPAL.DE', category: 'B' },
        { kind: 'sender', address: 'x@y.example', category: 'A' },
        { kind: 'sender', address: 'x@y.example', category: 'B' },
      ],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const text = JSON.stringify(r.error.issues)
      expect(text).toContain("duplicate domain rule 'paypal.de'")
      expect(text).toContain("duplicate sender rule 'x@y.example'")
    }
  })

  test('invalid regex in detection patterns fails at parse time, not inside compileConfig', () => {
    const r = classifierConfigSchema.safeParse({
      detection: { brandNamePattern: '(unclosed' },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.path.join('.')).toBe('detection.brandNamePattern')
      expect(r.error.issues[0]?.message).toContain('invalid regex')
    }
  })
})

describe('config secret rejection', () => {
  test('secret-named keys are refused', () => {
    expect(() => assertNoSecrets({ provider: { apiKey: 'x' } })).toThrow(ConfigSecretError)
  })

  test('token-shaped values are refused wherever they hide', () => {
    expect(() =>
      assertNoSecrets({ keepList: ['fmu1-60114032-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] }),
    ).toThrow(ConfigSecretError)
  })

  test('ordinary config passes', () => {
    expect(() => assertNoSecrets({ categories: [{ name: 'Dev', label: 'Dev' }] })).not.toThrow()
  })
})
