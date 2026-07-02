import { describe, test, expect } from 'bun:test'
import { buildEmailFilter } from '../../../src/provider/jmap/query.js'

describe('buildEmailFilter', () => {
  test('empty query → empty filter', () => {
    expect(buildEmailFilter({}, 'INBOX-ID')).toEqual({})
  })

  test("inMailbox 'inbox' resolves to the passed inbox id", () => {
    expect(buildEmailFilter({ inMailbox: 'inbox' }, 'INBOX-ID')).toEqual({ inMailbox: 'INBOX-ID' })
  })

  test("inMailbox 'inbox' with no inbox id omits the condition", () => {
    expect(buildEmailFilter({ inMailbox: 'inbox' }, null)).toEqual({})
  })

  test('inMailbox other value is used verbatim (provider pre-resolves ids)', () => {
    expect(buildEmailFilter({ inMailbox: 'MB-42' }, 'INBOX-ID')).toEqual({ inMailbox: 'MB-42' })
  })

  test('text alone', () => {
    expect(buildEmailFilter({ text: 'unsubscribe' }, null)).toEqual({ text: 'unsubscribe' })
  })

  test('from alone', () => {
    expect(buildEmailFilter({ from: 'news@example.com' }, null)).toEqual({
      from: 'news@example.com',
    })
  })

  test('unreadOnly → notKeyword $seen', () => {
    expect(buildEmailFilter({ unreadOnly: true }, null)).toEqual({ notKeyword: '$seen' })
    expect(buildEmailFilter({ unreadOnly: false }, null)).toEqual({})
  })

  test('after date → UTC midnight timestamp', () => {
    expect(buildEmailFilter({ after: '2026-06-15' }, null)).toEqual({
      after: '2026-06-15T00:00:00Z',
    })
  })

  test('notFrom alone collapses to a bare NOT node', () => {
    expect(buildEmailFilter({ notFrom: ['a@x.com', 'b@y.com'] }, null)).toEqual({
      operator: 'NOT',
      conditions: [{ from: 'a@x.com' }, { from: 'b@y.com' }],
    })
  })

  test('empty notFrom collapses to the base filter', () => {
    expect(buildEmailFilter({ text: 'hi', notFrom: [] }, null)).toEqual({ text: 'hi' })
  })

  test('base + notFrom → AND of base and NOT node', () => {
    expect(
      buildEmailFilter(
        {
          inMailbox: 'inbox',
          text: 'unsubscribe',
          unreadOnly: true,
          after: '2026-01-01',
          notFrom: ['keep@me.com'],
        },
        'INBOX-ID',
      ),
    ).toEqual({
      operator: 'AND',
      conditions: [
        {
          inMailbox: 'INBOX-ID',
          text: 'unsubscribe',
          notKeyword: '$seen',
          after: '2026-01-01T00:00:00Z',
        },
        { operator: 'NOT', conditions: [{ from: 'keep@me.com' }] },
      ],
    })
  })
})
