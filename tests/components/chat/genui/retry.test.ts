import {
  ArtifactRetryError,
  patchToolCallArguments,
  regenerateToolCallArguments,
  selectArtifactRetryContext,
} from '@/components/chat/genui/retry'
import type { Chat, Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { DEV_ENABLE_DEBUG_LOGS } from '@/constants/storage-keys'
import { StructuredCompletionError } from '@/services/inference/inference-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { logErrorMock, sendStructuredCompletionMock, zodToJsonSchemaMock } =
  vi.hoisted(() => ({
    logErrorMock: vi.fn(),
    sendStructuredCompletionMock: vi.fn(),
    zodToJsonSchemaMock: vi.fn(),
  }))

vi.mock('zod-to-json-schema', async () => {
  const actual =
    await vi.importActual<typeof import('zod-to-json-schema')>(
      'zod-to-json-schema',
    )
  zodToJsonSchemaMock.mockImplementation(actual.zodToJsonSchema)
  return { ...actual, zodToJsonSchema: zodToJsonSchemaMock }
})

vi.mock('@/services/inference/inference-client', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/inference/inference-client')
  >('@/services/inference/inference-client')
  return {
    ...actual,
    sendStructuredCompletion: sendStructuredCompletionMock,
  }
})

vi.mock('@/utils/error-handling', () => ({ logError: logErrorMock }))

const model = {
  modelName: 'gpt-oss-120b',
  chatConfig: { contextWindowTokens: 64000 },
} as BaseModel

function message(role: Message['role'], content: string): Message {
  return { role, content, timestamp: new Date() }
}

function artifactChat(argumentsValue: string): Chat {
  const timestamp = new Date('2026-08-11T12:00:00Z')
  return {
    id: 'chat-1',
    title: 'Artifact',
    createdAt: timestamp,
    messages: [
      message('user', 'Create an artifact'),
      {
        role: 'assistant',
        content: 'Unrelated prose stays unchanged',
        timestamp,
        turnId: 'turn-1',
        timeline: [
          { type: 'content', id: 'content-1', content: 'Unrelated prose' },
          {
            type: 'tool_call',
            id: 'block-1',
            toolCallId: 'call-1',
            name: 'render_artifact_preview',
            arguments: argumentsValue,
          },
          {
            type: 'tool_call',
            id: 'block-2',
            toolCallId: 'call-2',
            name: 'render_chart',
            arguments: '{"type":"bar","data":[]}',
          },
        ],
        toolCalls: [
          {
            id: 'call-1',
            name: 'render_artifact_preview',
            arguments: argumentsValue,
          },
          {
            id: 'call-2',
            name: 'render_chart',
            arguments: '{"type":"bar","data":[]}',
          },
        ],
      },
    ],
  }
}

describe('artifact retry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(DEV_ENABLE_DEBUG_LOGS)
  })

  beforeEach(() => {
    sendStructuredCompletionMock.mockReset()
    zodToJsonSchemaMock.mockClear()
    logErrorMock.mockReset()
  })

  it('always sends malformed arguments larger than 4000 characters in full', async () => {
    const malformed = `{"source":{"type":"html","html":"${'x'.repeat(5000)}`
    sendStructuredCompletionMock.mockResolvedValueOnce({
      source: { type: 'html', html: '<main>fixed</main>' },
    })

    await regenerateToolCallArguments({
      toolName: 'render_artifact_preview',
      originalArguments: malformed,
      contextMessages: [message('user', 'Create a page')],
      model,
    })

    const request = sendStructuredCompletionMock.mock.calls[0][0]
    expect(request.messages.at(-1).content).toBe(
      `Malformed arguments to repair:\n${malformed}`,
    )
  })

  it('selects only whole ancillary messages within the remaining budget', () => {
    const older = 'a'.repeat(300)
    const recent = 'b'.repeat(200)
    const selected = selectArtifactRetryContext(
      [message('user', older), message('assistant', recent)],
      1000,
      'm'.repeat(2800),
    )

    expect(selected).toEqual([{ role: 'assistant', content: recent }])
  })

  it('budgets only the role and content serialized for retry context', () => {
    const contextualMessage = {
      ...message('assistant', 'visible'),
      quote: 'q'.repeat(2000),
      searchReasoning: 'r'.repeat(2000),
    }

    expect(
      selectArtifactRetryContext([contextualMessage], 1000, 'm'.repeat(2800)),
    ).toEqual([{ role: 'assistant', content: 'visible' }])
  })

  it('preserves Auto candidates and current reasoning options', async () => {
    const candidate = {
      ...model,
      modelName: 'candidate-a',
      requestParams: { temperature: 0.2 },
    }
    sendStructuredCompletionMock.mockResolvedValueOnce({
      type: 'bar',
      data: [{ label: 'A', value: 1 }],
    })

    await regenerateToolCallArguments({
      toolName: 'render_chart',
      originalArguments: '{}',
      contextMessages: [],
      model: candidate,
      autoCandidates: [candidate],
      reasoningEffort: 'high',
      thinkingEnabled: true,
    })

    expect(sendStructuredCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: candidate,
        autoCandidates: [candidate],
        reasoningEffort: 'high',
        thinkingEnabled: true,
      }),
    )
  })

  it('allows schema-valid arguments to be replaced after a render exception', async () => {
    const originalArguments = JSON.stringify({
      type: 'bar',
      data: [{ label: 'Before', value: 1 }],
    })
    sendStructuredCompletionMock.mockResolvedValueOnce({
      type: 'bar',
      data: [{ label: 'Recovered', value: 2 }],
    })

    const replacement = await regenerateToolCallArguments({
      toolName: 'render_chart',
      originalArguments,
      contextMessages: [message('user', 'Fix the chart')],
      model,
    })

    expect(JSON.parse(replacement).data[0]).toEqual({
      label: 'Recovered',
      value: 2,
    })
    expect(sendStructuredCompletionMock).toHaveBeenCalledOnce()
  })

  it('classifies incomplete and schema-invalid replacements', async () => {
    sendStructuredCompletionMock.mockRejectedValueOnce(
      new StructuredCompletionError('incomplete_response', {
        finishReason: 'length',
      }),
    )
    await expect(
      regenerateToolCallArguments({
        toolName: 'render_chart',
        contextMessages: [],
        model,
      }),
    ).rejects.toMatchObject({ code: 'incomplete_replacement' })

    sendStructuredCompletionMock.mockResolvedValueOnce({
      type: 'donut',
      data: [],
    })
    await expect(
      regenerateToolCallArguments({
        toolName: 'render_chart',
        contextMessages: [],
        model,
      }),
    ).rejects.toMatchObject({ code: 'schema_invalid_replacement' })
  })

  it('distinguishes request failures and unavailable widgets', async () => {
    sendStructuredCompletionMock.mockRejectedValueOnce(
      new StructuredCompletionError('request_failed', { status: 503 }),
    )
    await expect(
      regenerateToolCallArguments({
        toolName: 'render_chart',
        contextMessages: [],
        model,
      }),
    ).rejects.toMatchObject({ code: 'request_failed' })

    await expect(
      regenerateToolCallArguments({
        toolName: 'render_unknown',
        contextMessages: [],
        model,
      }),
    ).rejects.toMatchObject({ code: 'unavailable_target' })
  })

  it('classifies and safely logs schema conversion failures', async () => {
    const privateArguments = 'private artifact source'
    const privateCause = 'private conversion detail'
    const conversionError = new Error(privateCause)
    const { logError } = await vi.importActual<
      typeof import('@/utils/error-handling')
    >('@/utils/error-handling')
    logErrorMock.mockImplementationOnce(logError)
    localStorage.setItem(DEV_ENABLE_DEBUG_LOGS, 'true')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {})
    zodToJsonSchemaMock.mockImplementationOnce(() => {
      throw conversionError
    })

    await expect(
      regenerateToolCallArguments({
        toolName: 'render_chart',
        originalArguments: privateArguments,
        contextMessages: [],
        model,
      }),
    ).rejects.toMatchObject({
      code: 'schema_conversion_failed',
      cause: conversionError,
    })
    expect(logErrorMock).toHaveBeenCalledWith(
      'Artifact schema conversion failed',
      expect.any(ArtifactRetryError),
      expect.objectContaining({
        metadata: {
          toolName: 'render_chart',
          code: 'schema_conversion_failed',
        },
      }),
    )
    expect(sendStructuredCompletionMock).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[genui-retry] Artifact schema conversion failed: schema_conversion_failed',
    )
    expect(debug).toHaveBeenCalledOnce()
    const output = [...warning.mock.calls, ...debug.mock.calls]
      .flat()
      .join('\n')
    expect(output).not.toContain(privateArguments)
    expect(output).not.toContain(privateCause)
  })

  it('patches only the originating block and mirror while preserving changes', () => {
    const original = '{"source":{"type":"html"}'
    const chat = artifactChat(original)
    chat.messages.push(message('user', 'Concurrent message'))
    const before = structuredClone(chat)
    const replacement = '{"source":{"type":"html","html":"fixed"}}'
    const result = patchToolCallArguments(
      chat,
      {
        messageTurnId: 'turn-1',
        messageTimestamp: chat.messages[1].timestamp.getTime(),
        timelineBlockId: 'block-1',
        toolCallId: 'call-1',
        toolName: 'render_artifact_preview',
        originalArguments: original,
      },
      replacement,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(chat).toEqual(before)
    expect(result.chat).not.toBe(chat)
    expect(result.chat.messages[1]).not.toBe(chat.messages[1])
    expect(result.chat.messages[0]).toBe(chat.messages[0])
    expect(result.chat.messages[2]).toBe(chat.messages[2])
    expect(result.chat.messages[1].timeline).toEqual([
      before.messages[1].timeline![0],
      { ...before.messages[1].timeline![1], arguments: replacement },
      before.messages[1].timeline![2],
    ])
    expect(result.chat.messages.at(-1)?.content).toBe('Concurrent message')
    expect(result.chat.messages[1].content).toBe(
      'Unrelated prose stays unchanged',
    )
    expect(result.chat.messages[1].toolCalls?.[0].arguments).toBe(replacement)
    expect(result.chat.messages[1].toolCalls?.[1].arguments).toBe(
      '{"type":"bar","data":[]}',
    )
  })

  it('refuses a stale originating block or mirror', () => {
    const original = '{}'
    const chat = artifactChat(original)
    chat.messages[1].timeline![1] = {
      ...chat.messages[1].timeline![1],
      arguments: '{"newer":true}',
    } as NonNullable<Message['timeline']>[number]
    const result = patchToolCallArguments(
      chat,
      {
        messageTurnId: 'turn-1',
        messageTimestamp: chat.messages[1].timestamp.getTime(),
        timelineBlockId: 'block-1',
        toolCallId: 'call-1',
        toolName: 'render_artifact_preview',
        originalArguments: original,
      },
      '{"fixed":true}',
    )

    expect(result).toMatchObject({
      ok: false,
      error: expect.any(ArtifactRetryError),
    })
    if (!result.ok) expect(result.error.code).toBe('stale_target')
  })

  it('patches a timeline-only legacy message without adding a mirror', () => {
    const chat = artifactChat('{}')
    chat.messages[1].toolCalls = undefined

    const result = patchToolCallArguments(
      chat,
      {
        messageTurnId: 'turn-1',
        messageTimestamp: chat.messages[1].timestamp.getTime(),
        timelineBlockId: 'block-1',
        toolCallId: 'call-1',
        toolName: 'render_artifact_preview',
        originalArguments: '{}',
      },
      '{"fixed":true}',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.chat.messages[1].timeline?.[1]).toMatchObject({
      arguments: '{"fixed":true}',
    })
    expect(result.chat.messages[1].toolCalls).toBeUndefined()
  })

  it.each([
    ['an empty mirror array', []],
    [
      'a mirror array missing the current tool call',
      [
        {
          id: 'call-2',
          name: 'render_chart',
          arguments: '{"type":"bar","data":[]}',
        },
      ],
    ],
  ] as const)('rejects %s', (_description, toolCalls) => {
    const chat = artifactChat('{}')
    chat.messages[1].toolCalls = [...toolCalls]

    expect(
      patchToolCallArguments(
        chat,
        {
          messageTurnId: 'turn-1',
          messageTimestamp: chat.messages[1].timestamp.getTime(),
          timelineBlockId: 'block-1',
          toolCallId: 'call-1',
          toolName: 'render_artifact_preview',
          originalArguments: '{}',
        },
        '{"fixed":true}',
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'stale_target' },
    })
  })

  it('rejects a stale or duplicate tool-call mirror', () => {
    const target = {
      messageTurnId: 'turn-1',
      messageTimestamp: artifactChat('{}').messages[1].timestamp.getTime(),
      timelineBlockId: 'block-1',
      toolCallId: 'call-1',
      toolName: 'render_artifact_preview',
      originalArguments: '{}',
    }
    const staleMirrorChat = artifactChat('{}')
    staleMirrorChat.messages[1].toolCalls![0].arguments = '{"stale":true}'
    const duplicateMirrorChat = artifactChat('{}')
    duplicateMirrorChat.messages[1].toolCalls!.push({
      ...duplicateMirrorChat.messages[1].toolCalls![0],
    })

    expect(
      patchToolCallArguments(staleMirrorChat, target, '{"fixed":true}'),
    ).toMatchObject({
      ok: false,
      error: { code: 'stale_target' },
    })
    expect(
      patchToolCallArguments(duplicateMirrorChat, target, '{"fixed":true}'),
    ).toMatchObject({
      ok: false,
      error: { code: 'stale_target' },
    })
  })
})
