// fast-classifier core barrel. Transports live behind subpath exports
// (fast-classifier/jmap, /mcp-client, /testing) so consumers only pull what
// they use; pipelines are re-exported here and at /pipelines.
export * from './types.js'
export * from './config/index.js'
export * from './classify/index.js'
export * from './safety/index.js'
export * from './audit/index.js'
export * from './pipeline/index.js'
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
export { paginate, Pager, type PagerOptions } from './provider/paging.js'
export { batchExecute, type BatchOptions } from './provider/batching.js'
