import {
  runComputerUseLoop,
  type DriverLike,
  type LoopEvent,
} from '@/services/computer-use/loop-controller'
import type {
  ActionResult,
  BeginResponse,
  CapabilityManifest,
  DriverAction,
} from '@/services/computer-use/types'
import { DriverError, firstImagePart } from '@/services/computer-use/types'
import { describe, expect, it, vi } from 'vitest'
import {
  FakeDriver,
  TINY_PNG,
  screenshotResult,
  scriptedStreamChat,
} from './fixtures'

const MANIFEST: CapabilityManifest = {
  version: 1,
  session: { os: 'mac', image: 'tahoe-test', clone: true },
}

function run(
  driver: DriverLike,
  turns: Parameters<typeof scriptedStreamChat>[0],
  extra?: { maxSteps?: number; onEvent?: (e: LoopEvent) => void; tokens?: any },
) {
  const { streamChat, invocations } = scriptedStreamChat(turns)
  return {
    invocations,
    promise: runComputerUseLoop({
      task: 'do the thing',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      maxSteps: extra?.maxSteps,
      onEvent: extra?.onEvent,
      tokens: extra?.tokens,
    }),
  }
}

describe('runComputerUseLoop — multi-turn screenshot→action cycle', () => {
  it('drives the model↔driver loop and tears the session down when the model finishes', async () => {
    const driver = new FakeDriver()
    const { promise } = run(driver, [
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'click', x: 10, y: 20 }),
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'type', text: 'hi' }),
          },
        ],
      },
      { content: 'Done — I opened the page and typed the query.' },
    ])
    const result = await promise

    expect(driver.beginCount).toBe(1)
    expect(driver.calls.map((c) => c.action.op)).toEqual(['click', 'type'])
    expect(result.reason).toBe('model_finished')
    expect(result.finalText).toMatch(/Done/)
    expect(result.ended).toBe(true)
    expect(driver.endedSessions).toEqual(['sess_test'])
  })

  it('feeds each screenshot back to the model on the next turn', async () => {
    const driver = new FakeDriver({
      onAction: (a: DriverAction): ActionResult =>
        screenshotResult(`screen after ${a.op}`),
    })
    const { promise, invocations } = run(driver, [
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'click', x: 1, y: 2 }),
          },
        ],
      },
      { content: 'finished' },
    ])
    await promise

    // First invocation carries the initial screen; second carries the click result.
    const secondTurnMessages = invocations[1].messages
    const toolMsg = secondTurnMessages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('screen after click')
    const userImg = secondTurnMessages.find(
      (m) => m.role === 'user' && Array.isArray(m.content),
    )
    expect(userImg).toBeDefined()
  })

  it('presents the `computer` tool on every turn', async () => {
    const driver = new FakeDriver()
    const { promise, invocations } = run(driver, [{ content: 'nothing to do' }])
    await promise
    expect(invocations[0].tools.map((t) => t.function.name)).toEqual([
      'computer',
    ])
  })
})

describe('runComputerUseLoop — unsupported actions', () => {
  it('feeds a tool error back and keeps going instead of aborting', async () => {
    const driver = new FakeDriver()
    const events: LoopEvent[] = []
    const { promise, invocations } = run(
      driver,
      [
        {
          toolCalls: [
            { name: 'computer', arguments: JSON.stringify({ type: 'drag' }) },
          ],
        },
        { content: 'ok, took a different approach' },
      ],
      { onEvent: (e) => events.push(e) },
    )
    const result = await promise

    expect(driver.calls).toHaveLength(0) // never dispatched
    expect(events.some((e) => e.type === 'unsupported')).toBe(true)
    const errToolMsg = invocations[1].messages.find((m) => m.role === 'tool')
    expect(String(errToolMsg?.content)).toMatch(/Error/)
    expect(result.reason).toBe('model_finished')
  })
})

describe('runComputerUseLoop — handoff', () => {
  it('stops on request_handoff and leaves the session open for resume', async () => {
    const driver = new FakeDriver()
    const events: LoopEvent[] = []
    const { promise } = run(
      driver,
      [
        {
          toolCalls: [
            {
              name: 'computer',
              arguments: JSON.stringify({ type: 'request_handoff' }),
            },
          ],
        },
      ],
      { onEvent: (e) => events.push(e) },
    )
    const result = await promise

    expect(result.reason).toBe('handoff')
    expect(result.ended).toBe(false)
    expect(driver.endedSessions).toEqual([]) // not torn down
    expect(events.some((e) => e.type === 'handoff')).toBe(true)
  })
})

describe('runComputerUseLoop — reduced image to the model', () => {
  function imageUrlParts(messages: any[]): string[] {
    return messages
      .filter((m) => Array.isArray(m.content))
      .flatMap((m) => m.content as any[])
      .filter((p) => p.type === 'image_url')
      .map((p) => p.image_url.url as string)
  }

  it('sends the reduced JPEG to the model but keeps the full frame in events', async () => {
    const driver = new FakeDriver()
    const reduceImage = vi.fn(async () => ({
      base64: 'REDUCEDDATA',
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
    }))
    const events: LoopEvent[] = []
    const { streamChat, invocations } = scriptedStreamChat([
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
          },
        ],
      },
      { content: 'done' },
    ])

    await runComputerUseLoop({
      task: 'go',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'kimi-k2-6',
      reduceImage,
      onEvent: (e) => events.push(e),
    })

    // The model only ever sees the reduced JPEG (initial screen + action result).
    const urls = invocations.flatMap((inv) => imageUrlParts(inv.messages))
    expect(urls.length).toBeGreaterThan(0)
    expect(
      urls.every((u) => u.includes('REDUCEDDATA') && u.includes('image/jpeg')),
    ).toBe(true)

    // The emitted events (chat/audit) keep the FULL original PNG.
    const begin = events.find((e) => e.type === 'begin') as Extract<
      LoopEvent,
      { type: 'begin' }
    >
    expect(firstImagePart(begin.screenshot)?.data).toBe(TINY_PNG)
    const result = events.find((e) => e.type === 'action_result') as Extract<
      LoopEvent,
      { type: 'action_result' }
    >
    expect(firstImagePart(result.result)?.data).toBe(TINY_PNG)

    expect(reduceImage).toHaveBeenCalled()
  })

  it('sends the full frame to the model when no reducer is provided', async () => {
    const driver = new FakeDriver()
    const { streamChat, invocations } = scriptedStreamChat([
      { content: 'done' },
    ])
    await runComputerUseLoop({
      task: 'go',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'kimi-k2-6',
    })
    const urls = invocations.flatMap((inv) => imageUrlParts(inv.messages))
    expect(urls.some((u) => u.includes(TINY_PNG))).toBe(true)
  })
})

describe('runComputerUseLoop — bounds', () => {
  it('stops at maxSteps when the model never finishes', async () => {
    const driver = new FakeDriver()
    const clickForever = Array.from({ length: 10 }, () => ({
      toolCalls: [
        {
          name: 'computer',
          arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
        },
      ],
    }))
    const { promise } = run(driver, clickForever, { maxSteps: 3 })
    const result = await promise

    expect(result.reason).toBe('max_steps')
    expect(result.steps).toBe(3)
    expect(driver.calls).toHaveLength(3)
    expect(result.ended).toBe(true)
  })
})

describe('runComputerUseLoop — token re-mint on 401', () => {
  it('invalidates and retries once when an action returns 401', async () => {
    const invalidate = vi.fn()
    let thrown = false
    const driver: DriverLike = {
      async begin(): Promise<BeginResponse> {
        return { session: 's1', screenshot: screenshotResult('init') }
      },
      async action(_s, _a): Promise<ActionResult> {
        if (!thrown) {
          thrown = true
          throw new DriverError('expired', 401)
        }
        return screenshotResult('ok')
      },
      async end() {},
    }
    const { promise } = run(
      driver,
      [
        {
          toolCalls: [
            {
              name: 'computer',
              arguments: JSON.stringify({ type: 'screenshot' }),
            },
          ],
        },
        { content: 'done' },
      ],
      { tokens: { invalidate } },
    )
    const result = await promise

    expect(invalidate).toHaveBeenCalledOnce()
    expect(result.reason).toBe('model_finished')
  })
})

describe('runComputerUseLoop — events', () => {
  it('emits begin → model_message → action → action_result → stopped', async () => {
    const driver = new FakeDriver()
    const events: LoopEvent[] = []
    const { promise } = run(
      driver,
      [
        {
          toolCalls: [
            {
              name: 'computer',
              arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
            },
          ],
        },
        { content: 'done' },
      ],
      { onEvent: (e) => events.push(e) },
    )
    await promise
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('begin')
    expect(types).toContain('action')
    expect(types).toContain('action_result')
    expect(types[types.length - 1]).toBe('stopped')
  })
})

describe('runComputerUseLoop — capability escalation', () => {
  it('intercepts request_capability: asks for approval, calls driver.escalate on approve, continues loop', async () => {
    // Model: 1st turn requests a capability, 2nd turn says done.
    const driver = new FakeDriver()
    const events: LoopEvent[] = []
    const { streamChat, invocations } = scriptedStreamChat([
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({
              type: 'request_capability',
              egress: ['www.reddit.com', '*.redditstatic.com'],
            }),
          },
        ],
      },
      { content: 'thanks, all set' },
    ])
    const approver = vi.fn(async (req: { egress: string[] }) => ({
      approved: true as const,
      // Simulate the user editing the list before approving.
      egress: [...req.egress, 'extra.example.com'],
    }))
    await runComputerUseLoop({
      task: 't',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      onEvent: (e) => events.push(e),
      requestCapabilityApproval: approver,
    })

    // Approver was asked with the exact egress list the model requested.
    expect(approver).toHaveBeenCalledOnce()
    expect(approver.mock.calls[0][0].egress).toEqual([
      'www.reddit.com',
      '*.redditstatic.com',
    ])
    // driver.escalate was called with the (possibly edited) list.
    expect(driver.escalateCalls).toHaveLength(1)
    expect(driver.escalateCalls[0].egress).toEqual([
      'www.reddit.com',
      '*.redditstatic.com',
      'extra.example.com',
    ])
    // The request_capability op was NOT sent through /action — it's a session-
    // config change, not a guest action.
    expect(driver.calls.map((c) => c.action.op)).not.toContain(
      'request_capability',
    )
    // Both lifecycle events appear in the audit trail.
    const types = events.map((e) => e.type)
    expect(types).toContain('capability_request')
    expect(types).toContain('capability_result')
    const result = events.find((e) => e.type === 'capability_result')!
    expect(result).toMatchObject({ approved: true })
    // Model gets a tool message describing the granted capability, then runs.
    const secondCall = invocations[1].messages
    const granted = secondCall.find(
      (m) => m.role === 'tool' && /Capability granted/.test(String(m.content)),
    )
    expect(granted).toBeDefined()
  })

  it('on denial, loop continues and tells the model NOT to retry', async () => {
    const driver = new FakeDriver()
    const events: LoopEvent[] = []
    const { streamChat, invocations } = scriptedStreamChat([
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({
              type: 'request_capability',
              egress: ['evil.com'],
            }),
          },
        ],
      },
      { content: 'understood' },
    ])
    const approver = vi.fn(async () => ({
      approved: false as const,
      reason: 'user denied',
    }))
    await runComputerUseLoop({
      task: 't',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      onEvent: (e) => events.push(e),
      requestCapabilityApproval: approver,
    })
    expect(driver.escalateCalls).toHaveLength(0)
    const result = events.find((e) => e.type === 'capability_result')!
    expect(result).toMatchObject({ approved: false, reason: 'user denied' })
    // The tool message back to the model contains the denial + the "don't
    // re-request" guidance.
    const denialMsg = invocations[1].messages.find(
      (m) => m.role === 'tool' && /denied/.test(String(m.content)),
    )
    expect(denialMsg).toBeDefined()
    expect(String(denialMsg!.content)).toMatch(/do not re-request/i)
  })

  it('without an approver wired, auto-denies (no driver.escalate)', async () => {
    const driver = new FakeDriver()
    const { streamChat } = scriptedStreamChat([
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({
              type: 'request_capability',
              egress: ['x.com'],
            }),
          },
        ],
      },
      { content: 'ok' },
    ])
    await runComputerUseLoop({
      task: 't',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      // No `requestCapabilityApproval` injected.
    })
    expect(driver.escalateCalls).toHaveLength(0)
  })

  it('escalate failure: surfaces as capability_result(approved:false) + tool error to the model', async () => {
    const driver = new FakeDriver()
    driver.escalateError = new Error('session started with no egress')
    const events: LoopEvent[] = []
    const { streamChat } = scriptedStreamChat([
      {
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({
              type: 'request_capability',
              egress: ['x.com'],
            }),
          },
        ],
      },
      { content: 'noted' },
    ])
    await runComputerUseLoop({
      task: 't',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      onEvent: (e) => events.push(e),
      requestCapabilityApproval: async () => ({
        approved: true,
        egress: ['x.com'],
      }),
    })
    const result = events.find((e) => e.type === 'capability_result')!
    expect(result).toMatchObject({ approved: false })
    expect(String((result as any).reason)).toMatch(/escalation failed/)
  })
})
