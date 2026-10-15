import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { DragProvider } from '@/components/chat/drag-context'
import type { Chat } from '@/components/chat/types'
import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
  UI_SIDEBAR_ACTIVE_TAB,
} from '@/constants/storage-keys'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ isSignedIn: true }))
vi.mock('@clerk/react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: auth.isSignedIn }),
  useUser: () => ({ user: auth.isSignedIn ? { id: 'sidebar-user' } : null }),
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

const cloudChat: Chat = {
  id: 'cloud-chat',
  title: 'Synced conversation',
  messages: [],
  messageCount: 2,
  isMetadataOnly: true,
  createdAt: new Date('2026-05-01T10:00:00Z'),
  updatedAt: '2026-05-01T10:00:00Z',
  isLocalOnly: false,
}
const localChat: Chat = {
  id: '8233746419999_8a3b4f1e-6f7d-4d52-9c3a-0e1f2a3b4c5d',
  title: 'Device conversation',
  messages: [],
  messageCount: 2,
  isMetadataOnly: true,
  createdAt: new Date('2026-05-01T09:00:00Z'),
  updatedAt: '2026-05-01T09:00:00Z',
  isLocalOnly: true,
}
const blankChat = (isLocalOnly: boolean): Chat => ({
  id: '',
  title: 'New Chat',
  messages: [],
  createdAt: new Date(),
  isBlankChat: true,
  isLocalOnly,
})

function Sidebar(props: Partial<ComponentProps<typeof ChatSidebar>>) {
  return (
    <DragProvider>
      <ChatSidebar
        isOpen
        setIsOpen={vi.fn()}
        chats={[cloudChat, localChat]}
        currentChat={blankChat(false)}
        isDarkMode={false}
        pixelateSidebarChatTitles={false}
        createNewChat={vi.fn()}
        handleChatSelect={vi.fn()}
        updateChatTitle={vi.fn()}
        deleteChat={vi.fn()}
        onToggleFavorite={vi.fn()}
        onMoveChatToProject={vi.fn(async () => {})}
        isClient
        isPremium
        windowWidth={1440}
        {...props}
      />
    </DragProvider>
  )
}

const chatTitles = () =>
  screen
    .queryAllByRole('listitem')
    .map((item) => within(item).queryByRole('link')?.textContent ?? '')

describe('chat sidebar storage modes', () => {
  beforeEach(() => {
    auth.isSignedIn = true
    sessionStorage.clear()
  })

  it('lists only local chats and offers cloud sync to an account without it', async () => {
    const onCloudSyncSetupClick = vi.fn()
    render(
      <Sidebar
        currentChat={blankChat(true)}
        onCloudSyncSetupClick={onCloudSyncSetupClick}
      />,
    )

    expect(chatTitles()).toEqual([localChat.title])
    expect(
      screen.getByText(/Chats are only stored locally on this device\./),
    ).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Favorites' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Pin to Favorites' }),
    ).not.toBeInTheDocument()
    expect(
      screen
        .getByRole('link', { name: localChat.title })
        .closest('[draggable]'),
    ).toHaveAttribute('draggable', 'false')
    expect(screen.getByRole('link', { name: localChat.title })).toHaveAttribute(
      'href',
      `/chat/local/${localChat.id}`,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable Cloud Sync' }))
    await waitFor(() => expect(onCloudSyncSetupClick).toHaveBeenCalledOnce())
  })

  it('lists only synced chats with cloud sync until local chats are enabled', () => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    localStorage.setItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED, 'false')
    render(<Sidebar />)

    expect(chatTitles()).toEqual([cloudChat.title])
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Chats are only stored locally on this device\./),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pin to Favorites' }),
    ).toBeInTheDocument()
  })

  it('starts new chats on the device from the Local tab', () => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    localStorage.setItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED, 'true')
    const createNewChat = vi.fn()
    const { rerender } = render(<Sidebar createNewChat={createNewChat} />)

    const tabs = within(screen.getByRole('tablist', { name: 'Chat storage' }))
    expect(tabs.getByRole('tab', { name: 'Cloud' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(chatTitles()).toEqual([cloudChat.title])
    expect(createNewChat).not.toHaveBeenCalled()

    fireEvent.click(tabs.getByRole('tab', { name: 'Local' }))

    expect(chatTitles()).toEqual([localChat.title])
    expect(sessionStorage.getItem(UI_SIDEBAR_ACTIVE_TAB)).toBe('local')
    expect(
      screen.getByText(
        "Local chats are stored only on this device and won't sync across devices.",
      ),
    ).toBeInTheDocument()
    // The blank chat follows the tab so its first message stays local.
    expect(createNewChat).toHaveBeenCalledExactlyOnceWith(true, false)

    rerender(
      <Sidebar createNewChat={createNewChat} currentChat={blankChat(true)} />,
    )
    const [newChat] = screen.getAllByRole('link', { name: /New chat/ })
    expect(newChat).toHaveAttribute('href', '/newchat?storage=local')
    expect(newChat).toHaveAttribute('aria-current', 'page')
  })

  it('turns on local chats for an account that already has some', () => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    render(<Sidebar />)

    expect(localStorage.getItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED)).toBe('true')
    expect(
      screen.getByRole('tablist', { name: 'Chat storage' }),
    ).toBeInTheDocument()
  })

  it('keeps a signed-out visitor’s chats in the browser tab', () => {
    auth.isSignedIn = false
    render(<Sidebar currentChat={blankChat(true)} chats={[localChat]} />)

    expect(chatTitles()).toEqual([localChat.title])
    expect(
      screen.getByText(
        'Your chats are stored temporarily in this browser tab. Create an account for persistent storage.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Enable Cloud Sync' }),
    ).not.toBeInTheDocument()
  })
})
