import {
  runComputerUseLoop,
  type BrokerLike,
  type LoopEvent,
} from '@/services/computer-use/loop-controller'
import type {
  ActionResult,
  BeginResponse,
  BrokerAction,
  CapabilityManifest,
} from '@/services/computer-use/types'
import { BrokerError } from '@/services/computer-use/types'
import { describe, expect, it, vi } from 'vitest'
import { FakeBroker, screenshotResult, scriptedStreamChat } from './fixtures'

const MANIFEST: CapabilityManifest = {
  version: 1,
  session: { os: 'mac', image: 'tahoe-test', clone: true },
}

function run(
  broker: BrokerLike,
  turns: Parameters<typeof scriptedStreamChat>[0],
  extra?: { maxSteps?: number; onEvent?: (e: LoopEvent) => void; tokens?: any },
) {
  const { streamChat, invocations } = scriptedStreamChat(turns)
  return {
    invocations,
    promise: runComputerUseLoop({
      task: 'do the thing',
      manifest: MANIFEST,
      broker,
      streamChat,
      modelName: 'qwen3-vl',
      maxSteps: extra?.maxSteps,
      onEvent: extra?.onEvent,
      tokens: extra?.tokens,
    }),
  }
}

describe('runComputerUseLoop — multi-turn screenshot→action cycle', () => {
  it('drives the model↔broker loop and tears the session down when the model finishes', async () => {
    const broker = new FakeBroker()
    const { promise } = run(broker, [
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

    expect(broker.beginCount).toBe(1)
    expect(broker.calls.map((c) => c.action.op)).toEqual(['click', 'type'])
    expect(result.reason).toBe('model_finished')
    expect(result.finalText).toMatch(/Done/)
    expect(result.ended).toBe(true)
    expect(broker.endedSessions).toEqual(['sess_test'])
  })

  it('feeds each screenshot back to the model on the next turn', async () => {
    const broker = new FakeBroker({
      onAction: (a: BrokerAction): ActionResult =>
        screenshotResult(`screen after ${a.op}`),
    })
    const { promise, invocations } = run(broker, [
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
    const broker = new FakeBroker()
    const { promise, invocations } = run(broker, [{ content: 'nothing to do' }])
    await promise
    expect(invocations[0].tools.map((t) => t.function.name)).toEqual([
      'computer',
    ])
  })
})

describe('runComputerUseLoop — unsupported actions', () => {
  it('feeds a tool error back and keeps going instead of aborting', async () => {
    const broker = new FakeBroker()
    const events: LoopEvent[] = []
    const { promise, invocations } = run(
      broker,
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

    expect(broker.calls).toHaveLength(0) // never dispatched
    expect(events.some((e) => e.type === 'unsupported')).toBe(true)
    const errToolMsg = invocations[1].messages.find((m) => m.role === 'tool')
    expect(String(errToolMsg?.content)).toMatch(/Error/)
    expect(result.reason).toBe('model_finished')
  })
})

describe('runComputerUseLoop — handoff', () => {
  it('stops on request_handoff and leaves the session open for resume', async () => {
    const broker = new FakeBroker()
    const events: LoopEvent[] = []
    const { promise } = run(
      broker,
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
    expect(broker.endedSessions).toEqual([]) // not torn down
    expect(events.some((e) => e.type === 'handoff')).toBe(true)
  })
})

describe('runComputerUseLoop — bounds', () => {
  it('stops at maxSteps when the model never finishes', async () => {
    const broker = new FakeBroker()
    const clickForever = Array.from({ length: 10 }, () => ({
      toolCalls: [
        {
          name: 'computer',
          arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
        },
      ],
    }))
    const { promise } = run(broker, clickForever, { maxSteps: 3 })
    const result = await promise

    expect(result.reason).toBe('max_steps')
    expect(result.steps).toBe(3)
    expect(broker.calls).toHaveLength(3)
    expect(result.ended).toBe(true)
  })
})

describe('runComputerUseLoop — token re-mint on 401', () => {
  it('invalidates and retries once when an action returns 401', async () => {
    const invalidate = vi.fn()
    let thrown = false
    const broker: BrokerLike = {
      async begin(): Promise<BeginResponse> {
        return { session: 's1', screenshot: screenshotResult('init') }
      },
      async action(_s, _a): Promise<ActionResult> {
        if (!thrown) {
          thrown = true
          throw new BrokerError('expired', 401)
        }
        return screenshotResult('ok')
      },
      async end() {},
    }
    const { promise } = run(
      broker,
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
    const broker = new FakeBroker()
    const events: LoopEvent[] = []
    const { promise } = run(
      broker,
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
