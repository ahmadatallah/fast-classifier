import { describe, expect, test } from 'bun:test'
import { makeEmail } from '../../src/provider/memory.js'
import { makeHarness } from './helpers.js'

describe('--csv flag', () => {
  test('outputs CSV instead of human-readable summary', async () => {
    const emails = [
      makeEmail({ id: '1', from: { name: 'GitHub', email: 'noreply@github.com' } }),
      makeEmail({ id: '2', from: { name: 'GitHub', email: 'notifications@github.com' } }),
    ]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('analyze', '--csv')

    const out = h.stdoutText()
    // Should have CSV header
    expect(out).toContain('email,name,count')
    // Should have data rows
    expect(out).toContain('noreply@github.com')
  })

  test('auto-picks first array-valued property', async () => {
    const emails = [makeEmail({ id: '1', from: { name: 'User', email: 'user@example.com' } })]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('plan', '--csv')

    const out = h.stdoutText()
    // Plan report has distribution (object) and unmatchedTopSenders (array)
    // Should pick unmatchedTopSenders
    expect(out).toContain('email')
  })

  test('--csv-field overrides auto-pick', async () => {
    const emails = [
      makeEmail({ id: '1', from: { name: 'GitHub', email: 'noreply@github.com' } }),
      makeEmail({ id: '2', from: { name: 'GitHub', email: 'notifications@github.com' } }),
    ]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('analyze', '--csv', '--csv-field', 'domains')

    const out = h.stdoutText()
    // Should output domains instead of senders
    expect(out).toContain('domain,count')
    expect(out).toContain('github.com')
  })

  test('--csv-field with non-array field throws error', async () => {
    const emails = [makeEmail({ id: '1', from: { email: 'user@example.com', name: 'User' } })]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('analyze', '--csv', '--csv-field', 'scanned')

    const err = h.stderrText()
    expect(err).toContain('--csv-field scanned is not an array')
    expect(h.exitCodes).toContain(1)
  })
})

describe('--view flag', () => {
  test('calls runCsvViewer instead of writing to stdout', async () => {
    const emails = [makeEmail({ id: '1', from: { name: 'Test', email: 'test@example.com' } })]
    const viewerCalls: string[] = []
    const mockViewer = async (csv: string) => {
      viewerCalls.push(csv)
    }

    const h = await makeHarness(emails, {
      config: { categories: [], rules: [] },
      runCsvViewer: mockViewer,
    })
    await h.run('analyze', '--view')

    expect(viewerCalls).toHaveLength(1)
    expect(viewerCalls[0]).toContain('email')
  })

  test('passed --csv-field to viewer', async () => {
    const emails = [makeEmail({ id: '1', from: { name: 'GitHub', email: 'noreply@github.com' } })]
    const viewerCalls: string[] = []
    const mockViewer = async (csv: string) => {
      viewerCalls.push(csv)
    }

    const h = await makeHarness(emails, {
      config: { categories: [], rules: [] },
      runCsvViewer: mockViewer,
    })
    await h.run('analyze', '--view', '--csv-field', 'domains')

    expect(viewerCalls[0]).toContain('domain,count')
  })
})

describe('output flag precedence and validation', () => {
  test('--csv and --json together throws validation error', async () => {
    const emails = [makeEmail({ id: '1', from: { email: 'test@example.com', name: 'Test' } })]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('analyze', '--csv', '--json')

    const err = h.stderrText()
    expect(err).toContain('mutually exclusive')
    expect(h.exitCodes).toContain(1)
  })

  test('--view, --csv, and --json together throws validation error', async () => {
    const emails = [makeEmail({ id: '1', from: { email: 'test@example.com', name: 'Test' } })]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('analyze', '--view', '--csv', '--json')

    const err = h.stderrText()
    expect(err).toContain('mutually exclusive')
    expect(h.exitCodes).toContain(1)
  })

  test('report file written and path logged even if viewer fails', async () => {
    const emails = [makeEmail({ id: '1', from: { email: 'test@example.com', name: 'Test' } })]
    const mockViewer = async () => {
      throw new Error('viewer failed')
    }

    const h = await makeHarness(emails, {
      config: { categories: [], rules: [] },
      runCsvViewer: mockViewer,
    })
    await h.run('analyze', '--view')

    // Error should be caught and reported
    expect(h.stderrText()).toContain('viewer failed')
    // Report path should still be logged (in finally block)
    expect(h.stderrText()).toContain('report:')
  })
})

describe('suggest command with machine-readable flags', () => {
  test('--csv suppresses interactive prompts', async () => {
    const emails = [
      makeEmail({ id: 'g1', from: { name: 'GitHub', email: 'notifications@github.com' } }),
      makeEmail({ id: 'g2', from: { name: 'GitHub', email: 'noreply@github.com' } }),
      makeEmail({ id: 'u1', from: { name: 'Unknown', email: 'updates@unknown.example' } }),
      makeEmail({ id: 'u2', from: { name: 'Unknown', email: 'updates@unknown.example' } }),
    ]
    const h = await makeHarness(emails, { config: { categories: [], rules: [] } })
    await h.run('suggest', '--no-interactive', '--csv')

    const out = h.stdoutText()
    // Should output CSV, not prompt for unknown domains
    expect(out).toContain('domain,category')
    // Should not include fragment printing (machine-readable suppresses it)
    expect(out).not.toContain('Paste into')
  })

  test('--view suppresses interactive prompts and fragment', async () => {
    const emails = [
      makeEmail({ id: 'g1', from: { name: 'GitHub', email: 'notifications@github.com' } }),
      makeEmail({ id: 'g2', from: { name: 'GitHub', email: 'noreply@github.com' } }),
    ]
    const mockViewer = async () => {}
    const h = await makeHarness(emails, {
      config: { categories: [], rules: [] },
      runCsvViewer: mockViewer,
    })
    await h.run('suggest', '--no-interactive', '--view')

    // Output should be minimal (report path only)
    expect(h.stdoutText()).not.toContain('Paste into')
    // Fragment should not be printed in stdout
    expect(h.stdoutText()).not.toContain('rules:')
  })
})
