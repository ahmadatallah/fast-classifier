import { describe, expect, test } from 'bun:test'
import { classify } from '../../src/classify/rules.js'
import { compileConfig } from '../../src/config/compile.js'
import { classifierConfigSchema } from '../../src/config/schema.js'

const compiled = compileConfig(
  classifierConfigSchema.parse({
    categories: [
      { name: 'Special', label: 'Special' },
      { name: 'Paypal', label: 'Paypal' },
      { name: 'Stores', label: 'Stores' },
      { name: 'Travel', label: 'Travel' },
      { name: 'Dev', label: 'Dev' },
    ],
    rules: [
      { kind: 'sender', address: 'ceo@paypal.de', category: 'Special' },
      { kind: 'domain', domain: 'paypal.de', category: 'Paypal' },
      { kind: 'domain', domain: 'amazon.co.uk', category: 'Stores' },
      { kind: 'name', pattern: 'bolt|uber', category: 'Travel' },
      { kind: 'name', pattern: 'github', category: 'Dev', onlyForDomains: ['google.com'] },
    ],
    detection: { personalDomains: ['atallahsan.cc'] },
  }),
)

describe('classify precedence', () => {
  test('exact sender wins over a domain rule for the same domain', () => {
    const match = classify({ name: '', email: 'ceo@paypal.de' }, compiled)
    expect(match).toEqual({
      category: 'Special',
      rule: 'sender',
      reason: 'sender ceo@paypal.de -> Special',
    })
  })

  test('sender match is case-insensitive', () => {
    expect(classify({ name: '', email: 'CEO@PayPal.DE' }, compiled)?.category).toBe('Special')
  })

  test('domain rule matches by registrable root', () => {
    const match = classify({ name: 'PayPal', email: 'service@paypal.de' }, compiled)
    expect(match).toEqual({
      category: 'Paypal',
      rule: 'domain',
      reason: 'domain paypal.de -> Paypal',
    })
  })

  test('domain rule matches through subdomains', () => {
    expect(classify({ name: '', email: 'no-reply@mail.paypal.de' }, compiled)?.category).toBe(
      'Paypal',
    )
  })

  test('co.uk domain rule fires (naive slice(-2) regression)', () => {
    expect(classify({ name: '', email: 'orders@amazon.co.uk' }, compiled)?.rule).toBe('domain')
    expect(classify({ name: '', email: 'x@news.amazon.co.uk' }, compiled)?.category).toBe('Stores')
  })

  test('relay domain consults name rules (onlyForDomains null = any relay)', () => {
    const match = classify({ name: 'Bolt', email: 'x@gmail.com' }, compiled)
    expect(match?.category).toBe('Travel')
    expect(match?.rule).toBe('name')
  })

  test('name rule pattern is case-insensitive', () => {
    expect(classify({ name: 'BOLT Ride', email: 'x@gmail.com' }, compiled)?.category).toBe('Travel')
  })

  test('name rules are not consulted for non-relay domains', () => {
    expect(classify({ name: 'Bolt', email: 'x@random-startup.io' }, compiled)).toBe(null)
  })

  test('name rule with onlyForDomains applies on the listed relay root', () => {
    const match = classify({ name: 'GitHub', email: 'noreply@google.com' }, compiled)
    expect(match?.category).toBe('Dev')
    expect(match?.rule).toBe('name')
  })

  test('name rule with onlyForDomains is skipped on other relay roots', () => {
    const match = classify({ name: 'GitHub', email: 'x@gmail.com' }, compiled)
    expect(match?.rule).toBe('personal-provider')
    expect(match?.category).toBe('Personal')
  })

  test('name rule beats account-root fallback', () => {
    const match = classify({ name: 'Uber Receipts', email: 'noreply@google.com' }, compiled)
    expect(match?.category).toBe('Travel')
    expect(match?.rule).toBe('name')
  })

  test('account-root fallback for relay account domains', () => {
    const match = classify({ name: 'Google', email: 'no-reply@accounts.google.com' }, compiled)
    expect(match).toEqual({
      category: 'Accounts',
      rule: 'account-root',
      reason: 'relay root google.com -> Accounts',
    })
  })

  test('personal-provider fallback for freemail relay domains', () => {
    const match = classify({ name: 'Jane Doe', email: 'jane@gmail.com' }, compiled)
    expect(match?.category).toBe('Personal')
    expect(match?.rule).toBe('personal-provider')
  })

  test('personal-domain matches the FULL domain part, not the root', () => {
    const match = classify({ name: 'Me', email: 'me@atallahsan.cc' }, compiled)
    expect(match?.category).toBe('Personal')
    expect(match?.rule).toBe('personal-domain')
    expect(classify({ name: 'Me', email: 'me@sub.atallahsan.cc' }, compiled)).toBe(null)
  })

  test('unmatched sender returns null', () => {
    expect(classify({ name: 'Someone', email: 'hi@unknown-random.example' }, compiled)).toBe(null)
  })

  test('tolerates empty email and name', () => {
    expect(classify({ name: '', email: '' }, compiled)).toBe(null)
  })
})

describe('classify tier ordering on the same address', () => {
  const layered = compileConfig(
    classifierConfigSchema.parse({
      categories: [
        { name: 'Special', label: 'Special' },
        { name: 'Stores', label: 'Stores' },
        { name: 'Travel', label: 'Travel' },
      ],
      rules: [
        { kind: 'sender', address: 'x@gmail.com', category: 'Special' },
        { kind: 'domain', domain: 'gmail.com', category: 'Stores' },
        { kind: 'name', pattern: 'bolt', category: 'Travel' },
      ],
    }),
  )

  test('sender beats domain beats name', () => {
    expect(classify({ name: 'Bolt', email: 'x@gmail.com' }, layered)?.rule).toBe('sender')
    expect(classify({ name: 'Bolt', email: 'y@gmail.com' }, layered)?.rule).toBe('domain')
  })
})
