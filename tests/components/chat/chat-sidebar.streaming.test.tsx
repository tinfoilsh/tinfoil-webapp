import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { DragProvider } from '@/components/chat/drag-context'
import type { Chat } from '@/components/chat/types'
import { streamingTracker } from '@/services/cloud/streaming-tracker'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useUser: () => ({ user: { id: 'sidebar-user' } }),
}))
vi.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/' }),
}))
vi.mock('@/components/project/project-context', () => ({
  useProject: () => ({ activeProject: null, deleteProject: vi.fn() }),
}))
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ projects: [], loading: false, refresh: vi.fn() }),
}))
vi.mock('@/hooks/use-cloud-pagination', () => ({
  useCloudPagination: () => ({ hasMore: false, isInitialized: true }),
}))
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock('@/hooks/use-safeguards', () => ({
  useFlaggedChatIds: () => ({}),
}))
vi.mock('@/hooks/use-sync-health', () => ({
  useSyncHealthAttention: () => false,
  useSyncHealthFailed: () => false,
}))
vi.mock('@/components/chat/sidebar-account-menu', () => ({
  SidebarAccountMenu: () => null,
}))
vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => true,
  isLocalOnlyModeEnabled: () => true,
  hasUserSetLocalOnlyPreference: () => true,
  CLOUD_SYNC_SETTING_CHANGED_EVENT: 'cloudSyncSettingChanged',
}))

const activeChat: Chat = {
  id: 'active-chat',
  title: 'Active conversation',
  messages: [{ role: 'user', content: 'Hello', timestamp: new Date() }],
  createdAt: new Date(),
  isBlankChat: false,
  isLocalOnly: false,
}
const otherChat: Chat = {
  id: 'other-chat',
  title: 'Other conversation',
  messages: [],
  messageCount: 2,
  isMetadataOnly: true,
  createdAt: new Date(),
  isBlankChat: false,
  isLocalOnly: false,
}

describe('chat sidebar during streaming', () => {
  beforeEach(() => {
    sessionStorage.clear()
    streamingTracker.reset()
  })

  afterEach(() => {
    act(() => streamingTracker.reset())
  })

  it('keeps other chats visible and selectable through streaming updates', () => {
    const handleChatSelect = vi.fn()
    const sidebar = (currentChat: Chat) => (
      <DragProvider>
        <ChatSidebar
          isOpen
          setIsOpen={vi.fn()}
          chats={[currentChat, otherChat]}
          currentChat={currentChat}
          isDarkMode={false}
          pixelateSidebarChatTitles={false}
          createNewChat={vi.fn()}
          handleChatSelect={handleChatSelect}
          updateChatTitle={vi.fn()}
          deleteChat={vi.fn()}
          isClient
          isPremium
          windowWidth={1440}
        />
      </DragProvider>
    )
    const { rerender } = render(sidebar(activeChat))
    expect(
      screen.getByRole('tab', { name: 'Local' }).querySelector('svg'),
    ).toHaveAttribute('aria-hidden', 'true')
    const otherLink = screen.getByRole('link', { name: otherChat.title })
    expect(otherLink).toBeVisible()

    act(() => streamingTracker.startStreaming(activeChat.id))
    expect(screen.getByText('Generating response')).toBeInTheDocument()
    for (const content of ['First', 'First chunk', 'First chunk and more']) {
      rerender(
        sidebar({
          ...activeChat,
          messages: [
            ...activeChat.messages,
            { role: 'assistant', content, timestamp: new Date() },
          ],
        }),
      )
      expect(screen.getByRole('link', { name: otherChat.title })).toBe(
        otherLink,
      )
      expect(otherLink).toBeVisible()
    }

    fireEvent.click(otherLink)
    expect(handleChatSelect).toHaveBeenCalledWith(otherChat.id)
    expect(streamingTracker.isStreaming(activeChat.id)).toBe(true)

    act(() => streamingTracker.endStreaming(activeChat.id))
    expect(screen.queryByText('Generating response')).not.toBeInTheDocument()
    expect(otherLink).toBeVisible()
  })
})
