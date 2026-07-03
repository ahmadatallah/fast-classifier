import { describe, test, expect } from 'bun:test'
import { DryRunViolation, readOnlyProvider } from '../../src/safety/dry-run.js'
import { MUTATING_METHODS, type MailProvider } from '../../src/provider/types.js'
import type { EmailMeta, Label } from '../../src/types.js'

// hand-rolled stub — deliberately not the memory provider, which lives in another module
const makeStub = (): { provider: MailProvider; calls: string[] } => {
  const calls: string[] = []
  const email: EmailMeta = {
    id: 'e1',
    subject: 'hello',
    from: { name: 'Alice', email: 'alice@example.com' },
    receivedAt: '2026-01-01T00:00:00Z',
    isUnread: true,
    labels: ['Inbox'],
  }
  const label: Label = { id: 'l1', name: 'Dev' }
  const provider: MailProvider = {
    kind: 'memory',
    caps: {
      maxPageSize: 50,
      serverSideNotFrom: 'address-only',
      autoCreatesLabels: true,
      canSetLabelColor: false,
    },
    async connect() {
      calls.push('connect')
    },
    async listLabels() {
      calls.push('listLabels')
      return [label]
    },
    async ensureLabels(names) {
      calls.push('ensureLabels')
      return new Map(names.map((n) => [n, label]))
    },
    async searchEmails() {
      calls.push('searchEmails')
      return { items: [email], position: 0, total: 1 }
    },
    async getEmail() {
      calls.push('getEmail')
      return email
    },
    async addLabels() {
      calls.push('addLabels')
    },
    async archive() {
      calls.push('archive')
    },
  }
  return { provider, calls }
}

describe('readOnlyProvider', () => {
  test('ensureLabels throws DryRunViolation and never reaches the provider', () => {
    const { provider, calls } = makeStub()
    const ro = readOnlyProvider(provider)
    expect(() => ro.ensureLabels(['Dev'])).toThrow(DryRunViolation)
    expect(() => ro.ensureLabels(['Dev'])).toThrow(/ensureLabels/)
    expect(calls).toEqual([])
  })

  test('addLabels throws DryRunViolation and never reaches the provider', () => {
    const { provider, calls } = makeStub()
    const ro = readOnlyProvider(provider)
    expect(() => ro.addLabels(['e1'], ['Dev'])).toThrow(DryRunViolation)
    expect(() => ro.addLabels(['e1'], ['Dev'])).toThrow(/addLabels/)
    expect(calls).toEqual([])
  })

  test('archive throws DryRunViolation and never reaches the provider', () => {
    const { provider, calls } = makeStub()
    const ro = readOnlyProvider(provider)
    expect(() => ro.archive(['e1'])).toThrow(DryRunViolation)
    expect(() => ro.archive(['e1'])).toThrow(/archive/)
    expect(calls).toEqual([])
  })

  test('every method in MUTATING_METHODS is guarded', () => {
    const { provider } = makeStub()
    const ro = readOnlyProvider(provider) as unknown as Record<string, () => unknown>
    for (const method of MUTATING_METHODS) {
      const guarded = ro[method]
      expect(guarded).toBeFunction()
      expect(() => guarded?.()).toThrow(DryRunViolation)
    }
  })

  test('violation error has the right name', () => {
    const { provider } = makeStub()
    const ro = readOnlyProvider(provider)
    try {
      ro.archive(['e1'])
      throw new Error('expected DryRunViolation')
    } catch (err) {
      expect((err as Error).name).toBe('DryRunViolation')
    }
  })

  test('read methods pass through to the underlying provider', async () => {
    const { provider, calls } = makeStub()
    const ro = readOnlyProvider(provider)
    await ro.connect()
    const labels = await ro.listLabels()
    const page = await ro.searchEmails({ inMailbox: 'inbox' }, { position: 0, limit: 10 })
    const email = await ro.getEmail('e1')
    expect(labels).toEqual([{ id: 'l1', name: 'Dev' }])
    expect(page.items).toHaveLength(1)
    expect(email.id).toBe('e1')
    expect(calls).toEqual(['connect', 'listLabels', 'searchEmails', 'getEmail'])
  })

  test('kind and caps are readable through the proxy', () => {
    const { provider } = makeStub()
    const ro = readOnlyProvider(provider)
    expect(ro.kind).toBe('memory')
    expect(ro.caps.maxPageSize).toBe(50)
    expect(ro.caps.serverSideNotFrom).toBe('address-only')
  })
})
