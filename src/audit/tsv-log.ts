import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface AuditRecord {
  id: string
  action: string
  category?: string | undefined
  sender?: string | undefined
}

/** TSV values must never break line/column structure. */
const sanitize = (field: string): string => {
  return field.replace(/[\t\r\n]+/g, ' ')
}

/**
 * Append-only TSV audit trail: `id\taction\tcategory\tsender` per line.
 * Doubles as the resume cursor — only the first column (id) matters for
 * resume, so the legacy 2-column (`id\tfrom`) and 3-column
 * (`id\tcategory\tfrom`) session logs load fine.
 */
export interface TsvAudit {
  /** Sync append: the line is on disk before the mutation batch continues. */
  append(record: AuditRecord): void
  has(id: string): boolean
  readonly processedIds: Set<string>
  readonly path: string
}

export const openTsvAudit = async (path: string): Promise<TsvAudit> => {
  const abs = resolve(path)
  mkdirSync(dirname(abs), { recursive: true })
  if (!existsSync(abs)) writeFileSync(abs, '')
  const ids = new Set<string>()
  for (const line of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const id = line.split('\t')[0]
    if (id) ids.add(id)
  }
  return {
    append(record: AuditRecord): void {
      const id = sanitize(record.id)
      const line = [
        id,
        sanitize(record.action),
        sanitize(record.category ?? ''),
        sanitize(record.sender ?? ''),
      ].join('\t')
      appendFileSync(abs, `${line}\n`)
      ids.add(id)
    },
    has(id: string): boolean {
      return ids.has(id)
    },
    get processedIds(): Set<string> {
      return new Set(ids)
    },
    get path(): string {
      return abs
    },
  }
}
