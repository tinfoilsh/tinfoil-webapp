/**
 * Test fixtures for the computer-use loop: an in-memory fake driver and a
 * scripted inference seam. These let us exercise the full multi-turn
 * screenshot→action cycle deterministically, without the network, a booted VM,
 * or the enclave.
 */

import type {
  ChatChunk,
  StreamChat,
  StreamChatParams,
  ToolCall,
} from '@/services/computer-use/chat-protocol'
import type { DriverLike } from '@/services/computer-use/loop-controller'
import type {
  ActionResult,
  BeginResponse,
  CapabilityManifest,
  DriverAction,
  HandoffResponse,
  PerceptionResult,
} from '@/services/computer-use/types'

/** A 1x1 transparent PNG, base64 — enough to stand in for a screenshot. */
export const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export function screenshotResult(text = 'window: Safari'): PerceptionResult {
  return {
    content: [
      { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
      { type: 'text', text },
    ],
  }
}

export interface FakeDriverCall {
  session: string
  action: DriverAction
}

/**
 * In-memory driver satisfying {@link DriverLike}. Records every action and
 * returns a canned screenshot (or a per-op override). `request_handoff` returns
 * a {@link HandoffResponse}, mirroring the real driver's special-casing.
 */
export class FakeDriver implements DriverLike {
  readonly calls: FakeDriverCall[] = []
  readonly escalateCalls: Array<{ session: string; egress: string[] }> = []
  beginCount = 0
  endedSessions: string[] = []
  escalateError?: Error

  constructor(
    private readonly opts: {
      sessionId?: string
      firstScreenshot?: ActionResult
      /** Map an op to a fixed result; default is a fresh screenshot. */
      onAction?: (action: DriverAction) => ActionResult | HandoffResponse
    } = {},
  ) {}

  async begin(_manifest: CapabilityManifest): Promise<BeginResponse> {
    this.beginCount++
    return {
      session: this.opts.sessionId ?? 'sess_test',
      screenshot: this.opts.firstScreenshot ?? screenshotResult('initial'),
    }
  }

  async action(session: string, action: DriverAction): Promise<ActionResult> {
    this.calls.push({ session, action })
    if (action.op === 'request_handoff') {
      const res: HandoffResponse = {
        handoff: 'user_active',
        driveable: true,
        message: 'You now have control. Log in, then Resume.',
      }
      // The loop casts this branch's result to HandoffResponse.
      return res as unknown as ActionResult
    }
    const override = this.opts.onAction?.(action)
    if (override) return override as ActionResult
    return screenshotResult(`after ${action.op}`)
  }

  async end(session: string): Promise<void> {
    this.endedSessions.push(session)
  }

  async escalate(
    session: string,
    egress: string[],
  ): Promise<{ egress: string[] }> {
    if (this.escalateError) throw this.escalateError
    this.escalateCalls.push({ session, egress })
    return { egress }
  }
}

/** Build one streaming chunk carrying assistant text content. */
export function contentChunk(text: string): ChatChunk {
  return { choices: [{ delta: { content: text } }] }
}

/**
 * Build streaming chunks for a single tool call, split across deltas the way
 * real servings stream them (id+name first, arguments in pieces).
 */
export function toolCallChunks(
  call: { id: string; name: string; arguments: string },
  index = 0,
): ChatChunk[] {
  const chunks: ChatChunk[] = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: '' },
              },
            ],
          },
        },
      ],
    },
  ]
  // Stream the arguments in two pieces to exercise accumulation.
  const mid = Math.floor(call.arguments.length / 2)
  for (const piece of [
    call.arguments.slice(0, mid),
    call.arguments.slice(mid),
  ]) {
    chunks.push({
      choices: [
        { delta: { tool_calls: [{ index, function: { arguments: piece } }] } },
      ],
    })
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  return chunks
}

/** A scripted turn: either plain content or a list of tool calls. */
export type ScriptedTurn =
  | { content: string }
  | { toolCalls: Array<{ name: string; arguments: string }> }

/**
 * A {@link StreamChat} that replays scripted turns in order — one turn per
 * `streamChat` invocation. Records the messages it was called with so tests can
 * assert how results were fed back.
 */
export function scriptedStreamChat(turns: ScriptedTurn[]): {
  streamChat: StreamChat
  invocations: StreamChatParams[]
} {
  let turn = 0
  const invocations: StreamChatParams[] = []

  const streamChat: StreamChat = (params) => {
    invocations.push(params)
    const script = turns[turn] ?? { content: '' }
    turn++

    const chunks: ChatChunk[] = []
    if ('content' in script) {
      chunks.push(contentChunk(script.content))
      chunks.push({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    } else {
      script.toolCalls.forEach((tc, i) => {
        chunks.push(
          ...toolCallChunks(
            { id: `call_${turn}_${i}`, name: tc.name, arguments: tc.arguments },
            i,
          ),
        )
      })
    }

    async function* gen(): AsyncGenerator<ChatChunk> {
      for (const c of chunks) yield c
    }
    return gen()
  }

  return { streamChat, invocations }
}

/** Pull the tool calls out of an assistant message (for assertions). */
export function assistantToolCalls(
  invocations: StreamChatParams[],
  invocationIndex: number,
): ToolCall[] {
  const messages = invocations[invocationIndex]?.messages ?? []
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant')
  return assistant?.tool_calls ?? []
}
