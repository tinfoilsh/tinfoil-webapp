import type { Chat } from '@/components/chat/types'
import {
  SYNC_SESSION_CHAT_DRAFT_PREFIX,
  SYNC_SESSION_CHATS,
} from '@/constants/storage-keys'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

function chat(id: string, content: string): Chat {
  return {
    id,
    title: id,
    messages: [
      {
        role: 'assistant',
        content,
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    isBlankChat: false,
  }
}

describe('sessionChatStorage streaming drafts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('merges a streaming draft without rewriting the chat collection', () => {
    const persisted = chat('chat-1', 'partial')
    sessionChatStorage.saveChat(persisted)
    const collectionBeforeDraft = sessionStorage.getItem(SYNC_SESSION_CHATS)

    sessionChatStorage.saveStreamingDraft(chat('chat-1', 'partial response'))

    expect(sessionStorage.getItem(SYNC_SESSION_CHATS)).toBe(
      collectionBeforeDraft,
    )
    expect(sessionChatStorage.getChat('chat-1')?.messages[0].content).toBe(
      'partial response',
    )
  })

  it('keeps unrelated drafts separate when saving a chat', () => {
    sessionChatStorage.saveChat(chat('chat-a', 'before'))
    sessionChatStorage.saveChat(chat('chat-b', 'persisted'))
    sessionChatStorage.saveStreamingDraft(chat('chat-b', 'streaming'))

    sessionChatStorage.saveChat(chat('chat-a', 'complete'))

    const canonicalChats = JSON.parse(
      sessionStorage.getItem(SYNC_SESSION_CHATS) ?? '[]',
    ) as Chat[]
    expect(
      canonicalChats.find((storedChat) => storedChat.id === 'chat-b')
        ?.messages[0].content,
    ).toBe('persisted')
    expect(sessionChatStorage.getChat('chat-b')?.messages[0].content).toBe(
      'streaming',
    )

    sessionChatStorage.saveChat(chat('chat-b', 'complete'))

    expect(
      sessionStorage.getItem(`${SYNC_SESSION_CHAT_DRAFT_PREFIX}chat-b`),
    ).toBeNull()
    expect(sessionChatStorage.getChat('chat-b')?.messages[0].content).toBe(
      'complete',
    )
  })

  it('keeps unrelated drafts separate when deleting a chat', () => {
    sessionChatStorage.saveChat(chat('chat-a', 'persisted'))
    sessionChatStorage.saveChat(chat('chat-b', 'persisted'))
    sessionChatStorage.saveStreamingDraft(chat('chat-b', 'streaming'))

    sessionChatStorage.deleteChat('chat-a')

    const canonicalChats = JSON.parse(
      sessionStorage.getItem(SYNC_SESSION_CHATS) ?? '[]',
    ) as Chat[]
    expect(canonicalChats).toHaveLength(1)
    expect(canonicalChats[0].id).toBe('chat-b')
    expect(canonicalChats[0].messages[0].content).toBe('persisted')
    expect(sessionChatStorage.getChat('chat-b')?.messages[0].content).toBe(
      'streaming',
    )
  })

  it.each(['save', 'delete'] as const)(
    'restores the target draft when a canonical %s fails',
    (operation) => {
      sessionChatStorage.saveChat(chat('chat-1', 'persisted'))
      sessionChatStorage.saveStreamingDraft(chat('chat-1', 'streaming'))
      const canonicalBefore = sessionStorage.getItem(SYNC_SESSION_CHATS)
      const originalSetItem = sessionStorage.setItem.bind(sessionStorage)
      const setItemSpy = vi
        .spyOn(sessionStorage, 'setItem')
        .mockImplementation((key, value) => {
          if (key === SYNC_SESSION_CHATS) {
            throw new DOMException(
              'Storage quota exceeded',
              'QuotaExceededError',
            )
          }
          originalSetItem(key, value)
        })

      try {
        if (operation === 'save') {
          sessionChatStorage.saveChat(chat('chat-1', 'complete'))
        } else {
          sessionChatStorage.deleteChat('chat-1')
        }
        expect(setItemSpy).toHaveBeenCalledWith(
          SYNC_SESSION_CHATS,
          JSON.stringify(
            operation === 'save' ? [chat('chat-1', 'complete')] : [],
          ),
        )
        expect(sessionStorage.getItem(SYNC_SESSION_CHATS)).toBe(canonicalBefore)
        expect(sessionChatStorage.getChat('chat-1')?.messages[0].content).toBe(
          'streaming',
        )
      } finally {
        setItemSpy.mockRestore()
      }
    },
  )

  it('clears drafts when chats are deleted or storage is cleared', () => {
    sessionChatStorage.saveChat(chat('chat-1', 'before'))
    sessionChatStorage.saveStreamingDraft(chat('chat-1', 'streaming'))
    sessionChatStorage.deleteChat('chat-1')
    expect(sessionChatStorage.getChat('chat-1')).toBeNull()

    const unrelatedKey = 'unrelated-session-state'
    sessionStorage.setItem(unrelatedKey, 'retain')
    sessionChatStorage.saveChat(chat('chat-2', 'persisted'))
    sessionChatStorage.saveStreamingDraft(chat('chat-2', 'streaming'))
    sessionChatStorage.saveStreamingDraft(chat('chat-3', 'another draft'))
    sessionChatStorage.clearAll()
    expect(sessionChatStorage.getAllChats()).toEqual([])
    expect(sessionStorage.getItem(SYNC_SESSION_CHATS)).toBeNull()
    expect(
      sessionStorage.getItem(`${SYNC_SESSION_CHAT_DRAFT_PREFIX}chat-2`),
    ).toBeNull()
    expect(
      sessionStorage.getItem(`${SYNC_SESSION_CHAT_DRAFT_PREFIX}chat-3`),
    ).toBeNull()
    expect(sessionStorage.getItem(unrelatedKey)).toBe('retain')
  })
})
