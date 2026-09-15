import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { ChatQueryBuilder } from '@/services/inference/chat-query-builder'
import { REASONING_HISTORY_POLICIES } from '@/utils/reasoning-history'
import { describe, expect, it, vi } from 'vitest'

const model: BaseModel = {
  modelName: 'gpt-oss-120b',
  image: '',
  name: 'GPT-OSS 120B',
  nameShort: 'GPT-OSS',
  description: '',
  type: 'chat',
  chat: true,
}

const userMessage: Message = {
  role: 'user',
  content: 'hello',
  timestamp: new Date('2026-01-01T00:00:00Z'),
}

const preservedHistoryModel: BaseModel = {
  ...model,
  modelName: 'kimi-k3',
  name: 'Kimi K3',
  chatConfig: {
    reasoningConfig: { reasoningHistoryPolicy: REASONING_HISTORY_POLICIES.all },
  },
}

const toolCallHistoryModel: BaseModel = {
  ...model,
  modelName: 'gemma4-31b',
  name: 'Gemma 4',
  chatConfig: {
    reasoningConfig: {
      reasoningHistoryPolicy: REASONING_HISTORY_POLICIES.toolCallOnly,
    },
  },
}

describe('ChatQueryBuilder', () => {
  it('archives history using numeric context metadata', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model: {
        ...model,
        chatConfig: { contextWindowTokens: 1000 },
      },
      systemPrompt: '',
      rules: '',
      messages: [
        { ...userMessage, content: 'a'.repeat(1600) },
        { ...userMessage, content: 'b'.repeat(1600) },
        { ...userMessage, content: 'c'.repeat(1600) },
      ],
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: 'b'.repeat(1600) })
  })

  it('omits system messages when there is no prompt content', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: '',
      rules: '',
      messages: [userMessage],
      includeGenUIHint: false,
    })

    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('uses the system role for every model, including DeepSeek and Auto', () => {
    const deepseek: BaseModel = {
      ...model,
      modelName: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    }

    for (const params of [
      { model },
      { model: deepseek },
      { model, autoCandidates: [model, deepseek] },
    ]) {
      const messages = ChatQueryBuilder.buildMessages({
        ...params,
        systemPrompt: 'be helpful',
        rules: '',
        messages: [userMessage],
        includeGenUIHint: false,
      })

      expect(messages).toEqual([
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hello' },
      ])
    }
  })

  it('appends a current-time reminder as the last message when requested', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'be helpful',
      rules: '',
      messages: [userMessage],
      includeGenUIHint: false,
      includeTimeReminder: true,
    })

    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toMatch(
      /^<system-reminder>Current time: .+<\/system-reminder>$/,
    )
    expect(messages[messages.length - 2]).toEqual({
      role: 'user',
      content: 'hello',
    })
  })

  it('merges a trailing instruction into the time reminder turn after a partial assistant message', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: '',
      rules: '',
      messages: [
        userMessage,
        {
          role: 'assistant',
          content: 'Half of an answer',
          timestamp: new Date('2026-01-01T00:00:01Z'),
        },
      ],
      includeTimeReminder: true,
      trailingInstruction: 'Continue where you left off.',
    })

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Half of an answer',
    })
    const last = messages[messages.length - 1]
    expect(last.content).toMatch(/^<system-reminder>Current time: /)
    expect(last.content).toMatch(/\n\nContinue where you left off\.$/)
  })

  it('omits the time reminder by default', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'be helpful',
      rules: '',
      messages: [userMessage],
      includeGenUIHint: false,
    })

    expect(
      messages.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('<system-reminder>'),
      ),
    ).toBe(false)
  })

  it('builds byte-identical messages across calls when the wall clock advances within a minute', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-20T10:15:01Z'))
      const first = ChatQueryBuilder.buildMessages({
        model,
        systemPrompt: 'be helpful',
        rules: '',
        messages: [userMessage],
        includeGenUIHint: false,
        includeTimeReminder: true,
      })

      vi.setSystemTime(new Date('2026-07-20T10:15:42Z'))
      const second = ChatQueryBuilder.buildMessages({
        model,
        systemPrompt: 'be helpful',
        rules: '',
        messages: [userMessage],
        includeGenUIHint: false,
        includeTimeReminder: true,
      })

      expect(second).toEqual(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns exact assistant reasoning alongside content and tool calls', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model: preservedHistoryModel,
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: 'answer',
          thoughts: '  exact reasoning  ',
          toolCalls: [
            { id: 'call_1', name: 'render_chart', arguments: '{"value":1}' },
          ],
          timestamp: new Date(),
        },
      ],
      includeGenUIHint: false,
    })

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: '  exact reasoning  ',
      tool_calls: [{ id: 'call_1' }],
    })
    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'executed',
    })
  })

  it('keeps reasoning-only assistant messages when history is required', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model: preservedHistoryModel,
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: '',
          thoughts: 'reasoning only',
          timestamp: new Date(),
        },
      ],
      includeGenUIHint: false,
    })

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'reasoning only',
      },
    ])
  })

  it('omits reasoning when the model does not require preserved history', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: 'answer',
          thoughts: 'reasoning',
          timestamp: new Date(),
        },
      ],
      includeGenUIHint: false,
    })

    expect(messages[0]).toEqual({ role: 'assistant', content: 'answer' })
  })

  it('preserves reasoning only on tool-call messages for tool-call policy models', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model: toolCallHistoryModel,
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: 'ordinary answer',
          thoughts: 'omit this',
          timestamp: new Date(),
        },
        {
          role: 'assistant',
          content: '',
          thoughts: 'keep this',
          toolCalls: [{ id: 'call_1', name: 'render_chart', arguments: '{}' }],
          timestamp: new Date(),
        },
      ],
      includeGenUIHint: false,
    })

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: 'ordinary answer',
    })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'keep this',
      tool_calls: [{ id: 'call_1' }],
    })
  })

  it('preserves reasoning when any Auto candidate requires it', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      autoCandidates: [model, preservedHistoryModel],
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: 'answer',
          thoughts: 'reasoning',
          timestamp: new Date(),
        },
      ],
      includeGenUIHint: false,
    })

    expect(messages[0]).toMatchObject({ reasoning_content: 'reasoning' })
  })
})
