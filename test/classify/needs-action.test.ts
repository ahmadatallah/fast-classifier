import { describe, expect, test } from 'bun:test'
import { scoreNeedsAction } from '../../src/classify/needs-action.js'
import { compileConfig } from '../../src/config/compile.js'
import { classifierConfigSchema } from '../../src/config/schema.js'
import type { EmailMeta } from '../../src/types.js'

const compiled = compileConfig(classifierConfigSchema.parse({}))

const email = (over: Partial<EmailMeta>): EmailMeta => ({
  id: 'e1',
  subject: '',
  from: { name: 'Service', email: 'noreply@service.example' },
  receivedAt: '2026-06-01T00:00:00Z',
  isUnread: false,
  labels: [],
  ...over,
})

describe('scoreNeedsAction', () => {
  test('English high keywords add +3 each', () => {
    const r = scoreNeedsAction(email({ subject: 'Action required: verify your account' }), compiled)
    expect(r.score).toBe(6)
    expect(r.signals).toContain('action required')
    expect(r.signals).toContain('verify your')
    expect(r.needsAction).toBe(true)
  })

  test('German keywords do NOT score with the default (English-only) config', () => {
    const r = scoreNeedsAction(
      email({ subject: 'Bitte Termin bestätigen — Frist läuft ab' }),
      compiled,
    )
    expect(r.score).toBe(0)
    expect(r.needsAction).toBe(false)
  })

  test("German high keywords score once languages includes 'de'", () => {
    const bilingual = compileConfig(
      classifierConfigSchema.parse({ needsAction: { languages: ['en', 'de'] } }),
    )
    const r = scoreNeedsAction(email({ subject: 'Bitte Termin bestätigen' }), bilingual)
    expect(r.score).toBe(6) // 'termin' + 'bestätige' (substring of bestätigen)
    expect(r.signals).toContain('termin')
    expect(r.signals).toContain('bestätige')
    expect(r.needsAction).toBe(true)
    // English keywords still score alongside
    const en = scoreNeedsAction(email({ subject: 'Deadline approaching' }), bilingual)
    expect(en.signals).toContain('deadline')
  })

  test('explicit highKeywords REPLACE the language packs entirely', () => {
    const custom = compileConfig(
      classifierConfigSchema.parse({
        needsAction: { highKeywords: [{ phrase: 'urgent widget', weight: 3 }] },
      }),
    )
    // a pack phrase no longer scores...
    expect(scoreNeedsAction(email({ subject: 'Deadline today' }), custom).score).toBe(0)
    // ...the explicit phrase does, and pack exclusions still apply (not overridden)
    const hit = scoreNeedsAction(email({ subject: 'Urgent widget receipt' }), custom)
    expect(hit.score).toBe(1) // +3 'urgent widget', -2 'receipt'
    expect(hit.signals).toEqual(['urgent widget'])
  })

  test('exclusion keywords subtract', () => {
    const hit = scoreNeedsAction(email({ subject: 'Invoice' }), compiled)
    expect(hit.score).toBe(3)
    const excluded = scoreNeedsAction(email({ subject: 'Invoice receipt' }), compiled)
    expect(excluded.score).toBe(1) // +3 invoice, -2 receipt
    expect(excluded.needsAction).toBe(false)
  })

  test('unread adds exactly the unread bonus', () => {
    const read = scoreNeedsAction(email({ subject: 'hello there' }), compiled)
    const unread = scoreNeedsAction(email({ subject: 'hello there', isUnread: true }), compiled)
    expect(read.score).toBe(0)
    expect(unread.score).toBe(1)
  })

  test('threshold boundary: score 3 flags, score 2 does not', () => {
    const three = scoreNeedsAction(email({ subject: 'Invoice' }), compiled)
    expect(three.score).toBe(3)
    expect(three.needsAction).toBe(true)
    const two = scoreNeedsAction(email({ subject: 'Invoice receipt', isUnread: true }), compiled)
    expect(two.score).toBe(2)
    expect(two.needsAction).toBe(false)
  })

  test('snippet and sender name are part of the haystack', () => {
    const viaSnippet = scoreNeedsAction(email({ snippet: 'please confirm your address' }), compiled)
    expect(viaSnippet.score).toBe(6) // 'please confirm' + 'confirm your'
    const viaName = scoreNeedsAction(
      email({ from: { name: 'DocuSign', email: 'noreply@service.example' } }),
      compiled,
    )
    expect(viaName.score).toBe(3)
    expect(viaName.signals).toEqual(['docusign'])
  })

  test("the bare 'sign ' phrase was dropped: 'design' never false-flags, 'to sign' still scores", () => {
    // review finding: reference's 'sign ' substring-matched 'design update'
    const design = scoreNeedsAction(email({ subject: 'New design update for you' }), compiled)
    expect(design.score).toBe(0)
    const toSign = scoreNeedsAction(email({ subject: 'Contract to sign today' }), compiled)
    expect(toSign.signals).toContain('to sign')
    const designs = scoreNeedsAction(email({ subject: 'Check out my designs' }), compiled)
    expect(designs.score).toBe(0)
  })

  describe('personal needs-reply heuristic', () => {
    const personal = { name: 'Jane Doe', email: 'jane@gmail.com' }

    test('freemail + spaced name + not automated + unanswered adds the bonus', () => {
      const r = scoreNeedsAction(email({ subject: 'hi', from: personal }), compiled)
      expect(r.score).toBe(4)
      expect(r.signals).toEqual(['personal'])
      expect(r.needsAction).toBe(true)
    })

    test('isAnswered undefined still counts as unanswered', () => {
      const r = scoreNeedsAction(
        email({ subject: 'hi', from: personal, isAnswered: undefined }),
        compiled,
      )
      expect(r.signals).toContain('personal')
    })

    test('no bonus for a non-freemail provider', () => {
      const r = scoreNeedsAction(
        email({ subject: 'hi', from: { name: 'Jane Doe', email: 'jane@company.example' } }),
        compiled,
      )
      expect(r.score).toBe(0)
      expect(r.signals).not.toContain('personal')
    })

    test('no bonus without whitespace in the name', () => {
      const r = scoreNeedsAction(
        email({ subject: 'hi', from: { name: 'Jane', email: 'jane@gmail.com' } }),
        compiled,
      )
      expect(r.score).toBe(0)
    })

    test('no bonus for an automated freemail address', () => {
      const r = scoreNeedsAction(
        email({ subject: 'hi', from: { name: 'Jane Doe', email: 'noreply@gmail.com' } }),
        compiled,
      )
      expect(r.score).toBe(0)
    })

    test('no bonus when already answered', () => {
      const r = scoreNeedsAction(
        email({ subject: 'hi', from: personal, isAnswered: true }),
        compiled,
      )
      expect(r.score).toBe(0)
      expect(r.signals).not.toContain('personal')
    })
  })

  test('signals are deduped after trimming', () => {
    const dupes = compileConfig(
      classifierConfigSchema.parse({
        needsAction: {
          highKeywords: [
            { phrase: 'reply', weight: 3 },
            { phrase: 'reply ', weight: 3 },
          ],
          exclusionKeywords: [],
        },
      }),
    )
    const r = scoreNeedsAction(email({ subject: 'Reply soon' }), dupes)
    expect(r.score).toBe(6) // both phrases hit and score
    expect(r.signals).toEqual(['reply']) // but the trimmed signal appears once
  })
})
