import { describe, expect, test } from 'bun:test'
import { reportToCsv } from '../../src/cli/csv.js'
import { resolveTarget, TENNIS_VERSION, installTennis } from '../../src/cli/tennis-install.js'
import { runTennis } from '../../src/cli/viewer.js'
import { makeEmail } from '../../src/provider/memory.js'
import { makeHarness } from './helpers.js'

describe('reportToCsv', () => {
  test('object root picks the first array-valued property', () => {
    const report = {
      meta: { command: 'analyze' },
      scanned: 2,
      senders: [{ email: 'a@x.com', name: 'A', count: 2 }],
      domains: [{ domain: 'x.com', count: 2 }],
    }
    expect(reportToCsv(report)).toBe('email,name,count\na@x.com,A,2\n')
  })

  test('field overrides the auto-pick, dot-path included', () => {
    const report = { top: [], nested: { list: [{ a: 1 }] } }
    expect(reportToCsv(report, 'nested.list')).toBe('a\n1\n')
  })

  test('field pointing at a non-array throws', () => {
    expect(() => reportToCsv({ scanned: 5 }, 'scanned')).toThrow('not an array')
  })

  test('nested objects flatten to dot columns; primitive arrays join', () => {
    const rows = [{ from: { email: 'x@y.com', name: 'X' }, signals: ['q', 'deadline'], score: 0.9 }]
    expect(reportToCsv(rows)).toBe(
      'from.email,from.name,signals,score\nx@y.com,X,q; deadline,0.9\n',
    )
  })

  test('cells with commas, quotes, CR, and LF are quoted per RFC 4180', () => {
    const rows = [{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2', d: 'cr\rhere' }]
    expect(reportToCsv(rows)).toBe('a,b,c,d\n"x,y","he said ""hi""","line1\nline2","cr\rhere"\n')
  })

  test('leading formula characters are neutralized', () => {
    const rows = [{ a: '=1+1', b: '@cmd', c: '+49123', d: '-5' }]
    expect(reportToCsv(rows)).toBe("a,b,c,d\n'=1+1,'@cmd,'+49123,'-5\n")
  })

  test('primitive rows get a stable "value" column', () => {
    expect(reportToCsv({ requested: ['Inbox/Dev', 'Inbox/Fin'] })).toBe(
      'value\nInbox/Dev\nInbox/Fin\n',
    )
  })

  test('missing keys across ragged rows become empty cells', () => {
    expect(reportToCsv([{ a: '1' }, { b: '2' }])).toBe('a,b\n1,\n,2\n')
  })

  test('null and undefined values become empty cells', () => {
    expect(reportToCsv([{ a: null, b: 'x' }])).toBe('a,b\n,x\n')
  })
})

describe('--csv / --view CLI flags', () => {
  const inbox = () => [
    makeEmail({ id: 'a1', from: { name: 'CI', email: 'builds@ci.example' } }),
    makeEmail({ id: 'a2', from: { name: 'CI', email: 'builds@ci.example' } }),
  ]

  test('analyze --csv prints sender rows as CSV', async () => {
    const h = await makeHarness(inbox())
    await h.run('analyze', '--csv')
    const [header, first] = h.stdoutText().split('\n')
    expect(header).toBe('email,name,count')
    expect(first).toBe('builds@ci.example,CI,2')
  })

  test('--csv-field selects the array and implies --csv', async () => {
    const h = await makeHarness(inbox())
    await h.run('analyze', '--csv-field', 'domains')
    expect(h.stdoutText().split('\n')[0]).toBe('domain,count,sampleSenders')
    expect(h.stdoutText()).toContain('ci.example,2,builds@ci.example')
  })

  test('--view pipes the CSV into the injected viewer instead of stdout', async () => {
    const seen: string[] = []
    const h = await makeHarness(inbox(), {
      runCsvViewer: async (csv) => {
        seen.push(csv)
      },
    })
    await h.run('analyze', '--view')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toStartWith('email,name,count\n')
    expect(h.stdoutText()).toBe('')
    expect(h.exitCodes).toHaveLength(0)
  })

  test('--csv and --json together fail with exit 1', async () => {
    const h = await makeHarness(inbox())
    await h.run('analyze', '--csv', '--json')
    expect(h.exitCodes).toEqual([1])
    expect(h.stderrText()).toContain('mutually exclusive')
  })

  test('viewer failure surfaces as a one-line error and exit 1', async () => {
    const h = await makeHarness(inbox(), {
      runCsvViewer: async () => {
        throw new Error('tennis exited with code 2')
      },
    })
    await h.run('analyze', '--view')
    expect(h.exitCodes).toEqual([1])
    expect(h.stderrText()).toContain('tennis exited with code 2')
  })

  test('suggest --csv is non-interactive and prints CSV, not the fragment', async () => {
    const h = await makeHarness([
      makeEmail({ id: 'g1', from: { name: 'GitHub', email: 'noti@github.com' } }),
      makeEmail({ id: 'g2', from: { name: 'GitHub', email: 'noreply@github.com' } }),
    ])
    await h.run('suggest', '--csv')
    expect(h.stdoutText()).not.toContain('Paste into')
    expect(h.exitCodes).toHaveLength(0)
  })
})

describe('runTennis', () => {
  test('missing binary rejects with the install hint', async () => {
    await expect(runTennis('a,b\n1,2\n', '/nonexistent/tennis-not-here')).rejects.toThrow(
      'install-viewer',
    )
  })
})

describe('tennis installer', () => {
  test('resolveTarget maps platform/arch to release assets', () => {
    expect(resolveTarget('darwin', 'arm64')).toEqual({
      asset: 'darwin_arm64.tar.gz',
      binary: 'tennis',
    })
    expect(resolveTarget('linux', 'x64')).toEqual({
      asset: 'linux_amd64.tar.gz',
      binary: 'tennis',
    })
    expect(resolveTarget('win32', 'x64')).toEqual({
      asset: 'windows_amd64.zip',
      binary: 'tennis.exe',
    })
    expect(() => resolveTarget('sunos', 'ia32')).toThrow('no tennis release')
  })

  test('checksum mismatch refuses to install, before touching disk', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
    await expect(installTennis({ fetchImpl })).rejects.toThrow('checksum mismatch')
  })

  test('failed download reports status and url', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch
    await expect(installTennis({ fetchImpl })).rejects.toThrow(
      `download failed: 404 Not Found — https://github.com/gurgeous/tennis/releases/download/v${TENNIS_VERSION}`,
    )
  })
})
