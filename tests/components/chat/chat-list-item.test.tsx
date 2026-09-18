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
  isPinned = false,
  isFlagged = false,
  showPinnedIndicator = true,
  showDesktopPinAction = true,
  onTogglePin,
}: {
  href?: string
  onSelect?: () => void
  chat?: ChatItemData
  isSelected?: boolean
  pixelateSidebarChatTitles?: boolean
  enableTitleAnimation?: boolean
  isStreaming?: boolean
  isPinned?: boolean
  isFlagged?: boolean
  showPinnedIndicator?: boolean
  showDesktopPinAction?: boolean
  onTogglePin?: () => void
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
      isPinned={isPinned}
      isFlagged={isFlagged}
      showPinnedIndicator={showPinnedIndicator}
      showDesktopPinAction={showDesktopPinAction}
      onTogglePin={onTogglePin}
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

describe('ChatListItem favorites', () => {
  it('shows pinned state and removes a favorite from the desktop action', () => {
    const onTogglePin = vi.fn()
    renderChatListItem({ isPinned: true, onTogglePin })

    expect(screen.getByLabelText('Pinned to Favorites')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove from Favorites' }),
    )
    expect(onTogglePin).toHaveBeenCalledOnce()
  })

  it('can hide pin controls next to a favorite title', () => {
    renderChatListItem({
      isPinned: true,
      showPinnedIndicator: false,
      showDesktopPinAction: false,
      onTogglePin: vi.fn(),
    })

    expect(screen.queryByLabelText('Pinned to Favorites')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Remove from Favorites' }),
    ).toBeNull()
  })

  it('can hide only the pinned marker', () => {
    renderChatListItem({
      isPinned: true,
      showPinnedIndicator: false,
      onTogglePin: vi.fn(),
    })

    expect(screen.queryByLabelText('Pinned to Favorites')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Remove from Favorites' }),
    ).toBeInTheDocument()
  })

  it('does not offer pinning for temporary chats', () => {
    renderChatListItem({
      chat: { ...savedChat, isTemporary: true },
      onTogglePin: vi.fn(),
    })
    expect(
      screen.queryByRole('button', { name: 'Pin to Favorites' }),
    ).not.toBeInTheDocument()
  })

  it('only offers unpinning while a chat save is pending', () => {
    renderChatListItem({
      chat: { ...savedChat, pendingSave: true },
      isPinned: true,
      onTogglePin: vi.fn(),
    })
    expect(
      screen.getByRole('button', { name: 'Remove from Favorites' }),
    ).toBeInTheDocument()
  })

  it('does not offer pinning while a chat save is pending', () => {
    renderChatListItem({
      chat: { ...savedChat, pendingSave: true },
      onTogglePin: vi.fn(),
    })
    expect(
      screen.queryByRole('button', { name: 'Pin to Favorites' }),
    ).not.toBeInTheDocument()
  })

  it('does not offer pinning for corrupted chats', () => {
    renderChatListItem({
      chat: { ...savedChat, dataCorrupted: true },
      onTogglePin: vi.fn(),
    })
    expect(
      screen.queryByRole('button', { name: 'Pin to Favorites' }),
    ).not.toBeInTheDocument()
  })

  it('offers the favorite action in the mobile menu', () => {
    const onTogglePin = vi.fn()
    renderChatListItem({ onTogglePin })

    fireEvent.click(screen.getByRole('button', { name: 'More chat options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to Favorites' }))

    expect(onTogglePin).toHaveBeenCalledOnce()
  })
})

describe('ChatListItem safeguards', () => {
  it('keeps the flag beside the title when the row has a favorite indicator and a timestamp', () => {
    renderChatListItem({
      isFlagged: true,
      isPinned: true,
      href: '/chat/chat-123',
      chat: { ...savedChat, createdAt: new Date().toISOString() },
      pixelateSidebarChatTitles: false,
    })
    const flag = screen.getByLabelText('Flagged by safeguards')
    expect(flag.parentElement).toContainElement(
      screen.getByText('Trip planning'),
    )
    expect(flag.parentElement).toContainElement(
      screen.getByLabelText('Pinned to Favorites'),
    )
    expect(
      screen.getByRole('link', { name: /Trip planning/ }),
    ).toContainElement(flag)
  })

  it('does not show a flag for unflagged chats', () => {
    renderChatListItem()
    expect(
      screen.queryByLabelText('Flagged by safeguards'),
    ).not.toBeInTheDocument()
  })
})

describe('ChatListItem title privacy', () => {
  it('redacts inactive saved chat titles by default', () => {
    renderChatListItem()

    expect(screen.getByText('Trip planning').parentElement).toHaveClass(
      'redacted-text',
    )
  })

  it('keeps the active chat title clear', () => {
    renderChatListItem({ isSelected: true })

    expect(screen.getByText('Trip planning').parentElement).not.toHaveClass(
      'redacted-text',
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
      'redacted-text',
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
      'redacted-text',
    )
  })

  it('keeps saved chat titles clear when title privacy is disabled', () => {
    renderChatListItem({ pixelateSidebarChatTitles: false })

    expect(screen.getByText('Trip planning').parentElement).not.toHaveClass(
      'redacted-text',
    )
  })

  it('updates redacted titles without hiding a stale animation', () => {
    const { rerenderChat } = renderChatListItem({ enableTitleAnimation: true })

    rerenderChat({ ...savedChat, title: 'Updated trip' })

    expect(screen.queryByText('Trip planning')).not.toBeInTheDocument()
    expect(screen.getByText('Updated trip').parentElement).toHaveClass(
      'redacted-text',
    )
  })
})

describe('ChatListItem message count', () => {
  const timestampedChat = {
    ...savedChat,
    createdAt: '2026-08-11T12:00:00.000Z',
    updatedAt: '2026-08-11T12:01:00.000Z',
  }

  it('shows only the title for saved chats', () => {
    renderChatListItem({ chat: { ...timestampedChat, messageCount: 4 } })

    expect(screen.getByText('Trip planning')).toBeInTheDocument()
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument()
  })

  it('trusts the stored count over the placeholder messages of a summary', () => {
    renderChatListItem({
      chat: {
        ...timestampedChat,
        messages: [],
        messageCount: 2,
        isMetadataOnly: true,
      },
    })

    expect(screen.queryByTitle('New chat')).not.toBeInTheDocument()
  })

  it('treats hydrated chats by their real messages', () => {
    renderChatListItem({
      chat: {
        ...timestampedChat,
        messages: { length: 0 },
        messageCount: 2,
        isMetadataOnly: false,
      },
    })

    expect(screen.getByTitle('New chat')).toBeInTheDocument()
  })
})
