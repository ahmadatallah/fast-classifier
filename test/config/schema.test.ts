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

  test('needsAction defaults to the English pack only, with no explicit keyword lists', () => {
    const config = classifierConfigSchema.parse({})
    expect(config.needsAction.languages).toEqual(['en'])
    expect(config.needsAction.highKeywords).toBeUndefined()
    expect(config.needsAction.exclusionKeywords).toBeUndefined()
    const phrases = compileConfig(config).needsAction.high.map((k) => k.phrase)
    expect(phrases).toContain('deadline')
    expect(phrases).not.toContain('frist')
  })

  test("languages ['en', 'de'] compiles to the union of both packs", () => {
    const compiled = compileConfig(
      classifierConfigSchema.parse({ needsAction: { languages: ['en', 'de'] } }),
    )
    const high = compiled.needsAction.high.map((k) => k.phrase)
    expect(high).toContain('deadline')
    expect(high).toContain('frist')
    const exclusion = compiled.needsAction.exclusion.map((k) => k.phrase)
    expect(exclusion).toContain('receipt')
    expect(exclusion).toContain('kontoauszug')
  })

  test('unsupported language codes are rejected', () => {
    const r = classifierConfigSchema.safeParse({ needsAction: { languages: ['fr'] } })
    expect(r.success).toBe(false)
  })

  test('explicit keyword lists replace the packs in the compiled output', () => {
    const compiled = compileConfig(
      classifierConfigSchema.parse({
        needsAction: {
          highKeywords: [{ phrase: 'Sign HERE', weight: 5 }],
          exclusionKeywords: [],
        },
      }),
    )
    expect(compiled.needsAction.high).toEqual([{ phrase: 'sign here', weight: 5 }])
    expect(compiled.needsAction.exclusion).toEqual([])
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
