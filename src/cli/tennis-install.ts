import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * tennis (github.com/gurgeous/tennis) is a single static Go binary released
 * via GoReleaser. Version and per-asset sha256 are pinned here — bumping the
 * version means re-pinning every checksum from the release's checksums.txt.
 */
export const TENNIS_VERSION = '0.6.0'

const CHECKSUMS: Record<string, string> = {
  'darwin_amd64.tar.gz': 'afb4892b6209b1e521f73c751175fab1c96a0b1d08a0e76f49f41ad5762d0550',
  'darwin_arm64.tar.gz': '4cef3f4dc59cb6a37542eae4fe7c34b47fe153e0628ec37b157b1a8122f3739b',
  'linux_amd64.tar.gz': 'd4377113fece9a535d49737ba8e1ffb469bbb702abe7d9962bd6a045669d6e53',
  'linux_arm64.tar.gz': '26c842d3681cb920c3712f927b877995c1e0814acb40cfd5548c0c4c2c25e458',
  'windows_amd64.zip': '2b23eb98096d8a564cd21bf343ba9137bba23b1c894ee03733dfbc4723d3a68c',
}

export interface TennisTarget {
  /** e.g. 'darwin_arm64.tar.gz' — key into CHECKSUMS and release asset suffix */
  asset: string
  /** binary name inside the archive: 'tennis' or 'tennis.exe' */
  binary: string
}

export const resolveTarget = (
  platform: string = process.platform,
  arch: string = process.arch,
): TennisTarget => {
  const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined
  const goOs = platform === 'darwin' || platform === 'linux' ? platform : undefined
  if (goOs !== undefined && goArch !== undefined) {
    return { asset: `${goOs}_${goArch}.tar.gz`, binary: 'tennis' }
  }
  if (platform === 'win32' && goArch === 'amd64') {
    return { asset: 'windows_amd64.zip', binary: 'tennis.exe' }
  }
  throw new Error(
    `no tennis release for ${platform}/${arch} — install manually: https://github.com/gurgeous/tennis`,
  )
}

/** fast-classifier-owned install location, decoupled from the per-project report dir */
export const managedBinDir = (): string => join(homedir(), '.fast-classifier', 'bin')

/** Path to the managed tennis binary if this machine has one installed, else undefined. */
export const managedTennisPath = (): string | undefined => {
  const path = join(managedBinDir(), process.platform === 'win32' ? 'tennis.exe' : 'tennis')
  return existsSync(path) ? path : undefined
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** `tar -xf` (bsdtar) reads both .tar.gz and .zip on macOS, Linux, and Windows 10+. */
const extractBinary = (archive: string, member: string, destDir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', destDir, '--strip-components=1', member], {
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with code ${code} extracting ${archive}`))
    })
  })

export interface InstallDeps {
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

/**
 * Download the pinned tennis release for this machine, verify its sha256
 * against the constants above, and install the binary into managedBinDir().
 * Returns the installed binary path. Safe to re-run; overwrites in place.
 */
export const installTennis = async (deps: InstallDeps = {}): Promise<string> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const log = deps.log ?? (() => {})
  const target = resolveTarget()
  const expected = CHECKSUMS[target.asset]
  if (expected === undefined) throw new Error(`no pinned checksum for ${target.asset}`)

  const url = `https://github.com/gurgeous/tennis/releases/download/v${TENNIS_VERSION}/tennis_${TENNIS_VERSION}_${target.asset}`
  log(`downloading ${url}`)
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} — ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())

  const actual = sha256(bytes)
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${target.asset}: expected ${expected}, got ${actual} — refusing to install`,
    )
  }
  log(`sha256 verified (${expected.slice(0, 12)}…)`)

  const binDir = managedBinDir()
  await mkdir(binDir, { recursive: true })
  const archivePath = join(binDir, `tennis_${TENNIS_VERSION}_${target.asset}`)
  await writeFile(archivePath, bytes)
  // archive members live under tennis_<ver>_<os>_<arch>/ — strip that root
  const stem = `tennis_${TENNIS_VERSION}_${target.asset.replace(/\.(tar\.gz|zip)$/, '')}`
  try {
    await extractBinary(archivePath, `${stem}/${target.binary}`, binDir)
  } finally {
    await rm(archivePath, { force: true })
  }
  const binaryPath = join(binDir, target.binary)
  await chmod(binaryPath, 0o755)
  log(`installed ${binaryPath} (tennis v${TENNIS_VERSION})`)
  return binaryPath
}
