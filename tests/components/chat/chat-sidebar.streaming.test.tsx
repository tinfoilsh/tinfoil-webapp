import { ChatSidebar } from '@/components/chat/chat-sidebar'
import {
  DragProvider,
  useDrag,
  type ChatDragSource,
} from '@/components/chat/drag-context'
import type { Chat } from '@/components/chat/types'
import { SETTINGS_CLOUD_SYNC_ENABLED } from '@/constants/storage-keys'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock('@/components/chat/sidebar-account-menu', () => ({
  SidebarAccountMenu: () => null,
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

function DragSource({
  source,
  fromProjectId,
}: {
  source: ChatDragSource
  fromProjectId: string | null
}) {
  const { setDraggingChat, draggingChatSource } = useDrag()
  return (
    <>
      <button
        onClick={() => setDraggingChat(activeChat.id, fromProjectId, source)}
      >
        Start drag
      </button>
      <output aria-label="Drag source">{draggingChatSource ?? 'none'}</output>
    </>
  )
}

const SIDEBAR_WIDTH = 1440

function SidebarHarness({
  currentChat = activeChat,
  source,
  fromProjectId = null,
  ...overrides
}: Partial<ComponentProps<typeof ChatSidebar>> & {
  source?: ChatDragSource
  fromProjectId?: string | null
}) {
  return (
    <DragProvider>
      {source && <DragSource source={source} fromProjectId={fromProjectId} />}
      <ChatSidebar
        isOpen
        setIsOpen={vi.fn()}
        chats={[currentChat, otherChat]}
        currentChat={currentChat}
        isDarkMode={false}
        pixelateSidebarChatTitles={false}
        createNewChat={vi.fn()}
        handleChatSelect={vi.fn()}
        updateChatTitle={vi.fn()}
        deleteChat={vi.fn()}
        isClient
        isPremium
        windowWidth={SIDEBAR_WIDTH}
        {...overrides}
      />
    </DragProvider>
  )
}

describe('chat sidebar during streaming', () => {
  beforeEach(() => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
  })

  it('keeps other chats visible and selectable through streaming updates', () => {
    const handleChatSelect = vi.fn()
    const streamingChat: Chat = {
      ...activeChat,
      activeRun: { runId: 'run-1' },
    }
    const sidebar = (currentChat: Chat) => (
      <SidebarHarness
        currentChat={currentChat}
        handleChatSelect={handleChatSelect}
      />
    )
    const { rerender } = render(sidebar(activeChat))
    const otherLink = screen.getByRole('link', { name: otherChat.title })
    expect(otherLink).toBeVisible()
    expect(screen.queryByText('Generating response')).not.toBeInTheDocument()

    rerender(sidebar(streamingChat))
    expect(screen.getByText('Generating response')).toBeInTheDocument()
    for (const content of ['First', 'First chunk', 'First chunk and more']) {
      rerender(
        sidebar({
          ...streamingChat,
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
    expect(handleChatSelect).toHaveBeenCalledExactlyOnceWith(otherChat.id)
    expect(screen.getByText('Generating response')).toBeInTheDocument()

    rerender(sidebar({ ...streamingChat, activeRun: null }))
    expect(screen.queryByText('Generating response')).not.toBeInTheDocument()
    expect(otherLink).toBeVisible()
  })

  it.each([
    { source: 'favorites', fromProjectId: null, outcome: 'unfavorite' },
    { source: 'chat-history', fromProjectId: null, outcome: 'none' },
    {
      source: 'chat-history',
      fromProjectId: 'project-1',
      outcome: 'leave project',
    },
  ] as const)(
    'routes a $source drop from project $fromProjectId on the chat list to $outcome',
    async ({ source, fromProjectId, outcome }) => {
      const onRemoveFavorite = vi.fn()
      const onRemoveChatFromProject = vi.fn(async () => {})
      render(
        <SidebarHarness
          source={source}
          fromProjectId={fromProjectId}
          pinnedChatIds={[activeChat.id]}
          onRemoveFavorite={onRemoveFavorite}
          onRemoveChatFromProject={onRemoveChatFromProject}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Start drag' }))
      expect(screen.getByLabelText('Drag source')).toHaveTextContent(source)

      await act(async () => {
        fireEvent.drop(screen.getByRole('link', { name: otherChat.title }), {
          dataTransfer: {
            getData: (type: string) => {
              if (type !== 'application/x-chat-id')
                throw new Error(`Unexpected drag type: ${type}`)
              return activeChat.id
            },
          },
        })
      })

      if (outcome === 'unfavorite')
        expect(onRemoveFavorite).toHaveBeenCalledExactlyOnceWith(activeChat.id)
      else expect(onRemoveFavorite).not.toHaveBeenCalled()
      if (outcome === 'leave project')
        expect(onRemoveChatFromProject).toHaveBeenCalledExactlyOnceWith(
          activeChat.id,
        )
      else expect(onRemoveChatFromProject).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Drag source')).toHaveTextContent('none')
    },
  )
})
