import { processStreamingResponse } from '@/components/chat/hooks/streaming/process-stream'
import { parseRichStreamingResponse } from '@/components/chat/hooks/streaming/rich-response-parser'
import type { StreamingContext } from '@/components/chat/hooks/streaming/types'
import type { Message } from '@/components/chat/types'
import type {
  ChatChunk,
  ChatChunkStream,
} from '@/services/inference/chat-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { endStreamingMock, startStreamingMock } = vi.hoisted(() => ({
  endStreamingMock: vi.fn(),
  startStreamingMock: vi.fn(),
}))

vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    endStreaming: endStreamingMock,
    startStreaming: startStreamingMock,
  },
}))

function createStream(): ChatChunkStream {
  return (async function* () {
    const events: ChatChunk[] = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    yield* events
  })()
}

function createReasoningStream(): ChatChunkStream {
  return (async function* () {
    yield { choices: [{ delta: { reasoning_content: 'Thinking' } }] }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  })()
}

function createContext(overrides: Partial<StreamingContext> = {}) {
  return {
    streamChatIdRef: { current: 'chat-1' },
    onUpdate: vi.fn(),
    setIsThinking: vi.fn(),
    setIsWaitingForResponse: vi.fn(),
    setIsStreaming: vi.fn(),
    setLoadingState: vi.fn(),
    ...overrides,
  } satisfies StreamingContext
}

function createOpenStream() {
  const chunks: ChatChunk[] = []
  let resume: (() => void) | undefined
  let closed = false
  const stream = (async function* () {
    while (!closed || chunks.length > 0) {
      if (chunks.length === 0) {
        await new Promise<void>((resolve) => {
          resume = resolve
        })
        continue
      }
      yield chunks.shift() as ChatChunk
    }
  })()
  return {
    stream,
    close: () => {
      closed = true
      resume?.()
    },
    send: (...events: ChatChunk[]) => {
      chunks.push(...events)
      resume?.()
      resume = undefined
    },
  }
}

describe('processStreamingResponse lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cleans up the stream by default', async () => {
    const context = createContext()

    await processStreamingResponse(createStream(), context)

    expect(context.setLoadingState).toHaveBeenCalledWith('idle')
    expect(context.setIsStreaming).toHaveBeenCalledWith(false)
    expect(endStreamingMock).toHaveBeenCalledWith('chat-1')
  })

  it('keeps the stream active when the caller has recovery to finalize', async () => {
    const context = createContext({ deferStreamCleanup: true })

    await processStreamingResponse(createStream(), context)

    expect(startStreamingMock).toHaveBeenCalledWith('chat-1')
    expect(context.setLoadingState).not.toHaveBeenCalled()
    expect(context.setIsStreaming).not.toHaveBeenCalled()
    expect(endStreamingMock).not.toHaveBeenCalled()
  })

  it('stores the routed model display name in the response', async () => {
    const stream = (async function* (): ChatChunkStream {
      yield {
        model: 'kimi-k2-6',
        choices: [{ delta: { content: 'Hello' } }],
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    })()

    const message = await processStreamingResponse(
      stream,
      createContext({
        modelDisplayName: 'Auto · Smart',
        resolveModelDisplayName: (modelName) =>
          modelName === 'kimi-k2-6' ? 'Kimi K2.6' : undefined,
      }),
    )

    expect(message?.modelDisplayName).toBe('Kimi K2.6')
  })

  it('does not publish a model-only assistant snapshot', async () => {
    const stream = (async function* (): ChatChunkStream {
      yield { model: 'kimi-k2-6', choices: [{ delta: { role: 'assistant' } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    })()
    const context = createContext({
      modelDisplayName: 'Kimi K2.6',
      resolveModelDisplayName: () => 'Kimi K2.6',
    })

    const message = await processStreamingResponse(stream, context)

    expect(message?.modelDisplayName).toBe('Kimi K2.6')
    expect(context.onUpdate).not.toHaveBeenCalled()
  })

  it('does not start tracking an already-aborted stream', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      processStreamingResponse(
        createStream(),
        createContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(startStreamingMock).not.toHaveBeenCalled()
  })
})

describe('processStreamingResponse interruption', () => {
  it('publishes the latest content with its turn identity on abort', async () => {
    const controller = new AbortController()
    const stream = createOpenStream()
    const interrupted: Array<Message | null> = []
    const context = createContext({
      signal: controller.signal,
      turnId: 'turn-1',
      onInterrupted: (message) => interrupted.push(message),
    })
    const processing = processStreamingResponse(stream.stream, context)

    stream.send(
      { choices: [{ delta: { content: 'Hello world' } }] },
      { choices: [{ delta: { content: ' before stopping' } }] },
    )
    await vi.waitFor(() => expect(context.onUpdate).toHaveBeenCalled())

    controller.abort()

    expect(interrupted).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'Hello world before stopping',
        turnId: 'turn-1',
        isThinking: false,
      }),
    ])

    stream.close()
    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
    expect(context.setLoadingState).not.toHaveBeenCalled()
  })

  it('preserves partial reasoning instead of dropping the message', async () => {
    const controller = new AbortController()
    const stream = createOpenStream()
    const interrupted: Array<Message | null> = []
    const context = createContext({
      signal: controller.signal,
      turnId: 'turn-1',
      onInterrupted: (message) => interrupted.push(message),
    })
    const processing = processStreamingResponse(stream.stream, context)

    stream.send({
      choices: [{ delta: { reasoning_content: 'Keep this reasoning' } }],
    })
    await vi.waitFor(() => expect(context.onUpdate).toHaveBeenCalled())

    controller.abort()

    expect(interrupted[0]).toMatchObject({
      thoughts: 'Keep this reasoning',
      isThinking: false,
      turnId: 'turn-1',
      timeline: [
        expect.objectContaining({
          type: 'thinking',
          content: 'Keep this reasoning',
          isThinking: false,
        }),
      ],
    })

    stream.close()
    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('includes content buffered for stream format detection', async () => {
    const controller = new AbortController()
    const stream = createOpenStream()
    const interrupted: Array<Message | null> = []
    const context = createContext({
      signal: controller.signal,
      turnId: 'turn-1',
      onInterrupted: (message) => interrupted.push(message),
    })
    const processing = processStreamingResponse(stream.stream, context)

    stream.send(
      { choices: [{ delta: { content: 'Hi' } }] },
      {
        type: 'web_search_call',
        status: 'in_progress',
        action: { query: 'test query' },
      },
    )
    await vi.waitFor(() =>
      expect(context.setIsWaitingForResponse).toHaveBeenCalledWith(false),
    )

    controller.abort()

    expect(interrupted[0]).toMatchObject({
      content: 'Hi',
      turnId: 'turn-1',
    })

    stream.close()
    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not publish an empty assistant placeholder', async () => {
    const controller = new AbortController()
    const stream = createOpenStream()
    const interrupted: Array<Message | null> = []
    const context = createContext({
      signal: controller.signal,
      turnId: 'turn-1',
      onInterrupted: (message) => interrupted.push(message),
    })
    const processing = processStreamingResponse(stream.stream, context)

    controller.abort()

    expect(interrupted).toEqual([null])

    stream.close()
    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('processStreamingResponse frame publication', () => {
  let nextFrameId = 1
  let frames: Map<number, FrameRequestCallback>
  let cancelledFrames: number[]

  beforeEach(() => {
    frames = new Map()
    cancelledFrames = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++
        frames.set(id, callback)
        return id
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        cancelledFrames.push(id)
        frames.delete(id)
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function runFrames() {
    const pending = [...frames.entries()]
    frames.clear()
    for (const [, callback] of pending) callback(performance.now())
  }

  it('publishes a short first content chunk immediately', async () => {
    const stream = createOpenStream()
    const updates: string[] = []
    const processing = processStreamingResponse(
      stream.stream,
      createContext({
        onUpdate: (message) => updates.push(message.content ?? ''),
      }),
    )

    stream.send({ choices: [{ delta: { content: 'Hi' } }] })

    await vi.waitFor(() => expect(updates).toEqual(['Hi']))
    stream.send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    stream.close()
    await vi.waitFor(() => expect(frames.size).toBe(1))
    runFrames()
    await processing
  })

  it('publishes the leading chunk and coalesces later chunks per frame', async () => {
    const updates: string[] = []
    const context = createContext({
      onUpdate: (message) => updates.push(message.thoughts ?? ''),
    })
    const processing = processStreamingResponse(
      (async function* (): AsyncGenerator<ChatChunk> {
        yield { choices: [{ delta: { reasoning_content: 'A' } }] }
        yield { choices: [{ delta: { reasoning_content: 'B' } }] }
        yield { choices: [{ delta: { reasoning_content: 'C' } }] }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
      })(),
      context,
    )

    await vi.waitFor(() => expect(frames.size).toBe(1))
    expect(updates).toEqual(['A'])
    runFrames()
    await processing

    expect(updates).toEqual(['A', 'ABC'])
  })

  it('awaits the scheduled final publication before resolving', async () => {
    let resolved = false
    const processing = processStreamingResponse(
      createReasoningStream(),
      createContext(),
    )
    void processing.then(() => {
      resolved = true
    })

    await vi.waitFor(() => expect(frames.size).toBe(1))
    expect(resolved).toBe(false)
    runFrames()
    await processing
    expect(resolved).toBe(true)
  })

  it('publishes the final snapshot without waiting for a hidden tab frame', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const updates: string[] = []

    await processStreamingResponse(
      createReasoningStream(),
      createContext({
        onUpdate: (message) => updates.push(message.thoughts ?? ''),
      }),
    )

    expect(frames.size).toBe(0)
    expect(updates).toEqual(['Thinking', 'Thinking'])
  })

  it('clears streaming state after an asynchronous final update settles', async () => {
    let releaseFinalUpdate: (() => void) | undefined
    let updateCount = 0
    const context = createContext({
      onUpdate: () => {
        updateCount += 1
        if (updateCount === 2) {
          return new Promise<void>((resolve) => {
            releaseFinalUpdate = resolve
          })
        }
      },
    })
    const processing = processStreamingResponse(
      createReasoningStream(),
      context,
    )

    await vi.waitFor(() => expect(frames.size).toBe(1))
    runFrames()
    await vi.waitFor(() => expect(releaseFinalUpdate).toBeDefined())
    expect(context.setIsStreaming).not.toHaveBeenCalled()

    releaseFinalUpdate?.()
    await processing
    expect(context.setIsStreaming).toHaveBeenCalledWith(false)
  })

  it('cancels a pending frame on abort without publishing stale content', async () => {
    const controller = new AbortController()
    const stream = createOpenStream()
    const updates: string[] = []
    const context = createContext({
      signal: controller.signal,
      onUpdate: (message) => updates.push(message.thoughts ?? ''),
    })
    const processing = processStreamingResponse(stream.stream, context)

    stream.send(
      { choices: [{ delta: { reasoning_content: 'A' } }] },
      { choices: [{ delta: { reasoning_content: 'B' } }] },
    )
    await vi.waitFor(() => expect(frames.size).toBe(1))
    controller.abort()
    expect(cancelledFrames).toHaveLength(1)
    runFrames()
    expect(updates).toEqual(['A'])

    stream.close()
    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('treats cancellation during the final frame as an interruption', async () => {
    const controller = new AbortController()
    const context = createContext({ signal: controller.signal })
    const processing = processStreamingResponse(
      createReasoningStream(),
      context,
    )

    await vi.waitFor(() => expect(frames.size).toBe(1))
    controller.abort()

    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('drops a queued asynchronous update after cancellation', async () => {
    const controller = new AbortController()
    let releaseLeadingUpdate!: () => void
    const updates: string[] = []
    const stream = createOpenStream()
    const processing = processStreamingResponse(
      stream.stream,
      createContext({
        signal: controller.signal,
        onUpdate: (message) => {
          updates.push(message.thoughts ?? '')
          if (updates.length === 1) {
            return new Promise<void>((resolve) => {
              releaseLeadingUpdate = resolve
            })
          }
        },
      }),
    )

    stream.send(
      { choices: [{ delta: { reasoning_content: 'A' } }] },
      { choices: [{ delta: { reasoning_content: 'B' } }] },
    )
    await vi.waitFor(() => expect(frames.size).toBe(1))
    runFrames()
    controller.abort()
    releaseLeadingUpdate()
    stream.close()

    await expect(processing).rejects.toMatchObject({ name: 'AbortError' })
    expect(updates).toEqual(['A'])
  })

  it('matches the rich parser for shared event assembly', async () => {
    const events: ChatChunk[] = [
      { choices: [{ delta: { reasoning_content: 'Reasoning' } }] },
      {
        type: 'web_search_call',
        id: 'search-1',
        status: 'in_progress',
        action: { query: 'query' },
      },
      {
        type: 'web_search_call',
        id: 'search-1',
        status: 'completed',
        sources: [{ title: 'Source', url: 'https://example.com' }],
      },
      { choices: [{ delta: { content: 'Answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]
    const makeStream = () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        yield* events
      })()
    const processing = processStreamingResponse(makeStream(), createContext())

    await vi.waitFor(() => expect(frames.size).toBe(1))
    runFrames()
    const [processed, parsed] = await Promise.all([
      processing,
      parseRichStreamingResponse(makeStream()),
    ])

    expect(processed?.content).toBe(parsed.content)
    expect(processed?.thoughts).toBe(parsed.thoughts)
    expect(processed?.webSearch).toEqual(parsed.webSearch)
    expect(processed?.timeline?.map(({ type }) => type)).toEqual(
      parsed.timeline?.map(({ type }) => type),
    )
  })
})
