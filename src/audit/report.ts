import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { redactDeep } from '../safety/redact.js'

export interface RunReportMeta {
  command: string
  startedAt: string
  finishedAt: string
  dryRun: boolean
}

/**
 * Writes `${dir}/${name}-report.json` (pretty-printed, credentials redacted),
 * creating the directory if needed. Overwrites a previous report of the same
 * name. Returns the absolute path.
 */
export const writeReport = async (dir: string, name: string, data: unknown): Promise<string> => {
  const absDir = resolve(dir)
  await mkdir(absDir, { recursive: true })
  const path = join(absDir, `${name}-report.json`)
  await writeFile(path, `${JSON.stringify(redactDeep(data), null, 2)}\n`)
  return path
}
