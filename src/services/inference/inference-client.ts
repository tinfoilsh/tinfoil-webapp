import { ChatError } from '@/components/chat/chat-utils'
import { CONSTANTS } from '@/components/chat/constants'
import { buildGenUIToolSchemas } from '@/components/chat/genui/registry'
import {
  isReasoningModel,
  supportsReasoningEffort,
  supportsThinkingToggle,
  type ReasoningEffort,
} from '@/components/chat/hooks/use-reasoning-effort'
import type { Message } from '@/components/chat/types'
import {
  AUTO_MODEL_ID,
  AUTO_MODEL_OPTIONS_FIELD,
  DEFAULT_AUTO_INTELLIGENCE_LEVEL,
  getAutoIntelligenceLevel,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@/config/models'
import { shouldRetryTestFail } from '@/utils/dev-simulator'
import { logError, logInfo } from '@/utils/error-handling'
import {
  PERFORMANCE_METRICS,
  recordPerformanceDuration,
  startPerformanceTimer,
} from '@/utils/performance-metrics'
import {
  APIConnectionError,
  APIUserAbortError,
  AuthenticationError,
} from 'openai'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'
import type { SessionRecoveryToken } from 'tinfoil'
import { ChatQueryBuilder } from './chat-query-builder'
import { chatChunkStreamFromSSE, type ChatChunkStream } from './chat-stream'
import {
  acquireRecoverableTinfoilTransport,
  createRecoverableTinfoilClient,
  discardRateLimitSnapshot,
  getRateLimitInfo,
  getTinfoilClient,
  refreshRateLimit,
  resetTinfoilClient,
  type RecoverableTinfoilTransportLease,
} from './tinfoil-client'

const CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions'

const EFFORT_PLACEHOLDER = '$EFFORT'
const RESERVED_MODEL_BODY_PARAMS = new Set([
  'model',
  'messages',
  'stream',
  'signal',
  'reasoning_effort',
  'web_search_options',
  'code_execution_options',
  'pii_check_options',
  'tools',
  'tool_choice',
  'response_format',
])

/**
 * Recursively clones an object, replacing any string equal to "$EFFORT" with
 * the provided effort value. Used to splice the user-selected reasoning effort
 * into the model's declarative `reasoningConfig.params[endpoint].enable` block
 * without the inference layer needing to know which key the model expects it
 * under (top-level `reasoning_effort`, nested `chat_template_kwargs`, etc.).
 */
function substituteEffort(value: unknown, effort: string): unknown {
  if (typeof value === 'string') {
    return value === EFFORT_PLACEHOLDER ? effort : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteEffort(v, effort))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEffort(v, effort)
    }
    return out
  }
  return value
}

/**
 * Builds the model-specific request-body delta for a single model: the
 * reasoning enable/disable block (with the user's effort spliced in) plus the
 * model's own `requestParams`. Shared, model-independent options (web search,
 * code execution, PII check, GenUI tools) are added to the base body by the
 * caller and are intentionally excluded here so this delta can also be sent
 * per-candidate in the Auto `auto_model_options` blob.
 */
function buildModelBodyParams(
  model: BaseModel,
  opts: { thinkingEnabled?: boolean; reasoningEffort?: ReasoningEffort },
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  if (isReasoningModel(model)) {
    const reasoningConfig = model.chatConfig?.reasoningConfig
    const endpointParams = reasoningConfig?.params?.[CHAT_COMPLETIONS_ENDPOINT]
    if (endpointParams) {
      const rawBlock = supportsThinkingToggle(model)
        ? opts.thinkingEnabled
          ? endpointParams.enable
          : endpointParams.disable
        : endpointParams.enable
      if (rawBlock) {
        const uiEffort =
          supportsReasoningEffort(model) && opts.reasoningEffort
            ? opts.reasoningEffort
            : 'medium'
        const effort = reasoningConfig?.effortMap?.[uiEffort] ?? uiEffort
        const block = substituteEffort(rawBlock, effort) as Record<
          string,
          unknown
        >
        for (const [key, value] of Object.entries(block)) {
          if (
            key === 'reasoning_effort' ||
            !RESERVED_MODEL_BODY_PARAMS.has(key)
          ) {
            out[key] = value
          }
        }
      }
    }
  }

  // Apply model-specific params, but never let them overwrite our explicit
  // or security-sensitive fields.
  if (model.requestParams) {
    for (const [key, value] of Object.entries(model.requestParams)) {
      if (!RESERVED_MODEL_BODY_PARAMS.has(key)) {
        out[key] = value
      }
    }
  }

  return out
}

function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Statuses the OpenAI SDK itself treats as retryable (client shouldRetry):
// request timeout, lock timeout, and rate limit. 5xx is handled as a range.
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429])
const RECOVERY_SESSION_ID_BYTES = 16

export function generateRecoverySessionId(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(RECOVERY_SESSION_ID_BYTES),
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export interface ChatRecoveryCallbacks {
  onAttemptStarted: (sessionId: string) => void
  onTokenCaptured: (
    sessionId: string,
    token: SessionRecoveryToken,
  ) => Promise<void>
  onAttemptAbandoned: (sessionId: string) => Promise<void>
}

function getHttpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * A 429 can mean transient per-request throttling (worth retrying) or an
 * exhausted usage quota (which cannot succeed until the window resets).
 * Distinguishes the two by refreshing the quota from the server: returns a
 * terminal ChatError when the quota is exhausted, or null when the 429 looks
 * transient and the caller may retry.
 */
async function classifyQuotaExhausted429(
  error: unknown,
): Promise<ChatError | null> {
  // The 429 means the server rejected the request without consuming quota,
  // so its refreshed count is authoritative. Drop the optimistic-decrement
  // snapshot first: reconciling against it would force `remaining` to 0 for
  // a user whose last request was merely throttled, misclassifying a
  // transient 429 as exhaustion.
  discardRateLimitSnapshot()
  await refreshRateLimit()
  const limit = getRateLimitInfo()
  if (!limit || limit.remaining > 0) {
    return null
  }
  const message =
    (error as { message?: string })?.message ?? 'Rate limit reached'
  return new ChatError(
    message,
    limit.kind === 'hourly' ? 'HOURLY_LIMIT' : 'RATE_LIMIT',
    { status: 429 },
  )
}

// Typed classification only — never inspect error message strings, which
// vary across browsers, SDK versions, and locales.
export function isRetryableError(error: unknown): boolean {
  // Don't retry user-initiated aborts. APIUserAbortError is the SDK wrapper
  // for our AbortSignal; "AbortError" is the spec-defined DOMException name
  // for the same condition on raw fetch paths.
  if (error instanceof APIUserAbortError) {
    return false
  }
  if ((error as { name?: unknown })?.name === 'AbortError') {
    return false
  }

  // ChatErrors are terminal classifications produced by our own layers
  // (e.g. the hourly usage cap); retrying them cannot succeed.
  if (error instanceof ChatError) {
    return false
  }

  // Transport failures raised by the SDK, including its request timeout
  // (APIConnectionTimeoutError extends APIConnectionError).
  if (error instanceof APIConnectionError) {
    return true
  }

  // fetch() signals a network failure by rejecting with a TypeError.
  if (error instanceof TypeError) {
    return true
  }

  // Retry 5xx server errors, timeouts, and rate limits by HTTP status
  const status = (error as { status?: unknown })?.status
  if (typeof status === 'number') {
    return status >= 500 || RETRYABLE_HTTP_STATUSES.has(status)
  }

  // Default to not retrying - only explicitly identified conditions should trigger retries
  // This prevents unnecessary retries for client errors (4xx) which won't succeed on retry
  return false
}

/**
 * Hands model selection to the router: `model` becomes the "auto" sentinel and
 * the requested intelligence level rides in the router-only options blob. The
 * router picks a concrete model and reasoning effort and injects that model's
 * own reasoning params, so no per-model params are sent from here.
 */
function applyAutoRouting(
  requestBody: Record<string, unknown>,
  autoIntelligence: AutoIntelligenceLevelId = DEFAULT_AUTO_INTELLIGENCE_LEVEL,
): void {
  requestBody.model = AUTO_MODEL_ID
  requestBody[AUTO_MODEL_OPTIONS_FIELD] = {
    intelligence: getAutoIntelligenceLevel(autoIntelligence).value,
  }
}

export interface SendChatStreamParams {
  model: BaseModel
  /**
   * Models the router may pick from. When provided (Auto is selected), the
   * request `model` is set to the router's "auto" sentinel and the requested
   * intelligence level travels in the `auto_model_options` blob. `model` is
   * the representative (first) candidate, used to build the shared message
   * body; the router applies the chosen model's reasoning params itself.
   */
  autoCandidates?: BaseModel[]
  /** Slider position sent with Auto requests. */
  autoIntelligence?: AutoIntelligenceLevelId
  systemPrompt: string
  rules?: string
  onRetry?: (attempt: number, maxRetries: number, error?: string) => void
  updatedMessages: Message[]
  signal: AbortSignal
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  webSearchEnabled?: boolean
  codeExecutionEnabled?: boolean
  piiCheckEnabled?: boolean
  /**
   * Include GenUI tool definitions in the request so the model can emit
   * render_* tool calls. Internal utilities (title gen, memory extraction,
   * etc.) should pass `false` to avoid steering those paths toward tools.
   */
  genUIEnabled?: boolean
  // The three below are required when codeExecutionEnabled.
  /** Per-chat secret; buckets lookup key + code-exec session id. */
  codeExecutionAccessToken?: string
  /** AES-256 key (base64url) for buckets envelope encryption. */
  codeExecutionEncryptionKey?: string
  /** Per-chat hex token authenticating the code-exec container. */
  codeExecutionContainerAuthToken?: string
  recovery?: ChatRecoveryCallbacks
  /**
   * Request-only user instruction appended after the history, used to ask
   * the model to resume the trailing assistant message. Not persisted.
   */
  trailingInstruction?: string
}

export async function sendChatStream(
  params: SendChatStreamParams,
): Promise<ChatChunkStream> {
  const {
    model,
    autoCandidates,
    autoIntelligence,
    systemPrompt,
    rules,
    onRetry,
    updatedMessages,
    signal,
    reasoningEffort,
    thinkingEnabled,
    webSearchEnabled,
    codeExecutionEnabled,
    piiCheckEnabled,
    genUIEnabled,
    codeExecutionAccessToken,
    codeExecutionEncryptionKey,
    codeExecutionContainerAuthToken,
    recovery,
    trailingInstruction,
  } = params

  const genUITools = genUIEnabled ? buildGenUIToolSchemas() : []

  if (model.modelName === 'dev-simulator') {
    const simulatorUrl = '/api/dev/simulator'
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt,
      rules,
      messages: updatedMessages,
      autoCandidates,
      includeGenUIHint: genUIEnabled,
      includeTimeReminder: true,
      trailingInstruction,
    })

    // Get the last user message for retry test check
    const lastUserMessage = updatedMessages
      .filter((m) => m.role === 'user')
      .pop()
    const queryText = lastUserMessage?.content || ''

    let lastError: unknown = null
    const maxRetries = CONSTANTS.MESSAGE_SEND_MAX_RETRIES

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      try {
        // Check if this is a retry test that should fail. A TypeError is
        // what fetch() rejects with on a real network failure, so the
        // simulation exercises the same retry classification as production.
        if (shouldRetryTestFail(queryText)) {
          throw new TypeError('Simulated network error for retry testing')
        }

        const response = await fetch(simulatorUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model.modelName,
            messages,
            stream: true,
          }),
          signal,
        })

        if (!response.ok) {
          if (response.status === 404) {
            throw new ChatError(
              'Dev simulator is only available in development environment',
              'FETCH_ERROR',
            )
          }
          throw new ChatError(
            `Server returned ${response.status}: ${response.statusText}`,
            'FETCH_ERROR',
          )
        }

        return chatChunkStreamFromSSE(response)
      } catch (err: unknown) {
        lastError = err
        const anyErr = err as any

        if (
          (typeof DOMException !== 'undefined' &&
            anyErr instanceof DOMException &&
            anyErr.name === 'AbortError') ||
          anyErr?.name === 'AbortError'
        ) {
          throw err
        }

        if (attempt < maxRetries && isRetryableError(err)) {
          const backoffDelay =
            CONSTANTS.MESSAGE_SEND_RETRY_DELAY_MS * Math.pow(2, attempt)

          logInfo('Retrying dev simulator request', {
            component: 'inference-client',
            action: 'sendChatStream.devSimulator',
            metadata: {
              attempt: attempt + 1,
              maxRetries,
              delayMs: backoffDelay,
              error: anyErr?.message,
            },
          })

          onRetry?.(attempt + 1, maxRetries, anyErr?.message)

          await delay(backoffDelay)
          continue
        }

        if (err instanceof ChatError) {
          throw err
        }

        const msg = anyErr?.message || 'Unknown network error'
        throw new ChatError(`Network request failed: ${msg}`, 'FETCH_ERROR')
      }
    }

    // Fallback if loop completes without returning
    const anyErr = lastError as any
    const msg = anyErr?.message || 'Unknown network error'
    throw new ChatError(
      `Network request failed after ${maxRetries} retries: ${msg}`,
      'FETCH_ERROR',
    )
  }

  const messages = ChatQueryBuilder.buildMessages({
    model,
    systemPrompt,
    rules,
    messages: updatedMessages,
    autoCandidates,
    includeGenUIHint: genUIEnabled,
    includeTimeReminder: true,
    trailingInstruction,
  })

  let lastError: unknown = null
  const maxRetries = CONSTANTS.MESSAGE_SEND_MAX_RETRIES
  let recoverableTransportLease: RecoverableTinfoilTransportLease | null = null

  const releaseRecoverableTransport = () => {
    recoverableTransportLease?.release()
    recoverableTransportLease = null
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let recoverySessionId: string | null = null
    if (signal.aborted) {
      releaseRecoverableTransport()
      throw new DOMException('Aborted', 'AbortError')
    }

    // Wait for connection if offline (except for first attempt)
    if (attempt > 0 && !isOnline()) {
      logInfo('Waiting for internet connection before retry', {
        component: 'inference-client',
        action: 'sendChatStream',
        metadata: { attempt, maxRetries },
      })
      // Wait up to 10 seconds for connection to return
      const connectionWaitStart = Date.now()
      while (!isOnline() && Date.now() - connectionWaitStart < 10000) {
        if (signal.aborted) {
          releaseRecoverableTransport()
          throw new DOMException('Aborted', 'AbortError')
        }
        await delay(500)
      }
    }

    try {
      const requestBody: Record<string, unknown> = {
        model: model.modelName,
        messages,
        stream: true,
        // The router only forwards usage chunks when the client asks for
        // them; the sidebar usage indicator consumes them mid-stream.
        stream_options: { include_usage: true },
      }
      if (webSearchEnabled) {
        requestBody.web_search_options = {}
      }
      if (codeExecutionEnabled) {
        if (
          !codeExecutionAccessToken ||
          !codeExecutionEncryptionKey ||
          !codeExecutionContainerAuthToken
        ) {
          throw new ChatError(
            'Code execution requested without an accessToken, encryption key, or container auth token',
            'FETCH_ERROR',
          )
        }
        requestBody.code_execution_options = {
          accessToken: codeExecutionAccessToken,
          encryptionKey: codeExecutionEncryptionKey,
          containerAuthToken: codeExecutionContainerAuthToken,
        }
      }
      if (piiCheckEnabled) {
        requestBody.pii_check_options = {}
      }
      if (genUITools.length > 0) {
        requestBody.tools = genUITools
        requestBody.tool_choice = 'auto'
      }

      if (autoCandidates && autoCandidates.length > 0) {
        applyAutoRouting(requestBody, autoIntelligence)
      } else {
        // Single model: merge its params straight into the body.
        const params = buildModelBodyParams(model, {
          thinkingEnabled,
          reasoningEffort,
        })
        for (const [key, value] of Object.entries(params)) {
          requestBody[key] = value
        }
      }

      const streamStartedAt = startPerformanceTimer()
      let client
      let waitForTokenCapture: (() => Promise<void>) | undefined
      let recoverySessionCleanup: (() => Promise<void>) | undefined
      if (recovery) {
        if (!recoverableTransportLease) {
          recoverableTransportLease = await acquireRecoverableTinfoilTransport()
        }
        const recoverableTransport = recoverableTransportLease.transport
        recoverySessionId = generateRecoverySessionId()
        recovery.onAttemptStarted(recoverySessionId)
        const recoverable = await createRecoverableTinfoilClient(
          recoverableTransport,
          recoverySessionId,
          (token) =>
            recovery.onTokenCaptured(recoverySessionId as string, token),
        )
        client = recoverable.client
        waitForTokenCapture = recoverable.waitForTokenCapture
        let cleanupPromise: Promise<void> | null = null
        recoverySessionCleanup = () => {
          cleanupPromise ??= recovery.onAttemptAbandoned(
            recoverySessionId as string,
          )
          return cleanupPromise
        }
      } else {
        client = await getTinfoilClient()
      }

      // This loop owns retry policy with typed error classification; the
      // SDK's internal retries would stack under it and delay terminal
      // errors such as quota-exhausted 429s.
      const stream = await (client.chat.completions.create as Function)(
        requestBody,
        { signal, maxRetries: 0 },
      )
      recordPerformanceDuration(
        PERFORMANCE_METRICS.INFERENCE_STREAM_READY,
        streamStartedAt,
      )
      if (!waitForTokenCapture || !recoverySessionCleanup) {
        releaseRecoverableTransport()
        return stream as ChatChunkStream
      }
      const abandonRecovery = recoverySessionCleanup
      const recoveryReady = waitForTokenCapture().catch(async (error) => {
        try {
          await abandonRecovery()
        } catch (cleanupError) {
          logError(
            'Failed to clean up recovery after token capture error',
            cleanupError,
            {
              component: 'inference-client',
              action: 'sendChatStream.recoveryTokenCleanup',
              metadata: { sessionId: recoverySessionId },
            },
          )
        }
        throw error
      })
      void recoveryReady.catch(() => undefined)
      return {
        recoveryReady,
        abandonRecovery: async () => {
          try {
            await abandonRecovery()
          } finally {
            releaseRecoverableTransport()
          }
        },
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of stream as ChatChunkStream) {
              yield chunk
            }
          } finally {
            releaseRecoverableTransport()
          }
        },
      }
    } catch (err: unknown) {
      if (recoverySessionId && recovery) {
        try {
          await recovery.onAttemptAbandoned(recoverySessionId)
        } catch (cleanupError) {
          logError('Failed to abandon chat recovery attempt', cleanupError, {
            component: 'inference-client',
            action: 'sendChatStream.recoveryCleanup',
            metadata: { sessionId: recoverySessionId },
          })
        }
      }
      lastError = err
      const anyErr = err as any

      // Don't retry aborted requests
      if (
        (typeof DOMException !== 'undefined' &&
          anyErr instanceof DOMException &&
          anyErr.name === 'AbortError') ||
        anyErr?.name === 'AbortError'
      ) {
        releaseRecoverableTransport()
        throw err
      }

      const refreshAuthentication =
        recovery && err instanceof AuthenticationError
      if (refreshAuthentication) {
        resetTinfoilClient()
      }

      // A 429 caused by an exhausted quota cannot succeed on retry; surface
      // it immediately so the paywall/limit UI shows instead of a retry loop.
      if (getHttpStatus(err) === 429) {
        const quotaError = await classifyQuotaExhausted429(err)
        if (quotaError) {
          releaseRecoverableTransport()
          throw quotaError
        }
      }

      if (
        attempt < maxRetries &&
        (refreshAuthentication || isRetryableError(err))
      ) {
        const backoffDelay =
          CONSTANTS.MESSAGE_SEND_RETRY_DELAY_MS * Math.pow(2, attempt)

        logInfo('Retrying chat stream request', {
          component: 'inference-client',
          action: 'sendChatStream',
          metadata: {
            attempt: attempt + 1,
            maxRetries,
            delayMs: backoffDelay,
            error: anyErr?.message,
          },
        })

        onRetry?.(attempt + 1, maxRetries)

        await delay(backoffDelay)
        continue
      }

      logError('Chat stream request failed after retries', err, {
        component: 'inference-client',
        action: 'sendChatStream',
        metadata: {
          model: model.modelName,
          attempts: attempt + 1,
          error: anyErr?.message,
          stack: anyErr?.stack,
        },
      })

      releaseRecoverableTransport()
      throw toTerminalChatError(err)
    }
  }

  // Fallback: every branch above should already have thrown, but if the
  // retry loop exits without doing so we still need to surface an error.
  releaseRecoverableTransport()
  throw toTerminalChatError(lastError, maxRetries)
}

/**
 * Wraps a failed request's error into a typed ChatError, preserving any
 * classification already attached (our own ChatErrors pass through, HTTP
 * 429 maps to RATE_LIMIT). FETCH_ERROR is reserved for failures with no
 * HTTP response at all — a request that reached the server and got an
 * error status is a SERVER_ERROR, and telling the user to check their
 * internet for a 500 would be misleading.
 */
function toTerminalChatError(err: unknown, retries?: number): ChatError {
  if (err instanceof ChatError) {
    return err
  }
  const anyErr = err as { message?: string; status?: unknown }
  const msg = anyErr?.message || 'Unknown network error'
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined
  if (status === 429) {
    return new ChatError(msg, 'RATE_LIMIT', { status })
  }
  if (status !== undefined) {
    return new ChatError(msg, 'SERVER_ERROR', { status })
  }
  const suffix = retries !== undefined ? ` after ${retries} retries` : ''
  return new ChatError(`Network request failed${suffix}: ${msg}`, 'FETCH_ERROR')
}

export interface StructuredCompletionParams {
  model: BaseModel
  autoCandidates?: BaseModel[]
  autoIntelligence?: AutoIntelligenceLevelId
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  jsonSchema: Record<string, unknown>
  signal?: AbortSignal
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
}

export type StructuredCompletionErrorCode =
  | 'request_failed'
  | 'incomplete_response'
  | 'refused_response'
  | 'empty_response'
  | 'invalid_json_response'

export class StructuredCompletionError extends Error {
  readonly code: StructuredCompletionErrorCode
  readonly status?: number
  readonly requestCode?: string
  readonly finishReason?: string

  constructor(
    code: StructuredCompletionErrorCode,
    options: {
      cause?: unknown
      status?: number
      requestCode?: string
      finishReason?: string
    } = {},
  ) {
    super(code, { cause: options.cause })
    this.name = 'StructuredCompletionError'
    this.code = code
    this.status = options.status
    this.requestCode = options.requestCode
    this.finishReason = options.finishReason
  }
}

export async function sendStructuredCompletion<T>(
  params: StructuredCompletionParams,
): Promise<T> {
  const {
    model,
    autoCandidates,
    autoIntelligence,
    messages,
    jsonSchema,
    signal,
    reasoningEffort,
    thinkingEnabled,
  } = params
  const requestBody: ChatCompletionCreateParamsNonStreaming &
    Record<string, unknown> = {
    model: model.modelName,
    messages,
    stream: false,
  }
  if (autoCandidates && autoCandidates.length > 0) {
    applyAutoRouting(requestBody, autoIntelligence)
  } else {
    Object.assign(
      requestBody,
      buildModelBodyParams(model, { thinkingEnabled, reasoningEffort }),
    )
  }
  requestBody.response_format = {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      schema: jsonSchema,
    },
  }

  let response
  try {
    const client = await getTinfoilClient()
    response = await client.chat.completions.create(requestBody, { signal })
  } catch (error) {
    if (
      error instanceof APIUserAbortError ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError')
    ) {
      throw error
    }
    const requestCode = (error as { code?: unknown })?.code
    throw new StructuredCompletionError('request_failed', {
      cause: error,
      status: getHttpStatus(error),
      requestCode: typeof requestCode === 'string' ? requestCode : undefined,
    })
  }

  const choice = response.choices[0]
  const finishReason =
    typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
  if (choice?.message?.refusal) {
    throw new StructuredCompletionError('refused_response', { finishReason })
  }
  if (finishReason && finishReason !== 'stop') {
    throw new StructuredCompletionError('incomplete_response', { finishReason })
  }
  const content = choice?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new StructuredCompletionError('empty_response', { finishReason })
  }

  try {
    return JSON.parse(content) as T
  } catch (error) {
    throw new StructuredCompletionError('invalid_json_response', {
      cause: error,
      finishReason,
    })
  }
}
