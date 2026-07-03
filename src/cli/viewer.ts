import { spawn } from 'node:child_process'
import { managedTennisPath } from './tennis-install.js'

const INSTALL_HINT =
  'run `fast-classifier install-viewer`, or: brew install gurgeous/tap/tennis (https://github.com/gurgeous/tennis)'

/**
 * Pipes CSV through the `tennis` binary for a pretty terminal table (`--view`).
 * The managed binary (~/.fast-classifier/bin, written by install-viewer) wins
 * over PATH so installs work without shell profile edits.
 */
export const runTennis = (csv: string, command?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const bin = command ?? managedTennisPath() ?? 'tennis'
    const child = spawn(bin, ['-'], { stdio: ['pipe', 'inherit', 'inherit'] })
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      reject(code === 'ENOENT' ? new Error(`tennis not found — ${INSTALL_HINT}`) : err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tennis exited with code ${code}`))
    })
    // Error handler for write stream (EPIPE if child closes before write completes)
    child.stdin.on('error', reject)
    // Write entire CSV, checking for backpressure; drain before end()
    const ok = child.stdin.write(csv)
    if (ok) {
      child.stdin.end()
    } else {
      child.stdin.once('drain', () => child.stdin.end())
    }
  })
