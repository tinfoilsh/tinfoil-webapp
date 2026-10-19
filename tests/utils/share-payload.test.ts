import { validateShareableChatData } from '@/utils/share-payload'
import { describe, expect, it } from 'vitest'

const validPayload = {
  v: 1 as const,
  title: 'Shared chat',
  messages: [
    {
      role: 'user' as const,
      content: 'Hello',
      timestamp: 1,
    },
    {
      role: 'assistant' as const,
      content: 'Hi',
      modelDisplayName: 'Tinfoil Model',
      timestamp: 2,
    },
  ],
  createdAt: 1,
}

describe('validateShareableChatData', () => {
  it('accepts payload v1', () => {
    expect(validateShareableChatData(validPayload)).toEqual(validPayload)
  })

  it.each([
    { ...validPayload, v: 0 },
    { ...validPayload, v: 2 },
    { ...validPayload, title: null },
    { ...validPayload, messages: null },
    { ...validPayload, createdAt: '1' },
    {
      ...validPayload,
      messages: [{ role: 'system', content: 'Hello', timestamp: 1 }],
    },
    {
      ...validPayload,
      messages: [{ role: 'user', content: null, timestamp: 1 }],
    },
  ])('rejects an invalid or unsupported payload', (payload) => {
    expect(validateShareableChatData(payload)).toBeNull()
  })
})
