import { describe, test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  denyAll,
  allowAll,
  interactiveConfirm,
  needsConfirmation,
} from '../../src/safety/confirm.js'

describe('needsConfirmation', () => {
  test('boundary at the default threshold of 100', () => {
    expect(needsConfirmation(100)).toBe(false)
    expect(needsConfirmation(101)).toBe(true)
    expect(needsConfirmation(0)).toBe(false)
  })

  test('custom threshold', () => {
    expect(needsConfirmation(5, 5)).toBe(false)
    expect(needsConfirmation(6, 5)).toBe(true)
  })
})

describe('denyAll / allowAll', () => {
  test('denyAll always refuses', async () => {
    expect(await denyAll('label 5000 emails')).toBe(false)
  })

  test('allowAll always accepts', async () => {
    expect(await allowAll('label 5000 emails')).toBe(true)
  })
})

const ask = async (answer: string): Promise<{ result: boolean; prompt: string }> => {
  const input = new PassThrough()
  const output = new PassThrough()
  const confirm = interactiveConfirm(input, output)
  const pending = confirm('Will label 500 emails.')
  input.write(answer)
  const result = await pending
  const prompt = (output.read() as Buffer | null)?.toString('utf8') ?? ''
  return { result, prompt }
}

describe('interactiveConfirm', () => {
  test("answers 'y' -> true and prints summary + prompt", async () => {
    const { result, prompt } = await ask('y\n')
    expect(result).toBe(true)
    expect(prompt).toContain('Will label 500 emails. Proceed? [y/N] ')
  })

  test("answers 'yes' / 'YES' -> true (case-insensitive)", async () => {
    expect((await ask('yes\n')).result).toBe(true)
    expect((await ask('YES\n')).result).toBe(true)
    expect((await ask('Y\n')).result).toBe(true)
  })

  test("answers 'n' -> false", async () => {
    expect((await ask('n\n')).result).toBe(false)
  })

  test('empty line -> false (No is the default)', async () => {
    expect((await ask('\n')).result).toBe(false)
  })

  test('garbage -> false', async () => {
    expect((await ask('sure why not\n')).result).toBe(false)
  })
})
