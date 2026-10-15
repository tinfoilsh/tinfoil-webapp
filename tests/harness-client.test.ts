import { HarnessClient } from '@/services/harness/client'
import {
  applyPatch,
  initialChat,
  reduceEvent,
} from '@/services/harness/reducer'
import { HarnessError, readEvents } from '@/services/harness/sse'
import type { Frame } from '@/services/harness/types'
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
      collect(stream('id: -1\ndata: {}\n\n')),
    ).rejects.toBeInstanceOf(HarnessError)
    await expect(collect(stream('data: nope\n\n'))).rejects.toMatchObject({
      detail: { code: 'INVALID_STREAM' },
    })
  })
})

describe('harness reducer', () => {
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
    for (const event of [
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
      { type: 'RUN_FINISHED', metadata: { cancelled: true } },
    ])
      state = reduceEvent(state, { event })
    expect(state.messages[0].timeline?.map((b) => b.type)).toEqual([
      'thinking',
      'content',
      'tool_call',
    ])
    expect(state.messages[0].timeline?.[2].progress).toEqual(['1'])
    expect(state.messages[0].isInterrupted).toBe(true)
  })
  it('applies queue patches atomically with JSON pointer escaping', () => {
    const original = { queue: [{ id: 'a' }], 'a/b': { '~': 1 } }
    expect(
      applyPatch(original, [
        { op: 'test', path: '/a~1b/~0', value: 1 },
        { op: 'copy', from: '/queue/0', path: '/queue/-' },
        { op: 'replace', path: '/queue/1/id', value: 'b' },
        { op: 'move', from: '/queue/0', path: '/queue/1' },
        { op: 'remove', path: '/a~1b' },
      ]),
    ).toEqual({ queue: [{ id: 'b' }, { id: 'a' }] })
    expect(() =>
      applyPatch(original, [
        { op: 'remove', path: '/queue/0' },
        { op: 'remove', path: '/missing' },
      ]),
    ).toThrow(HarnessError)
    expect(original.queue).toEqual([{ id: 'a' }])
    expect(() =>
      applyPatch({}, [{ op: 'add', path: '/__proto__/polluted', value: true }]),
    ).toThrow(HarnessError)
  })
})

describe('attested harness transport', () => {
  const transport = () => ({
    ready: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    getVerificationDocument: vi.fn(),
  })
  it('refreshes an expired Clerk JWT once while retaining the same turn nonce and body', async () => {
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
      secure,
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
      secure.fetch.mock.calls.every(
        (call) =>
          call[0] === 'https://harness.example/v1/threads/turn' &&
          call[1].body === JSON.stringify(body),
      ),
    ).toBe(true)
  })
  it('uses fresh tokens per call and never downgrades rejected authentication to anonymous', async () => {
    const secure = transport()
    secure.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    const client = new HarnessClient(
      'https://harness.example',
      vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce(null),
      secure,
    )
    await expect(client.session()).rejects.toMatchObject({ status: 401 })
    expect(secure.fetch).toHaveBeenCalledTimes(1)
  })
  it('uses the same verified connection for multipart, binary, and follow requests', async () => {
    const secure = transport()
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      secure,
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
    for await (const frame of client.events(
      '/v1/threads/follow',
      { threadId: 't', runId: 'r' },
      undefined,
      0,
    ))
      expect(frame.event.type).toBe('RUN_FINISHED')
    expect(
      new Headers(secure.fetch.mock.calls[2][1].headers).get('Last-Event-ID'),
    ).toBe('0')
  })
  it('does not send keys or JWTs to arbitrary URLs', async () => {
    const secure = transport()
    const client = new HarnessClient(
      'https://harness.example',
      async () => 'clerk',
      secure,
    )
    for (const path of [
      'https://other.example/v1/session',
      '//other.example/v1/session',
      '/v1/../session',
      '/v1/session?key=secret',
    ])
      await expect(client.post(path, { key: 'cek' })).rejects.toBeInstanceOf(
        HarnessError,
      )
    expect(secure.fetch).not.toHaveBeenCalled()
    expect(
      () =>
        new HarnessClient('http://harness.example', async () => null, secure),
    ).toThrow(HarnessError)
  })
})
