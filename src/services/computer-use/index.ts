/**
 * Confidential computer-use: browser-side half of the feature.
 *
 * The host broker (`tinfoil-broker`) is already built; this module is the
 * browser/Next layer that detects + pairs with it, presents the curated tool
 * surface to the model, and drives the browser-mediated action loop. See
 * `~/dev/tinfoil/architecture.md` for the authoritative design.
 */

export { AccessTokenManager, createBrokerConnection } from './access-token'
export type { BrokerConnection } from './access-token'
export {
  adapterForModel,
  openAICUAdapter,
  resolveAdapter,
  type ModelAdapter,
  type NormalizeContext,
  type NormalizeResult,
  type ResolvedAdapter,
} from './adapter'
export {
  brokerReadiness,
  computerUseAvailability,
  connectionIndicator,
  readyImageNames,
  readyImages,
  type BrokerReadiness,
  type ComputerUseAvailability,
  type ConnectionIndicator,
} from './availability'
export {
  BrokerClient,
  DEFAULT_BROKER_ORIGIN,
  type BrokerClientOptions,
} from './broker-client'
export * from './chat-protocol'
export {
  forgetPairing,
  getStoredConnection,
  pairAndConnect,
  type ConnectionOptions,
} from './connection'
export {
  clearRefreshCredential,
  getRefreshCredential,
  isPaired,
  setRefreshCredential,
} from './credential-store'
export { isMacOS } from './host'
export {
  DEFAULT_IMAGE_QUALITY,
  createCanvasImageReducer,
  getComputerUseImageQuality,
  type ReduceOpts,
} from './image-reduce'
export { imageSize, type ImageSize } from './image-size'
export { createTinfoilStreamChat } from './inference'
export {
  runComputerUseLoop,
  type BrokerLike,
  type ImageReducer,
  type LoopEvent,
  type LoopResult,
  type LoopStopReason,
  type RunComputerUseLoopParams,
} from './loop-controller'
export {
  COMPUTER_BEGIN_TOOL_NAME,
  buildComputerBeginSchema,
} from './manifest-schema'
export {
  computerUseSupport,
  type ComputerUseSupport,
  type ModelLike,
} from './model-support'
export {
  PairingDeniedError,
  PairingTimeoutError,
  generatePairingCode,
  runPairing,
  type PairingResult,
  type RunPairingOptions,
} from './pairing'
export {
  COMPUTER_USE_PROMPT_HINT,
  computerUseRequestTools,
  extractComputerBegin,
  type ComputerBeginCall,
} from './request-tools'
export {
  BrokerStatusPoller,
  type BrokerStatusPollerOptions,
  type BrokerStatusState,
} from './status-poller'
export { collectTurn, type CollectedTurn } from './turn-collector'
export * from './types'
export {
  useBrokerStatus,
  type UseBrokerStatusOptions,
} from './use-broker-status'
export {
  useComputerUseSession,
  type ComputerUseSessionDeps,
  type ComputerUseSessionState,
  type SessionPhase,
} from './use-computer-use-session'
