#!/usr/bin/env node
/**
 * Flatten JSON into CSV. Meant to feed tennis (github.com/gurgeous/tennis)
 * for terminal viewing, e.g.:
 *
 *   fast-classifier analyze --json | node scripts/json-to-csv.mjs --field senders | tennis -
 *
 * Auto mode (no --field): array root is used as-is; object root uses its
 * first array-valued property, or falls back to a single-row dump of the
 * whole object.
 *
 * NOTE: This script duplicates logic from src/cli/csv.ts for standalone use.
 * Consider using fast-classifier analyze --csv or --view instead.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let field
let filePath
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--field' || args[i] === '-f') field = args[++i]
  else if (!args[i].startsWith('-')) filePath = args[i]
}

const raw = filePath ? readFileSync(filePath, 'utf8') : readFileSync(0, 'utf8')
const data = JSON.parse(raw)

const getPath = (obj, path) =>
  path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)

const pickRows = (root) => {
  if (field !== undefined) {
    const value = getPath(root, field)
    if (!Array.isArray(value)) throw new Error(`--field ${field} is not an array`)
    return value
  }
  if (Array.isArray(root)) return root
  if (root && typeof root === 'object') {
    const arrayKey = Object.keys(root).find((k) => Array.isArray(root[k]))
    if (arrayKey !== undefined) return root[arrayKey]
    return [root]
  }
  return [root]
}

const flatten = (obj, prefix = '', out = {}) => {
  if (obj === null || obj === undefined) {
    out[prefix] = ''
    return out
  }
  if (Array.isArray(obj)) {
    out[prefix] = obj.every((v) => v === null || typeof v !== 'object')
      ? obj.join('; ')
      : JSON.stringify(obj)
    return out
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      flatten(value, prefix === '' ? key : `${prefix}.${key}`, out)
    }
    return out
  }
  out[prefix] = String(obj)
  return out
}

const csvCell = (value) => {
  let s = value ?? ''
  // Prevent formula injection: prefix leading formula chars with single quote
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  // Quote if contains comma, quote, CR, or LF (RFC 4180)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const rows = pickRows(data).map((row) => flatten(row))
const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]

const lines = [columns.join(',')]
for (const row of rows) {
  lines.push(columns.map((col) => csvCell(row[col])).join(','))
}

process.stdout.write(lines.join('\n') + '\n')
