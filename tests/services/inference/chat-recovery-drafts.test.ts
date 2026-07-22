import {
  clearChatRecoveryDraft,
  clearChatRecoveryDrafts,
  getChatRecoveryDraftSnapshot,
  pruneChatRecoveryDrafts,
  setChatRecoveryDraft,
  subscribeChatRecoveryDrafts,
} from '@/services/inference/chat-recovery-drafts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const message = (content: string) => ({
  role: 'assistant' as const,
  content,
  timestamp: new Date('2026-07-21T00:00:00.000Z'),
})

describe('chat recovery drafts', () => {
  beforeEach(() => {
    clearChatRecoveryDrafts()
  })

  it('replaces reconnect snapshots without letting an old session clear them', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeChatRecoveryDrafts(listener)
    setChatRecoveryDraft({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      message: message('First replay'),
    })
    setChatRecoveryDraft({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: 'session-2',
      message: message('Reconnected replay'),
    })

    clearChatRecoveryDraft('session-1')

    expect(getChatRecoveryDraftSnapshot()).toEqual([
      expect.objectContaining({
        sessionId: 'session-2',
        message: expect.objectContaining({ content: 'Reconnected replay' }),
      }),
    ])
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('prunes drafts whose pending turn no longer exists', () => {
    setChatRecoveryDraft({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      message: message('Partial'),
    })

    pruneChatRecoveryDrafts(new Set())

    expect(getChatRecoveryDraftSnapshot()).toEqual([])
  })
})
