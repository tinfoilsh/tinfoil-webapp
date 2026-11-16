import { initialChat, reduceEvent } from '@/services/harness/reducer'
import type { ConnectorCall, Frame } from '@/services/harness/types'
import {
  messageView,
  shownMessages,
  type ShownMessage,
} from '@/services/harness/view-model'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The harness's recorded reply that calls a connector's tool, which waits
// for the user to approve it, then answers from what the tool returned.
const recorded: { frames: Frame[] } = JSON.parse(
  readFileSync('harness-protocol/fixtures/connector-approval.json', 'utf8'),
)

// The chat once the run's frames up to and including the one at `last`
// applied.
const replayedThrough = (last: number) =>
  recorded.frames
    .slice(0, last + 1)
    .reduce((chat, frame) => reduceEvent(chat, frame), initialChat())

const lastIndexOf = (type: Frame['event']['type']) =>
  recorded.frames.findLastIndex(({ event }) => event.type === type)

// The display the frame at `index` gives its call, an ACTIVITY_DELTA's.
const deltaDisplay = (index: number) => {
  const { event } = recorded.frames[index]
  return event.type === 'ACTIVITY_DELTA' ? event.display : undefined
}

const callOf = (frames: number) => {
  const reply = shownMessages(replayedThrough(frames).messages).at(-1)!
  return reply.timeline!.find((block) => block.type === 'tool_call')!
}

describe('a call to a connector’s tool in a run', () => {
  const pending = recorded.frames.findIndex(
    ({ event }) =>
      event.type === 'ACTIVITY_DELTA' &&
      event.display?.connector?.approval?.status === 'pending',
  )
  const approved = recorded.frames.findIndex(
    ({ event }) =>
      event.type === 'ACTIVITY_DELTA' &&
      event.display?.connector?.approval?.status === 'approved',
  )

  it('shows each display an activity delta replaces the last with', () => {
    expect(pending).toBeGreaterThan(0)
    expect(approved).toBeGreaterThan(pending)

    const waiting = callOf(pending)
    expect(waiting.display).toEqual(deltaDisplay(pending))
    expect(waiting.display?.connector?.approval).toMatchObject({
      status: 'pending',
      id: expect.any(String),
      expiresAt: expect.any(String),
    })

    // The approved call's display is the delta's own: nothing of the
    // pending approval is left.
    const running = callOf(approved)
    expect(running.display).toEqual(deltaDisplay(approved))
    expect(running.display?.connector?.approval).toEqual({
      status: 'approved',
    })
  })

  it('waits for approval while the reply streams, and ends with what the tool returned', () => {
    const streaming = shownMessages(replayedThrough(pending).messages).at(-1)!
    const connector = deltaDisplay(pending)!.connector!
    expect(messageView(streaming, true).timeline).toContainEqual(
      expect.objectContaining({
        type: 'connector_call',
        id: 'app-call',
        tool: 'create_page',
        title: 'Create a page',
        status: 'running',
        arguments: '{"title":"Plans"}',
        approval: {
          id: connector.approval!.id,
          expiresAt: connector.approval!.expiresAt,
        },
      }),
    )

    const finished = shownMessages(
      replayedThrough(lastIndexOf('RUN_FINISHED')).messages,
    ).at(-1)!
    const [call] = messageView(finished).timeline!
    expect(call).toMatchObject({
      type: 'connector_call',
      connector: {
        id: connector.id,
        name: 'Fake',
        url: 'https://mcp.example.test/mcp',
      },
      status: 'completed',
      output: 'created Plans',
    })
    expect(call).not.toHaveProperty('approval')
  })
})

// A reply holding one call to a connector's tool, as a stored chat keeps it.
const replyCalling = (
  display: { status: string; approval?: ConnectorCall['approval'] },
  result?: unknown,
): ShownMessage => ({
  id: 'a1',
  role: 'assistant',
  createdAt: '2026-11-01T09:00:00Z',
  timeline: [
    {
      id: 'call-1',
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'docs__create_page',
      arguments: '{"title":"Plans"}',
      ...(result !== undefined ? { result } : {}),
      display: {
        status: display.status,
        sources: [],
        connector: {
          id: 'connector-1',
          name: 'Docs',
          url: 'https://mcp.docs.example/mcp',
          tool: 'create_page',
          ...(display.approval ? { approval: display.approval } : {}),
        },
      },
    },
  ],
})

describe('a stored call to a connector’s tool', () => {
  it.each([
    ['declined', { status: 'declined' }, 'declined'],
    ['not answered in time', { status: 'expired' }, 'expired'],
    // An answer of a status this client does not know shows as declined.
    ['answered in a later way', { status: 'withdrawn' }, 'declined'],
  ])('says the user %s it', (_, approval, status) => {
    const [call] = messageView(
      replyCalling({ status: 'failed', approval }, { error: approval.status }),
    ).timeline!
    expect(call).toMatchObject({ type: 'connector_call', status })
    expect(call).not.toHaveProperty('output')
  })

  it('shows a call left waiting for approval as failed once its reply stopped', () => {
    const [call] = messageView(
      replyCalling({
        status: 'running',
        approval: {
          id: 'approval-1',
          status: 'pending',
          expiresAt: '2026-11-01T09:10:00Z',
        },
      }),
    ).timeline!
    expect(call).toMatchObject({ type: 'connector_call', status: 'failed' })
    expect(call).not.toHaveProperty('approval')
  })

  it('leaves out a tool call the harness reports no connector of', () => {
    const message = replyCalling({ status: 'completed' })
    delete message.timeline![0].display!.connector
    expect(messageView(message).timeline).toEqual([])
  })
})
