import { createUpdateChatWithHistoryCheck } from '@/components/chat/hooks/chat-persistence'
import { useChatCollection } from '@/components/chat/hooks/use-chat-collection'
import type { Chat, Message } from '@/components/chat/types'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/storage/session-storage', () => ({
  sessionChatStorage: {
    saveChat: vi.fn(),
    saveStreamingDraft: vi.fn(),
    clearStreamingDraft: vi.fn(),
  },
}))

vi.mock('@/services/storage/chat-storage', () => ({
  chatStorage: { saveChat: vi.fn() },
}))

function createChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function renderCollection(chats: Chat[], currentChat: Chat = chats[0]) {
  return renderHook(() => useChatCollection(() => ({ chats, currentChat })))
}

describe('useChatCollection', () => {
  it('preserves the chats reference across unrelated renders', () => {
    const chat = createChat()
    const { result, rerender } = renderCollection([chat])
    const initialChats = result.current.chats

    rerender()

    expect(result.current.chats).toBe(initialChats)
  })

  it('immediately reflects list entity updates in the current chat', () => {
    const chat = createChat()
    const { result } = renderCollection([chat])

    act(() => {
      result.current.setChats((previous) =>
        previous.map((item) =>
          item.id === chat.id ? { ...item, title: 'From list' } : item,
        ),
      )
    })

    expect(result.current.currentChat.title).toBe('From list')
  })

  it('immediately reflects same-identity current updates in the list', () => {
    const chat = createChat()
    const { result } = renderCollection([chat])

    act(() => {
      result.current.setCurrentChat((previous) => ({
        ...previous,
        title: 'From current',
      }))
    })

    expect(result.current.chats[0].title).toBe('From current')
  })

  it('keeps blank cloud and local chat identities separate', () => {
    const cloudBlank = createChat({ id: '', isBlankChat: true })
    const localBlank = createChat({
      id: '',
      isBlankChat: true,
      isLocalOnly: true,
    })
    const { result } = renderCollection([cloudBlank, localBlank])

    act(() => {
      result.current.setCurrentChat(localBlank)
      result.current.setCurrentChat((previous) => ({
        ...previous,
        title: 'Local blank',
      }))
    })

    expect(result.current.currentChat.isLocalOnly).toBe(true)
    expect(result.current.chats[0].title).toBe('Chat')
    expect(result.current.chats[1].title).toBe('Local blank')
  })

  it('supports a detached temporary current chat without listing it', () => {
    const listedChat = createChat()
    const temporaryChat = createChat({ id: 'temporary', isTemporary: true })
    const { result } = renderCollection([listedChat])

    act(() => {
      result.current.setCurrentChat(temporaryChat)
    })

    expect(result.current.currentChat).toEqual(temporaryChat)
    expect(result.current.chats).toEqual([listedChat])
  })

  it('selects an existing list entity instead of creating a detached copy', () => {
    const first = createChat({ id: 'first' })
    const second = createChat({ id: 'second' })
    const { result } = renderCollection([first, second], first)

    act(() => result.current.setCurrentChat(second))

    expect(result.current.currentChat).toBe(result.current.chats[1])

    act(() => {
      result.current.setCurrentChat((current) => ({
        ...current,
        title: 'Selected',
      }))
    })

    expect(result.current.chats[1].title).toBe('Selected')
  })

  it('applies queued blank-to-real updates before joining the ordered list', () => {
    const blank = createChat({ id: '', isBlankChat: true })
    const realChat = createChat({ id: 'real-chat', isBlankChat: false })
    const streamedMessage: Message = {
      role: 'assistant',
      content: 'First response',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    }
    const { result } = renderCollection([blank])
    const updateChat = createUpdateChatWithHistoryCheck({
      storeHistory: false,
      chatsRef: { current: [blank] },
      currentChatRef: { current: blank },
    })

    act(() => {
      result.current.setCurrentChat(realChat)
      updateChat(
        result.current.setChats,
        realChat,
        result.current.setCurrentChat,
        realChat.id,
        [streamedMessage],
      )
    })

    expect(result.current.currentChat.id).toBe('real-chat')
    expect(result.current.currentChat.messages).toEqual([streamedMessage])
    expect(result.current.chats).toEqual([blank])

    act(() => {
      result.current.setChats([result.current.currentChat])
    })

    expect(result.current.chats[0]).toBe(result.current.currentChat)
  })

  it('guards the active view from a background stream after navigation', () => {
    const first = createChat({ id: 'first' })
    const second = createChat({ id: 'second', title: 'Second' })
    const streamedMessage: Message = {
      role: 'assistant',
      content: 'background result',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    }
    const { result } = renderCollection([first, second], first)
    const updateChat = createUpdateChatWithHistoryCheck({
      storeHistory: false,
      chatsRef: { current: [first, second] },
      currentChatRef: { current: first },
    })

    act(() => {
      result.current.setCurrentChat(second)
      updateChat(
        result.current.setChats,
        first,
        result.current.setCurrentChat,
        first.id,
        [streamedMessage],
      )
    })

    expect(result.current.currentChat.id).toBe(second.id)
    expect(result.current.currentChat.messages).toEqual([])
    expect(result.current.chats[0].messages).toEqual([streamedMessage])
  })

  it('persists guest chats during streaming updates', () => {
    vi.mocked(sessionChatStorage.saveStreamingDraft).mockClear()
    const chat = createChat()
    const partialMessage: Message = {
      role: 'assistant',
      content: 'Partial response',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    }
    const updateChat = createUpdateChatWithHistoryCheck({
      storeHistory: false,
      chatsRef: { current: [chat] },
      currentChatRef: { current: chat },
    })

    updateChat(vi.fn(), chat, vi.fn(), chat.id, [partialMessage], {
      skipIndexedDBSave: true,
    })

    expect(sessionChatStorage.saveStreamingDraft).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [partialMessage] }),
    )
  })

  it('skips IndexedDB during streaming updates', () => {
    vi.mocked(chatStorage.saveChat).mockClear()
    vi.mocked(sessionChatStorage.clearStreamingDraft).mockClear()
    const chat = createChat()
    const updateChat = createUpdateChatWithHistoryCheck({
      storeHistory: true,
      chatsRef: { current: [chat] },
      currentChatRef: { current: chat },
    })

    updateChat(vi.fn(), chat, vi.fn(), chat.id, [], {
      skipIndexedDBSave: true,
    })

    expect(chatStorage.saveChat).not.toHaveBeenCalled()
    expect(sessionChatStorage.clearStreamingDraft).not.toHaveBeenCalled()

    vi.mocked(chatStorage.saveChat).mockResolvedValue(chat)
    updateChat(vi.fn(), chat, vi.fn(), chat.id, [])

    expect(sessionChatStorage.clearStreamingDraft).toHaveBeenCalledWith(chat.id)
    expect(chatStorage.saveChat).toHaveBeenCalled()
  })
})
