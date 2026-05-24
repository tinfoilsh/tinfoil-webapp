import { openAICUAdapter } from '@/services/computer-use/adapter'
import type { ToolCall } from '@/services/computer-use/chat-protocol'
import { describe, expect, it } from 'vitest'
import { screenshotResult } from './fixtures'

function norm(name: string, args: unknown) {
  return openAICUAdapter.normalizeCall({
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  })
}

describe('openAICUAdapter.presentTools', () => {
  it('presents a single `computer` function tool with a JSON-schema parameters object', () => {
    const tools = openAICUAdapter.presentTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('computer')
    expect(tools[0].function.parameters).toMatchObject({ type: 'object' })
  })
})

describe('openAICUAdapter.normalizeCall — happy paths', () => {
  it('maps a pixel click', () => {
    const r = norm('computer', { type: 'click', x: 100, y: 200 })
    expect(r).toEqual({
      ok: true,
      action: { op: 'click', payload: { x: 100, y: 200, count: 1 } },
    })
  })

  it('maps double_click to a click with count 2', () => {
    const r = norm('computer', { type: 'double_click', x: 10, y: 20 })
    expect(r).toEqual({
      ok: true,
      action: { op: 'click', payload: { x: 10, y: 20, count: 2 } },
    })
  })

  it('maps right_click with a button', () => {
    const r = norm('computer', { type: 'right_click', x: 5, y: 6 })
    expect(r).toMatchObject({
      ok: true,
      action: { op: 'click', payload: { button: 'right', count: 1 } },
    })
  })

  it('maps type', () => {
    const r = norm('computer', { type: 'type', text: 'hello' })
    expect(r).toEqual({
      ok: true,
      action: { op: 'type', payload: { text: 'hello' } },
    })
  })

  it('maps keypress with a keys array', () => {
    const r = norm('computer', { type: 'keypress', keys: ['cmd', 'c'] })
    expect(r).toEqual({
      ok: true,
      action: { op: 'key', payload: { keys: ['cmd', 'c'] } },
    })
  })

  it('maps scroll with defaults for missing deltas', () => {
    const r = norm('computer', { type: 'scroll', x: 1, y: 2, scroll_y: -3 })
    expect(r).toEqual({
      ok: true,
      action: {
        op: 'scroll',
        payload: { x: 1, y: 2, scroll_x: 0, scroll_y: -3 },
      },
    })
  })

  it('maps screenshot and wait to a screenshot op', () => {
    expect(norm('computer', { type: 'screenshot' })).toEqual({
      ok: true,
      action: { op: 'screenshot', payload: { format: 'png' } },
    })
    expect(norm('computer', { type: 'wait' })).toMatchObject({
      ok: true,
      action: { op: 'screenshot' },
    })
  })

  it('maps exec (command or cmd)', () => {
    expect(norm('computer', { type: 'exec', command: 'ls -la' })).toEqual({
      ok: true,
      action: { op: 'exec', payload: { cmd: 'ls -la' } },
    })
    expect(norm('computer', { type: 'exec', cmd: 'pwd' })).toEqual({
      ok: true,
      action: { op: 'exec', payload: { cmd: 'pwd' } },
    })
  })

  it('classifies launch_app target as bundle id vs name', () => {
    expect(
      norm('computer', { type: 'launch_app', app: 'com.apple.Safari' }),
    ).toEqual({
      ok: true,
      action: { op: 'launch_app', payload: { bundle_id: 'com.apple.Safari' } },
    })
    expect(norm('computer', { type: 'launch_app', app: 'Safari' })).toEqual({
      ok: true,
      action: { op: 'launch_app', payload: { name: 'Safari' } },
    })
  })

  it('maps request_handoff', () => {
    expect(norm('computer', { type: 'request_handoff' })).toEqual({
      ok: true,
      action: { op: 'request_handoff', payload: {} },
    })
  })

  it('maps request_capability to a driver op carrying the egress list', () => {
    expect(
      norm('computer', {
        type: 'request_capability',
        egress: ['www.reddit.com', '*.redditstatic.com'],
      }),
    ).toEqual({
      ok: true,
      action: {
        op: 'request_capability',
        payload: { egress: ['www.reddit.com', '*.redditstatic.com'] },
      },
    })
  })

  it('also accepts the `escalate` / `request_egress` aliases', () => {
    const a = norm('computer', { type: 'escalate', egress: ['a.com'] })
    expect(a.ok && a.action.op).toBe('request_capability')
    const b = norm('computer', { type: 'request_egress', egress: ['b.com'] })
    expect(b.ok && b.action.op).toBe('request_capability')
  })

  it('rejects request_capability when egress is empty / missing', () => {
    expect(norm('computer', { type: 'request_capability' }).ok).toBe(false)
    expect(
      norm('computer', { type: 'request_capability', egress: [] }).ok,
    ).toBe(false)
    // Trims and drops empty strings.
    const a = norm('computer', {
      type: 'request_capability',
      egress: ['  ', 'x.com'],
    })
    if (!a.ok) throw new Error('expected ok')
    expect(a.action.payload).toEqual({ egress: ['x.com'] })
  })

  it('lenient JSON: accepts unquoted keys (a common model emission quirk)', () => {
    // Models periodically emit Python/JS-literal style: `{type: "click", x: 100, y: 200}`
    // — i.e. unquoted keys. Strict JSON.parse rejects, so the adapter repairs.
    const r = openAICUAdapter.normalizeCall({
      name: 'computer',
      arguments: '{type: "click", x: 100, y: 200}',
    })
    expect(r).toEqual({
      ok: true,
      action: { op: 'click', payload: { x: 100, y: 200, count: 1 } },
    })
  })

  it('lenient JSON: rewrites tool_call.arguments in place after repair', () => {
    // Downstream the loop pushes the assistant message back to the upstream
    // inference server, which re-validates `tool_calls[].function.arguments`
    // and 400s on malformed JSON. The repair must overwrite the raw string so
    // we never echo invalid JSON upstream.
    const call: ToolCall['function'] = {
      name: 'computer',
      arguments: '{type: "click", x: 1, y: 2}',
    }
    openAICUAdapter.normalizeCall(call)
    expect(() => JSON.parse(call.arguments)).not.toThrow()
    expect(JSON.parse(call.arguments)).toMatchObject({
      type: 'click',
      x: 1,
      y: 2,
    })
  })

  it('lenient JSON: accepts single-quoted strings + trailing commas', () => {
    const r = openAICUAdapter.normalizeCall({
      name: 'computer',
      arguments: "{'type': 'click', x: 10, y: 20,}",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.action).toEqual({
        op: 'click',
        payload: { x: 10, y: 20, count: 1 },
      })
    }
  })

  it('lenient JSON: still rejects truly unparseable input', () => {
    const r = openAICUAdapter.normalizeCall({
      name: 'computer',
      arguments: '{this is not json at all',
    })
    expect(r.ok).toBe(false)
  })

  it('lenient JSON: repairs a missing opening quote on a value (`:click"`)', () => {
    // Regression: observed live from Kimi —
    // ` {"type":click", "x": 502, "y": 129} `
    // missing the opening quote on "click". Before repair, this would 400
    // upstream on the next turn's re-emit.
    const call = {
      name: 'computer',
      arguments: ' {"type":click", "x": 502, "y": 129} ',
    }
    const r = openAICUAdapter.normalizeCall(call)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.action.op).toBe('click')
    expect(r.action.payload).toMatchObject({ x: 502, y: 129 })
    // The original arguments must be canonicalised in place so the next
    // upstream turn doesn't see the broken payload.
    expect(() => JSON.parse(call.arguments)).not.toThrow()
    expect(JSON.parse(call.arguments)).toMatchObject({ type: 'click' })
  })

  it('prefers element-addressed clicks when an element_index is given', () => {
    const r = norm('computer', {
      type: 'click',
      element_index: 4,
      window_id: 2,
    })
    expect(r).toEqual({
      ok: true,
      action: { op: 'click', payload: { element_index: 4, window_id: 2 } },
    })
  })
})

describe('openAICUAdapter.normalizeCall — quirk repairs', () => {
  it('repairs the x:[a,b] quirk', () => {
    const r = norm('computer', { type: 'click', x: [12, 34] })
    expect(r).toEqual({
      ok: true,
      action: { op: 'click', payload: { x: 12, y: 34, count: 1 } },
    })
  })

  it('reads coordinates from a coordinate array', () => {
    const r = norm('computer', { type: 'click', coordinate: [7, 8] })
    expect(r).toMatchObject({ ok: true, action: { payload: { x: 7, y: 8 } } })
  })

  it('coerces numeric strings', () => {
    const r = norm('computer', { type: 'click', x: '50', y: '60' })
    expect(r).toMatchObject({ ok: true, action: { payload: { x: 50, y: 60 } } })
  })

  it('unwraps a nested action object', () => {
    const r = norm('computer', { action: { type: 'type', text: 'hi' } })
    expect(r).toEqual({
      ok: true,
      action: { op: 'type', payload: { text: 'hi' } },
    })
  })

  it('falls back to the call name when there is no type field', () => {
    const r = norm('screenshot', {})
    expect(r).toMatchObject({ ok: true, action: { op: 'screenshot' } })
  })
})

describe('openAICUAdapter.normalizeCall — rejections', () => {
  it('rejects invalid JSON arguments', () => {
    expect(
      openAICUAdapter.normalizeCall({ name: 'computer', arguments: '{bad' }),
    ).toMatchObject({
      ok: false,
    })
  })

  it('rejects a click without coordinates', () => {
    expect(norm('computer', { type: 'click' })).toMatchObject({ ok: false })
  })

  it('rejects unsupported actions with a helpful reason', () => {
    const r = norm('computer', { type: 'drag', path: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not supported|Supported actions/)
  })

  it('rejects an unknown action type', () => {
    const r = norm('computer', { type: 'teleport' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown action/)
  })
})

describe('openAICUAdapter — real Kimi K2.6 payloads (from live probe)', () => {
  // Captured verbatim from Tinfoil-hosted kimi-k2-6. These pin the contract to
  // what the model actually emits, not what we assume.

  it('PROBE 3: keypress with cmd+space maps to a key op', () => {
    // arguments emitted: {"type": "keypress", "keys": ["cmd", "space"]}
    expect(
      norm('computer', { type: 'keypress', keys: ['cmd', 'space'] }),
    ).toEqual({
      ok: true,
      action: { op: 'key', payload: { keys: ['cmd', 'space'] } },
    })
  })

  it('PROBE 4: pixel-labeled schema → pixel coords pass through unchanged', () => {
    // arguments emitted: {"type":"click","x":105,"y":79}
    expect(norm('computer', { type: 'click', x: 105, y: 79 })).toEqual({
      ok: true,
      action: { op: 'click', payload: { x: 105, y: 79, count: 1 } },
    })
  })

  it('PROBE 5: normalized coords are rescued to pixels when the frame size is known', () => {
    // arguments emitted: {"type": "click", "x": 0.109, "y": 0.118}; image was 1024x665
    const r = openAICUAdapter.normalizeCall(
      { name: 'computer', arguments: '{"type":"click","x":0.109,"y":0.118}' },
      { screenWidth: 1024, screenHeight: 665 },
    )
    expect(r).toEqual({
      ok: true,
      action: {
        op: 'click',
        payload: {
          x: Math.round(0.109 * 1024),
          y: Math.round(0.118 * 665),
          count: 1,
        },
      },
    })
  })

  it('does not rescale normalized coords without a frame size (passes through)', () => {
    expect(norm('computer', { type: 'click', x: 0.109, y: 0.118 })).toEqual({
      ok: true,
      action: { op: 'click', payload: { x: 0.109, y: 0.118, count: 1 } },
    })
  })

  it('never misreads real pixel coords as normalized, even with a frame size', () => {
    const r = openAICUAdapter.normalizeCall(
      { name: 'computer', arguments: '{"type":"click","x":105,"y":79}' },
      { screenWidth: 1024, screenHeight: 665 },
    )
    expect(r).toMatchObject({
      ok: true,
      action: { payload: { x: 105, y: 79 } },
    })
  })
})

describe('openAICUAdapter.formatToolResult', () => {
  const call: ToolCall = {
    id: 'c1',
    type: 'function',
    function: { name: 'computer', arguments: '{}' },
  }

  it('returns a tool message plus a user message carrying the screenshot image', () => {
    const msgs = openAICUAdapter.formatToolResult(
      call,
      screenshotResult('window: Safari'),
    )
    expect(msgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    const userMsg = msgs[1]
    expect(userMsg.role).toBe('user')
    expect(Array.isArray(userMsg.content)).toBe(true)
    const parts = userMsg.content as Array<{ type: string }>
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
  })

  it('formats an exec result as a single text tool message', () => {
    const msgs = openAICUAdapter.formatToolResult(call, {
      stdout: 'hi',
      stderr: '',
      exit_code: 0,
    })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('tool')
    expect(String(msgs[0].content)).toContain('exit_code: 0')
    expect(String(msgs[0].content)).toContain('hi')
  })
})
