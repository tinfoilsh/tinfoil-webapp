/**
 * Confidential computer-use: browser-side half of the feature.
 *
 * The host driver (`tinfoil-driver`) is already built; this module is the
 * browser/Next layer that detects + pairs with it, presents the curated tool
 * surface to the model, and drives the browser-mediated action loop. See
 * `~/dev/tinfoil/architecture.md` for the authoritative design.
 */

export { AccessTokenManager, createDriverConnection } from './access-token'
export type { DriverConnection } from './access-token'
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
  computerUseAvailability,
  connectionIndicator,
  driverReadiness,
  readyImageNames,
  readyImages,
  type ComputerUseAvailability,
  type ConnectionIndicator,
  type DriverReadiness,
} from './availability'
export * from './chat-protocol'
export {
  forgetPairing,
  getStoredConnection,
  pairAndConnect,
  type ConnectionOptions,
} from './connection'
export {
  PAIR_CHANGE_EVENT,
  clearRefreshCredential,
  getRefreshCredential,
  isPaired,
  setRefreshCredential,
} from './credential-store'
export {
  DEFAULT_DRIVER_ORIGIN,
  DriverClient,
  type DriverClientOptions,
} from './driver-client'
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
  DEFAULT_SCREENSHOT_WINDOW,
  applyScreenshotWindow,
  runComputerUseLoop,
  type DriverLike,
  type ImageReducer,
  type LoopEvent,
  type LoopResult,
  type LoopStopReason,
  type RunComputerUseLoopParams,
  type ScreenshotWindow,
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
  DriverStatusPoller,
  type DriverStatusPollerOptions,
  type DriverStatusState,
} from './status-poller'
export { collectTurn, type CollectedTurn } from './turn-collector'
export * from './types'
export {
  useComputerUseSession,
  type ComputerUseSessionDeps,
  type ComputerUseSessionState,
  type SessionPhase,
} from './use-computer-use-session'
export {
  markComputerUseDiscovered,
  useComputerUseDiscovered,
} from './use-discovered'
export {
  useDriverStatus,
  type UseDriverStatusOptions,
} from './use-driver-status'
export { usePaired } from './use-paired'
