/**
 * Model-initiated computer-use: expose `computer_begin` to the model in the
 * normal chat request, and detect when it calls it.
 *
 * The model decides whether to drive the computer (the toggle just makes the
 * tool available). `computer_begin` is NOT auto-continued, so the model stops
 * after emitting it; the webapp inspects the finished assistant message, and on
 * a `computer_begin` call hands off to the consent + agentic-loop session. The
 * normal streaming pipeline is untouched — this is a post-stream check.
 */

import { computerUseAvailability } from './availability'
import { BrokerClient, type BrokerClientOptions } from './broker-client'
import type { ToolSchema } from './chat-protocol'
import { buildComputerBeginSchema } from './manifest-schema'
import type { ModelLike } from './model-support'
import type { CapabilityManifest } from './types'

/**
 * System-prompt nudge so the model knows the `computer_begin` tool is available
 * and when to reach for it. Added only when computer-use tools are in the request
 * (mirrors the GenUI prompt-hint mechanism).
 */
export const COMPUTER_USE_PROMPT_HINT = [
  'You can operate a real, isolated sandboxed computer when a task needs it.',
  'If the user asks you to *do* something on a computer — browse the web, fill a',
  'form, use a desktop or GUI app, run software, or work with files inside apps —',
  'call the `computer_begin` tool once to start a sandboxed session.',
  'Request a least-privilege manifest: the chosen image, plus only the mounts and',
  'network egress the task genuinely needs (default to none).',
  'AFTER `computer_begin` returns and the user approves, you will be presented',
  'with a `computer` action tool (click, type, screenshot, scroll, keypress, etc.)',
  'in a follow-on interactive session — that is the tool you actually drive the',
  'desktop with. The `computer` tool is not visible to you before that point;',
  'do not try to script the work via the `computer_begin` entrypoint or assume',
  '`computer` is missing — just call `computer_begin` and drive interactively',
  'when the session opens. Do NOT call `computer_begin` for questions you can',
  'answer directly in text.',
].join(' ')

/**
 * Build the computer-use tool(s) to add to the chat request, or `[]` if
 * unavailable (broker absent/unreachable, no ready image, or non-vision model).
 * Probes `/status` once at send time to populate the `session.image` enum.
 * Never throws — a broker problem just means no tools are offered.
 */
export async function computerUseRequestTools(args: {
  model: ModelLike
  baseUrl?: string
  fetchImpl?: BrokerClientOptions['fetchImpl']
  signal?: AbortSignal
}): Promise<ToolSchema[]> {
  try {
    const client = new BrokerClient({
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
    })
    const status = await client.getStatus(args.signal)
    const avail = computerUseAvailability({ status, model: args.model })
    if (!avail.exposeTools) return []
    return [buildComputerBeginSchema(avail.images)]
  } catch {
    return []
  }
}

/** Minimal view of an assistant message's emitted tool calls. */
interface ToolCallLike {
  name: string
  arguments: string
}

export interface ComputerBeginCall {
  manifest: CapabilityManifest
  /** The model's own one-line summary of why it's opening the sandbox. */
  reason?: string
}

/**
 * Find a `computer_begin` call in the model's emitted tool calls and parse its
 * manifest argument. Returns `null` if absent or unparseable (the broker
 * re-validates the manifest server-side regardless, so we parse leniently). The
 * model's `reason` is pulled out for the consent UI; the rest is the manifest.
 */
export function extractComputerBegin(message: {
  toolCalls?: ToolCallLike[]
}): ComputerBeginCall | null {
  const call = message.toolCalls?.find((c) => c.name === 'computer_begin')
  if (!call) return null
  try {
    const parsed = JSON.parse(call.arguments) as CapabilityManifest & {
      reason?: unknown
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.session) return null
    const { reason, ...manifest } = parsed
    return {
      manifest: manifest as CapabilityManifest,
      reason: typeof reason === 'string' ? reason : undefined,
    }
  } catch {
    return null
  }
}
