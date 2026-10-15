import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { DragProvider } from '@/components/chat/drag-context'
import type { Chat } from '@/components/chat/types'
import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
  UI_SIDEBAR_ACTIVE_TAB,
} from '@/constants/storage-keys'
import {
  act,
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
const sidebarProjects = vi.hoisted(() => ({
  list: [] as { id: string; name: string }[],
}))
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    projects: sidebarProjects.list,
    loading: false,
    refresh: vi.fn(),
  }),
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

// A drag's data, shared by the events of one drag as a browser shares it.
function dragData() {
  const data = new Map<string, string>()
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  }
}

// The row a chat is dragged by; its link is never draggable itself.
const listItem = (title: string) =>
  screen
    .getByRole('link', { name: title })
    .parentElement!.closest('[draggable]')!

describe('chat sidebar storage modes', () => {
  beforeEach(() => {
    auth.isSignedIn = true
    sessionStorage.clear()
    sidebarProjects.list = []
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
    expect(listItem(localChat.title)).toHaveAttribute('draggable', 'false')
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

  it('starts a synced chat when local chats are off but a blank local chat is open', () => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    localStorage.setItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED, 'false')
    const createNewChat = vi.fn()
    render(
      <Sidebar createNewChat={createNewChat} currentChat={blankChat(true)} />,
    )

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    const [newChat] = screen.getAllByRole('link', { name: /New chat/ })
    expect(newChat).toHaveAttribute('href', '/newchat')
    expect(newChat).not.toHaveAttribute('aria-current')
    fireEvent.click(newChat)
    expect(createNewChat).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('turns on local chats for an account that already has some', () => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    render(<Sidebar />)

    expect(localStorage.getItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED)).toBe('true')
    expect(
      screen.getByRole('tablist', { name: 'Chat storage' }),
    ).toBeInTheDocument()
  })

  it('offers no way to move or pin a device chat without the transfer routes', () => {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    localStorage.setItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED, 'true')
    sessionStorage.setItem(UI_SIDEBAR_ACTIVE_TAB, 'local')
    sidebarProjects.list = [{ id: 'project-1', name: 'Garden' }]
    render(<Sidebar />)

    expect(chatTitles()).toEqual([localChat.title])
    expect(listItem(localChat.title)).toHaveAttribute('draggable', 'false')
    expect(
      screen.queryByRole('button', { name: 'Pin to Favorites' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More chat options' }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'Move to cloud' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: /Move to project/ }),
    ).not.toBeInTheDocument()
  })

  describe('with the transfer routes', () => {
    function renderMovable(tab: 'cloud' | 'local') {
      localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
      localStorage.setItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED, 'true')
      sessionStorage.setItem(UI_SIDEBAR_ACTIVE_TAB, tab)
      const onConvertChatToCloud = vi.fn(async () => true)
      const onConvertChatToLocal = vi.fn(async () => {})
      const onToggleFavorite = vi.fn()
      const onRemoveChatFromProject = vi.fn(async () => {})
      render(
        <Sidebar
          onConvertChatToCloud={onConvertChatToCloud}
          onConvertChatToLocal={onConvertChatToLocal}
          onToggleFavorite={onToggleFavorite}
          onRemoveChatFromProject={onRemoveChatFromProject}
        />,
      )
      const tabs = within(screen.getByRole('tablist', { name: 'Chat storage' }))
      return {
        onConvertChatToCloud,
        onConvertChatToLocal,
        onToggleFavorite,
        onRemoveChatFromProject,
        cloudTab: tabs.getByRole('tab', { name: 'Cloud' }),
        localTab: tabs.getByRole('tab', { name: 'Local' }),
      }
    }

    it('moves a device chat to the cloud when it is dropped on the Cloud tab', async () => {
      const moves = renderMovable('local')
      const drag = dragData()
      expect(listItem(localChat.title)).toHaveAttribute('draggable', 'true')

      fireEvent.dragStart(listItem(localChat.title), { dataTransfer: drag })
      fireEvent.dragEnter(moves.cloudTab, { dataTransfer: drag })
      expect(moves.cloudTab).toHaveAttribute('aria-selected', 'true')
      fireEvent.dragOver(moves.cloudTab, { dataTransfer: drag })
      await act(async () => {
        fireEvent.drop(moves.cloudTab, { dataTransfer: drag })
      })

      expect(moves.onConvertChatToCloud).toHaveBeenCalledExactlyOnceWith(
        localChat.id,
      )
      expect(moves.onConvertChatToLocal).not.toHaveBeenCalled()
    })

    it('moves a synced chat to this device when it is dropped on the Local tab', async () => {
      const moves = renderMovable('cloud')
      const drag = dragData()

      fireEvent.dragStart(listItem(cloudChat.title), { dataTransfer: drag })
      fireEvent.dragEnter(moves.localTab, { dataTransfer: drag })
      expect(moves.localTab).toHaveAttribute('aria-selected', 'true')
      await act(async () => {
        fireEvent.drop(moves.localTab, { dataTransfer: drag })
      })

      expect(moves.onConvertChatToLocal).toHaveBeenCalledExactlyOnceWith(
        cloudChat.id,
      )
      expect(moves.onConvertChatToCloud).not.toHaveBeenCalled()
    })

    it('moves a chat dropped on the list of the tab it was dragged to', async () => {
      const moves = renderMovable('local')
      const drag = dragData()

      fireEvent.dragStart(listItem(localChat.title), { dataTransfer: drag })
      fireEvent.dragEnter(moves.cloudTab, { dataTransfer: drag })
      await act(async () => {
        fireEvent.drop(screen.getByRole('tabpanel'), { dataTransfer: drag })
      })

      expect(moves.onConvertChatToCloud).toHaveBeenCalledExactlyOnceWith(
        localChat.id,
      )

      // A chat dropped back on the list it came from stays where it is.
      fireEvent.dragStart(listItem(cloudChat.title), { dataTransfer: drag })
      await act(async () => {
        fireEvent.drop(screen.getByRole('tabpanel'), { dataTransfer: drag })
      })
      expect(moves.onConvertChatToCloud).toHaveBeenCalledOnce()
      expect(moves.onConvertChatToLocal).not.toHaveBeenCalled()
    })

    it('moves, pins, and files a device chat from its menu', () => {
      sidebarProjects.list = [{ id: 'project-1', name: 'Garden' }]
      const moves = renderMovable('local')

      fireEvent.click(screen.getByRole('button', { name: 'Pin to Favorites' }))
      expect(moves.onToggleFavorite).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: localChat.id, isLocalOnly: true }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'More chat options' }))
      expect(
        screen.getByRole('menuitem', { name: /Move to project/ }),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('menuitem', { name: 'Move to local' }),
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to cloud' }))

      expect(moves.onConvertChatToCloud).toHaveBeenCalledExactlyOnceWith(
        localChat.id,
      )
    })

    it('moves a synced chat to this device from its menu', () => {
      const moves = renderMovable('cloud')

      fireEvent.click(screen.getByRole('button', { name: 'More chat options' }))
      expect(
        screen.queryByRole('menuitem', { name: 'Move to cloud' }),
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to local' }))

      expect(moves.onConvertChatToLocal).toHaveBeenCalledExactlyOnceWith(
        cloudChat.id,
      )
      expect(moves.onConvertChatToCloud).not.toHaveBeenCalled()
    })
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
