import { initialChat, reduceEvent } from '@/services/harness/reducer'
import type { Frame, HarnessErrorBody } from '@/services/harness/types'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The runs the harness recorded, each with the chat a client that applies
// its frames in order must show.
interface RecordedRun {
  description: string
  frames: Frame[]
  expected: {
    messages: unknown[]
    title: string
    titleState: string
    status: 'idle' | 'error'
    error?: HarnessErrorBody
  }
}

const FIXTURES = 'harness-protocol/fixtures'
const runs = Object.fromEntries(
  readdirSync(FIXTURES).map((name): [string, RecordedRun] => [
    name,
    JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8')),
  ]),
)

const STEP_MEMBERS = [
  'id',
  'type',
  'content',
  'toolCallId',
  'name',
  'arguments',
  'complete',
  'result',
  'progress',
  'display',
] as const

describe('recorded harness runs', () => {
  it('are vendored', () => {
    expect(Object.keys(runs).length).toBeGreaterThan(0)
  })

  it.each(Object.entries(runs))('%s', (_, run) => {
    const state = run.frames.reduce(
      (chat, frame) => reduceEvent(chat, frame),
      initialChat(),
    )
    expect({
      messages: state.messages.map((message) => ({
        id: message.id,
        role: message.role,
        ...(message.role === 'user' ? { content: message.content ?? '' } : {}),
        timeline: (message.timeline ?? []).map((step) =>
          Object.fromEntries(
            STEP_MEMBERS.flatMap((member) =>
              step[member] === undefined ? [] : [[member, step[member]]],
            ),
          ),
        ),
      })),
      title: state.snapshot.thread?.title,
      titleState: state.snapshot.thread?.titleState,
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
    }).toEqual(run.expected)
  })
})
