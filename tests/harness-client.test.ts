import { API_BASE_URL } from '@/config'
import { HarnessClient } from '@/services/harness/client'
import {
  INFERENCE_KEY_HEADER,
  type HarnessRoute,
} from '@/services/harness/protocol'
import { initialChat, reduceEvent } from '@/services/harness/reducer'
import { HarnessError, readEvents } from '@/services/harness/sse'
import type {
  Frame,
  Json,
  Message,
  QueueItem,
  RateLimit,
  TimelineBlock,
} from '@/services/harness/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubChatAccess } from './harness-fixture'

vi.mock('tinfoil', () => ({ SecureClient: vi.fn() }))

const transport = () => ({
  ready: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn(),
  getVerificationDocument: vi.fn(),
})

function stream(text: string, bytesPerChunk = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) controller.close()
      else {
        controller.enqueue(bytes.slice(offset, offset + bytesPerChunk))
        offset += Math.min(bytesPerChunk, bytes.length - offset)
      }
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const frames: Frame[] = []
  for await (const frame of readEvents(body)) frames.push(frame)
  return frames
}

describe('harness SSE', () => {
  it('reads split UTF-8, CRLF, comments, multiline data and cursor zero', async () => {
    const frames = await collect(
      stream(
        ': heartbeat\r\n\r\nid: 0\r\ndata: {"type":"TEXT_MESSAGE_CHUNK",\r\ndata: "messageId":"m","delta":"🙂 café"}\r\n\r\ndata: {"type":"RUN_FINISHED"}\r\n\r\n',
      ),
    )
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ id: 0, event: { delta: '🙂 café' } })
    expect(frames[1].id).toBeUndefined()
  })
  it('requires a terminal event and rejects invalid cursors and JSON', async () => {
    await expect(
      collect(stream('data: {"type":"RUN_STARTED"}\n\n')),
    ).rejects.toMatchObject({ detail: { code: 'STREAM_INTERRUPTED' } })
    await expect(
      collect(stream('id: -1\ndata: {"type":"RUN_FINISHED"}\n\n')),
    ).rejects.toMatchObject({ detail: { code: 'INVALID_STREAM' } })
    await expect(collect(stream('data: nope\n\n'))).rejects.toMatchObject({
      detail: { code: 'INVALID_STREAM' },
    })
  })
})

describe('harness reducer', () => {
  // A turn queued behind the running reply, as a run's state lists it.
  const queued = (queueId: string, content: string): QueueItem => ({
    queueId,
    kind: 'send',
    content,
    quote: null,
    attachments: [],
    createdAt: '2026-10-01T00:00:00Z',
  })
  it('applies committed metadata to each reply without changing earlier replies', () => {
    let state = initialChat()
    state.messages = [
      {
        id: 'old',
        role: 'assistant',
        createdAt: '',
        content: 'Earlier answer',
      },
    ]
    state = reduceEvent(state, {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId: 't',
        runId: 'run',
        instance: 'instance-1',
      },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        role: 'assistant',
        delta: 'A sourced answer.',
      },
    })
    const metadata = {
      id: 'answer',
      model: 'gpt-oss-120b',
      modelDisplayName: 'GPT-OSS',
      annotations: [
        {
          type: 'url_citation' as const,
          url_citation: {
            url: 'https://example.org',
            title: 'Source',
            start_index: 0,
            end_index: 17,
          },
        },
      ],
      usage: { promptTokens: 17, completionTokens: 4 },
      isError: true,
      isInterrupted: false,
    }
    const finished = reduceEvent(state, {
      id: 2,
      event: {
        type: 'RUN_ERROR',
        threadId: 't',
        runId: 'run',
        code: 'UPSTREAM_REFUSED',
        message: 'The model could not finish the reply.',
        action: 'retry',
        metadata: { messages: [metadata] },
      },
    })
    expect(finished.messages[0]).toBe(state.messages[0])
    expect(finished.messages[1]).toMatchObject(metadata)
    expect(finished.messages[1].timeline).toEqual(state.messages[1].timeline)
    expect(state.messages[1]).not.toHaveProperty('annotations')
  })
  it('keeps the active run when a separately streamed queued turn is removed', () => {
    let state = reduceEvent(initialChat(), {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        runId: 'active',
        threadId: 't',
        instance: 'instance-1',
      },
    })
    state = reduceEvent(state, {
      id: 0,
      event: {
        type: 'STATE_DELTA',
        runId: 'queued',
        delta: [
          {
            op: 'add',
            path: '/queue/-',
            value: queued('queued', 'later'),
          },
        ],
      },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'queued',
        metadata: { cancelled: true },
      },
    })
    expect(state.status).toBe('streaming')
    expect(state.runId).toBe('active')
    expect(state.snapshot.queue).toEqual([])
    state = reduceEvent(state, {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId: 't',
        runId: 'next',
        instance: 'instance-1',
      },
    })
    state = reduceEvent(state, {
      id: 2,
      event: {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'active',
        metadata: {},
      },
    })
    expect(state.status).toBe('streaming')
    expect(state.runId).toBe('next')
  })
  it('replaces the cursor snapshot, deduplicates deltas and retries the same widget', () => {
    let state = initialChat()
    const frames: Frame[] = [
      {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          runId: 'r',
          threadId: 't',
          instance: 'instance-1',
        },
      },
      {
        id: 1,
        event: {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm',
          role: 'assistant',
          delta: 'Keep this',
        },
      },
      {
        id: 2,
        event: {
          type: 'TOOL_CALL_START',
          parentMessageId: 'm',
          toolCallId: 'call',
          toolCallName: 'render_clock',
        },
      },
      {
        id: 3,
        event: {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'call',
          delta: '{"durationSeconds":1}',
        },
      },
      {
        id: 4,
        event: {
          type: 'TOOL_CALL_RESULT',
          messageId: 'tool-result',
          toolCallId: 'call',
          role: 'tool',
          content: { result: 'kept' },
        },
      },
    ]
    for (const frame of frames) state = reduceEvent(state, frame)
    expect(reduceEvent(state, frames[1])).toBe(state)
    state = reduceEvent(state, {
      event: {
        type: 'MESSAGES_SNAPSHOT',
        messages: state.messages,
        hasOlder: false,
      },
    })
    state.messages[0].timeline![1].invalidArguments = true
    state = reduceEvent(state, {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        runId: 'retry',
        threadId: 't',
        instance: 'instance-1',
      },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'TOOL_CALL_START',
        parentMessageId: 'm',
        toolCallId: 'call',
        toolCallName: 'render_clock',
      },
    })
    state = reduceEvent(state, {
      id: 2,
      event: {
        type: 'TOOL_CALL_ARGS',
        toolCallId: 'call',
        delta: '{"durationSeconds":2}',
      },
    })
    state = reduceEvent(state, {
      id: 3,
      event: { type: 'TOOL_CALL_END', toolCallId: 'call' },
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].timeline![1].invalidArguments).not.toBe(true)
    expect(state.messages[0].timeline).toEqual([
      { id: 'm_content_0', type: 'content', content: 'Keep this' },
      expect.objectContaining({
        toolCallId: 'call',
        arguments: '{"durationSeconds":2}',
        complete: true,
        result: { result: 'kept' },
      }),
    ])
  })
  it('keeps thinking, text, tools and progress in order and marks cancelled partial output', () => {
    let state = initialChat()
    const events: Frame['event'][] = [
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'm-reasoning',
        delta: 'Think',
      },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'm',
        role: 'assistant',
        delta: 'Text',
      },
      {
        type: 'TOOL_CALL_START',
        parentMessageId: 'm',
        toolCallId: 'c',
        toolCallName: 'python',
      },
      {
        type: 'ACTIVITY_SNAPSHOT',
        messageId: 'act_c',
        activityType: 'TOOL',
        content: { toolCallId: 'c', tool: 'python', progress: 0, output: [] },
      },
      {
        type: 'ACTIVITY_DELTA',
        messageId: 'act_c',
        activityType: 'TOOL',
        patch: [{ op: 'add' as const, path: '/output/-', value: '1' }],
      },
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        metadata: {
          cancelled: true,
          messages: [{ id: 'm', isInterrupted: true }],
        },
      },
    ]
    for (const event of events) state = reduceEvent(state, { event })
    expect(state.messages[0].timeline?.map((b) => b.type)).toEqual([
      'thinking',
      'content',
      'tool_call',
    ])
    expect(state.messages[0].timeline?.[2].progress).toEqual(['1'])
    expect(state.messages[0].isInterrupted).toBe(true)
  })
  const summary = {
    id: 't',
    title: 'New Chat',
    titleState: 'placeholder',
    createdAt: 't0',
    updatedAt: 't0',
    activityAt: 't0',
    model: 'test-model',
    projectId: null,
    pinned: false,
    webSearchEnabled: true,
    contextUsage: null,
    messageCount: 1,
    activeRun: null,
  } as const
  it('applies the queue and title changes a run sends, and refuses others', () => {
    let state = reduceEvent(initialChat(), {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        runId: 'r',
        threadId: 't',
        instance: 'instance-1',
      },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: summary,
          queue: [queued('q1', 'first')],
          rateLimit: { kind: null },
        },
      },
    })
    const before = state
    state = reduceEvent(state, {
      id: 2,
      event: {
        type: 'STATE_DELTA',
        delta: [
          {
            op: 'add',
            path: '/queue/-',
            value: queued('q2', 'second'),
          },
          { op: 'replace', path: '/thread/title', value: 'Named' },
          { op: 'replace', path: '/thread/titleState', value: 'generated' },
        ],
      },
    })
    expect(state.snapshot).toEqual({
      thread: { ...summary, title: 'Named', titleState: 'generated' },
      queue: [queued('q1', 'first'), queued('q2', 'second')],
      rateLimit: { kind: null },
    })
    expect(before.snapshot).toEqual({
      thread: summary,
      queue: [queued('q1', 'first')],
      rateLimit: { kind: null },
    })
    state = reduceEvent(state, {
      id: 3,
      event: {
        type: 'STATE_DELTA',
        delta: [{ op: 'replace', path: '/queue', value: [] }],
      },
    })
    expect(state.snapshot.queue).toEqual([])
    expect(() =>
      reduceEvent(state, {
        id: 4,
        event: {
          type: 'STATE_DELTA',
          delta: [{ op: 'remove', path: '/queue/0' }] as never,
        },
      }),
    ).toThrow(HarnessError)
  })
  it('leaves the snapshot as it was when a later change of a delta is refused', () => {
    const state = reduceEvent(initialChat(), {
      id: 0,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: summary,
          queue: [queued('q1', 'first')],
          rateLimit: { kind: null },
        },
      },
    })
    const before = structuredClone(state.snapshot)

    expect(() =>
      reduceEvent(state, {
        id: 1,
        event: {
          type: 'STATE_DELTA',
          delta: [
            {
              op: 'add',
              path: '/queue/-',
              value: queued('q2', 'second'),
            },
            { op: 'remove', path: '/queue/0' },
          ] as never,
        },
      }),
    ).toThrow(HarnessError)

    expect(state.snapshot).toEqual(before)
  })
  // Timed reply events, from STEPS_START: a reply's reasoning and text, each
  // at the second given.
  const STEPS_START = Date.UTC(2026, 9, 1)
  const stepAt = (seconds: number) =>
    new Date(STEPS_START + seconds * 1000).toISOString()
  const reasoning = (delta: string, seconds: number): Frame['event'] => ({
    type: 'REASONING_MESSAGE_CHUNK',
    messageId: 'r-reasoning',
    delta,
    timestamp: stepAt(seconds),
  })
  const text = (delta: string, seconds: number): Frame['event'] => ({
    type: 'TEXT_MESSAGE_CHUNK',
    messageId: 'r',
    role: 'assistant',
    delta,
    timestamp: stepAt(seconds),
  })
  // Reasoning for 2.5 seconds, then the reply's text.
  const thoughtThenAnswer = [
    reasoning('Plan', 0),
    reasoning('ning', 2.5),
    text('Answer', 3),
  ]
  const reduceAll = (events: Frame['event'][]) =>
    events.reduce(
      (state, event) => reduceEvent(state, { event }),
      initialChat(),
    )

  it('records when each reasoning and tool step ran, as the harness does', () => {
    const start = STEPS_START
    const state = reduceAll([
      ...thoughtThenAnswer,
      {
        type: 'TOOL_CALL_START',
        parentMessageId: 'r',
        toolCallId: 's',
        toolCallName: 'web_search',
        timestamp: stepAt(4),
      },
      {
        type: 'TOOL_CALL_RESULT',
        messageId: 'tool-result',
        toolCallId: 's',
        role: 'tool',
        content: { results: [] },
        timestamp: stepAt(6),
      },
      reasoning('Next', 7),
      reasoning(' step', 8.25),
    ])
    expect(state.messages[0].timeline).toEqual([
      {
        id: 'r_thinking_0',
        type: 'thinking',
        content: 'Planning',
        startedAt: start,
        endedAt: start + 2_500,
        duration: 2.5,
      },
      { id: 'r_content_1', type: 'content', content: 'Answer' },
      {
        id: 's',
        toolCallId: 's',
        type: 'tool_call',
        name: 'web_search',
        arguments: '',
        complete: false,
        progress: [],
        result: { results: [] },
        startedAt: start + 4_000,
        endedAt: start + 6_000,
      },
      {
        id: 'r_thinking_3',
        type: 'thinking',
        content: 'Next step',
        startedAt: start + 7_000,
        endedAt: start + 8_250,
        duration: 1.25,
      },
    ])
  })
  it('marks a widget call as invalid once the harness refuses its arguments', () => {
    const call = (
      toolCallId: string,
      name: string,
      content: Json,
    ): Frame['event'][] => [
      {
        type: 'TOOL_CALL_START',
        parentMessageId: 'r',
        toolCallId,
        toolCallName: name,
      },
      { type: 'TOOL_CALL_ARGS', toolCallId, delta: '{"url":"x"}' },
      { type: 'TOOL_CALL_END', toolCallId },
      {
        type: 'TOOL_CALL_RESULT',
        messageId: `tool-${toolCallId}`,
        toolCallId,
        role: 'tool',
        content,
      },
    ]
    const refusal = { status: 'error', error: 'The arguments did not match.' }
    let state = initialChat()
    for (const event of [
      ...call('refused', 'render_link_preview', refusal),
      ...call('unread', 'render_link_preview', { error: 'Not found' }),
      ...call('search', 'web_search', refusal),
    ])
      state = reduceEvent(state, { event })
    expect(state.messages[0].timeline).toEqual([
      {
        id: 'refused',
        toolCallId: 'refused',
        type: 'tool_call',
        name: 'render_link_preview',
        arguments: '{"url":"x"}',
        complete: true,
        progress: [],
        result: refusal,
        invalidArguments: true,
      },
      expect.not.objectContaining({ invalidArguments: true }),
      expect.not.objectContaining({ invalidArguments: true }),
    ])
  })
  it('keeps late reasoning with the thought the reply text closed', () => {
    const state = reduceAll([
      ...thoughtThenAnswer,
      reasoning(' late', 3.2),
      text(' done', 3.4),
    ])
    expect(state.messages[0].timeline).toEqual([
      {
        id: 'r_thinking_0',
        type: 'thinking',
        content: 'Planning late',
        startedAt: STEPS_START,
        endedAt: STEPS_START + 2_500,
        duration: 2.5,
      },
      { id: 'r_content_1', type: 'content', content: 'Answer done' },
    ])
  })
  it('leaves the state a frame was applied to as it was', () => {
    const started = reduceEvent(initialChat(), {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        runId: 'r',
        threadId: 't',
        instance: 'instance-1',
      },
    })
    const first = reduceEvent(started, {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'm',
        role: 'assistant',
        delta: 'Hello',
      },
    })
    const second = reduceEvent(first, {
      id: 2,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'm',
        role: 'assistant',
        delta: ' there',
      },
    })

    expect(first.messages[0].timeline).toEqual([
      { id: 'm_content_0', type: 'content', content: 'Hello' },
    ])
    expect(second.messages[0].timeline).toEqual([
      { id: 'm_content_0', type: 'content', content: 'Hello there' },
    ])
    expect(started.messages).toEqual([])
    expect(first.cursors).toEqual({ r: 1 })
  })
})

describe('continuing a reply', () => {
  const user: Message = {
    id: 'u1',
    role: 'user',
    createdAt: 't0',
    content: 'Tell me a story',
  }
  function reply(...timeline: TimelineBlock[]): Message {
    return { id: 'a1', role: 'assistant', createdAt: 't1', timeline }
  }
  function run(window: Message[], ...events: Frame['event'][]) {
    let state = initialChat()
    for (const [id, event] of [
      {
        type: 'RUN_STARTED',
        threadId: 't',
        runId: 'run-2',
        instance: 'instance-1',
        messageId: 'a1',
      },
      { type: 'MESSAGES_SNAPSHOT', messages: window, hasOlder: false },
      ...events,
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'run-2',
        metadata: {
          messages: [{ id: 'a1', isError: false, isInterrupted: false }],
        },
      },
    ].entries())
      state = reduceEvent(state, { id, event: event as Frame['event'] })
    return state
  }

  it('extends the trailing text of the reply RUN_STARTED names', () => {
    const state = run(
      [
        user,
        reply(
          { id: 'r', type: 'thinking', content: 'plan' },
          { id: 'c', type: 'content', content: 'Once upon' },
        ),
      ],
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'a1',
        role: 'assistant',
        delta: ' a time',
      },
    )
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].timeline).toEqual([
      { id: 'r', type: 'thinking', content: 'plan' },
      { id: 'c', type: 'content', content: 'Once upon a time' },
    ])
    expect(state.messages[1].isError).toBe(false)
  })

  it('starts new blocks after a reply that ended in reasoning or a tool call', () => {
    const state = run(
      [
        user,
        reply(
          { id: 'r', type: 'thinking', content: 'plan' },
          {
            id: 'call',
            type: 'tool_call',
            toolCallId: 'call',
            name: 'render_chart',
            arguments: '{}',
            complete: true,
          },
        ),
      ],
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'a1',
        role: 'assistant',
        delta: 'Here it is.',
      },
    )
    expect(state.messages[1].timeline?.map((block) => block.type)).toEqual([
      'thinking',
      'tool_call',
      'content',
    ])
    expect(state.messages[1].timeline?.[2]).toMatchObject({
      id: 'a1_content_2',
      content: 'Here it is.',
    })
  })

  it('keeps finished reasoning apart from new reasoning', () => {
    const state = run(
      [user, reply({ id: 'r', type: 'thinking', content: 'first' })],
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'a1-reasoning',
        delta: 'second',
      },
    )
    expect(state.messages[1].timeline).toEqual([
      { id: 'r', type: 'thinking', content: 'first' },
      { id: 'a1_thinking_1', type: 'thinking', content: 'second' },
    ])
  })

  it('does not add new reasoning to a thought the stored reply finished', () => {
    const state = run(
      [
        user,
        reply(
          { id: 'r', type: 'thinking', content: 'first' },
          { id: 'c', type: 'content', content: 'Once upon' },
        ),
      ],
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'a1-reasoning',
        delta: 'second',
      },
    )
    expect(state.messages[1].timeline).toEqual([
      { id: 'r', type: 'thinking', content: 'first' },
      { id: 'c', type: 'content', content: 'Once upon' },
      { id: 'a1_thinking_2', type: 'thinking', content: 'second' },
    ])
  })
})

describe('attested harness transport', () => {
  beforeEach(() => {
    stubChatAccess()
  })
  // The harness's refusal of an expired Clerk session.
  const expiredSession = () =>
    Response.json(
      {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Expired session',
          action: 'reauthenticate',
        },
      },
      { status: 401 },
    )
  it('refreshes an expired Clerk JWT once while retaining the same turn nonce and body', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'fr'])
    const secure = transport()
    secure.fetch
      .mockResolvedValueOnce(expiredSession())
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    const getToken = vi
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('fresh')
    const client = new HarnessClient(
      'https://harness.example',
      getToken,
      () => secure,
    )
    const body = { key: 'cek', clientRequestId: 'nonce' }
    await expect(client.post('/v1/threads/turn', body)).resolves.toEqual({
      ok: true,
    })
    expect(getToken).toHaveBeenLastCalledWith({ skipCache: true })
    expect(
      secure.fetch.mock.calls.map((call) =>
        new Headers(call[1].headers).get('Authorization'),
      ),
    ).toEqual(['Bearer old', 'Bearer fresh'])
    expect(
      secure.fetch.mock.calls.map((call) =>
        new Headers(call[1].headers).get('Accept-Language'),
      ),
    ).toEqual(['fr-FR,fr', 'fr-FR,fr'])
    expect(
      secure.fetch.mock.calls.every(
        (call) =>
          call[0] === 'https://harness.example/v1/threads/turn' &&
          call[1].body === JSON.stringify(body),
      ),
    ).toBe(true)
  })
  it('reads a token for each request', async () => {
    const secure = transport()
    secure.fetch.mockImplementation(async () => new Response('{}'))
    const client = new HarnessClient(
      'https://harness.example',
      vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second'),
      () => secure,
    )
    await client.post('/v1/session', {})
    await client.post('/v1/session', {})
    expect(
      secure.fetch.mock.calls.map((call) =>
        new Headers(call[1].headers).get('Authorization'),
      ),
    ).toEqual(['Bearer first', 'Bearer second'])
  })
  it('never downgrades rejected authentication to anonymous', async () => {
    const secure = transport()
    secure.fetch.mockResolvedValueOnce(expiredSession())
    const client = new HarnessClient(
      'https://harness.example',
      vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce(null),
      () => secure,
    )
    await expect(client.post('/v1/session', {})).rejects.toMatchObject({
      status: 401,
    })
    expect(secure.fetch).toHaveBeenCalledTimes(1)
  })
  // A refusal signing in again cannot change: a key this device must unlock,
  // or a stored chat a signed-out caller asked for.
  it.each([
    { code: 'KEY_REQUIRED', action: 'unlock' },
    { code: 'UNAUTHENTICATED', action: 'stop' },
  ])(
    'sends a request the harness refused with $action once',
    async ({ code, action }) => {
      const secure = transport()
      secure.fetch.mockResolvedValueOnce(
        Response.json(
          { error: { code, message: 'Refused', action } },
          { status: 401 },
        ),
      )
      const getToken = vi.fn().mockResolvedValue('clerk')
      const client = new HarnessClient(
        'https://harness.example',
        getToken,
        () => secure,
      )
      await expect(client.post('/v1/threads/get', {})).rejects.toMatchObject({
        status: 401,
        detail: { code, action },
      })
      expect(secure.fetch).toHaveBeenCalledTimes(1)
      expect(getToken).not.toHaveBeenCalledWith({ skipCache: true })
    },
  )
  it('signs in again for a 401 from a harness that names no action', async () => {
    const secure = transport()
    secure.fetch
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'UNAUTHENTICATED', message: 'Expired session' } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    const client = new HarnessClient(
      'https://harness.example',
      vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('fresh'),
      () => secure,
    )
    await expect(client.post('/v1/session', {})).resolves.toEqual({ ok: true })
    expect(
      secure.fetch.mock.calls.map((call) =>
        new Headers(call[1].headers).get('Authorization'),
      ),
    ).toEqual(['Bearer old', 'Bearer fresh'])
  })
  it('names the last event a follow applied in Last-Event-ID, apart from its body', async () => {
    const secure = transport()
    secure.fetch.mockImplementation(
      async () =>
        new Response(
          stream(
            `id: 3\ndata: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', metadata: {} })}\n\n`,
          ),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    )
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      () => secure,
    )
    const ids: (number | undefined)[] = []
    for (const lastEventId of [2, undefined])
      for await (const frame of client.events('/v1/threads/follow', {
        threadId: 't',
        runId: 'r',
        ...(lastEventId === undefined ? {} : { lastEventId }),
      }))
        ids.push(frame.id)
    expect(ids).toEqual([3, 3])
    expect(
      secure.fetch.mock.calls.map(([, init]) => [
        new Headers(init.headers).get('Last-Event-ID'),
        JSON.parse(init.body),
      ]),
    ).toEqual([
      ['2', { threadId: 't', runId: 'r' }],
      [null, { threadId: 't', runId: 'r' }],
    ])
  })
  it("sends requests about a chat's run to the instance its run named", async () => {
    const secure = transport()
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      () => secure,
    )
    const run = (instance: string) =>
      new Response(
        stream(
          `id: 0\ndata: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 't', runId: 'r', instance })}\n\n` +
            `id: 1\ndata: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', metadata: {} })}\n\n`,
        ),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    secure.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/v1/threads/follow')
        ? run('instance-2')
        : Response.json({}),
    )
    secure.fetch.mockResolvedValueOnce(run('instance-1'))
    // Each run is read to its end, as the client reads it.
    const typesOf = async (frames: AsyncIterable<Frame>) => {
      const types: string[] = []
      for await (const frame of frames) types.push(frame.event.type)
      return types
    }
    expect(
      await typesOf(
        client.events('/v1/threads/turn', {
          clientRequestId: 'nonce',
          threadId: 't',
        }),
      ),
    ).toEqual(['RUN_STARTED', 'RUN_FINISHED'])
    await client.post('/v1/threads/cancel', { threadId: 't', runId: 'r' })
    await client.post('/v1/threads/queue/send', { threadId: 't', queueId: 'q' })
    await client.post('/v1/threads/queue/remove', {
      threadId: 't',
      queueId: 'q',
    })
    await client.post('/v1/threads/cancel', { threadId: 'other', runId: 'o' })
    expect(
      await typesOf(
        client.events('/v1/threads/follow', { threadId: 't', runId: 'r' }),
      ),
    ).toEqual(['RUN_STARTED', 'RUN_FINISHED'])
    // A run another instance holds now names that one.
    await client.post('/v1/threads/cancel', { threadId: 't', runId: 'r' })
    // A chat's running hint names the instance of a run this client did not
    // see start.
    client.locate('other', 'instance-3')
    await client.post('/v1/threads/cancel', { threadId: 'other', runId: 'o' })
    expect(
      secure.fetch.mock.calls.map(([url, init]) => [
        new URL(url).pathname,
        new Headers(init.headers).get('X-Tinfoil-Harness-Instance'),
      ]),
    ).toEqual([
      ['/v1/threads/turn', null],
      ['/v1/threads/cancel', 'instance-1'],
      ['/v1/threads/queue/send', 'instance-1'],
      ['/v1/threads/queue/remove', 'instance-1'],
      ['/v1/threads/cancel', null],
      ['/v1/threads/follow', 'instance-1'],
      ['/v1/threads/cancel', 'instance-2'],
      ['/v1/threads/cancel', 'instance-3'],
    ])
  })
  it('uses the same verified connection for multipart, binary, and follow requests', async () => {
    const secure = transport()
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      () => secure,
    )
    secure.fetch.mockResolvedValueOnce(new Response('{"id":"attachment"}'))
    await client.upload(
      '/v1/attachments/upload',
      new File(['hello'], 'file.txt'),
      { ephemeral: 'true' },
    )
    const form = secure.fetch.mock.calls[0][1].body as FormData
    expect(form.get('ephemeral')).toBe('true')
    expect((form.get('file') as File).name).toBe('file.txt')
    expect(
      new Headers(secure.fetch.mock.calls[0][1].headers).has('Content-Type'),
    ).toBe(false)
    secure.fetch.mockResolvedValueOnce(new Response('file'))
    expect((await client.download('/v1/export', {})).size).toBe(4)
    secure.fetch.mockResolvedValueOnce(
      new Response(stream('data: {"type":"RUN_FINISHED"}\n\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    for await (const frame of client.events('/v1/threads/follow', {
      threadId: 't',
      runId: 'r',
    }))
      expect(frame.event.type).toBe('RUN_FINISHED')
    expect(JSON.parse(secure.fetch.mock.calls[2][1].body)).toEqual({
      threadId: 't',
      runId: 'r',
    })
  })
  it('abandons an attestation that stalls and verifies again with a new client', async () => {
    vi.useFakeTimers()
    try {
      const stalled = transport()
      stalled.ready.mockReturnValue(new Promise(() => {}))
      const fresh = transport()
      fresh.fetch.mockResolvedValue(new Response('{"ok":true}'))
      const created = [stalled, fresh]
      const client = new HarnessClient(
        'https://harness.example',
        async () => 'clerk',
        () => created.shift()!,
      )

      const stuck = expect(
        client.post('/v1/session', {}),
      ).rejects.toMatchObject({ code: 'CONNECTION' })
      await vi.advanceTimersByTimeAsync(20_000)
      await stuck

      await expect(client.post('/v1/session', {})).resolves.toEqual({
        ok: true,
      })
      expect(created).toEqual([])
      expect(stalled.fetch).not.toHaveBeenCalled()
      expect(fresh.fetch).toHaveBeenCalledExactlyOnceWith(
        'https://harness.example/v1/session',
        expect.objectContaining({ method: 'POST', body: '{}' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not send keys or JWTs to arbitrary URLs', async () => {
    const secure = transport()
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      () => secure,
    )
    for (const path of [
      'https://other.example/v1/session',
      '//other.example/v1/session',
      '/v1/../session',
      '/v1/session?key=secret',
    ])
      await expect(
        client.post(path as HarnessRoute, { key: 'cek' }),
      ).rejects.toBeInstanceOf(HarnessError)
    expect(secure.fetch).not.toHaveBeenCalled()
    expect(
      () =>
        new HarnessClient(
          'http://harness.example',
          async () => null,
          () => secure,
        ),
    ).toThrow(HarnessError)
  })
})

describe('chat access a signed-in client mints', () => {
  const CONTROLPLANE = API_BASE_URL || 'https://api.tinfoil.sh'
  const expiresAt = () => new Date(Date.now() + 15 * 60_000).toISOString()
  // What each request to the harness carried as its chat access.
  const access = (secure: ReturnType<typeof transport>) =>
    secure.fetch.mock.calls.map((call) =>
      new Headers(call[1].headers).get(INFERENCE_KEY_HEADER),
    )
  const connect = (secure: ReturnType<typeof transport>) => {
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      () => secure,
    )
    const reported: RateLimit[] = []
    client.onRateLimit = (rateLimit) => reported.push(rateLimit)
    return { client, reported }
  }
  const needsAccess = () =>
    Response.json(
      {
        error: {
          code: 'CREDENTIAL_REQUIRED',
          message: 'Chat access expired',
          action: 'reauthenticate',
        },
      },
      { status: 401 },
    )

  it('mints a subscriber token once while it lasts and reports its quota', async () => {
    const controlplane = vi.fn<typeof fetch>(async () =>
      Response.json({
        key: 'chat-token',
        expires_at: expiresAt(),
        is_free_tier: false,
        rate_limit: {
          max_input_tokens: 1000,
          input_tokens_used: 10,
          input_tokens_remaining: 990,
          resets_at: '2026-10-23T00:00:00Z',
        },
      }),
    )
    vi.stubGlobal('fetch', controlplane)
    const secure = transport()
    secure.fetch.mockImplementation(async () => Response.json({}))
    const { client, reported } = connect(secure)
    await client.post('/v1/session', {})
    await client.post('/v1/threads/turn', {})
    expect(controlplane).toHaveBeenCalledTimes(1)
    expect(String(controlplane.mock.calls[0][0])).toBe(
      `${CONTROLPLANE}/api/chat/token`,
    )
    expect(
      new Headers(controlplane.mock.calls[0][1]?.headers).get('Authorization'),
    ).toBe('Bearer clerk')
    expect(access(secure)).toEqual(['chat-token', 'chat-token'])
    expect(reported).toEqual([
      {
        kind: 'hourly',
        inputTokens: { max: 1000, used: 10, remaining: 990 },
        resetsAt: '2026-10-23T00:00:00Z',
      },
    ])
  })

  it("sends the account's free key only without a subscription", async () => {
    const controlplane = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/api/chat/token')
        ? new Response('{}', { status: 402 })
        : Response.json({
            key: 'free_key',
            expires_at: expiresAt(),
            is_free_tier: true,
            rate_limit: { max_requests: 10, remaining: 7 },
          }),
    )
    vi.stubGlobal('fetch', controlplane)
    const secure = transport()
    secure.fetch.mockImplementation(async () => Response.json({}))
    const { client, reported } = connect(secure)
    await client.post('/v1/threads/turn', {})
    expect(controlplane.mock.calls.map((call) => String(call[0]))).toEqual([
      `${CONTROLPLANE}/api/chat/token`,
      `${CONTROLPLANE}/api/keys/chat`,
    ])
    expect(access(secure)).toEqual(['free_key'])
    expect(reported).toEqual([
      { kind: 'free_daily', maxRequests: 10, remaining: 7 },
    ])
  })

  it('keeps an hourly cap until it lifts and shows it where access is needed', async () => {
    const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString()
    const controlplane = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: 'You have reached your hourly usage limit.',
          code: 'HOURLY_LIMIT_REACHED',
          resets_at: resetsAt,
          rate_limit: {
            max_output_tokens: 100,
            output_tokens_used: 100,
            output_tokens_remaining: 0,
          },
        },
        { status: 429 },
      ),
    )
    vi.stubGlobal('fetch', controlplane)
    const secure = transport()
    secure.fetch.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith('/v1/threads/turn') &&
      !new Headers(init.headers).has(INFERENCE_KEY_HEADER)
        ? needsAccess()
        : Response.json({ ok: true }),
    )
    const { client, reported } = connect(secure)
    await expect(client.post('/v1/session', {})).resolves.toEqual({ ok: true })
    await expect(client.post('/v1/threads/turn', {})).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
      detail: { kind: 'hourly', resetsAt },
    })
    // Neither asked again with each request nor downgraded to a free key.
    expect(controlplane).toHaveBeenCalledTimes(1)
    expect(reported).toEqual([
      {
        kind: 'hourly',
        outputTokens: { max: 100, used: 100, remaining: 0 },
        maxRequests: 0,
        remaining: 0,
        resetsAt,
      },
    ])
    // Renewing asks again, as when the cap may have lifted.
    controlplane.mockImplementation(async () =>
      Response.json({ key: 'chat-token', expires_at: expiresAt() }),
    )
    await client.renewCredential()
    expect(reported.at(-1)).toEqual({ kind: null })
    await expect(client.post('/v1/threads/turn', {})).resolves.toEqual({
      ok: true,
    })
    expect(controlplane).toHaveBeenCalledTimes(2)
  })

  it.each([
    { status: 429, code: 'RATE_LIMITED', retryAfter: null, heldMs: 60_000 },
    { status: 503, code: 'UPSTREAM_REFUSED', retryAfter: null, heldMs: 60_000 },
    { status: 403, code: 'UPSTREAM_REFUSED', retryAfter: null, heldMs: 60_000 },
    { status: 429, code: 'RATE_LIMITED', retryAfter: '120', heldMs: 120_000 },
  ])(
    'keeps a $status refusal (Retry-After: $retryAfter) for $heldMs ms before asking again',
    async ({ status, code, retryAfter, heldMs }) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const controlplane = vi.fn<typeof fetch>(
          async () =>
            new Response('{}', {
              status,
              headers: retryAfter ? { 'Retry-After': retryAfter } : {},
            }),
        )
        vi.stubGlobal('fetch', controlplane)
        const secure = transport()
        secure.fetch.mockImplementation(async () => needsAccess())
        const { client } = connect(secure)
        const first = await client
          .post('/v1/threads/turn', {})
          .catch((cause: unknown) => cause)
        expect(first).toBeInstanceOf(HarnessError)
        expect(first).toMatchObject({ status, code })
        expect(controlplane).toHaveBeenCalledOnce()

        vi.advanceTimersByTime(heldMs - 1)
        await expect(client.post('/v1/threads/turn', {})).rejects.toBe(first)
        expect(controlplane).toHaveBeenCalledOnce()

        vi.advanceTimersByTime(1)
        const next = await client
          .post('/v1/threads/turn', {})
          .catch((cause: unknown) => cause)
        expect(next).toBeInstanceOf(HarnessError)
        expect(next).not.toBe(first)
        expect(next).toMatchObject({ status, code })
        expect(controlplane).toHaveBeenCalledTimes(2)
        expect(access(secure)).toEqual([null, null, null, null, null, null])
      } finally {
        vi.useRealTimers()
      }
    },
  )

  describe('while a run stream is open', () => {
    const RENEWAL_POINT_MS = 10 * 60_000
    const encoder = new TextEncoder()
    // A run stream the test holds open until it finishes the run.
    function heldRun() {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
        },
      })
      const send = (type: string) =>
        controller.enqueue(encoder.encode(`data: {"type":"${type}"}\n\n`))
      send('RUN_STARTED')
      return {
        response: () =>
          new Response(body, {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        finish: () => {
          send('RUN_FINISHED')
          controller.close()
        },
      }
    }
    // Reads a run's stream, resolving `started` at its first event.
    function read(client: HarnessClient) {
      let started!: () => void
      const running = new Promise<void>((resolve) => {
        started = resolve
      })
      const reading = (async () => {
        const types: string[] = []
        for await (const frame of client.events('/v1/threads/follow', {
          threadId: 'thread',
          runId: 'run',
        })) {
          types.push(frame.event.type)
          started()
        }
        return types
      })()
      return { running, reading }
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      return () => vi.useRealTimers()
    })

    it('mints the chat token again before it expires and presents it once', async () => {
      const keys = ['idle-token', 'run-token', 'renewed-token']
      const controlplane = vi.fn<typeof fetch>(async () =>
        Response.json({ key: keys.shift(), expires_at: expiresAt() }),
      )
      vi.stubGlobal('fetch', controlplane)
      const run = heldRun()
      let presented!: () => void
      const presenting = new Promise<void>((resolve) => {
        presented = resolve
      })
      const secure = transport()
      secure.fetch.mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/threads/follow')) return run.response()
        if (secure.fetch.mock.calls.length > 1) presented()
        return Response.json({})
      })
      const { client } = connect(secure)

      // No run is open: the token is left to expire.
      await client.post('/v1/session', {})
      await vi.advanceTimersByTimeAsync(2 * RENEWAL_POINT_MS)
      expect(controlplane).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)

      const { running, reading } = read(client)
      await running
      expect(controlplane).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(RENEWAL_POINT_MS - 1)
      expect(controlplane).toHaveBeenCalledTimes(2)
      expect(secure.fetch).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1)
      await presenting
      expect(controlplane).toHaveBeenCalledTimes(3)
      expect(
        secure.fetch.mock.calls.map(([url, init]) => [
          url,
          new Headers(init.headers).get('Authorization'),
          new Headers(init.headers).get(INFERENCE_KEY_HEADER),
        ]),
      ).toEqual([
        ['https://harness.example/v1/session', 'Bearer clerk', 'idle-token'],
        [
          'https://harness.example/v1/threads/follow',
          'Bearer clerk',
          'run-token',
        ],
        ['https://harness.example/v1/session', 'Bearer clerk', 'renewed-token'],
      ])

      run.finish()
      await expect(reading).resolves.toEqual(['RUN_STARTED', 'RUN_FINISHED'])
      await vi.advanceTimersByTimeAsync(2 * RENEWAL_POINT_MS)
      expect(controlplane).toHaveBeenCalledTimes(3)
      expect(secure.fetch).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("leaves an account's free key as it is", async () => {
      const controlplane = vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith('/api/chat/token')
          ? new Response('{}', { status: 402 })
          : Response.json({ key: 'free_key', expires_at: expiresAt() }),
      )
      vi.stubGlobal('fetch', controlplane)
      const run = heldRun()
      const secure = transport()
      secure.fetch.mockImplementation(async () => run.response())
      const { client } = connect(secure)

      const { running, reading } = read(client)
      await running
      await vi.advanceTimersByTimeAsync(2 * RENEWAL_POINT_MS)
      run.finish()
      await expect(reading).resolves.toEqual(['RUN_STARTED', 'RUN_FINISHED'])
      expect(controlplane).toHaveBeenCalledTimes(2)
      expect(access(secure)).toEqual(['free_key'])
    })
  })

  it('mints again when the harness refuses the access it was sent', async () => {
    const keys = ['old-token', 'new-token']
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({ key: keys.shift(), expires_at: expiresAt() }),
      ),
    )
    const secure = transport()
    secure.fetch
      .mockResolvedValueOnce(needsAccess())
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const { client } = connect(secure)
    await expect(client.post('/v1/threads/turn', {})).resolves.toEqual({
      ok: true,
    })
    expect(access(secure)).toEqual(['old-token', 'new-token'])
  })

  it('mints with the refreshed Clerk session before retrying a turn', async () => {
    const controlplane = vi.fn<typeof fetch>(async (_url, init) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer expired'
        ? new Response('{}', { status: 401 })
        : Response.json({ key: 'fresh-chat-token', expires_at: expiresAt() }),
    )
    vi.stubGlobal('fetch', controlplane)
    const secure = transport()
    secure.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      if (headers.get('Authorization') === 'Bearer expired')
        return Response.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Expired session',
              action: 'reauthenticate',
            },
          },
          { status: 401 },
        )
      return headers.has(INFERENCE_KEY_HEADER)
        ? Response.json({ ok: true })
        : needsAccess()
    })
    const client = new HarnessClient(
      'https://harness.example',
      vi.fn().mockResolvedValueOnce('expired').mockResolvedValue('fresh'),
      () => secure,
    )
    await expect(client.post('/v1/threads/turn', {})).resolves.toEqual({
      ok: true,
    })
    expect(access(secure)).toEqual([null, 'fresh-chat-token'])
    expect(
      controlplane.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get('Authorization'),
      ),
    ).toEqual(['Bearer expired', 'Bearer fresh'])
  })

  it('keeps valid access through transient refresh failures but honors a cap', async () => {
    const controlplane = stubChatAccess('held-token')
    const secure = transport()
    secure.fetch.mockImplementation(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).has(INFERENCE_KEY_HEADER)
        ? Response.json({ ok: true })
        : needsAccess(),
    )
    const { client } = connect(secure)
    await client.post('/v1/threads/turn', {})
    controlplane.mockImplementation(
      async () => new Response('{}', { status: 503 }),
    )
    await expect(client.renewCredential()).rejects.toMatchObject({
      status: 503,
    })
    await expect(client.post('/v1/threads/turn', {})).resolves.toEqual({
      ok: true,
    })
    expect(access(secure)).toEqual(['held-token', 'held-token'])

    controlplane.mockImplementation(async () =>
      Response.json(
        {
          code: 'HOURLY_LIMIT_REACHED',
          resets_at: expiresAt(),
        },
        { status: 429 },
      ),
    )
    await expect(client.renewCredential()).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    })
    await expect(client.post('/v1/threads/turn', {})).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    })
    expect(access(secure).slice(2)).toEqual([null, null])
  })

  it('replaces a pending mint without letting its late answer restore old access', async () => {
    let release!: (response: Response) => void
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const controlplane = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        started()
        return held
      })
      .mockImplementation(async () =>
        Response.json({ key: 'renewed-token', expires_at: expiresAt() }),
      )
    vi.stubGlobal('fetch', controlplane)
    const secure = transport()
    secure.fetch.mockImplementation(async () => Response.json({ ok: true }))
    const { client, reported } = connect(secure)
    const previous = client.post('/v1/session', {})
    await reached
    const renewal = client.renewCredential()
    try {
      await vi.waitFor(() => expect(controlplane).toHaveBeenCalledTimes(2))
      await renewal
    } finally {
      release(
        Response.json({
          key: 'old-token',
          expires_at: expiresAt(),
          rate_limit: { max_requests: 5, remaining: 0 },
        }),
      )
    }
    await previous
    await client.post('/v1/threads/turn', {})
    expect(access(secure)).not.toContain('old-token')
    expect(access(secure).at(-1)).toBe('renewed-token')
    expect(reported).toEqual([{ kind: null }])
  })

  it.each([true, false])(
    'drops only denied subscriber access when the free-key fallback fails (subscriber: %s)',
    async (subscriber) => {
      let lostSubscription = false
      const controlplane = vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith('/api/chat/token'))
          return subscriber && !lostSubscription
            ? Response.json({
                key: 'subscriber-token',
                expires_at: expiresAt(),
              })
            : new Response('{}', { status: 402 })
        return lostSubscription
          ? new Response('{}', { status: 503 })
          : Response.json({ key: 'free_key', expires_at: expiresAt() })
      })
      vi.stubGlobal('fetch', controlplane)
      const secure = transport()
      secure.fetch.mockImplementation(
        async (_url: string, init: RequestInit) =>
          new Headers(init.headers).has(INFERENCE_KEY_HEADER)
            ? Response.json({ ok: true })
            : needsAccess(),
      )
      const { client } = connect(secure)
      await client.post('/v1/threads/turn', {})
      lostSubscription = true
      await expect(client.renewCredential()).rejects.toMatchObject({
        status: 503,
      })
      const next = client.post('/v1/threads/turn', {})
      if (subscriber) {
        await expect(next).rejects.toMatchObject({ status: 503 })
        expect(access(secure)).toEqual(['subscriber-token', null, null])
      } else {
        await expect(next).resolves.toEqual({ ok: true })
        expect(access(secure)).toEqual(['free_key', 'free_key'])
      }
    },
  )
})
