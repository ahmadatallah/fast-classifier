// fast-classifier core: shared types + config. Classify/provider/pipeline
// modules are re-exported here as they land (see subpath exports for direct
// imports: fast-classifier/config, /jmap, /mcp-client, /pipelines, /testing).
export * from './types.js'
export * from './config/index.js'
export {
  MUTATING_METHODS,
  NeverDeleteViolation,
  RateLimitError,
  TransportError,
  type MailProvider,
  type MutatingMethod,
  type PageRequest,
  type ProviderCapabilities,
} from './provider/types.js'
