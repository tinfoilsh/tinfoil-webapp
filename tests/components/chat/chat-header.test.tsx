import { ChatHeader } from '@/components/chat/chat-header'
import type { Chat } from '@/components/chat/types'
import {
  reportChatSyncFailed,
  resetSyncHealth,
} from '@/services/cloud/sync-health'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const baseChat: Chat = {
  id: 'chat-1',
  title: 'Trip planning',
  messages: [],
  messageCount: 4,
  isMetadataOnly: true,
  createdAt: new Date('2026-08-11T10:00:00.000Z'),
  updatedAt: '2026-08-11T13:25:00.000Z',
}

function renderHeader(chat: Partial<Chat> = {}, isStreaming = false) {
  return render(
    <ChatHeader
      chat={{ ...baseChat, ...chat }}
      isStreaming={isStreaming}
      actions={<button type="button">Share</button>}
    />,
  )
}

describe('ChatHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T13:30:00.000Z'))
    resetSyncHealth()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('uses one clock reference for identical created and updated timestamps', () => {
    const timestamp = new Date('2026-08-11T13:00:00.000Z')
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(timestamp.getTime() + 59_999)
      .mockReturnValue(timestamp.getTime() + 60_000)
    renderHeader({
      createdAt: timestamp,
      updatedAt: timestamp.toISOString(),
      messageCount: 4,
    })
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument()
    expect(now).toHaveBeenCalledTimes(1)
  })

  it('shows the title, creation time, and updated time for later turns', () => {
    renderHeader({ syncedAt: Date.now() })

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Trip planning',
    )
    expect(screen.getByText('3h ago')).toBeInTheDocument()
    expect(screen.getByText('Updated 5m ago')).toBeInTheDocument()
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument()
  })

  it('includes the sidebar toggle within the same header as the title and actions', () => {
    const onOpenSidebar = vi.fn()
    render(
      <ChatHeader
        chat={baseChat}
        isStreaming={false}
        leadingAction={<button onClick={onOpenSidebar}>Open sidebar</button>}
        actions={<button>Share</button>}
      />,
    )

    const header = screen.getByRole('banner')
    const toggle = within(header).getByRole('button', { name: 'Open sidebar' })
    expect(within(header).getByRole('heading')).toHaveTextContent(
      'Trip planning',
    )
    expect(
      within(header).getByRole('button', { name: 'Share' }),
    ).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(onOpenSidebar).toHaveBeenCalledTimes(1)
  })

  it('hides the updated time for the initial turn and while streaming', () => {
    const { rerender } = renderHeader({ messageCount: 2 })
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument()

    rerender(
      <ChatHeader
        chat={{ ...baseChat, messageCount: 4 }}
        isStreaming
        actions={null}
      />,
    )
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument()
  })

  it('prefers the local-only label over cloud sync state', () => {
    renderHeader({ isLocalOnly: true, syncedAt: Date.now() })

    expect(screen.getByText('Only saved locally')).toBeInTheDocument()
    expect(screen.queryByText('Synced')).not.toBeInTheDocument()
  })

  it.each(['pendingSave', 'locallyModified'] as const)(
    'does not report an old sync timestamp while %s is set',
    (dirtyFlag) => {
      const chat = { ...baseChat, [dirtyFlag]: true, syncedAt: Date.now() }
      const { rerender } = renderHeader(chat, true)
      expect(screen.queryByText('Synced')).not.toBeInTheDocument()
      expect(screen.queryByText('Syncing')).not.toBeInTheDocument()
      rerender(<ChatHeader chat={chat} isStreaming={false} actions={null} />)
      expect(screen.getByText('Syncing')).toBeInTheDocument()
      expect(screen.queryByText('Synced')).not.toBeInTheDocument()
      rerender(
        <ChatHeader
          chat={{ ...chat, [dirtyFlag]: false }}
          isStreaming={false}
          actions={null}
        />,
      )
      expect(screen.getByText('Synced')).toBeInTheDocument()
    },
  )

  it('surfaces per-chat sync failures from the sync-health store', () => {
    reportChatSyncFailed('chat-1', 'upload rejected')
    renderHeader({ pendingSave: true })

    expect(screen.getByText("Couldn't sync")).toBeInTheDocument()
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument()
  })

  it('marks temporary chats instead of showing sync state', () => {
    renderHeader({ isTemporary: true, pendingSave: true })

    expect(screen.getByText('Temporary chat')).toBeInTheDocument()
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument()
  })
})
