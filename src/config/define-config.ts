import type { ClassifierConfigInput } from './schema.js'

/**
 * Identity helper for type-safe config authoring:
 *
 * ```ts
 * // fast-classifier.config.ts
 * import { defineConfig } from 'fast-classifier/config'
 * export default defineConfig({ categories: [...], rules: [...] })
 * ```
 */
export function defineConfig(config: ClassifierConfigInput): ClassifierConfigInput {
  return config
}
