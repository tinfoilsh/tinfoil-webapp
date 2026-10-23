import {
  ChatListItem,
  type ChatItemData,
} from '@/components/chat/chat-list-item'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ])('preserves modified-click link behavior (%j)', (modifiers) => {
    const { onSelect } = renderChatListItem({ href: '/chat/chat-123' })
    const link = screen.getByRole('link')

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ...modifiers,
    })
    fireEvent(link, event)
    expect(event.defaultPrevented).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('ChatListItem favorites', () => {
  it('does not show a pinned indicator for an unpinned chat', () => {
    renderChatListItem({ onTogglePin: vi.fn() })

    expect(
      screen.queryByLabelText('Pinned to Favorites'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pin to Favorites' }),
    ).toBeInTheDocument()
  })

  it('hides the pinned indicator during streaming and restores it afterward', () => {
    const { rerenderChat } = renderChatListItem({ isPinned: true })
    const indicator = screen.getByLabelText('Pinned to Favorites').outerHTML

    rerenderChat(savedChat, true)

    expect(
      screen.queryByLabelText('Pinned to Favorites'),
    ).not.toBeInTheDocument()
    expect(screen.getByTitle('Generating response')).toBeInTheDocument()

    rerenderChat(savedChat, false)

    expect(screen.getByLabelText('Pinned to Favorites').outerHTML).toBe(
      indicator,
    )
    expect(screen.queryByTitle('Generating response')).not.toBeInTheDocument()
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

    cleanup()
    renderChatListItem({
      isPinned: true,
      showPinnedIndicator: false,
      showDesktopPinAction: false,
      onTogglePin: vi.fn(),
    })
    expect(
      screen.queryByRole('button', { name: 'Remove from Favorites' }),
    ).toBeNull()
  })

  it.each([
    { isTemporary: true },
    { pendingSave: true },
    { dataCorrupted: true },
  ])('does not offer pinning for a chat with %j', (state) => {
    renderChatListItem({
      chat: { ...savedChat, ...state },
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
})

describe('ChatListItem safeguards', () => {
  it('shows the flag in the row of a flagged chat only', () => {
    renderChatListItem({ isFlagged: true, href: '/chat/chat-123' })
    expect(
      screen.getByRole('link', { name: /Trip planning/ }),
    ).toContainElement(screen.getByLabelText('Flagged by safeguards'))

    cleanup()
    renderChatListItem({ href: '/chat/chat-123' })
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

  it('keeps saved chats without messages clear', () => {
    const { rerenderChat } = renderChatListItem({
      chat: {
        id: 'empty-saved-chat',
        title: 'Empty saved chat',
        messageCount: 0,
      },
    })

    expect(screen.getByText('Empty saved chat').parentElement).not.toHaveClass(
      'redacted-text',
    )
    rerenderChat({
      id: 'blank-chat',
      title: 'New Chat',
      isBlankChat: true,
      messageCount: 0,
    })
    expect(screen.getByText('New Chat').parentElement).not.toHaveClass(
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

  it('cancels a rename on Escape and marks the key handled for the sidebar', () => {
    const onCancelEdit = vi.fn()
    render(
      <ChatListItem
        chat={savedChat}
        isSelected={false}
        isEditing
        editingTitle="Trip planning"
        isDarkMode={false}
        pixelateSidebarChatTitles={false}
        onSelect={vi.fn()}
        onStartEdit={vi.fn()}
        onTitleChange={vi.fn()}
        onSaveTitle={vi.fn()}
        onCancelEdit={onCancelEdit}
        onRequestDelete={vi.fn()}
      />,
    )

    const title = screen.getByRole('textbox', { name: 'Chat title' })
    expect(fireEvent.keyDown(title, { key: 'Escape' })).toBe(false)
    expect(onCancelEdit).toHaveBeenCalledOnce()
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
