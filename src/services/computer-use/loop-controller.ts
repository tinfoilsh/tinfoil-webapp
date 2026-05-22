/**
 * Browser-mediated agentic loop for confidential computer-use.
 *
 * This is the piece the rest of the design hangs off (architecture →
 * "Integration — the action loop"). The model runs in the attested enclave; the
 * browser relays its emitted actions to the local broker over loopback and
 * feeds the resulting screenshots back as tool results, looping until the model
 * stops emitting actions. Tinfoil's backend never touches this loop — execution
 * is browser↔localhost↔guest; only screenshots leave the machine, inside the
 * already-attested inference request.
 *
 *   begin(manifest) → first screenshot
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ stream a turn → normalize emitted action(s) → POST /action  │
 *   │ → feed result/screenshot back → repeat                      │
 *   └────────────────────────────────────────────────────────────┘
 *   until: model emits no action (done) | request_handoff | max steps | abort
 *
 * It is a dedicated, isolated controller: it reuses the inference seam and the
 * broker client but owns its own multi-turn cycle, so the main chat pipeline is
 * untouched. It works directly in OpenAI chat-protocol message space (so it can
 * carry `tool` messages and image content the webapp `Message` type can't).
 *
 * The discrete frames it surfaces via `onEvent` double as the replayable audit
 * trail (architecture → "Visualizing the agent").
 */

import type { AccessTokenManager } from './access-token'
import { adapterForModel, type NormalizeContext } from './adapter'
import {
  dataUrl,
  type ChatMessage,
  type StreamChat,
  type ToolCall,
} from './chat-protocol'
import { imageSize } from './image-size'
import { collectTurn } from './turn-collector'
import {
  BrokerError,
  firstImagePart,
  perceptionText,
  type ActionResult,
  type BeginResponse,
  type BrokerAction,
  type CapabilityManifest,
  type HandoffResponse,
} from './types'

/**
 * The slice of the broker client the loop needs. Typed structurally so the loop
 * is decoupled from the concrete `BrokerClient` (and trivially fakeable). The
 * real client satisfies this.
 */
export interface BrokerLike {
  begin(
    manifest: CapabilityManifest,
    signal?: AbortSignal,
  ): Promise<BeginResponse>
  action(
    session: string,
    action: BrokerAction,
    signal?: AbortSignal,
  ): Promise<ActionResult>
  end(session: string, signal?: AbortSignal): Promise<void>
}

const DEFAULT_MAX_STEPS = 30

/** Why the loop stopped. */
export type LoopStopReason =
  | 'model_finished'
  | 'max_steps'
  | 'handoff'
  | 'aborted'
  | 'error'

/**
 * Events emitted as the loop runs — for the live view, the inline screenshot
 * frames (audit trail), and debugging. Purely observational; the loop runs to
 * completion regardless of whether anyone is listening.
 */
export type LoopEvent =
  | { type: 'begin'; session: string; screenshot: ActionResult }
  | {
      type: 'model_message'
      content: string
      reasoning: string
      toolCalls: ToolCall[]
    }
  | { type: 'action'; callId: string; action: BrokerAction }
  | {
      type: 'action_result'
      callId: string
      action: BrokerAction
      result: ActionResult
    }
  | {
      type: 'action_error'
      callId: string
      action: BrokerAction
      message: string
    }
  | { type: 'unsupported'; callId: string; reason: string }
  | { type: 'handoff'; response: HandoffResponse }
  | { type: 'stopped'; reason: LoopStopReason; finalText: string }

export interface RunComputerUseLoopParams {
  /** The user's task / instruction for the agent. */
  task: string
  /** Capability manifest for `computer_begin`. */
  manifest: CapabilityManifest
  /** Broker client (JWT-gated calls auto-attach the access token). */
  broker: BrokerLike
  /** Inference seam — streams a chat completion (wraps the attested client). */
  streamChat: StreamChat
  /** Model name, used to pick the presentation adapter. */
  modelName: string
  /** Override the default computer-use system prompt. */
  systemPrompt?: string
  /** Safety bound on model↔broker round-trips. Default 30. */
  maxSteps?: number
  /** Token manager, so a surprise 401 mid-loop can invalidate + re-mint once. */
  tokens?: AccessTokenManager
  signal?: AbortSignal
  onEvent?: (event: LoopEvent) => void
}

export interface LoopResult {
  session: string
  reason: LoopStopReason
  finalText: string
  steps: number
  /** Whether the session was torn down (`/end` called). False on handoff. */
  ended: boolean
}

/**
 * Run the computer-use loop to completion. Provisions a session, drives the
 * model↔broker action loop, and tears the session down — except on a handoff,
 * where the session is left alive so the user can take over and `resume`.
 */
export async function runComputerUseLoop(
  params: RunComputerUseLoopParams,
): Promise<LoopResult> {
  const {
    task,
    manifest,
    broker,
    streamChat,
    modelName,
    maxSteps = DEFAULT_MAX_STEPS,
    tokens,
    signal,
    onEvent,
  } = params

  const adapter = adapterForModel(modelName)
  // Default to the adapter's per-family system prompt; allow a caller override.
  const systemPrompt = params.systemPrompt ?? adapter.systemPrompt
  const tools = adapter.presentTools()
  const emit = (e: LoopEvent) => onEvent?.(e)

  // 1) Provision the session and get the first screen.
  const begin = await broker.begin(manifest, signal)
  const session = begin.session
  emit({ type: 'begin', session, screenshot: begin.screenshot })

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
    screenMessage('Initial screen:', begin.screenshot),
  ]

  // The pixel size of the latest screenshot the model has seen. Coordinates the
  // model emits are relative to this frame, so the normalizer uses it to rescue
  // any normalized [0,1] coordinates back into pixels.
  let screen: NormalizeContext | undefined = screenFrom(begin.screenshot)

  let stop: LoopStopReason = 'max_steps'
  let finalText = ''
  let steps = 0
  let leaveSessionOpen = false

  try {
    for (steps = 0; steps < maxSteps; steps++) {
      if (signal?.aborted) {
        stop = 'aborted'
        throw new DOMException('Aborted', 'AbortError')
      }

      const turn = await collectTurn(
        await streamChat({ messages, tools, signal }),
        signal,
      )
      emit({
        type: 'model_message',
        content: turn.content,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
      })
      messages.push(assistantMessage(turn.content, turn.toolCalls))

      if (turn.toolCalls.length === 0) {
        // No action requested — the model is talking to the user / finished.
        finalText = turn.content
        stop = 'model_finished'
        break
      }

      // Dispatch each emitted action in order, feeding results back.
      let handedOff = false
      for (const call of turn.toolCalls) {
        const norm = adapter.normalizeCall(call.function, screen)
        if (!norm.ok) {
          emit({ type: 'unsupported', callId: call.id, reason: norm.reason })
          messages.push(adapter.formatToolError(call, norm.reason))
          continue
        }
        const action = norm.action

        if (action.op === 'request_handoff') {
          const res = (await dispatch(
            broker,
            session,
            action,
            tokens,
            signal,
          )) as HandoffResponse
          emit({ type: 'handoff', response: res })
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              res.message ??
              'Control handed to the user. Paused until resumed.',
          })
          handedOff = true
          break
        }

        emit({ type: 'action', callId: call.id, action })
        try {
          const result = (await dispatch(
            broker,
            session,
            action,
            tokens,
            signal,
          )) as ActionResult
          emit({ type: 'action_result', callId: call.id, action, result })
          for (const m of adapter.formatToolResult(call, result))
            messages.push(m)
          // Track the newest frame so subsequent coordinates scale against it.
          screen = screenFrom(result) ?? screen
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError')
            throw err
          const message = err instanceof Error ? err.message : String(err)
          emit({ type: 'action_error', callId: call.id, action, message })
          // Feed the failure back so the model can adapt rather than killing the
          // session on a single bad action; max steps still bounds runaway.
          messages.push(adapter.formatToolError(call, message))
        }
      }

      if (handedOff) {
        // Resume is a user action — leave the session alive and stop the loop.
        stop = 'handoff'
        leaveSessionOpen = true
        break
      }
    }
  } finally {
    if (!leaveSessionOpen) {
      try {
        await broker.end(session)
      } catch {
        // Best-effort teardown; idle_timeout is the backstop.
      }
    }
  }

  emit({ type: 'stopped', reason: stop, finalText })
  return { session, reason: stop, finalText, steps, ended: !leaveSessionOpen }
}

/**
 * POST one action, transparently re-minting the access token once on a surprise
 * 401 (the cached token expired between the proactive-refresh skew check and the
 * request). A second 401 propagates — the refresh credential was revoked.
 */
async function dispatch(
  broker: BrokerLike,
  session: string,
  action: BrokerAction,
  tokens: AccessTokenManager | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await broker.action(session, action, signal)
  } catch (err) {
    if (err instanceof BrokerError && err.isAuthError && tokens) {
      tokens.invalidate()
      return await broker.action(session, action, signal)
    }
    throw err
  }
}

/** Derive the screenshot's pixel size from an action result, if it has an image. */
function screenFrom(result: ActionResult): NormalizeContext | undefined {
  const image = firstImagePart(result)
  if (!image) return undefined
  const size = imageSize(image.data)
  if (!size) return undefined
  return { screenWidth: size.width, screenHeight: size.height }
}

/** Build a user message presenting a screenshot (text summary + image). */
function screenMessage(label: string, result: ActionResult): ChatMessage {
  const image = firstImagePart(result)
  const text = perceptionText(result)
  if (!image) {
    return { role: 'user', content: `${label}\n${text}`.trim() }
  }
  const content: ChatMessage['content'] = [
    { type: 'text', text: text ? `${label}\n${text}` : label },
    {
      type: 'image_url',
      image_url: { url: dataUrl(image.data, image.mimeType) },
    },
  ]
  return { role: 'user', content }
}

function assistantMessage(content: string, toolCalls: ToolCall[]): ChatMessage {
  return {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}
