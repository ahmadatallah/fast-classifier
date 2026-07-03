import { describe, expect, test } from 'bun:test'
import { batchExecute } from '../../src/provider/batching.js'
import { RateLimitError } from '../../src/provider/types.js'

const recordingSleep = () => {
  const calls: number[] = []
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms)
    return Promise.resolve()
  }
  return { calls, sleep }
}

const numbers = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('batchExecute', () => {
  test('chunks on batchSize boundaries: 120 / 50 -> 50, 50, 20', async () => {
    const { sleep } = recordingSleep()
    const chunks: number[][] = []
    const result = await batchExecute(
      numbers(120),
      async (chunk) => {
        chunks.push(chunk)
      },
      { batchSize: 50, sleep },
    )

    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20])
    expect(chunks[0]?.[0]).toBe(0)
    expect(chunks[2]?.[0]).toBe(100)
    expect(chunks[2]?.[19]).toBe(119)
    expect(result).toEqual({ processed: 120, chunks: 3 })
  })

  test('sleeps delayMs between chunks, not after the last', async () => {
    const { calls, sleep } = recordingSleep()
    await batchExecute(numbers(120), async () => {}, { batchSize: 50, delayMs: 100, sleep })
    expect(calls).toEqual([100, 100])
  })

  test('a single chunk never sleeps', async () => {
    const { calls, sleep } = recordingSleep()
    await batchExecute(numbers(10), async () => {}, { batchSize: 50, delayMs: 100, sleep })
    expect(calls).toEqual([])
  })

  test('empty input: no calls, no chunks', async () => {
    const { calls, sleep } = recordingSleep()
    let called = 0
    const result = await batchExecute(
      [],
      async () => {
        called++
      },
      { sleep },
    )
    expect(result).toEqual({ processed: 0, chunks: 0 })
    expect(called).toBe(0)
    expect(calls).toEqual([])
  })

  test('RateLimitError: retries the same chunk with growing backoff, then succeeds', async () => {
    const { calls, sleep } = recordingSleep()
    let attempts = 0
    const seen: number[][] = []
    const result = await batchExecute(
      numbers(3),
      async (chunk) => {
        seen.push(chunk)
        attempts++
        if (attempts <= 2) throw new RateLimitError()
      },
      { retryBackoffMs: 1000, sleep },
    )

    expect(attempts).toBe(3)
    expect(seen[0]).toEqual(seen[1] ?? [])
    expect(seen[1]).toEqual(seen[2] ?? [])
    expect(calls).toEqual([1000, 2000]) // retryBackoffMs * attempt
    expect(result).toEqual({ processed: 3, chunks: 1 })
  })

  test('honors err.retryAfterMs when larger than the computed backoff', async () => {
    const { calls, sleep } = recordingSleep()
    let attempts = 0
    await batchExecute(
      numbers(1),
      async () => {
        attempts++
        if (attempts === 1) throw new RateLimitError('slow down', 5000)
        if (attempts === 2) throw new RateLimitError('slow down', 10)
      },
      { retryBackoffMs: 1000, sleep },
    )

    // max(1000*1, 5000) then max(1000*2, 10)
    expect(calls).toEqual([5000, 2000])
  })

  test('retries exhausted: rethrows the RateLimitError', async () => {
    const { calls, sleep } = recordingSleep()
    let attempts = 0
    const run = batchExecute(
      numbers(1),
      async () => {
        attempts++
        throw new RateLimitError()
      },
      { retries: 2, retryBackoffMs: 500, sleep },
    )

    await expect(run).rejects.toBeInstanceOf(RateLimitError)
    expect(attempts).toBe(3) // initial call + 2 retries
    expect(calls).toEqual([500, 1000])
  })

  test('non-rate-limit errors propagate immediately without retry', async () => {
    const { calls, sleep } = recordingSleep()
    let attempts = 0
    const run = batchExecute(
      numbers(60),
      async () => {
        attempts++
        throw new Error('boom')
      },
      { batchSize: 50, sleep },
    )

    await expect(run).rejects.toThrow('boom')
    expect(attempts).toBe(1)
    expect(calls).toEqual([])
  })

  test('onProgress fires after each successful chunk with cumulative counts', async () => {
    const { sleep } = recordingSleep()
    const progress: Array<[number, number]> = []
    await batchExecute(numbers(120), async () => {}, {
      batchSize: 50,
      sleep,
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(progress).toEqual([
      [50, 120],
      [100, 120],
      [120, 120],
    ])
  })

  test('onProgress not called for a chunk that ultimately fails', async () => {
    const { sleep } = recordingSleep()
    const progress: Array<[number, number]> = []
    const run = batchExecute(
      numbers(60),
      async (chunk) => {
        if (chunk[0] === 50) throw new Error('boom')
      },
      { batchSize: 50, sleep, onProgress: (done, total) => progress.push([done, total]) },
    )
    await expect(run).rejects.toThrow('boom')
    expect(progress).toEqual([[50, 60]])
  })
})
