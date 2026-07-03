import { createInterface } from 'node:readline/promises'

/** Injectable confirmation gate; pipelines never talk to a TTY directly. */
export type ConfirmFn = (summary: string) => Promise<boolean>

/** Safe non-interactive default: refuse every big mutation. */
export const denyAll: ConfirmFn = () => Promise.resolve(false)

/** Explicit opt-in (--yes). */
export const allowAll: ConfirmFn = () => Promise.resolve(true)

export const interactiveConfirm = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): ConfirmFn => {
  return async (summary) => {
    const rl = createInterface({ input, output })
    try {
      const answer = await rl.question(`${summary} Proceed? [y/N] `)
      const normalized = answer.trim().toLowerCase()
      return normalized === 'y' || normalized === 'yes'
    } finally {
      rl.close()
    }
  }
}

export const needsConfirmation = (plannedMutations: number, threshold = 100): boolean => {
  return plannedMutations > threshold
}
