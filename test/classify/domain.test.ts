import { describe, expect, test } from 'bun:test'
import { rootDomain } from '../../src/classify/domain.js'

describe('rootDomain', () => {
  test('extracts registrable domain from an email address', () => {
    expect(rootDomain('user@paypal.de')).toBe('paypal.de')
  })

  // the origin session's naive slice(-2) called amazon.co.uk "co.uk" — lock the fix
  test('multi-part public suffixes: co.uk', () => {
    expect(rootDomain('orders@amazon.co.uk')).toBe('amazon.co.uk')
    expect(rootDomain('a@mail.amazon.co.uk')).toBe('amazon.co.uk')
  })

  test('multi-part public suffixes: gov.uk', () => {
    expect(rootDomain('noreply@hmrc.gov.uk')).toBe('hmrc.gov.uk')
    expect(rootDomain('noreply@sub.hmrc.gov.uk')).toBe('hmrc.gov.uk')
  })

  test('multi-part public suffixes: com.au', () => {
    expect(rootDomain('x@shop.foo.com.au')).toBe('foo.com.au')
  })

  test('flattens subdomains to the registrable root', () => {
    expect(rootDomain('news@mail.perplexity.ai')).toBe('perplexity.ai')
    expect(rootDomain('no-reply@accounts.google.com')).toBe('google.com')
  })

  test('accepts a bare domain without @', () => {
    expect(rootDomain('paypal.de')).toBe('paypal.de')
    expect(rootDomain('sub.foo.co.uk')).toBe('foo.co.uk')
  })

  test('lowercases output', () => {
    expect(rootDomain('User@MAIL.Amazon.CO.UK')).toBe('amazon.co.uk')
    expect(rootDomain('PayPal.DE')).toBe('paypal.de')
  })

  test('falls back to last two labels when tldts cannot resolve', () => {
    // 'co.uk' is itself a public suffix, so tldts returns null
    expect(rootDomain('user@co.uk')).toBe('co.uk')
  })

  test('keeps unknown/internal multi-label hosts resolvable', () => {
    expect(rootDomain('svc@host.internal')).toBe('host.internal')
    expect(rootDomain('svc@corp.internal.lan')).toBe('internal.lan')
  })

  test('null for empty and single-label input', () => {
    expect(rootDomain('')).toBe(null)
    expect(rootDomain('localhost')).toBe(null)
    expect(rootDomain('user@localhost')).toBe(null)
    expect(rootDomain('user@')).toBe(null)
  })
})
