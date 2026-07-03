import { describe, expect, test } from 'bun:test'
import { rootDomain } from '../../src/classify/domain.js'
import {
  CATALOG_DOMAINS_BY_CATEGORY,
  DOMAIN_CATALOG,
  SUGGESTED_CATEGORIES,
} from '../../src/suggest/catalog.js'

const EXPECTED_CATEGORY_NAMES = [
  'Finance',
  'Shopping',
  'Travel',
  'Development',
  'Social',
  'Jobs',
  'News',
  'Entertainment',
  'Health',
  'Telecom',
  'Cloud',
  'Accounts',
]

const allDomains = Object.values(CATALOG_DOMAINS_BY_CATEGORY).flat()

describe('SUGGESTED_CATEGORIES', () => {
  test('exactly the twelve generic categories, in order', () => {
    expect(SUGGESTED_CATEGORIES.map((c) => c.name)).toEqual(EXPECTED_CATEGORY_NAMES)
  })

  test('every entry has a non-empty label and description', () => {
    for (const c of SUGGESTED_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.description.length).toBeGreaterThan(0)
    }
  })
})

describe('DOMAIN_CATALOG', () => {
  test('no duplicate domains across categories', () => {
    expect(new Set(allDomains).size).toBe(allDomains.length)
    // the flat Map would silently collapse duplicates — sizes must agree
    expect(DOMAIN_CATALOG.size).toBe(allDomains.length)
  })

  test('every catalog category is a suggested category', () => {
    const names = new Set(SUGGESTED_CATEGORIES.map((c) => c.name))
    for (const key of Object.keys(CATALOG_DOMAINS_BY_CATEGORY)) {
      expect(names.has(key)).toBe(true)
    }
    for (const category of DOMAIN_CATALOG.values()) {
      expect(names.has(category)).toBe(true)
    }
  })

  test('all domains are lowercase registrable roots', () => {
    for (const domain of DOMAIN_CATALOG.keys()) {
      expect(domain).toBe(domain.toLowerCase())
      expect(domain).not.toContain('@')
      expect(domain).not.toContain(' ')
      // already a registrable root: rootDomain must be a fixed point
      expect(rootDomain(domain)).toBe(domain)
    }
  })

  test('stays curated: 150-200 globally recognizable domains', () => {
    expect(DOMAIN_CATALOG.size).toBeGreaterThanOrEqual(150)
    expect(DOMAIN_CATALOG.size).toBeLessThanOrEqual(200)
  })

  test('spot-check well-known mappings', () => {
    expect(DOMAIN_CATALOG.get('paypal.com')).toBe('Finance')
    expect(DOMAIN_CATALOG.get('github.com')).toBe('Development')
    expect(DOMAIN_CATALOG.get('booking.com')).toBe('Travel')
    expect(DOMAIN_CATALOG.get('linkedin.com')).toBe('Jobs')
    expect(DOMAIN_CATALOG.get('netflix.com')).toBe('Entertainment')
    expect(DOMAIN_CATALOG.get('dropbox.com')).toBe('Cloud')
  })
})
