import {
  ChatListItem,
  type ChatItemData,
} from '@/components/chat/chat-list-item'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const savedChat: ChatItemData = {
  id: 'chat-123',
  title: 'Trip planning',
  messageCount: 2,
}

function renderChatListItem({
  href,
  onSelect = vi.fn(),
  chat = savedChat,
  isSelected = false,
  pixelateSidebarChatTitles = true,
  enableTitleAnimation = false,
  isStreaming = false,
}: {
  href?: string
  onSelect?: () => void
  chat?: ChatItemData
  isSelected?: boolean
  pixelateSidebarChatTitles?: boolean
  enableTitleAnimation?: boolean
  isStreaming?: boolean
} = {}) {
  const renderItem = (item: ChatItemData, streaming: boolean) => (
    <ChatListItem
      chat={item}
      href={href}
      isSelected={isSelected}
      isEditing={false}
      editingTitle=""
      isDarkMode={false}
      pixelateSidebarChatTitles={pixelateSidebarChatTitles}
      enableTitleAnimation={enableTitleAnimation}
      isStreaming={streaming}
      onSelect={onSelect}
      onStartEdit={vi.fn()}
      onTitleChange={vi.fn()}
      onSaveTitle={vi.fn()}
      onCancelEdit={vi.fn()}
      onRequestDelete={vi.fn()}
    />
  )
  const view = render(renderItem(chat, isStreaming))
  return {
    onSelect,
    rerenderChat: (updatedChat: ChatItemData, streaming = isStreaming) =>
      view.rerender(renderItem(updatedChat, streaming)),
  }
}

describe('ChatListItem navigation semantics', () => {
  it('renders persistent chats as links and handles ordinary clicks in place', () => {
    const { onSelect } = renderChatListItem({ href: '/chat/chat-123' })
    const link = screen.getByRole('link', { name: /Trip planning/ })

    expect(link).toHaveAttribute('href', '/chat/chat-123')
    fireEvent.click(link)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('preserves modified- and middle-click link behavior', () => {
    const { onSelect } = renderChatListItem({ href: '/chat/chat-123' })
    const link = screen.getByRole('link')

    fireEvent.click(link, { ctrlKey: true })
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders chats without destinations as buttons', () => {
    const { onSelect } = renderChatListItem()

    fireEvent.click(screen.getByRole('button', { name: /Trip planning/ }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('ChatListItem title privacy', () => {
  it('pixelates inactive saved chat titles by default', () => {
    renderChatListItem()

    expect(screen.getByText('Trip planning').parentElement).toHaveClass(
      'pixelated-text',
    )
  })

  it('keeps the active chat title clear', () => {
    renderChatListItem({ isSelected: true })

    expect(screen.getByText('Trip planning').parentElement).not.toHaveClass(
      'pixelated-text',
    )
  })

  it('keeps the new chat title clear', () => {
    renderChatListItem({
      chat: {
        id: 'blank-chat',
        title: 'New Chat',
        isBlankChat: true,
        messageCount: 0,
      },
    })

    expect(screen.getByText('New Chat').parentElement).not.toHaveClass(
      'pixelated-text',
    )
  })

  it('keeps saved chats without messages clear', () => {
    renderChatListItem({
      chat: {
        id: 'empty-saved-chat',
        title: 'Empty saved chat',
        messageCount: 0,
      },
    })

    expect(screen.getByText('Empty saved chat').parentElement).not.toHaveClass(
      'pixelated-text',
    )
  })

  it('keeps saved chat titles clear when pixelation is disabled', () => {
    renderChatListItem({ pixelateSidebarChatTitles: false })

    expect(screen.getByText('Trip planning').parentElement).not.toHaveClass(
      'pixelated-text',
    )
  })

  it('updates pixelated titles without hiding a stale animation', () => {
    const { rerenderChat } = renderChatListItem({ enableTitleAnimation: true })

    rerenderChat({ ...savedChat, title: 'Updated trip' })

    expect(screen.queryByText('Trip planning')).not.toBeInTheDocument()
    expect(screen.getByText('Updated trip').parentElement).toHaveClass(
      'pixelated-text',
    )
  })
})

describe('ChatListItem streaming timestamp', () => {
  it('keeps relative time stable and hides updated time while streaming', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T00:00:10.000Z'))
    const chat = {
      ...savedChat,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:05.000Z',
    }

    try {
      const { rerenderChat } = renderChatListItem({ chat, isStreaming: true })
      expect(screen.getByText('10s ago')).toBeInTheDocument()
      expect(screen.queryByText(/Updated/)).not.toBeInTheDocument()

      vi.advanceTimersByTime(5_000)
      rerenderChat({
        ...chat,
        messageCount: 3,
        updatedAt: '2026-08-07T00:00:10.000Z',
      })

      expect(screen.getByText('10s ago')).toBeInTheDocument()
      expect(screen.queryByText(/Updated/)).not.toBeInTheDocument()

      rerenderChat(chat, false)

      expect(screen.getByText('15s ago')).toBeInTheDocument()
      expect(screen.getByText(/Updated 10s ago/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
