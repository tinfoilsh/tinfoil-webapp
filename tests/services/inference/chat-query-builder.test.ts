import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { ChatQueryBuilder } from '@/services/inference/chat-query-builder'
import { describe, expect, it } from 'vitest'

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

describe('ChatQueryBuilder', () => {
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

  it('omits synthetic system wrappers when there is no prompt content', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model: { ...model, modelName: 'deepseek-r1' },
      systemPrompt: '',
      rules: '',
      messages: [userMessage],
      includeGenUIHint: false,
    })

    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('uses the system role for system-role models by default', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'be helpful',
      rules: '',
      messages: [userMessage],
      includeGenUIHint: false,
    })

    expect(messages[0]).toEqual({ role: 'system', content: 'be helpful' })
  })

  it('prepends the system prompt as a user message when forced', () => {
    const messages = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'be helpful',
      rules: '',
      messages: [userMessage],
      includeGenUIHint: false,
      forcePrependSystemPrompt: true,
    })

    expect(messages.some((m) => m.role === 'system')).toBe(false)
    expect(messages[0]).toEqual({
      role: 'user',
      content: '<system>\nbe helpful\n</system>',
    })
  })
})
