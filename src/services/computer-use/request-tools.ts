/**
 * Model-initiated computer-use: expose `computer_begin` to the model in the
 * normal chat request, and detect when it calls it.
 *
 * The model decides whether to drive the computer (the toggle just makes the
 * tool available). `computer_begin` is NOT auto-continued, so the model stops
 * after emitting it; the webapp inspects the finished assistant message, and on
 * a `computer_begin` call hands off to the consent + agentic-loop session. The
 * normal streaming pipeline is untouched — this is a post-stream check.
 *
 * When the broker is ABSENT (driver not installed yet), we instead expose
 * `suggest_installing_computer_use` — the install-funnel widget — so the model
 * can surface the right CTA when a request implies computer use. Exactly one
 * of the two tools is offered at a time; the rendering registry knows about
 * the widget either way (see `genui/registry.ts`).
 */

import { GENUI_WIDGETS_BY_NAME } from '@/components/chat/genui/registry'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { computerUseAvailability } from './availability'
import { BrokerClient, type BrokerClientOptions } from './broker-client'
import type { ToolSchema } from './chat-protocol'
import { isMacOS } from './host'
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
 * System-prompt nudge used when the broker is absent. Tells the model to use
 * the install-funnel tool whenever the user shows interest in computer use,
 * including direct "how do I enable this" questions — not just task requests.
 * Added only when `suggest_installing_computer_use` is offered; by exposure
 * the `computer_begin` / `computer` tools are mutually exclusive, so there is
 * nothing to "avoid" calling — this hint just describes what IS available.
 */
export const SUGGEST_INSTALL_PROMPT_HINT = [
  'The user is on macOS but has NOT installed the Tinfoil computer driver yet.',
  'You have a single tool for this turn: `suggest_installing_computer_use`,',
  'which surfaces the inline install card carrying the canonical install',
  'command + download link. Call it (with a brief `reason`) in ANY of these',
  'cases:',
  '(1) the user asks you to *do* something on a computer (browse, click,',
  'type, fill a form, drive a desktop or GUI app);',
  '(2) the user asks how to enable, install, set up, or turn on computer use',
  '/ the local driver / desktop control;',
  '(3) the user asks what computer use is or how to get it;',
  '(4) the user otherwise expresses interest in the feature.',
  'The install card IS the answer in all four cases — do NOT just describe',
  'install steps in text, because you do not know the exact command/link.',
  'After calling the tool, you may add a short follow-up line in text',
  '("once installed, ask me to do X"). Skip the tool only for questions',
  'genuinely unrelated to computer use.',
].join(' ')

/**
 * Build the computer-use tool(s) to add to the chat request. Returns one of:
 *  - `[computer_begin]` — broker reachable + model can drive it. Existing flow.
 *  - `[suggest_installing_computer_use]` — broker absent on a macOS host with a
 *    vision-capable model. The install-funnel CTA tool, so the model can
 *    surface install instructions when the user asks for a computer task.
 *  - `[]` — broker unreachable (non-mac, non-vision model, transport error).
 *
 * Probes `/status` once at send time. Never throws — a broker problem just
 * means no tools are offered. The caller's `enabled` (the per-chat toggle)
 * gates `computer_begin` but NOT `suggest_installing_computer_use`: the
 * install funnel is the discovery path, so it shouldn't require the user to
 * have already opted in.
 */
export async function computerUseRequestTools(args: {
  model: ModelLike
  /** Per-chat toggle. Required true for `computer_begin`; ignored for install funnel. */
  enabled: boolean
  baseUrl?: string
  fetchImpl?: BrokerClientOptions['fetchImpl']
  signal?: AbortSignal
  /** Override the macOS host check (tests). Defaults to runtime detection. */
  isMacOSImpl?: () => boolean
}): Promise<ToolSchema[]> {
  // Probe the broker; an unreachable broker is the install-funnel case (the
  // user hasn't installed the driver yet), NOT a generic error. So we treat
  // the throw as "status = null" rather than bailing to [].
  let status = null as Awaited<ReturnType<BrokerClient['getStatus']>> | null
  try {
    const client = new BrokerClient({
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
    })
    status = await client.getStatus(args.signal)
  } catch {
    // Treat any failure as broker-absent. AbortError is uninteresting here —
    // the chat path will respect the signal independently.
  }
  const avail = computerUseAvailability({ status, model: args.model })
  // Install funnel: vision model + macOS host + broker absent. Independent of
  // the per-chat toggle, since this is the discovery path.
  if (avail.showInstallCTA) {
    const onMac = args.isMacOSImpl ? args.isMacOSImpl() : isMacOS()
    if (onMac) return [buildSuggestInstallingComputerUseSchema()]
    return []
  }
  // Existing flow: computer_begin gated by the per-chat toggle.
  if (avail.exposeTools && args.enabled) {
    return [buildComputerBeginSchema(avail.images)]
  }
  return []
}

/**
 * Tool-schema builder for `suggest_installing_computer_use` derived from the
 * widget's Zod schema (single source of truth). Kept here rather than in the
 * widget file so widgets stay rendering-only.
 */
function buildSuggestInstallingComputerUseSchema(): ToolSchema {
  const widget = GENUI_WIDGETS_BY_NAME['suggest_installing_computer_use']
  if (!widget) {
    // Build a minimal schema if the widget isn't registered — shouldn't happen
    // in practice (the import side-effect registers it). This keeps the tool
    // exposure robust to refactors of the registry.
    return {
      type: 'function',
      function: {
        name: 'suggest_installing_computer_use',
        description:
          'Surface the Tinfoil computer-use install card to the user.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
          required: [],
        },
      },
    }
  }
  return {
    type: 'function',
    function: {
      name: widget.name,
      description: widget.description,
      parameters: zodToJsonSchema(widget.schema, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    },
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
