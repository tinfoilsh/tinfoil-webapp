import { HarnessClient } from '@/services/harness/client'
import type { HarnessRoute } from '@/services/harness/protocol'
import { initialChat, reduceEvent } from '@/services/harness/reducer'
import { HarnessError, readEvents } from '@/services/harness/sse'
import type {
  Frame,
  Json,
  Message,
  TimelineBlock,
} from '@/services/harness/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('tinfoil', () => ({ SecureClient: vi.fn() }))

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
      event: { type: 'RUN_STARTED', runId: 'run' },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
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
          url_citation: { url: 'https://example.org', title: 'Source' },
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
        runId: 'run',
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
      event: { type: 'RUN_STARTED', runId: 'active', threadId: 't' },
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
            value: { queueId: 'queued', content: 'later' },
          },
        ],
      },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'RUN_FINISHED',
        runId: 'queued',
        metadata: { cancelled: true },
      },
    })
    expect(state.status).toBe('streaming')
    expect(state.runId).toBe('active')
    expect(state.snapshot.queue).toEqual([])
    state = reduceEvent(state, {
      id: 0,
      event: { type: 'RUN_STARTED', runId: 'next' },
    })
    state = reduceEvent(state, {
      id: 2,
      event: { type: 'RUN_FINISHED', runId: 'active' },
    })
    expect(state.status).toBe('streaming')
    expect(state.runId).toBe('next')
  })
  it('replaces the cursor snapshot, deduplicates deltas and retries the same widget', () => {
    let state = initialChat()
    const frames: Frame[] = [
      { id: 0, event: { type: 'RUN_STARTED', runId: 'r', threadId: 't' } },
      {
        id: 1,
        event: {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm',
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
          toolCallId: 'call',
          content: { result: 'kept' },
        },
      },
    ]
    for (const frame of frames) state = reduceEvent(state, frame)
    expect(reduceEvent(state, frames[1])).toBe(state)
    state = reduceEvent(state, {
      event: { type: 'MESSAGES_SNAPSHOT', messages: state.messages },
    })
    state.messages[0].timeline![1].invalidArguments = true
    state = reduceEvent(state, {
      id: 0,
      event: { type: 'RUN_STARTED', runId: 'retry', threadId: 't' },
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
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', delta: 'Text' },
      {
        type: 'TOOL_CALL_START',
        parentMessageId: 'm',
        toolCallId: 'c',
        toolCallName: 'python',
      },
      {
        type: 'ACTIVITY_SNAPSHOT',
        messageId: 'act_c',
        content: { output: [] },
      },
      {
        type: 'ACTIVITY_DELTA',
        messageId: 'act_c',
        patch: [{ op: 'add' as const, path: '/output/-', value: '1' }],
      },
      {
        type: 'RUN_FINISHED',
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
  it('applies the queue and title changes a run sends, and refuses others', () => {
    const summary = {
      id: 't',
      title: 'New Chat',
      titleState: 'placeholder',
      createdAt: 't0',
      updatedAt: 't0',
      model: 'test-model',
      projectId: null,
      pinned: false,
      webSearchEnabled: true,
      messageCount: 1,
      activeRun: null,
    } as const
    let state = reduceEvent(initialChat(), {
      id: 0,
      event: { type: 'RUN_STARTED', runId: 'r', threadId: 't' },
    })
    state = reduceEvent(state, {
      id: 1,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: summary,
          queue: [{ queueId: 'q1', content: 'first' }],
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
            value: { queueId: 'q2', content: 'second' },
          },
          { op: 'replace', path: '/thread/title', value: 'Named' },
          { op: 'replace', path: '/thread/titleState', value: 'generated' },
        ],
      },
    })
    expect(state.snapshot).toEqual({
      thread: { ...summary, title: 'Named', titleState: 'generated' },
      queue: [
        { queueId: 'q1', content: 'first' },
        { queueId: 'q2', content: 'second' },
      ],
    })
    expect(before.snapshot).toEqual({
      thread: summary,
      queue: [{ queueId: 'q1', content: 'first' }],
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
          thread: null,
          queue: [{ queueId: 'q1', content: 'first' }],
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
              value: { queueId: 'q2', content: 'second' },
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
        toolCallId: 's',
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
      { type: 'TOOL_CALL_RESULT', toolCallId, content },
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
      event: { type: 'RUN_STARTED', runId: 'r', threadId: 't' },
    })
    const first = reduceEvent(started, {
      id: 1,
      event: { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', delta: 'Hello' },
    })
    const second = reduceEvent(first, {
      id: 2,
      event: { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', delta: ' there' },
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
      { type: 'RUN_STARTED', threadId: 't', runId: 'run-2', messageId: 'a1' },
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
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', delta: ' a time' },
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
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', delta: 'Here it is.' },
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
  const transport = () => ({
    ready: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    getVerificationDocument: vi.fn(),
  })
  it('refreshes an expired Clerk JWT once while retaining the same turn nonce and body', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'fr'])
    const secure = transport()
    secure.fetch
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
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
    secure.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
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
