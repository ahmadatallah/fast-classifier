import { describe, test, expect } from 'bun:test'
import { buildSearchString } from '../../../src/provider/mcp/query.js'

describe('buildSearchString', () => {
  test('empty query compiles to empty string', () => {
    expect(buildSearchString({})).toBe('')
  })

  test('inMailbox inbox', () => {
    expect(buildSearchString({ inMailbox: 'inbox' })).toBe('in:inbox')
  })

  test('inMailbox with another label', () => {
    expect(buildSearchString({ inMailbox: 'Promotion' })).toBe('in:Promotion')
  })

  test('text appended bare', () => {
    expect(buildSearchString({ text: 'unsubscribe' })).toBe('unsubscribe')
  })

  test('from', () => {
    expect(buildSearchString({ from: 'boss@example.com' })).toBe('from:boss@example.com')
  })

  test('each notFrom entry becomes a -from: negation', () => {
    expect(buildSearchString({ notFrom: ['a@x.com', 'b@y.com', 'c@z.com'] })).toBe(
      '-from:a@x.com -from:b@y.com -from:c@z.com',
    )
  })

  test('after uses the only working date operator', () => {
    expect(buildSearchString({ after: '2026-01-15' })).toBe('after:2026-01-15')
  })

  test('unreadOnly', () => {
    expect(buildSearchString({ unreadOnly: true })).toBe('is:unread')
    expect(buildSearchString({ unreadOnly: false })).toBe('')
  })

  test('combined query joins in stable order: in, text, from, notFrom…, after, is:unread', () => {
    expect(
      buildSearchString({
        unreadOnly: true,
        after: '2026-01-01',
        notFrom: ['keep1@x.com', 'keep2@y.com'],
        from: 'news@z.com',
        text: 'unsubscribe',
        inMailbox: 'inbox',
      }),
    ).toBe(
      'in:inbox unsubscribe from:news@z.com -from:keep1@x.com -from:keep2@y.com after:2026-01-01 is:unread',
    )
  })
})
