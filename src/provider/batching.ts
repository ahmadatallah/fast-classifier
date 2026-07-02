import { RateLimitError } from './types.js'

export interface BatchOptions {
  batchSize?: number
  /** pause between chunks (not after the last) */
  delayMs?: number
  /** retries per chunk on RateLimitError; other errors propagate immediately */
  retries?: number
  /** multiplied by the attempt number; err.retryAfterMs wins if larger */
  retryBackoffMs?: number
  sleep?: (ms: number) => Promise<void>
  onProgress?: (done: number, total: number) => void
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The shared write loop: chunk, pace, retry rate limits, report progress. */
export async function batchExecute<T>(
  items: readonly T[],
  fn: (chunk: T[]) => Promise<void>,
  opts: BatchOptions = {},
): Promise<{ processed: number; chunks: number }> {
  const batchSize = opts.batchSize ?? 50
  const delayMs = opts.delayMs ?? 220
  const retries = opts.retries ?? 3
  const retryBackoffMs = opts.retryBackoffMs ?? 1200
  const sleep = opts.sleep ?? realSleep

  let processed = 0
  let chunks = 0
  for (let start = 0; start < items.length; start += batchSize) {
    if (chunks > 0) await sleep(delayMs)
    const chunk = items.slice(start, start + batchSize)

    let attempt = 0
    for (;;) {
      try {
        await fn(chunk)
        break
      } catch (err) {
        if (!(err instanceof RateLimitError) || attempt >= retries) throw err
        attempt++
        await sleep(Math.max(retryBackoffMs * attempt, err.retryAfterMs ?? 0))
      }
    }

    processed += chunk.length
    chunks++
    opts.onProgress?.(processed, items.length)
  }
  return { processed, chunks }
}
