/**
 * Model-presentation adapter (architecture → "Model-presentation adapter").
 *
 * Qwen3-VL / Kimi K2.6 are finetuned on the **OpenAI computer-use** action
 * vocabulary and will emit `{type:"click", x, y}` (with quirks like `x:[a,b]`)
 * regardless of the schema we declare. So we *present* the OpenAI-CU `computer`
 * tool to the model and *normalize* whatever it emits into the broker's
 * canonical `{ op, payload }`. `computer_*` stays the internal/broker vocabulary
 * — the model never sees it.
 *
 * The adapter also owns the *return* direction: how a perception/exec result
 * becomes the next-turn messages fed back to the model. For maximum
 * compatibility with OpenAI-compatible vision servings (which often reject
 * image parts inside `role:"tool"` messages), screenshots are returned as a
 * short textual tool result followed by a `user` message carrying the image —
 * the pattern these models are trained to consume.
 *
 * Maintain a `{model family → adapter}` table; for now one OpenAI-CU entry
 * covers both Qwen and Kimi.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  dataUrl,
  type ChatMessage,
  type ToolCall,
  type ToolSchema,
} from './chat-protocol'
import {
  firstImagePart,
  isExecResult,
  perceptionText,
  type ActionResult,
  type BrokerAction,
  type BrokerOp,
} from './types'

export type NormalizeResult =
  | { ok: true; action: BrokerAction }
  | { ok: false; reason: string }

/**
 * Context that helps interpret a model's emitted coordinates. The screen size
 * is the pixel dimensions of the screenshot the model was shown; it lets the
 * normalizer rescue normalized [0,1] coordinates into pixels (Kimi K2.6 grounds
 * in 0..1 internally and reverts to fractions under some prompts — confirmed via
 * live probe). Optional: when absent, coordinates pass through unchanged.
 */
export interface NormalizeContext {
  screenWidth?: number
  screenHeight?: number
}

export interface ModelAdapter {
  /** Identifier for logging / the `{family → adapter}` table. */
  readonly family: string
  /**
   * Per-family computer-use system prompt. Prompt engineering that steers a
   * specific model family (e.g. "must call the tool, no prose"; coordinate
   * convention; how to yield for takeover) lives here, not in the loop — so a
   * new model family is one adapter entry, schema + prompt + normalizer together.
   */
  readonly systemPrompt: string
  /** The tool schema(s) presented to the model on every turn. */
  presentTools(): ToolSchema[]
  /** Normalize one emitted tool call into a canonical broker action. */
  normalizeCall(
    call: { name: string; arguments: string },
    ctx?: NormalizeContext,
  ): NormalizeResult
  /** Turn an action result into the messages appended for the next turn. */
  formatToolResult(call: ToolCall, result: ActionResult): ChatMessage[]
  /** Turn a dispatch failure into a tool message the model can recover from. */
  formatToolError(call: ToolCall, message: string): ChatMessage
}

// ---------------------------------------------------------------------------
// OpenAI-CU adapter
// ---------------------------------------------------------------------------

const COMPUTER_TOOL_NAME = 'computer'

/**
 * The action schema presented to the model. A single permissive object keyed by
 * `type` — matching the OpenAI computer-use shape the models were trained on,
 * while staying liberal enough that serving-side translation quirks still
 * validate. The normalizer, not this schema, is the real contract.
 */
const computerActionSchema = z
  .object({
    type: z
      .enum([
        'click',
        'double_click',
        'right_click',
        'scroll',
        'type',
        'keypress',
        'move',
        'screenshot',
        'wait',
        'drag',
        'launch_app',
        'exec',
        'request_handoff',
      ])
      .describe('The action to perform on the sandboxed desktop.'),
    x: z
      .number()
      .optional()
      .describe('Pixel X in the screenshot (origin top-left).'),
    y: z
      .number()
      .optional()
      .describe('Pixel Y in the screenshot (origin top-left).'),
    button: z
      .enum(['left', 'right', 'wheel', 'back', 'forward'])
      .optional()
      .describe('Mouse button for click actions (default left).'),
    text: z.string().optional().describe('Text to type, for type actions.'),
    keys: z
      .array(z.string())
      .optional()
      .describe('Key names for keypress, e.g. ["cmd","c"].'),
    scroll_x: z.number().optional().describe('Horizontal scroll amount.'),
    scroll_y: z.number().optional().describe('Vertical scroll amount.'),
    app: z
      .string()
      .optional()
      .describe('App name or bundle id, for launch_app.'),
    command: z.string().optional().describe('Shell command, for exec.'),
  })
  .describe(
    'A single computer-use action. Emit one action per tool call, then wait for the resulting screenshot before the next.',
  )

const COMPUTER_TOOL_DESCRIPTION = [
  'Control an isolated, sandboxed macOS desktop. Each call performs one action;',
  'the result is a fresh screenshot you should read before acting again. Use',
  'pixel coordinates from the most recent screenshot. Prefer `exec` for anything',
  'scriptable (far more reliable than clicking). When you hit a login or 2FA',
  'wall you cannot pass, emit `request_handoff` to let the user take over.',
].join(' ')

/**
 * System prompt for OpenAI-CU-style vision models (Qwen3-VL, Kimi K2.6). The
 * "must call the tool, never prose" line is load-bearing — confirmed via live
 * probe that without it Kimi narrates the action instead of emitting the call.
 */
const OPENAI_CU_SYSTEM_PROMPT = [
  'You are operating an isolated, sandboxed macOS desktop on the user’s behalf via the `computer` tool.',
  'You see the screen only through screenshots returned after each action. Work in a tight loop:',
  'look at the latest screenshot, take exactly ONE action, then look again.',
  'To act, you MUST call the `computer` tool — never describe an action in prose instead of calling it.',
  'Coordinates are pixels in the most recent screenshot, with the origin at the top-left.',
  'Prefer the `exec` action for anything scriptable — it is far more reliable than clicking.',
  'You are already signed in to the apps you need; never ask for or type passwords.',
  'If you reach a login or 2FA wall you cannot pass, emit `request_handoff` so the user can take over.',
  'Only when the task is fully complete, reply with a short summary in prose and DO NOT call the tool.',
].join(' ')

/** Read a numeric value that may arrive as a number or numeric string. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Extract x/y from an action, repairing the known emission quirks: coordinates
 * delivered as `coordinate`/`coordinates`/`point` arrays, or `x` itself being a
 * two-element `[x, y]` array (the `x:[a,b]` quirk).
 */
function extractXY(a: Record<string, unknown>): { x?: number; y?: number } {
  for (const key of ['coordinate', 'coordinates', 'point', 'position']) {
    const arr = a[key]
    if (Array.isArray(arr) && arr.length >= 2) {
      return { x: num(arr[0]), y: num(arr[1]) }
    }
  }
  if (Array.isArray(a.x) && a.x.length >= 2) {
    return { x: num(a.x[0]), y: num(a.x[1]) }
  }
  return { x: num(a.x), y: num(a.y) }
}

/**
 * Rescue normalized [0,1] coordinates into pixels when we know the frame size.
 * Real pixel targets are effectively never both ≤1, so this only fires on the
 * fractional coordinates a model emits when it reverts to normalized grounding;
 * pixel coordinates pass through untouched. No-op without a screen size.
 */
function maybeScale(
  x: number,
  y: number,
  ctx?: NormalizeContext,
): { x: number; y: number } {
  if (
    ctx?.screenWidth &&
    ctx?.screenHeight &&
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1
  ) {
    return {
      x: Math.round(x * ctx.screenWidth),
      y: Math.round(y * ctx.screenHeight),
    }
  }
  return { x, y }
}

const SUPPORTED_TYPES =
  'click, double_click, right_click, scroll, type, keypress, screenshot, launch_app, exec, request_handoff'

/** Map a normalized OpenAI-CU action object to a canonical broker action. */
function buildAction(
  type: string,
  a: Record<string, unknown>,
  ctx?: NormalizeContext,
): NormalizeResult {
  const t = type.toLowerCase()
  const ok = (
    op: BrokerOp,
    payload: Record<string, unknown>,
  ): NormalizeResult => ({
    ok: true,
    action: { op, payload },
  })
  const needXY = (): { x: number; y: number } | null => {
    const { x, y } = extractXY(a)
    if (x === undefined || y === undefined) return null
    return maybeScale(x, y, ctx)
  }

  switch (t) {
    case 'click':
    case 'left_click':
    case 'mouse_click': {
      if (typeof a.element_index === 'number') {
        return ok('click', {
          element_index: a.element_index,
          ...(typeof a.window_id === 'number'
            ? { window_id: a.window_id }
            : {}),
        })
      }
      const p = needXY()
      if (!p) return { ok: false, reason: 'click requires x and y coordinates' }
      const button = typeof a.button === 'string' ? a.button : undefined
      return ok('click', {
        ...p,
        count: 1,
        ...(button && button !== 'left' ? { button } : {}),
      })
    }
    case 'double_click':
    case 'doubleclick': {
      const p = needXY()
      if (!p) return { ok: false, reason: 'double_click requires x and y' }
      return ok('click', { ...p, count: 2 })
    }
    case 'right_click': {
      const p = needXY()
      if (!p) return { ok: false, reason: 'right_click requires x and y' }
      return ok('click', { ...p, count: 1, button: 'right' })
    }
    case 'type': {
      const text = typeof a.text === 'string' ? a.text : undefined
      if (text === undefined) return { ok: false, reason: 'type requires text' }
      return ok('type', { text })
    }
    case 'keypress':
    case 'key':
    case 'press_key':
    case 'hotkey': {
      if (Array.isArray(a.keys) && a.keys.length > 0) {
        return ok('key', { keys: a.keys.map(String) })
      }
      const key =
        typeof a.key === 'string'
          ? a.key
          : typeof a.text === 'string'
            ? a.text
            : undefined
      if (!key) return { ok: false, reason: 'keypress requires keys or key' }
      return ok('key', { keys: [key] })
    }
    case 'scroll': {
      const raw = extractXY(a)
      const scaled =
        raw.x !== undefined && raw.y !== undefined
          ? maybeScale(raw.x, raw.y, ctx)
          : raw
      return ok('scroll', {
        ...(scaled.x !== undefined ? { x: scaled.x } : {}),
        ...(scaled.y !== undefined ? { y: scaled.y } : {}),
        scroll_x: num(a.scroll_x) ?? 0,
        scroll_y: num(a.scroll_y) ?? num(a.amount) ?? 0,
      })
    }
    case 'screenshot':
    case 'wait':
      // `wait` has no curated op; re-observing the screen is the closest useful
      // behavior and lets the UI settle, which is the model's actual intent.
      return ok('screenshot', { format: 'png' })
    case 'launch_app':
    case 'open':
    case 'open_app': {
      const app =
        typeof a.app === 'string'
          ? a.app
          : typeof a.bundle_id === 'string'
            ? a.bundle_id
            : typeof a.name === 'string'
              ? a.name
              : undefined
      if (!app)
        return {
          ok: false,
          reason: 'launch_app requires an app name or bundle id',
        }
      // Heuristic: a reverse-DNS string is a bundle id, otherwise a name.
      const key = app.includes('.') && !app.includes(' ') ? 'bundle_id' : 'name'
      return ok('launch_app', { [key]: app })
    }
    case 'exec':
    case 'shell':
    case 'bash': {
      const cmd =
        typeof a.command === 'string'
          ? a.command
          : typeof a.cmd === 'string'
            ? a.cmd
            : undefined
      if (!cmd) return { ok: false, reason: 'exec requires a command' }
      return ok('exec', { cmd })
    }
    case 'request_handoff':
    case 'handoff':
    case 'human_takeover':
      return ok('request_handoff', {})
    case 'move':
    case 'mouse_move':
    case 'drag':
      return {
        ok: false,
        reason: `'${t}' is not supported by this sandbox. Supported actions: ${SUPPORTED_TYPES}.`,
      }
    default:
      return {
        ok: false,
        reason: `unknown action '${type}'. Supported actions: ${SUPPORTED_TYPES}.`,
      }
  }
}

export const openAICUAdapter: ModelAdapter = {
  family: 'openai-cu',
  systemPrompt: OPENAI_CU_SYSTEM_PROMPT,

  presentTools(): ToolSchema[] {
    return [
      {
        type: 'function',
        function: {
          name: COMPUTER_TOOL_NAME,
          description: COMPUTER_TOOL_DESCRIPTION,
          parameters: zodToJsonSchema(computerActionSchema, {
            target: 'openApi3',
            $refStrategy: 'none',
          }) as Record<string, unknown>,
        },
      },
    ]
  },

  normalizeCall(call, ctx): NormalizeResult {
    let parsed: unknown
    try {
      parsed = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch {
      return { ok: false, reason: 'tool call arguments were not valid JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, reason: 'tool call arguments must be a JSON object' }
    }
    let action = parsed as Record<string, unknown>
    // Some servings nest the action under `action`/`input`.
    if (action.action && typeof action.action === 'object') {
      action = action.action as Record<string, unknown>
    } else if (action.input && typeof action.input === 'object') {
      action = action.input as Record<string, unknown>
    }
    // The action type may be in `type`/`action`, or — if serving mapped the
    // action name onto the tool name — in the call name itself.
    const type =
      (typeof action.type === 'string' && action.type) ||
      (typeof action.action === 'string' && action.action) ||
      (call.name !== COMPUTER_TOOL_NAME ? call.name : undefined)
    if (!type) {
      return { ok: false, reason: 'tool call is missing an action type' }
    }
    return buildAction(type, action, ctx)
  },

  formatToolResult(call, result): ChatMessage[] {
    if (isExecResult(result)) {
      const body = [
        `exit_code: ${result.exit_code}`,
        result.stdout ? `stdout:\n${result.stdout}` : 'stdout: (empty)',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return [{ role: 'tool', tool_call_id: call.id, content: body }]
    }

    const text = perceptionText(result)
    const image = firstImagePart(result)
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        tool_call_id: call.id,
        content: text || 'Action performed; screenshot follows.',
      },
    ]
    // Screenshots ride in a follow-up user message: the most broadly compatible
    // way to feed an image to OpenAI-compatible vision servings, which commonly
    // reject image parts inside tool-role messages.
    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Current screen:' },
          {
            type: 'image_url',
            image_url: { url: dataUrl(image.data, image.mimeType) },
          },
        ],
      })
    }
    return messages
  },

  formatToolError(call, message): ChatMessage {
    return { role: 'tool', tool_call_id: call.id, content: `Error: ${message}` }
  },
}

// ---------------------------------------------------------------------------
// Adapter registry — the per-model extensibility seam
// ---------------------------------------------------------------------------

/**
 * One entry per model family. Each binds a name-match to the adapter that owns
 * that family's prompt + tool schema + normalizer + result formatting. Adding a
 * model is a new entry here (and, when its quirks differ enough, a new adapter)
 * — coordinate conventions, native action shapes, and prompt steering all vary
 * by family, so they belong together behind one adapter, not scattered.
 *
 * Order matters: first match wins. Keep specific patterns above general ones.
 */
interface AdapterEntry {
  family: string
  match: RegExp
  adapter: ModelAdapter
}

const ADAPTER_REGISTRY: AdapterEntry[] = [
  // Kimi K2.6 — general tool-caller; complies with our declared schema. Verified
  // via live probe (see NOTES.md).
  { family: 'kimi', match: /kimi/i, adapter: openAICUAdapter },
  // Qwen3-VL — pixel-CU-finetuned. OpenAI-CU shape for now; a dedicated adapter
  // can slot in here if its coordinate scaling (smart-resize) needs special
  // handling.
  { family: 'qwen-vl', match: /qwen.*vl|qwen-?vl/i, adapter: openAICUAdapter },
]

export interface ResolvedAdapter {
  adapter: ModelAdapter
  /** True when the model matched a known family (not the default fallback). */
  recognized: boolean
  /** The matched family name, or 'default'. */
  family: string
}

/**
 * Resolve the adapter for a model name, reporting whether the family was
 * recognized. An unrecognized model still gets the OpenAI-CU adapter as a
 * best-effort fallback, but `recognized:false` lets the UI flag that actions may
 * be unreliable (architecture → conditional tool exposure / constraint surfacing).
 */
export function resolveAdapter(modelName: string): ResolvedAdapter {
  for (const entry of ADAPTER_REGISTRY) {
    if (entry.match.test(modelName)) {
      return { adapter: entry.adapter, recognized: true, family: entry.family }
    }
  }
  return { adapter: openAICUAdapter, recognized: false, family: 'default' }
}

/** Convenience: just the adapter (best-effort fallback for unknown models). */
export function adapterForModel(modelName: string): ModelAdapter {
  return resolveAdapter(modelName).adapter
}
