import { tokenFromEnv } from '../config/load.js'
import type { ClassifierConfig } from '../config/schema.js'
import { createJmapMailProvider } from '../provider/jmap/index.js'
import { createMcpMailProvider } from '../provider/mcp/index.js'
import type { MailProvider } from '../provider/types.js'

/** Injectable so tests drive the CLI with a MemoryMailProvider. */
export type ProviderFactory = (
  type: string,
  config: ClassifierConfig,
  env: Record<string, string | undefined>,
) => MailProvider

export const defaultProviderFactory: ProviderFactory = (type, config, env) => {
  const baseUrl = config.provider.baseUrl
  switch (type) {
    case 'jmap':
      return createJmapMailProvider({
        token: tokenFromEnv('jmap', env),
        ...(baseUrl ? { sessionUrl: `${baseUrl}/jmap/session` } : {}),
      })
    case 'mcp':
      return createMcpMailProvider({
        token: tokenFromEnv('mcp', env),
        ...(baseUrl ? { endpoint: baseUrl } : {}),
      })
    default:
      throw new Error(`unknown provider type '${type}' — expected 'jmap' or 'mcp'`)
  }
}
