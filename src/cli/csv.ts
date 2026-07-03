const getPath = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, value)

const pickRows = (report: unknown, field?: string): unknown[] => {
  if (field !== undefined) {
    const value = getPath(report, field)
    if (!Array.isArray(value)) throw new Error(`--csv-field ${field} is not an array`)
    return value
  }
  if (Array.isArray(report)) return report
  if (report !== null && typeof report === 'object') {
    const arrayEntry = Object.entries(report as Record<string, unknown>).find(([, v]) =>
      Array.isArray(v),
    )
    if (arrayEntry !== undefined) return arrayEntry[1] as unknown[]
    return [report]
  }
  return [report]
}

/** primitive rows (e.g. a string[] report field) get a stable column name */
const keyOf = (prefix: string): string => (prefix === '' ? 'value' : prefix)

const flatten = (
  value: unknown,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> => {
  if (value === null || value === undefined) {
    out[keyOf(prefix)] = ''
  } else if (Array.isArray(value)) {
    out[keyOf(prefix)] = value.every((v) => v === null || typeof v !== 'object')
      ? value.join('; ')
      : JSON.stringify(value)
  } else if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix === '' ? key : `${prefix}.${key}`, out)
    }
  } else {
    out[keyOf(prefix)] = String(value)
  }
  return out
}

const csvCell = (value: string): string => {
  let s = value
  // Prevent formula injection: prefix leading formula chars with single quote
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  // Quote if contains comma, quote, CR, or LF (RFC 4180)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Flattens a report into CSV for `--csv`/`--view`. Array root is used as-is;
 * object root uses its first array-valued property, `field` (dot-path)
 * overrides that pick, and anything else falls back to a single-row dump.
 */
export const reportToCsv = (report: unknown, field?: string): string => {
  const rows = pickRows(report, field).map((row) => flatten(row))
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((col) => csvCell(row[col] ?? '')).join(','))
  }
  return `${lines.join('\n')}\n`
}
