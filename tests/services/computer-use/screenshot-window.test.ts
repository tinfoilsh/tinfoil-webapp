/**
 * Tests for the screenshot sliding window in `loop-controller.ts`.
 *
 * The window replaces older image-bearing user messages with a small text
 * placeholder so the loop's model-facing context stays bounded as the run
 * extends. Two layers of test: the pure helper, and the loop end-to-end
 * (asserting what the model actually sees on the Nth turn).
 */

import type { ChatMessage } from '@/services/computer-use/chat-protocol'
import {
  applyScreenshotWindow,
  runComputerUseLoop,
  type LoopEvent,
} from '@/services/computer-use/loop-controller'
import type { CapabilityManifest } from '@/services/computer-use/types'
import { describe, expect, it } from 'vitest'
import { FakeDriver, scriptedStreamChat } from './fixtures'

const MANIFEST: CapabilityManifest = {
  version: 1,
  session: { os: 'mac', image: 'tahoe-test', clone: true },
}

/** Build a user message carrying a screenshot, the same shape the loop builds. */
function userScreenshot(label = 'Current screen:'): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: label },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,XXXX' } },
    ],
  }
}

/** A plain assistant turn — assistant messages aren't windowed. */
function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text }
}

/** A `tool` result message — those aren't windowed either. */
function toolResult(id: string, text: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: text }
}

/** Count image-bearing user messages still present in the array. */
function countScreenshots(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'image_url')
    ) {
      n++
    }
  }
  return n
}

describe('applyScreenshotWindow — pure helper', () => {
  it('no-op while screenshot count is within the window', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      userScreenshot('Initial screen:'),
      assistant('thinking'),
      toolResult('call_1', 'click ok'),
      userScreenshot(),
    ]
    const snapshot = JSON.stringify(messages)

    applyScreenshotWindow(messages, { first: 1, recent: 2 })

    expect(JSON.stringify(messages)).toBe(snapshot)
    expect(countScreenshots(messages)).toBe(2)
  })

  it('keeps the first screenshot and the last `recent` once exceeded', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      userScreenshot('Initial screen:'), // #0 — should be retained (first)
      userScreenshot('s1'), // #1 — should be elided
      userScreenshot('s2'), // #2 — should be elided
      userScreenshot('s3'), // #3 — kept (recent)
      userScreenshot('s4'), // #4 — kept (recent)
    ]

    applyScreenshotWindow(messages, { first: 1, recent: 2 })

    // #1 and #2 replaced; the others still carry image_url parts.
    expect(countScreenshots(messages)).toBe(3)
    const initial = messages[1]
    expect(initial.role).toBe('user')
    expect(Array.isArray(initial.content)).toBe(true)
    expect(
      (initial.content as Array<{ type: string }>).some(
        (p) => p.type === 'image_url',
      ),
    ).toBe(true)
    // The elided slots are now plain string-content user messages.
    expect(messages[2]).toEqual({
      role: 'user',
      content: '[earlier screenshot elided to save context]',
    })
    expect(messages[3]).toEqual({
      role: 'user',
      content: '[earlier screenshot elided to save context]',
    })
  })

  it('does not touch assistant or tool-role messages between screenshots', () => {
    const messages: ChatMessage[] = [
      userScreenshot('s0'),
      assistant('a0'),
      toolResult('c0', 't0'),
      userScreenshot('s1'),
      assistant('a1'),
      toolResult('c1', 't1'),
      userScreenshot('s2'),
      userScreenshot('s3'),
    ]

    applyScreenshotWindow(messages, { first: 1, recent: 1 })

    // s0 kept (first), s3 kept (recent), s1 + s2 elided.
    expect(countScreenshots(messages)).toBe(2)
    // Non-screenshot turns are untouched.
    expect(messages[1]).toEqual(assistant('a0'))
    expect(messages[2]).toEqual(toolResult('c0', 't0'))
    expect(messages[4]).toEqual(assistant('a1'))
    expect(messages[5]).toEqual(toolResult('c1', 't1'))
  })

  it('idempotent on repeat application', () => {
    const messages: ChatMessage[] = [
      userScreenshot('s0'),
      userScreenshot('s1'),
      userScreenshot('s2'),
      userScreenshot('s3'),
      userScreenshot('s4'),
    ]

    applyScreenshotWindow(messages, { first: 1, recent: 2 })
    const afterFirst = JSON.parse(JSON.stringify(messages))
    applyScreenshotWindow(messages, { first: 1, recent: 2 })

    expect(messages).toEqual(afterFirst)
    expect(countScreenshots(messages)).toBe(3)
  })

  it('floor-clamps negative and fractional bounds, no-ops when first+recent=0', () => {
    const before: ChatMessage[] = [userScreenshot(), userScreenshot()]
    const messages: ChatMessage[] = JSON.parse(JSON.stringify(before))

    applyScreenshotWindow(messages, { first: 0, recent: 0 })

    expect(messages).toEqual(before)
  })

  it('extends monotonically: appending one and re-running narrows the kept set', () => {
    // Mirrors how the loop calls this — once per appended screenshot.
    const messages: ChatMessage[] = []
    const policy = { first: 1, recent: 2 }

    for (let i = 0; i < 5; i++) {
      messages.push(userScreenshot(`s${i}`))
      applyScreenshotWindow(messages, policy)
    }

    // s0 (first), s3+s4 (recent). s1+s2 elided.
    expect(countScreenshots(messages)).toBe(3)
  })

  it('handles user messages with mixed text+image parts correctly', () => {
    // The first/initial screen and follow-up screenshots both have a text
    // part alongside the image_url. Confirm we detect them by structure.
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Initial screen:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'plain text user message' }], // not a screenshot
      },
      userScreenshot('s1'),
      userScreenshot('s2'),
      userScreenshot('s3'),
    ]

    applyScreenshotWindow(messages, { first: 1, recent: 1 })

    // 4 image-bearing messages → keep first(#0) + recent(#4); elide #2 and #3.
    expect(countScreenshots(messages)).toBe(2)
    // The plain text user message at #1 is left alone.
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'plain text user message' },
    ])
  })
})

describe('runComputerUseLoop — screenshot window plumbed end-to-end', () => {
  it('keeps initial + last 2 screenshots by default after many turns', async () => {
    const driver = new FakeDriver()
    const turns = [
      // 4 model turns each emitting a click, then a closing text turn.
      ...Array.from({ length: 4 }, () => ({
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
          },
        ],
      })),
      { content: 'done' },
    ]
    const { streamChat, invocations } = scriptedStreamChat(turns)
    await runComputerUseLoop({
      task: 'do the thing',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
    })

    // The LAST request the model saw should have at most first(1) + recent(2)
    // screenshots in its messages array, regardless of how many turns ran.
    const lastMessages = invocations.at(-1)!.messages
    const screenshots = lastMessages.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    )
    expect(screenshots.length).toBeLessThanOrEqual(3)
  })

  it('respects screenshotWindow:false (no elision; every frame retained)', async () => {
    const driver = new FakeDriver()
    const turns = [
      ...Array.from({ length: 4 }, () => ({
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
          },
        ],
      })),
      { content: 'done' },
    ]
    const { streamChat, invocations } = scriptedStreamChat(turns)
    await runComputerUseLoop({
      task: 'do the thing',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      screenshotWindow: false,
    })

    const lastMessages = invocations.at(-1)!.messages
    const screenshots = lastMessages.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    )
    // Initial screen + 4 action screenshots → 5 image messages, all retained.
    expect(screenshots.length).toBe(5)
  })

  it('honors a custom window policy (first:1, recent:1)', async () => {
    const driver = new FakeDriver()
    const turns = [
      ...Array.from({ length: 5 }, () => ({
        toolCalls: [
          {
            name: 'computer',
            arguments: JSON.stringify({ type: 'click', x: 1, y: 1 }),
          },
        ],
      })),
      { content: 'done' },
    ]
    const { streamChat, invocations } = scriptedStreamChat(turns)
    const events: LoopEvent[] = []
    await runComputerUseLoop({
      task: 'do the thing',
      manifest: MANIFEST,
      driver,
      streamChat,
      modelName: 'qwen3-vl',
      screenshotWindow: { first: 1, recent: 1 },
      onEvent: (e) => events.push(e),
    })

    const lastMessages = invocations.at(-1)!.messages
    const screenshots = lastMessages.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    )
    expect(screenshots.length).toBeLessThanOrEqual(2)

    // The audit trail (frames emitted via onEvent) keeps every action_result
    // regardless of the window — the windowing is purely model-facing.
    const actionResults = events.filter((e) => e.type === 'action_result')
    expect(actionResults.length).toBe(5)
  })
})
