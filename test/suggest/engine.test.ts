import { describe, expect, test } from 'bun:test'
import { compileConfig } from '../../src/config/compile.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import { SUGGESTED_CATEGORIES } from '../../src/suggest/catalog.js'
import { suggestRules, toConfigFragment } from '../../src/suggest/engine.js'
import type { SuggestionResult } from '../../src/suggest/engine.js'

const compiled = compileConfig(
  classifierConfigSchema.parse({
    categories: [{ name: 'Finance', label: 'Money' }],
    rules: [
      { kind: 'domain', domain: 'paypal.com', category: 'Finance' },
      { kind: 'sender', address: 'news@covered-sender.example', category: 'Finance' },
    ],
    detection: { personalDomains: ['my-own-domain.example'] },
  }),
)

describe('suggestRules partitioning', () => {
  const result = suggestRules(
    [
      { domain: 'paypal.com', count: 12 }, // covered: domainMap
      { domain: 'gmail.com', count: 9 }, // covered: default relayDomains
      { domain: 'my-own-domain.example', count: 3 }, // covered: personalDomains
      {
        domain: 'covered-sender.example',
        count: 2,
        sampleSenders: ['news@covered-sender.example'], // covered: senderMap via sample
      },
      { domain: 'stripe.com', count: 5, sampleSenders: ['billing@stripe.com'] }, // catalog hit
      { domain: 'booking.com', count: 4 }, // catalog hit
      { domain: 'unknown-shop.example', count: 7 }, // unknown
    ],
    compiled,
  )

  test('covered domains are counted, not suggested', () => {
    expect(result.alreadyCovered).toBe(4)
    const suggested = result.suggestions.map((s) => s.domain)
    expect(suggested).not.toContain('paypal.com')
    expect(suggested).not.toContain('gmail.com')
  })

  test('catalog hits become suggestions sorted by count', () => {
    expect(result.suggestions).toEqual([
      {
        domain: 'stripe.com',
        category: 'Finance',
        count: 5,
        source: 'catalog',
        sampleSenders: ['billing@stripe.com'],
      },
      { domain: 'booking.com', category: 'Travel', count: 4, source: 'catalog', sampleSenders: [] },
    ])
  })

  test('non-catalog uncovered domains land in unknown', () => {
    expect(result.unknown).toEqual([
      { domain: 'unknown-shop.example', count: 7, sampleSenders: [] },
    ])
  })

  test('categories are the suggested ones minus what the user already has', () => {
    // Finance is already in the user's config (as 'Money'), Travel is not
    expect(result.categories.map((c) => c.name)).toEqual(['Travel'])
    const travel = SUGGESTED_CATEGORIES.find((c) => c.name === 'Travel')
    expect(result.categories[0]).toEqual({
      name: 'Travel',
      label: travel?.label ?? '',
      description: travel?.description ?? '',
    })
  })

  test('input casing is normalized', () => {
    const upper = suggestRules(
      [{ domain: 'STRIPE.COM', count: 3, sampleSenders: ['Billing@Stripe.com'] }],
      compiled,
    )
    expect(upper.suggestions[0]?.domain).toBe('stripe.com')
    expect(upper.suggestions[0]?.sampleSenders).toEqual(['billing@stripe.com'])
  })
})

describe('suggestRules minCount', () => {
  test('domains below minCount are dropped from suggestions and unknown', () => {
    const result = suggestRules(
      [
        { domain: 'github.com', count: 1 },
        { domain: 'one-off.example', count: 1 },
      ],
      compiled,
    )
    expect(result.suggestions).toEqual([])
    expect(result.unknown).toEqual([])
  })

  test('minCount 1 lets singletons through', () => {
    const result = suggestRules([{ domain: 'github.com', count: 1 }], compiled, { minCount: 1 })
    expect(result.suggestions[0]?.category).toBe('Development')
  })

  test('covered domains count as covered even below minCount', () => {
    const result = suggestRules([{ domain: 'paypal.com', count: 1 }], compiled)
    expect(result.alreadyCovered).toBe(1)
  })
})

describe('suggestRules maxUnknown', () => {
  test('unknown is sorted by count desc (domain asc on ties) and capped', () => {
    const result = suggestRules(
      [
        { domain: 'aaa.example', count: 2 },
        { domain: 'bbb.example', count: 9 },
        { domain: 'ddd.example', count: 5 },
        { domain: 'ccc.example', count: 5 },
      ],
      compiled,
      { maxUnknown: 3 },
    )
    expect(result.unknown.map((u) => u.domain)).toEqual([
      'bbb.example',
      'ccc.example',
      'ddd.example',
    ])
  })
})

describe('toConfigFragment', () => {
  const result = suggestRules(
    [
      { domain: 'stripe.com', count: 5 },
      { domain: 'booking.com', count: 4 },
      { domain: 'unknown-shop.example', count: 7 },
    ],
    compiled,
  )

  test('renders needed categories and accepted domain rules', () => {
    const fragment = toConfigFragment(result, [
      { domain: 'stripe.com', category: 'Finance' },
      { domain: 'booking.com', category: 'Travel' },
      { domain: 'unknown-shop.example', category: 'Travel' },
    ])
    expect(fragment).toContain('categories: [')
    expect(fragment).toContain("{ name: 'Travel', label: 'Travel', description: '")
    // the user already has Finance — no category entry for it
    expect(fragment).not.toContain("name: 'Finance'")
    expect(fragment).toContain("{ kind: 'domain', domain: 'stripe.com', category: 'Finance' },")
    expect(fragment).toContain("{ kind: 'domain', domain: 'booking.com', category: 'Travel' },")
    expect(fragment).toContain(
      "{ kind: 'domain', domain: 'unknown-shop.example', category: 'Travel' },",
    )
    expect(fragment).not.toContain(';')
    expect(fragment).not.toContain('"')
  })

  test('fragment is valid object-literal syntax', () => {
    const fragment = toConfigFragment(result, [
      { domain: 'stripe.com', category: 'Finance' },
      { domain: 'booking.com', category: 'Travel' },
    ])
    const parsed = new Function(`return { ${fragment} }`)() as {
      categories: { name: string }[]
      rules: { kind: string; domain: string; category: string }[]
    }
    expect(parsed.categories.map((c) => c.name)).toEqual(['Travel'])
    expect(parsed.rules).toEqual([
      { kind: 'domain', domain: 'stripe.com', category: 'Finance' },
      { kind: 'domain', domain: 'booking.com', category: 'Travel' },
    ])
  })

  test('omits the categories block when the user already has them all', () => {
    const fragment = toConfigFragment(result, [{ domain: 'stripe.com', category: 'Finance' }])
    expect(fragment.startsWith('rules: [')).toBe(true)
    expect(fragment).not.toContain('categories:')
  })

  test('empty accepted list renders nothing', () => {
    expect(toConfigFragment(result, [])).toBe('')
  })

  test('escapes single quotes in accepted values', () => {
    const custom: SuggestionResult = { ...result, categories: [] }
    const fragment = toConfigFragment(custom, [{ domain: "o'brien.example", category: "Bob's" }])
    expect(fragment).toContain("domain: 'o\\'brien.example'")
    expect(fragment).toContain("category: 'Bob\\'s'")
  })
})
