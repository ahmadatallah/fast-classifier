import { describe, expect, test } from 'bun:test'
import { reportToCsv } from '../../src/cli/csv.js'
import type {
  AnalyzeReport,
  FileReport,
  NeedsActionReport,
  PlanReport,
  SweepReport,
  VerifyReport,
} from '../../src/pipeline/index.js'
import type { SuggestionResult } from '../../src/suggest/index.js'

const baseMeta = {
  command: 'test',
  dryRun: false,
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:01Z',
}

describe('reportToCsv', () => {
  describe('pickRows heuristic', () => {
    test('array root: uses entire array', () => {
      const data = [{ id: '1', name: 'a' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('id,name')
      expect(csv).toContain('1,a')
    })

    test('AnalyzeReport: picks senders array (first array-valued property)', () => {
      const report: AnalyzeReport = {
        meta: baseMeta,
        scanned: 100,
        senders: [{ email: 'a@b.com', name: 'A', count: 10 }],
        domains: [{ domain: 'b.com', count: 5, sampleSenders: ['a@b.com'] }],
      }
      const csv = reportToCsv(report)
      // Should use senders array, not domains array
      expect(csv).toContain('email,name,count')
      expect(csv).toContain('a@b.com,A,10')
      // senders array should be output, domains should not be a row
      const lines = csv.trim().split('\n')
      expect(lines).toHaveLength(2) // header + 1 data row
    })

    test('--csv-field override: picks specified path', () => {
      const report: AnalyzeReport = {
        meta: baseMeta,
        scanned: 100,
        senders: [{ email: 'a@b.com', name: 'A', count: 10 }],
        domains: [{ domain: 'b.com', count: 5, sampleSenders: ['a@b.com'] }],
      }
      const csv = reportToCsv(report, 'domains')
      // Should use domains instead
      expect(csv).toContain('domain,count')
      expect(csv).toContain('b.com,5')
      // Only domains array rows
      const lines = csv.trim().split('\n')
      expect(lines).toHaveLength(2) // header + 1 data row
    })

    test('non-array root without array properties: wraps in single-row array', () => {
      const data = { id: '1', name: 'scalar' }
      const csv = reportToCsv(data)
      expect(csv).toContain('id,name')
      expect(csv).toContain('1,scalar')
    })

    test('--csv-field on non-array throws error', () => {
      const report = { meta: baseMeta, scanned: 100 }
      expect(() => reportToCsv(report, 'scanned')).toThrow('--csv-field scanned is not an array')
    })
  })

  describe('flatten and escape', () => {
    test('nested objects flatten to dot-keys', () => {
      const data = [{ user: { name: 'Alice', email: 'a@b.com' } }]
      const csv = reportToCsv(data)
      expect(csv).toContain('user.name,user.email')
      expect(csv).toContain('Alice,a@b.com')
    })

    test('null/undefined become empty strings', () => {
      const data = [{ a: null, b: undefined }]
      const csv = reportToCsv(data)
      expect(csv).toContain('a,b')
      expect(csv).toContain(',')
    })

    test('primitive arrays join with "; "', () => {
      const data = [{ tags: ['x', 'y', 'z'] }]
      const csv = reportToCsv(data)
      expect(csv).toContain('x; y; z')
    })

    test('object arrays JSON.stringify', () => {
      const data = [{ items: [{ id: 1 }, { id: 2 }] }]
      const csv = reportToCsv(data)
      // JSON.stringify of objects will be in the CSV
      expect(csv).toContain('[')
      expect(csv).toContain('{')
    })
  })

  describe('CSV escaping (RFC 4180 + security)', () => {
    test('values with comma are quoted', () => {
      const data = [{ text: 'hello, world' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('"hello, world"')
    })

    test('values with quote double the quote inside and wrap', () => {
      const data = [{ text: 'say "hi"' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('"say ""hi"""')
    })

    test('values with LF (newline) are quoted', () => {
      const data = [{ text: 'line1\nline2' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('"line1\nline2"')
    })

    test('values with CR (carriage return) are quoted', () => {
      const data = [{ text: 'line1\rline2' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('"line1\rline2"')
    })

    test('values with CRLF are quoted', () => {
      const data = [{ text: 'line1\r\nline2' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('"line1\r\nline2"')
    })

    test('formula injection (=) prevented: prefix with single quote', () => {
      const data = [{ formula: '=1+1' }]
      const csv = reportToCsv(data)
      expect(csv).toContain("'=1+1")
    })

    test('formula injection (+) prevented: prefix with single quote', () => {
      const data = [{ formula: '+2+3' }]
      const csv = reportToCsv(data)
      expect(csv).toContain("'+2+3")
    })

    test('formula injection (-) prevented: prefix with single quote', () => {
      const data = [{ formula: '-5' }]
      const csv = reportToCsv(data)
      expect(csv).toContain("'-5")
    })

    test('formula injection (@) prevented: prefix with single quote', () => {
      const data = [{ formula: '@SUM(A1:A10)' }]
      const csv = reportToCsv(data)
      expect(csv).toContain("'@SUM")
    })

    test('formula char in middle is not prefixed', () => {
      const data = [{ text: 'hello=world' }]
      const csv = reportToCsv(data)
      expect(csv).toContain('hello=world')
    })
  })

  describe('report-specific shapes', () => {
    test('PlanReport picks unmatchedTopSenders (first array)', () => {
      const report: PlanReport = {
        meta: baseMeta,
        scanned: 100,
        matched: 90,
        coveragePercent: 90,
        distribution: { Dev: 50, Personal: 40 },
        unmatchedTopSenders: [{ email: 'spam@evil.com', name: 'Spam', count: 10 }],
      }
      const csv = reportToCsv(report)
      expect(csv).toContain('email,name,count')
      expect(csv).toContain('spam@evil.com')
    })

    test('SweepReport picks topSenders', () => {
      const report: SweepReport = {
        meta: baseMeta,
        scanned: 100,
        planned: 50,
        executed: 50,
        skippedByConfirm: false,
        keptOut: 10,
        topSenders: [{ email: 'newsletter@x.com', count: 45 }],
      }
      const csv = reportToCsv(report)
      expect(csv).toContain('email,count')
      expect(csv).toContain('newsletter@x.com,45')
    })

    test('FileReport picks unmatchedTopSenders', () => {
      const report: FileReport = {
        meta: baseMeta,
        scanned: 100,
        planned: 50,
        executed: 50,
        skippedByConfirm: false,
        keptOut: 0,
        tally: { Dev: 30, Personal: 20 },
        unmatched: 10,
        unmatchedTopSenders: [{ email: 'unknown@test.com', name: 'Unknown', count: 10 }],
        coveragePercent: 90,
      }
      const csv = reportToCsv(report)
      expect(csv).toContain('email,name,count')
      expect(csv).toContain('unknown@test.com')
    })

    test('NeedsActionReport picks candidates', () => {
      const report: NeedsActionReport = {
        meta: baseMeta,
        scanned: 100,
        candidates: [
          {
            id: '1',
            receivedAt: '2026-01-01T00:00:00Z',
            from: { email: 'boss@work.com', name: 'Boss' },
            subject: 'Meeting tomorrow',
            score: 9,
            signals: ['urgent', 'from-vip'],
          },
        ],
        tagged: 1,
      }
      const csv = reportToCsv(report)
      expect(csv).toContain('id,receivedAt')
      expect(csv).toContain('1,2026-01-01T00:00:00Z')
    })

    test('VerifyReport picks checks', () => {
      const report: VerifyReport = {
        meta: baseMeta,
        passed: true,
        checks: [
          { name: 'label exists', ok: true, detail: 'found with 10 emails' },
          { name: 'inbox cleared', ok: true, detail: 'no emails from spam' },
        ],
      }
      const csv = reportToCsv(report)
      expect(csv).toContain('name,ok,detail')
      expect(csv).toContain('label exists,true')
    })

    test('SuggestionResult picks suggestions (first array)', () => {
      const result: SuggestionResult = {
        suggestions: [
          { domain: 'github.com', category: 'Dev', count: 5, source: 'catalog', sampleSenders: [] },
        ],
        unknown: [{ domain: 'mystery.example', count: 2, sampleSenders: [] }],
        alreadyCovered: 1,
        categories: [],
      }
      const csv = reportToCsv(result)
      expect(csv).toContain('domain,category,count')
      expect(csv).toContain('github.com,Dev,5')
    })
  })

  describe('header deduplication', () => {
    test('unique column names from all rows', () => {
      const data = [
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      ]
      const csv = reportToCsv(data)
      const lines = csv.trim().split('\n')
      const header = lines[0]
      // Should have a, b, c (but order matters for flatMap order)
      expect(header).toContain('a')
      expect(header).toContain('b')
      expect(header).toContain('c')
    })
  })
})
