import { tokenFromEnv } from '../config/load.js'
import type { ClassifierConfig } from '../config/schema.js'
import { JmapMailProvider } from '../provider/jmap/index.js'
import { McpMailProvider } from '../provider/mcp/index.js'
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
      return new JmapMailProvider({
        token: tokenFromEnv('jmap', env),
        ...(baseUrl ? { sessionUrl: `${baseUrl}/jmap/session` } : {}),
      })
    case 'mcp':
      return new McpMailProvider({
        token: tokenFromEnv('mcp', env),
        ...(baseUrl ? { endpoint: baseUrl } : {}),
      })
    default:
      throw new Error(`unknown provider type '${type}' — expected 'jmap' or 'mcp'`)
  }
}
