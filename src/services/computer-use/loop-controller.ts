/**
 * Browser-mediated agentic loop for confidential computer-use.
 *
 * This is the piece the rest of the design hangs off (architecture →
 * "Integration — the action loop"). The model runs in the attested enclave; the
 * browser relays its emitted actions to the local driver over loopback and
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
 * driver client but owns its own multi-turn cycle, so the main chat pipeline is
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
  DriverError,
  firstImagePart,
  isPerceptionResult,
  perceptionText,
  type ActionResult,
  type BeginResponse,
  type CapabilityManifest,
  type DriverAction,
  type HandoffResponse,
} from './types'

/**
 * Derives the **reduced** copy of a screenshot that is sent to the model (saving
 * inference tokens/context). Returns the reduced image's base64 + mime + pixel
 * dimensions. The full frame still goes to the chat/audit; only the model turn
 * gets this. Injected by the browser (canvas-based); absent in node/tests, where
 * the model gets the full frame unchanged.
 */
export type ImageReducer = (
  base64: string,
  mimeType: string,
) => Promise<{
  base64: string
  mimeType: string
  width: number
  height: number
}>

/**
 * Build the model-facing copy of an action result: same content, but the image
 * part swapped for the reduced JPEG. No-op when there's no reducer or no image.
 * Critically, the loop derives `screenFrom` from THIS (reduced) result, so the
 * coordinate normalizer scales clicks against the exact frame the model saw.
 */
async function reduceResultForModel(
  result: ActionResult,
  reduce: ImageReducer | undefined,
): Promise<ActionResult> {
  if (!reduce || !isPerceptionResult(result)) return result
  const img = firstImagePart(result)
  if (!img) return result
  const r = await reduce(img.data, img.mimeType)
  return {
    ...result,
    content: result.content.map((p) =>
      p.type === 'image'
        ? { type: 'image', data: r.base64, mimeType: r.mimeType }
        : p,
    ),
  }
}

/**
 * The slice of the driver client the loop needs. Typed structurally so the loop
 * is decoupled from the concrete `DriverClient` (and trivially fakeable). The
 * real client satisfies this.
 */
export interface DriverLike {
  begin(
    manifest: CapabilityManifest,
    signal?: AbortSignal,
  ): Promise<BeginResponse>
  action(
    session: string,
    action: DriverAction,
    signal?: AbortSignal,
  ): Promise<ActionResult>
  end(session: string, signal?: AbortSignal): Promise<void>
  /**
   * Live capability escalation — today only egress, supplied as the full
   * desired allowlist. Called after user consent.
   */
  escalate(
    session: string,
    egress: string[],
    signal?: AbortSignal,
  ): Promise<{ egress: string[] }>
}

/** Result of asking the user to approve a model-requested capability change. */
export type CapabilityApproval =
  | {
      /** User approved. May have edited the requested list. */
      approved: true
      egress: string[]
    }
  | {
      /** User denied. The loop continues but tells the model. */
      approved: false
      reason?: string
    }

/**
 * Surface a capability-escalation request from the model and await the user's
 * decision. Provided by the session orchestration hook; the loop pauses while
 * the promise is in flight. Omit to deny all escalation requests automatically.
 */
export type RequestCapabilityApproval = (req: {
  egress: string[]
}) => Promise<CapabilityApproval>

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
  | { type: 'action'; callId: string; action: DriverAction }
  | {
      type: 'action_result'
      callId: string
      action: DriverAction
      result: ActionResult
    }
  | {
      type: 'action_error'
      callId: string
      action: DriverAction
      message: string
    }
  | { type: 'unsupported'; callId: string; reason: string }
  | { type: 'handoff'; response: HandoffResponse }
  /** Model asked for additional capabilities; user consent is pending. */
  | { type: 'capability_request'; callId: string; egress: string[] }
  /** User resolved the capability request (approved or denied). */
  | {
      type: 'capability_result'
      callId: string
      approved: boolean
      /** Final egress allowlist applied to the session (approved only). */
      egress?: string[]
      reason?: string
    }
  | { type: 'stopped'; reason: LoopStopReason; finalText: string }

/**
 * Sliding-window policy that keeps the loop's model-facing context bounded as
 * the run extends across many screenshots. Image-bearing user messages outside
 * the window are replaced (in place) with a small text-only placeholder, so the
 * model still sees the turn happened but the bytes are released. The audit
 * trail (`onEvent`) keeps every full frame regardless.
 *
 * `first` is how many of the earliest screenshots to retain (typically 1, the
 * initial screen — useful for grounding). `recent` is how many of the most-
 * recent screenshots to retain (typically 2–3 — what the model is acting on
 * now). Set `false` to disable windowing entirely.
 */
export type ScreenshotWindow = { first: number; recent: number } | false

/** Default screenshot window: keep the initial screen + the last 2 frames. */
export const DEFAULT_SCREENSHOT_WINDOW: ScreenshotWindow = {
  first: 1,
  recent: 2,
}

export interface RunComputerUseLoopParams {
  /** The user's task / instruction for the agent. */
  task: string
  /** Capability manifest for `computer_begin`. */
  manifest: CapabilityManifest
  /** Driver client (JWT-gated calls auto-attach the access token). */
  driver: DriverLike
  /** Inference seam — streams a chat completion (wraps the attested client). */
  streamChat: StreamChat
  /** Model name, used to pick the presentation adapter. */
  modelName: string
  /** Override the default computer-use system prompt. */
  systemPrompt?: string
  /** Safety bound on model↔driver round-trips. Default 30. */
  maxSteps?: number
  /** Token manager, so a surprise 401 mid-loop can invalidate + re-mint once. */
  tokens?: AccessTokenManager
  /**
   * Reduce screenshots before they go to the model (chat/audit keep the full
   * frame). Omit to send the full frame to the model too.
   */
  reduceImage?: ImageReducer
  /**
   * Sliding-window policy for screenshots in the model-facing context. Default
   * keeps the initial screen + the last 2 frames; older screenshots are
   * replaced with a text placeholder so the loop's RAM footprint and the
   * per-turn token cost stay bounded. Pass `false` to disable.
   */
  screenshotWindow?: ScreenshotWindow
  signal?: AbortSignal
  onEvent?: (event: LoopEvent) => void
  /**
   * Pause the loop and ask the user to approve/deny a model-requested capability
   * change. The loop only honors this for egress (the only live-escalatable
   * axis). Omit to auto-deny every escalation request.
   */
  requestCapabilityApproval?: RequestCapabilityApproval
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
 * model↔driver action loop, and tears the session down — except on a handoff,
 * where the session is left alive so the user can take over and `resume`.
 */
export async function runComputerUseLoop(
  params: RunComputerUseLoopParams,
): Promise<LoopResult> {
  const {
    task,
    manifest,
    driver,
    streamChat,
    modelName,
    maxSteps = DEFAULT_MAX_STEPS,
    tokens,
    reduceImage,
    screenshotWindow = DEFAULT_SCREENSHOT_WINDOW,
    signal,
    onEvent,
    requestCapabilityApproval,
  } = params

  const adapter = adapterForModel(modelName)
  // Default to the adapter's per-family system prompt; allow a caller override.
  const systemPrompt = params.systemPrompt ?? adapter.systemPrompt
  const tools = adapter.presentTools()
  const emit = (e: LoopEvent) => onEvent?.(e)

  // 1) Provision the session and get the first screen.
  const begin = await driver.begin(manifest, signal)
  const session = begin.session
  // Full frame → chat/audit; reduced copy → model.
  emit({ type: 'begin', session, screenshot: begin.screenshot })
  const beginForModel = await reduceResultForModel(
    begin.screenshot,
    reduceImage,
  )

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
    screenMessage('Initial screen:', beginForModel),
  ]

  // The pixel size of the latest screenshot the model has seen. Coordinates the
  // model emits are relative to this frame, so the normalizer uses it to rescue
  // any normalized [0,1] coordinates back into pixels — derived from the REDUCED
  // frame, since that's what the model actually saw.
  let screen: NormalizeContext | undefined = screenFrom(beginForModel)

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
            driver,
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

        if (action.op === 'request_capability') {
          // Don't dispatch through /action — capability changes are a session-
          // level config swap, not a guest action. Ask the user for consent,
          // then call /escalate when approved.
          const requested = Array.isArray(action.payload?.egress)
            ? (action.payload.egress as unknown[]).filter(
                (d): d is string => typeof d === 'string' && d.length > 0,
              )
            : []
          emit({
            type: 'capability_request',
            callId: call.id,
            egress: requested,
          })
          const approval: CapabilityApproval = requestCapabilityApproval
            ? await requestCapabilityApproval({ egress: requested })
            : { approved: false, reason: 'no approver wired' }
          if (approval.approved) {
            try {
              const applied = await driver.escalate(
                session,
                approval.egress,
                signal,
              )
              emit({
                type: 'capability_result',
                callId: call.id,
                approved: true,
                egress: applied.egress,
              })
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: `Capability granted. Egress allowlist now: ${applied.egress.join(', ')}. Retry the action that needed it.`,
              })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              emit({
                type: 'capability_result',
                callId: call.id,
                approved: false,
                reason: `escalation failed: ${message}`,
              })
              messages.push(
                adapter.formatToolError(call, `escalation failed: ${message}`),
              )
            }
          } else {
            emit({
              type: 'capability_result',
              callId: call.id,
              approved: false,
              reason: approval.reason,
            })
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: `Capability request denied${approval.reason ? `: ${approval.reason}` : '.'} Try another approach — do not re-request the same capability.`,
            })
          }
          continue
        }

        emit({ type: 'action', callId: call.id, action })
        try {
          const result = (await dispatch(
            driver,
            session,
            action,
            tokens,
            signal,
          )) as ActionResult
          emit({ type: 'action_result', callId: call.id, action, result })
          // Full frame → chat/audit (emit above); reduced copy → model below.
          const resultForModel = await reduceResultForModel(result, reduceImage)
          for (const m of adapter.formatToolResult(call, resultForModel))
            messages.push(m)
          // Track the newest frame (as the model saw it) for coordinate scaling.
          screen = screenFrom(resultForModel) ?? screen
          // Slide the screenshot window forward: older image-bearing user
          // messages are replaced with a text placeholder in place, freeing
          // the base64 bytes and bounding per-turn token cost. No-op when
          // disabled or when we haven't accumulated past the window yet.
          if (screenshotWindow !== false) {
            applyScreenshotWindow(messages, screenshotWindow)
          }
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
        await driver.end(session)
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
  driver: DriverLike,
  session: string,
  action: DriverAction,
  tokens: AccessTokenManager | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await driver.action(session, action, signal)
  } catch (err) {
    if (err instanceof DriverError && err.isAuthError && tokens) {
      tokens.invalidate()
      return await driver.action(session, action, signal)
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

/**
 * Replace older image-bearing user messages with a text-only placeholder so the
 * model-facing context stays bounded across a long run. Mutates `messages` in
 * place — the audit trail (`onEvent`) keeps every full frame regardless.
 *
 * Identifies screenshots structurally (any `user` message whose `content` is an
 * array containing an `image_url` part); keeps the first `first` of them and
 * the last `recent`. Messages outside that union are rewritten to a short
 * string `user` message. Tool-result `tool` messages and assistant turns are
 * left untouched, so the action↔result pairing the model sees is preserved.
 *
 * Idempotent: re-running on the same array after appending more screenshots
 * narrows the kept set monotonically. No-op while the count is within the
 * window or when `first + recent` is zero.
 */
export function applyScreenshotWindow(
  messages: ChatMessage[],
  policy: { first: number; recent: number },
): void {
  const first = Math.max(0, policy.first | 0)
  const recent = Math.max(0, policy.recent | 0)
  if (first + recent === 0) return

  const imageIdxs: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isImageBearingUserMessage(messages[i])) imageIdxs.push(i)
  }
  if (imageIdxs.length <= first + recent) return

  const keep = new Set<number>([
    ...imageIdxs.slice(0, first),
    ...imageIdxs.slice(imageIdxs.length - recent),
  ])
  for (const i of imageIdxs) {
    if (keep.has(i)) continue
    // Replace with a text-only user message so structural turn ordering (and
    // the model's awareness that a screenshot was here) stays intact, but the
    // base64 bytes are released and the token cost drops to ~10 tokens.
    messages[i] = {
      role: 'user',
      content: '[earlier screenshot elided to save context]',
    }
  }
}

function isImageBearingUserMessage(m: ChatMessage): boolean {
  if (m.role !== 'user' || !Array.isArray(m.content)) return false
  for (const part of m.content) {
    if (part.type === 'image_url') return true
  }
  return false
}
