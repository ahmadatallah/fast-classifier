import type {
  AnalyzeReport,
  FileReport,
  NeedsActionReport,
  PlanReport,
  RunMeta,
  SweepReport,
  VerifyReport,
} from '../pipeline/index.js'
import type { Label } from '../types.js'

/** Plain padEnd table — the CLI has no formatting dependencies on purpose. */
export const table = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  )
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

const truncate = (text: string, max: number): string => {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const metaLine = (meta: RunMeta): string => {
  return `${meta.command}${meta.dryRun ? ' (dry run)' : ''} — started ${meta.startedAt}`
}

const num = (n: number): string => String(n)

export const formatAnalyze = (report: AnalyzeReport): string => {
  const senders = table(
    ['count', 'sender', 'name'],
    report.senders.slice(0, 15).map((s) => [num(s.count), s.email, truncate(s.name, 30)]),
  )
  const domains = table(
    ['count', 'domain', 'sample senders'],
    report.domains
      .slice(0, 15)
      .map((d) => [num(d.count), d.domain, truncate(d.sampleSenders.join(', '), 60)]),
  )
  return [
    metaLine(report.meta),
    `scanned ${report.scanned} emails`,
    '',
    'Top senders:',
    senders,
    '',
    'Top domains:',
    domains,
    '',
  ].join('\n')
}

export const formatPlan = (report: PlanReport): string => {
  const distribution = table(
    ['count', 'category'],
    Object.entries(report.distribution).map(([category, count]) => [num(count), category]),
  )
  const unmatched = table(
    ['count', 'sender', 'name'],
    report.unmatchedTopSenders
      .slice(0, 15)
      .map((s) => [num(s.count), s.email, truncate(s.name, 30)]),
  )
  return [
    metaLine(report.meta),
    `scanned ${report.scanned}, matched ${report.matched} (${report.coveragePercent}% coverage)`,
    '',
    'Distribution:',
    distribution,
    '',
    'Top unmatched senders (add rules for these to raise coverage):',
    unmatched,
    '',
  ].join('\n')
}

export const formatSweep = (report: SweepReport): string => {
  const senders = table(
    ['count', 'sender'],
    report.topSenders.map((s) => [num(s.count), s.email]),
  )
  const lines = [
    metaLine(report.meta),
    `scanned ${report.scanned}, planned ${report.planned}, executed ${report.executed}, ` +
      `kept out ${report.keptOut}`,
  ]
  if (report.skippedByConfirm) lines.push('ABORTED: confirmation declined — nothing was changed')
  lines.push('', 'Top swept senders:', senders, '')
  return lines.join('\n')
}

export const formatFile = (report: FileReport): string => {
  const tally = table(
    ['count', 'category'],
    Object.entries(report.tally).map(([category, count]) => [num(count), category]),
  )
  const unmatched = table(
    ['count', 'sender', 'name'],
    report.unmatchedTopSenders
      .slice(0, 15)
      .map((s) => [num(s.count), s.email, truncate(s.name, 30)]),
  )
  const lines = [
    metaLine(report.meta),
    `scanned ${report.scanned}, planned ${report.planned}, executed ${report.executed}, ` +
      `kept out ${report.keptOut}, unmatched ${report.unmatched} ` +
      `(${report.coveragePercent}% coverage)`,
  ]
  if (report.skippedByConfirm) lines.push('ABORTED: confirmation declined — nothing was changed')
  lines.push('', 'Filed per category:', tally, '', 'Top unmatched senders:', unmatched, '')
  return lines.join('\n')
}

export const formatNeedsAction = (report: NeedsActionReport): string => {
  const candidates = table(
    ['score', 'received', 'sender', 'subject'],
    report.candidates
      .slice(0, 20)
      .map((c) => [num(c.score), c.receivedAt.slice(0, 10), c.from.email, truncate(c.subject, 60)]),
  )
  return [
    metaLine(report.meta),
    `scanned ${report.scanned}, ${report.candidates.length} candidates, tagged ${report.tagged}`,
    '',
    candidates,
    '',
  ].join('\n')
}

export const formatVerify = (report: VerifyReport): string => {
  const checks = report.checks.map(
    (check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`,
  )
  return [
    metaLine(report.meta),
    ...checks,
    report.passed ? 'verify: all checks passed' : 'verify: FAILED',
    '',
  ].join('\n')
}

export const formatLabels = (labels: Label[]): string => {
  const rows = [...labels]
    .sort((a, b) => (a.path ?? a.name).localeCompare(b.path ?? b.name))
    .map((label) => [label.path ?? label.name, label.role ?? '', num(label.totalEmails ?? 0)])
  return `${table(['label', 'role', 'emails'], rows)}\n`
}

export const formatEnsurePlan = (names: string[]): string => {
  return `would ensure ${names.length} label(s): ${names.join(', ')}\n`
}

export const formatEnsured = (labels: Label[]): string => {
  const rows = labels.map((label) => [label.path ?? label.name, label.id])
  return `ensured ${labels.length} label(s):\n${table(['label', 'id'], rows)}\n`
}
