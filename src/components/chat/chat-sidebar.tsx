import { PAGINATION } from '@/config'
import {
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  UI_EXPAND_PROJECTS_ON_MOUNT,
  UI_SIDEBAR_ACTIVE_TAB,
  UI_SIDEBAR_CHAT_HISTORY_EXPANDED,
  UI_SIDEBAR_EXPAND_SECTION,
  UI_SIDEBAR_PROJECTS_EXPANDED,
} from '@/constants/storage-keys'
import { useProjects } from '@/hooks/use-projects'
import { useSyncHealthAttention } from '@/hooks/use-sync-health'
import { toast } from '@/hooks/use-toast'
import { useUpgradeToPro } from '@/hooks/use-upgrade-to-pro'
import { encryptionService } from '@/services/encryption/encryption-service'
import { chatStorage } from '@/services/storage/chat-storage'
import {
  hasUserSetLocalOnlyPreference,
  isCloudSyncEnabled,
  isLocalOnlyModeEnabled,
  setCloudSyncEnabled as setCloudSyncEnabledSetting,
  setLocalOnlyModeEnabled as setLocalOnlyModeSetting,
} from '@/utils/cloud-sync-settings'
import { logInfo } from '@/utils/error-handling'
import { SignInButton, useAuth, useUser } from '@clerk/nextjs'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  FolderPlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { CiFloppyDisk } from 'react-icons/ci'
import { FaLock } from 'react-icons/fa6'
import { GoSidebarCollapse, GoSidebarExpand, GoSync } from 'react-icons/go'
import { IoChatbubblesOutline } from 'react-icons/io5'
import {
  PiFolder,
  PiMicrophone,
  PiNotePencilLight,
  PiSparkle,
  PiSpinner,
} from 'react-icons/pi'
import { ChatList, type ChatItemData } from './chat-list'
import { formatRelativeTime } from './chat-list-utils'
import { CONSTANTS } from './constants'
import { useDrag } from './drag-context'

import { useProject } from '@/components/project/project-context'
import { cn } from '@/components/ui/utils'
import {
  getProjectColor,
  PROJECT_COLOR_SIDEBAR_TINT_OPACITY,
  projectColorTintLayer,
} from '@/constants/project-colors'
import { useCloudPagination } from '@/hooks/use-cloud-pagination'

import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '../link'
import { Logo } from '../logo'
import type { Chat } from './types'

// Utility function to detect iOS devices
function isIOSDevice() {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

// Pagination state is managed by useCloudPagination

type ChatSidebarProps = {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  chats: Chat[]
  currentChat: Chat
  isDarkMode: boolean
  createNewChat: (isLocalOnly?: boolean, fromUserAction?: boolean) => void
  handleChatSelect: (chatId: string) => void
  updateChatTitle: (chatId: string, newTitle: string) => void
  deleteChat: (chatId: string) => void
  isClient: boolean
  isPremium?: boolean
  onEncryptionKeyClick?: () => void
  onCloudSyncSetupClick?: () => void
  onSetupPasskey?: () => Promise<boolean>
  passkeySetupAvailable?: boolean
  onAddPasskeyToThisDevice?: () => Promise<boolean>
  passkeyAddDeviceAvailable?: boolean
  backupWarningVisible?: boolean
  /**
   * True when remote encrypted data exists but this device can't decrypt it
   * (no local key, no usable passkey). Switches the warning copy from
   * "not being backed up" to "can't access existing backup".
   */
  backupWarningNeedsRecovery?: boolean
  onDismissBackupWarning?: () => void
  onChatsUpdated?: () => void
  /** Triggers a deep (all-pages) cloud sync from the sidebar "Sync" button. */
  onManualSync?: () => Promise<void>
  /** True while a cloud sync is in progress; drives the Sync button spinner. */
  isSyncing?: boolean
  verificationComplete?: boolean
  verificationSuccess?: boolean
  onVerificationComplete?: (success: boolean) => void
  onVerificationUpdate?: (state: any) => void
  isProjectMode?: boolean
  activeProjectName?: string
  onEnterProject?: (projectId: string, projectName?: string) => Promise<void>
  onCreateProject?: () => Promise<void>
  onMoveChatToProject?: (chatId: string, projectId: string) => Promise<void>
  onRemoveChatFromProject?: (chatId: string) => Promise<void>
  onConvertChatToCloud?: (chatId: string) => Promise<void>
  onConvertChatToLocal?: (chatId: string) => Promise<void>
  onSettingsClick?: () => void
  windowWidth: number
  /**
   * Progress of the post-unlock background chat decryption. When
   * `isDecrypting` is true the sidebar shows a "Loading chats"
   * indicator so users see work is happening after the recovery modal
   * dismisses, without the modal blocking the whole UI.
   */
  chatDecryptionProgress?: {
    isDecrypting: boolean
    current: number
    total: number
  } | null
}

const MOBILE_BREAKPOINT = 1024 // Same as in chat-interface.tsx

// Prevent pinch-zoom on mobile Safari while the chat UI is mounted.
function usePreventZoom() {
  useEffect(() => {
    const viewportMeta = document.createElement('meta')
    viewportMeta.name = 'viewport'
    viewportMeta.content =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'
    document.head.appendChild(viewportMeta)

    return () => {
      if (viewportMeta.parentNode === document.head) {
        document.head.removeChild(viewportMeta)
      }
    }
  }, [])
}

export function ChatSidebar({
  isOpen,
  setIsOpen,
  chats,
  currentChat,
  isDarkMode,
  createNewChat,
  handleChatSelect,
  updateChatTitle,
  deleteChat,
  isClient,
  isPremium = true,
  onEncryptionKeyClick,
  onCloudSyncSetupClick,
  onSetupPasskey,
  passkeySetupAvailable,
  onAddPasskeyToThisDevice,
  passkeyAddDeviceAvailable,
  backupWarningVisible = false,
  backupWarningNeedsRecovery = false,
  onDismissBackupWarning,
  onChatsUpdated,
  onManualSync,
  isSyncing = false,
  isProjectMode,
  activeProjectName,
  onEnterProject,
  onCreateProject,
  onMoveChatToProject,
  onRemoveChatFromProject,
  onConvertChatToCloud,
  onConvertChatToLocal,
  onSettingsClick,
  windowWidth,
  chatDecryptionProgress,
}: ChatSidebarProps) {
  const syncNeedsAttention = useSyncHealthAttention()
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const shouldExpand = sessionStorage.getItem(UI_EXPAND_PROJECTS_ON_MOUNT)
      if (shouldExpand === 'true') {
        return true
      }
      const expandSection = sessionStorage.getItem(UI_SIDEBAR_EXPAND_SECTION)
      if (expandSection === 'projects') {
        return true
      }
      const stored = sessionStorage.getItem(UI_SIDEBAR_PROJECTS_EXPANDED)
      if (stored !== null) {
        return stored === 'true'
      }
    }
    return false
  })
  const [isCreatingProject, setIsCreatingProject] = useState(false)
  const [isChatHistoryExpanded, setIsChatHistoryExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const shouldExpandProjects = sessionStorage.getItem(
        UI_EXPAND_PROJECTS_ON_MOUNT,
      )
      if (shouldExpandProjects === 'true') {
        sessionStorage.removeItem(UI_EXPAND_PROJECTS_ON_MOUNT)
        return false
      }
      const expandSection = sessionStorage.getItem(UI_SIDEBAR_EXPAND_SECTION)
      if (expandSection === 'projects') {
        return false
      }
      const stored = sessionStorage.getItem(UI_SIDEBAR_CHAT_HISTORY_EXPANDED)
      if (stored !== null) {
        return stored === 'true'
      }
    }
    return true
  })
  const [isChatListScrolled, setIsChatListScrolled] = useState(false)
  const chatListRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const [isIOS, setIsIOS] = useState(false)
  const {
    startUpgrade: handleUpgradeToPro,
    upgradeLoading,
    upgradeError,
  } = useUpgradeToPro()
  const [activeTab, setActiveTab] = useState<'cloud' | 'local'>(() => {
    if (typeof window !== 'undefined') {
      const stored = sessionStorage.getItem(UI_SIDEBAR_ACTIVE_TAB)
      if (stored === 'local' && isLocalOnlyModeEnabled()) {
        return 'local'
      }
    }
    return 'cloud'
  })
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(isCloudSyncEnabled())
  const [localOnlyModeEnabled, setLocalOnlyModeEnabled] = useState(
    isLocalOnlyModeEnabled(),
  )
  const { isSignedIn } = useAuth()
  const { user } = useUser()

  const {
    draggingChatId,
    draggingChatFromProjectId,
    dropTargetProjectId,
    dropTargetTab,
    isDropTargetChatHistory,
    setDraggingChat,
    setDropTargetProject,
    setDropTargetTab,
    setDropTargetChatHistory,
    clearDragState,
  } = useDrag()

  const [isDropTargetChatList, setIsDropTargetChatList] = useState(false)
  const [isDropTargetProjectsHeader, setIsDropTargetProjectsHeader] =
    useState(false)
  const projectHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform))
  }, [])
  const modKey = isMac ? '⌘' : 'Ctrl+'

  const {
    projects,
    loading: projectsLoading,
    hasMore: hasMoreProjects,
    loadMore: loadMoreProjects,
    refresh: refreshProjects,
  } = useProjects({ autoLoad: isSignedIn && cloudSyncEnabled && isPremium })

  const { deleteProject, activeProject } = useProject()

  const sidebarTintColor = getProjectColor(activeProject?.color)
  const sidebarTintStyle = sidebarTintColor
    ? {
        backgroundImage: projectColorTintLayer(
          sidebarTintColor,
          PROJECT_COLOR_SIDEBAR_TINT_OPACITY,
        ),
      }
    : undefined

  // Subtle background applied to expanded section panels so they read as
  // distinct drawers against the sidebar surface.
  const expandedPanelClass = isDarkMode ? 'bg-white/5' : 'bg-black/5'

  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  )

  // Cloud pagination state via hook
  const {
    hasMore: hasMoreRemote,
    isLoading: isLoadingMore,
    hasAttempted: hasAttemptedLoadMore,
    initialize: initPagination,
    loadMore: loadMorePage,
    reset: resetPagination,
  } = useCloudPagination({
    isSignedIn: !!isSignedIn,
    userId: user?.id,
  })
  const previousChatCount = useRef(chats.length)

  // Token getter should be set by parent component that has access to getApiKey
  // The parent (ChatInterface) already sets this up through useCloudSync

  // Apply zoom prevention for mobile
  usePreventZoom()

  // Persist active tab selection to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(UI_SIDEBAR_ACTIVE_TAB, activeTab)
  }, [activeTab])

  // Persist projects expanded state to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(
      UI_SIDEBAR_PROJECTS_EXPANDED,
      isProjectsExpanded ? 'true' : 'false',
    )
  }, [isProjectsExpanded])

  // Persist chat history expanded state to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(
      UI_SIDEBAR_CHAT_HISTORY_EXPANDED,
      isChatHistoryExpanded ? 'true' : 'false',
    )
  }, [isChatHistoryExpanded])

  // Listen for cloud sync setting changes
  useEffect(() => {
    const handleCloudSyncChange = () => {
      setCloudSyncEnabled(isCloudSyncEnabled())
    }

    // Listen for both storage events and custom events
    window.addEventListener('storage', handleCloudSyncChange)
    window.addEventListener('cloudSyncSettingChanged', handleCloudSyncChange)

    return () => {
      window.removeEventListener('storage', handleCloudSyncChange)
      window.removeEventListener(
        'cloudSyncSettingChanged',
        handleCloudSyncChange,
      )
    }
  }, [])

  // Listen for local-only mode setting changes
  useEffect(() => {
    const handleLocalOnlyModeChange = () => {
      const enabled = isLocalOnlyModeEnabled()
      setLocalOnlyModeEnabled(enabled)
      if (!enabled && activeTab === 'local') {
        setActiveTab('cloud')
      }
    }

    // Listen for both storage events (cross-tab) and custom events (same-tab)
    window.addEventListener('storage', handleLocalOnlyModeChange)
    window.addEventListener('localOnlyModeChanged', handleLocalOnlyModeChange)
    return () => {
      window.removeEventListener('storage', handleLocalOnlyModeChange)
      window.removeEventListener(
        'localOnlyModeChanged',
        handleLocalOnlyModeChange,
      )
    }
  }, [activeTab])

  // Auto-enable local-only mode if user has existing local chats and hasn't
  // explicitly set the preference (matches iOS ChatViewModel behavior)
  useEffect(() => {
    if (!isSignedIn || !cloudSyncEnabled || hasUserSetLocalOnlyPreference()) {
      return
    }
    const hasLocalChats = chats.some(
      (chat) => chat.isLocalOnly && !chat.isBlankChat,
    )
    if (hasLocalChats) {
      setLocalOnlyModeSetting(true)
      setLocalOnlyModeEnabled(true)
    }
  }, [isSignedIn, cloudSyncEnabled, chats])

  // Update blank chat's isLocalOnly when active tab changes
  useEffect(() => {
    if (!isSignedIn || !cloudSyncEnabled || !localOnlyModeEnabled) return

    const shouldBeLocal = activeTab === 'local'

    // Only switch to blank chat if we're already on a blank chat
    // This ensures we don't interrupt the user when they've selected a real chat.
    // Temporary chats are also blank but must not be replaced here — doing so
    // would silently exit temporary-chat mode whenever the active tab and the
    // temp chat's isLocalOnly disagree (which is always, since temp chats
    // leave isLocalOnly undefined).
    if (
      currentChat?.isBlankChat &&
      !currentChat.isTemporary &&
      currentChat.isLocalOnly !== shouldBeLocal
    ) {
      createNewChat(shouldBeLocal, false)
    }
  }, [
    activeTab,
    isSignedIn,
    cloudSyncEnabled,
    localOnlyModeEnabled,
    createNewChat,
    currentChat?.isBlankChat,
    currentChat?.isLocalOnly,
    currentChat?.isTemporary,
  ])

  // Calculate if we should show the Load More button
  const syncedChatsCount = chats.filter((chat) => chat.syncedAt).length
  // Show load more if:
  // 1. User is signed in
  // 2. On cloud tab
  // 3. Either: we have more remote chats, OR we haven't tried loading yet and have enough chats to suggest pagination
  const shouldShowLoadMore =
    isSignedIn &&
    activeTab === 'cloud' &&
    (hasMoreRemote ||
      (!hasAttemptedLoadMore && syncedChatsCount >= PAGINATION.CHATS_PER_PAGE))

  // Detect iOS device
  useEffect(() => {
    if (isClient) {
      setIsIOS(isIOSDevice())
    }
  }, [isClient])

  // Remove initial load state after mount
  useEffect(() => {
    setIsInitialLoad(false)
  }, [])

  // Handle sidebar expand section when sidebar opens
  useEffect(() => {
    if (isOpen) {
      const expandSection = sessionStorage.getItem(UI_SIDEBAR_EXPAND_SECTION)
      if (expandSection === 'projects') {
        setIsProjectsExpanded(true)
        setIsChatHistoryExpanded(false)
        refreshProjects()
      } else if (expandSection === 'chats') {
        setIsProjectsExpanded(false)
        setIsChatHistoryExpanded(true)
      }
      sessionStorage.removeItem(UI_SIDEBAR_EXPAND_SECTION)
    }
  }, [isOpen, refreshProjects])

  // Pagination initialization handled by hook/useEffect below

  // Track if we just loaded more chats via pagination
  const justLoadedMoreRef = useRef(false)
  // Track if we're waiting for newly loaded chats to render (prevents scroll jump)
  const [pendingChatsRender, setPendingChatsRender] = useState(false)

  // Reset pagination when new chats are added (but not when loading more via pagination)
  useEffect(() => {
    // Detect if a new chat was added (chat count increased)
    if (
      isSignedIn &&
      chats.length > previousChatCount.current &&
      previousChatCount.current > 0 // Not the initial load
    ) {
      // Check if this was from pagination or a new chat
      if (justLoadedMoreRef.current) {
        // This was from pagination, don't reset
        justLoadedMoreRef.current = false
        setPendingChatsRender(false)
      } else {
        resetPagination()
          .then((result) => {
            if (result?.deletedIds.length && onChatsUpdated) {
              onChatsUpdated()
            }
          })
          .catch((error) => {
            logError('Failed to reset pagination after new chat', error, {
              component: 'ChatSidebar',
              action: 'resetPaginationAfterNewChat',
            })
          })
      }
    }

    // Update the previous count for next comparison
    previousChatCount.current = chats.length
  }, [chats.length, isSignedIn, onChatsUpdated, resetPagination])

  // Initialize pagination state on page refresh
  useEffect(() => {
    const cleanupAndInitialize = async () => {
      if (!isSignedIn || !user?.id) return

      try {
        const result = await initPagination()
        if (result?.deletedIds.length && onChatsUpdated) {
          onChatsUpdated()
        }
      } catch (error) {
        logError('Failed to cleanup and initialize pagination', error, {
          component: 'ChatSidebar',
          action: 'cleanupAndInitialize',
        })
      }
    }

    cleanupAndInitialize()
  }, [isSignedIn, user?.id, onChatsUpdated, initPagination])

  // Load more chats from backend (delegated to CloudSync via hook)
  const loadMoreChats = useCallback(async () => {
    try {
      if (isLoadingMore || !isSignedIn) return
      const result = await loadMorePage()
      const savedCount = result?.saved ?? 0
      justLoadedMoreRef.current = savedCount > 0
      if (savedCount > 0) {
        setPendingChatsRender(true)
        onChatsUpdated?.()
      }
    } catch (error) {
      justLoadedMoreRef.current = false
      setPendingChatsRender(false)
      logError('Failed to load more chats', error, {
        component: 'ChatSidebar',
        action: 'loadMoreChats',
      })
    }
  }, [isLoadingMore, isSignedIn, loadMorePage, onChatsUpdated])

  // Instead of trying to detect Safari, let's use CSS custom properties
  // that will apply the padding only when needed
  useEffect(() => {
    if (isClient) {
      // Add CSS variables to root to handle Safari bottom bar
      document.documentElement.style.setProperty(
        '--safe-area-inset-bottom',
        'env(safe-area-inset-bottom, 0px)',
      )
    }
  }, [isClient])

  useEffect(() => {
    const chatList = chatListRef.current
    if (!chatList) return

    const handleScroll = () => {
      setIsChatListScrolled(chatList.scrollTop > 0)
    }

    handleScroll()
    chatList.addEventListener('scroll', handleScroll)
    return () => chatList.removeEventListener('scroll', handleScroll)
  }, [isChatHistoryExpanded])

  // Auto-load more chats when scrolling to bottom
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (
          entry.isIntersecting &&
          shouldShowLoadMore &&
          !isLoadingMore &&
          isSignedIn
        ) {
          loadMoreChats()
        }
      },
      {
        root: chatListRef.current,
        rootMargin: '100px',
        threshold: 0,
      },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    shouldShowLoadMore,
    isLoadingMore,
    isSignedIn,
    loadMoreChats,
    isChatHistoryExpanded,
  ])

  const sortedChats = useMemo(() => {
    // The incoming `chats` array is already sorted by `sortChats`
    // (blank-first, then most-recently-updated). We only filter
    // here; the display order matches the server's pagination so
    // newly-loaded pages slot in at the bottom without reshuffling.
    if (isSignedIn && cloudSyncEnabled) {
      if (localOnlyModeEnabled && activeTab === 'local') {
        return chats.filter((chat) => chat.isLocalOnly && !chat.projectId)
      }
      return chats.filter((chat) => !chat.isLocalOnly && !chat.projectId)
    }
    return chats.filter((chat) => (chat as any).isLocalOnly && !chat.projectId)
  }, [chats, activeTab, isSignedIn, cloudSyncEnabled, localOnlyModeEnabled])

  const handleCloudSyncToggle = async (enabled: boolean) => {
    if (enabled) {
      // Check if encryption key exists
      if (!encryptionService.getKey()) {
        // Prefer passkey setup when available
        if (passkeySetupAvailable && onSetupPasskey) {
          const success = await onSetupPasskey()
          if (success) return
        }

        // Turn on the toggle visually (but don't persist yet)
        setCloudSyncEnabled(true)

        // Show the cloud sync setup modal
        if (onCloudSyncSetupClick) {
          onCloudSyncSetupClick()
        }
        return
      }

      // If key exists, proceed with enabling
      setCloudSyncEnabled(true)
      setCloudSyncEnabledSetting(true)

      // Clear the explicit disable flag when re-enabling
      localStorage.removeItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED)
    } else {
      // Disabling cloud sync
      setCloudSyncEnabled(false)
      setCloudSyncEnabledSetting(false)

      // Mark that user explicitly disabled cloud sync (to prevent auto-enable)
      localStorage.setItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED, 'true')

      try {
        const deletedCount = await chatStorage.deleteAllNonLocalChats()
        logInfo(
          `Deleted ${deletedCount} synced chats when disabling cloud sync`,
          {
            component: 'ChatSidebar',
            action: 'handleCloudSyncToggle',
          },
        )
        if (deletedCount > 0 && onChatsUpdated) {
          onChatsUpdated()
        }
      } catch (error) {
        logInfo('Failed to delete synced chats', {
          component: 'ChatSidebar',
          action: 'handleCloudSyncToggle',
          metadata: { error },
        })
      }
    }

    if (isClient) {
      window.dispatchEvent(
        new CustomEvent('cloudSyncSettingChanged', {
          detail: { enabled },
        }),
      )
    }
  }

  // Check if mobile
  const isMobile = windowWidth < MOBILE_BREAKPOINT

  return (
    <>
      {/* Collapsed sidebar rail - shown on desktop when sidebar is closed.
          Fades in only after the expanded sidebar has slid away so the two
          appear to swap rather than the rail sitting statically underneath. */}
      <AnimatePresence>
        {!isMobile && !isOpen && (
          <motion.nav
            key="collapsed-rail"
            aria-label="Chat history"
            initial={{ opacity: 0 }}
            animate={{
              opacity: 1,
              transition: {
                duration: CONSTANTS.CHAT_SIDEBAR_RAIL_FADE_IN_DURATION_S,
                delay: CONSTANTS.CHAT_SIDEBAR_SLIDE_DURATION_S,
              },
            }}
            exit={{
              opacity: 0,
              transition: {
                duration: CONSTANTS.CHAT_SIDEBAR_RAIL_FADE_OUT_DURATION_S,
              },
            }}
            className={cn(
              'fixed left-0 top-0 z-40 flex h-dvh flex-col border-r',
              'border-border-subtle bg-surface-sidebar text-content-primary',
            )}
            style={{
              width: `${CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX}px`,
              ...sidebarTintStyle,
            }}
          >
            {/* Logo icon - shows expand icon on hover */}
            <div className="flex h-16 flex-none items-center justify-center">
              <button
                onClick={() => setIsOpen(true)}
                className="group/logo relative rounded p-2"
                aria-label="Expand sidebar"
              >
                <img
                  src={isDarkMode ? '/icon-dark.png' : '/icon-light.png'}
                  alt=""
                  className="h-6 w-6 transition-opacity group-hover/logo:opacity-0"
                />
                <GoSidebarCollapse className="absolute inset-0 m-auto h-5 w-5 text-content-secondary opacity-0 transition-opacity group-hover/logo:opacity-100" />
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col items-center gap-1 px-2">
              {/* New chat button */}
              <div className="group relative">
                <Link
                  href="/newchat"
                  onClick={(e) => {
                    if (
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey ||
                      e.button !== 0
                    )
                      return
                    e.preventDefault()
                    createNewChat(activeTab === 'local', true)
                  }}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return
                    e.preventDefault()
                    window.open('/newchat', '_blank', 'noopener,noreferrer')
                  }}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                    'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                  )}
                  aria-label="New chat"
                >
                  <PiNotePencilLight className="h-5 w-5" />
                </Link>
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  New chat{' '}
                  <span className="text-content-muted">
                    {modKey}
                    {isMac ? '⇧' : 'Shift+'}O
                  </span>
                </span>
              </div>

              {/* Projects button - only for premium users */}
              {isSignedIn && isPremium && (
                <div className="group relative">
                  <button
                    onClick={() => {
                      sessionStorage.setItem(
                        UI_SIDEBAR_EXPAND_SECTION,
                        'projects',
                      )
                      setIsProjectsExpanded(true)
                      setIsChatHistoryExpanded(false)
                      setIsOpen(true)
                    }}
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                      'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                    )}
                    aria-label="Projects"
                  >
                    <FolderIcon className="h-5 w-5" />
                  </button>
                  <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                    Projects
                  </span>
                </div>
              )}

              {/* Chats button */}
              <div className="group relative">
                <button
                  onClick={() => {
                    sessionStorage.setItem(UI_SIDEBAR_EXPAND_SECTION, 'chats')
                    setIsChatHistoryExpanded(true)
                    setIsProjectsExpanded(false)
                    setIsOpen(true)
                  }}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                    'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                  )}
                  aria-label="Chats"
                >
                  <IoChatbubblesOutline className="h-5 w-5" />
                </button>
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  Chats <span className="text-content-muted">{modKey}.</span>
                </span>
              </div>

              {/* Settings button */}
              <div className="group relative">
                <button
                  onClick={onSettingsClick}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                    'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                  )}
                  aria-label="Settings"
                >
                  <Cog6ToothIcon className="h-5 w-5" />
                  {syncNeedsAttention && (
                    <span
                      className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-orange-500"
                      title="Cloud sync needs attention"
                      aria-hidden="true"
                    />
                  )}
                </button>
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  Settings
                </span>
              </div>
            </div>
          </motion.nav>
        )}
      </AnimatePresence>

      {/* Expanded sidebar wrapper */}
      <nav
        aria-label="Chat history"
        inert={!isOpen}
        className={cn(
          'fixed z-40 flex h-dvh flex-col overflow-hidden border-r',
          // On mobile: slide in/out. On desktop: always positioned, just toggle width
          isMobile
            ? isOpen
              ? 'translate-x-0'
              : '-translate-x-full'
            : 'translate-x-0',
          'border-border-subtle bg-surface-sidebar text-content-primary',
          isInitialLoad ? '' : 'transition-all duration-200 ease-in-out',
        )}
        style={{
          width: isMobile ? '85vw' : `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`,
          maxWidth: `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`,
          // On desktop when closed, hide behind the collapsed rail
          left:
            !isMobile && !isOpen
              ? `-${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`
              : '0',
          ...sidebarTintStyle,
        }}
      >
        {/* Header */}
        <div className="flex h-16 flex-none items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              title="Home"
              className="flex items-center"
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                window.open('/', '_blank', 'noopener,noreferrer')
              }}
            >
              <Logo className="h-6 w-auto" dark={isDarkMode} />
            </Link>
            {/* Settings button */}
            <div className="group relative flex items-center">
              <button
                id="settings-button"
                type="button"
                onClick={onSettingsClick}
                aria-label="Settings"
                className="relative rounded p-1.5 text-content-muted transition-all duration-200 hover:text-content-secondary"
              >
                <Cog6ToothIcon className="h-5 w-5" aria-hidden="true" />
                {syncNeedsAttention && (
                  <span
                    className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-orange-500"
                    title="Cloud sync needs attention"
                    aria-hidden="true"
                  />
                )}
              </button>
              <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                Settings
              </span>
            </div>
          </div>
          {/* Close sidebar button */}
          <div className="group relative flex items-center">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded p-1.5 text-content-muted transition-all duration-200 hover:bg-surface-chat hover:text-content-secondary"
              aria-label="Close sidebar"
            >
              <GoSidebarExpand className="h-5 w-5" />
            </button>
            <span className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              Close sidebar{' '}
              <span className="text-content-muted">{modKey}.</span>
            </span>
          </div>
        </div>

        {/* Main sidebar content */}
        <div className="relative flex h-full flex-col overflow-hidden">
          {/* Message for non-premium users (signed in or not) */}
          {!isPremium && (
            <div
              className={cn(
                'relative z-10 m-2 flex-none rounded-lg border p-4 transition-all duration-300',
                isDarkMode
                  ? 'border-emerald-500/30 bg-emerald-950/20'
                  : 'border-emerald-500/30 bg-emerald-50/50',
              )}
            >
              <div className="flex-1">
                <h4 className="mb-3 text-sm font-semibold text-content-primary">
                  Get more out of Tinfoil Chat
                </h4>
                <div className="space-y-2.5">
                  <div className="flex items-center gap-3 text-xs text-content-secondary">
                    <PiMicrophone className="h-4 w-4 flex-shrink-0 text-content-muted" />
                    <span>Speech-to-text voice input</span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-content-secondary">
                    <PiSparkle className="h-4 w-4 flex-shrink-0 text-content-muted" />
                    <span>No daily request limits</span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-content-secondary">
                    <PiFolder className="h-4 w-4 flex-shrink-0 text-content-muted" />
                    <span>Create projects to chat with files</span>
                  </div>
                </div>
                <div className="mt-4">
                  {isSignedIn ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void handleUpgradeToPro()
                        }}
                        disabled={upgradeLoading}
                        className={`inline-flex items-center gap-1 text-sm font-medium transition-colors ${
                          isDarkMode
                            ? 'text-emerald-400 hover:text-emerald-300'
                            : 'text-emerald-600 hover:text-emerald-500'
                        } ${upgradeLoading ? 'cursor-not-allowed opacity-70' : ''}`}
                      >
                        {upgradeLoading
                          ? 'Redirecting…'
                          : 'Subscribe to Premium'}
                        {!upgradeLoading && (
                          <svg
                            className="h-3 w-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        )}
                      </button>
                      {upgradeError && (
                        <p className="mt-2 text-xs text-destructive">
                          {upgradeError}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <SignInButton mode="modal">
                        <span className="relative block w-full cursor-pointer rounded-md bg-brand-accent-dark px-4 py-2 text-center text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90">
                          Subscribe to Premium
                        </span>
                      </SignInButton>
                      <p className="text-center text-xs text-content-secondary">
                        Already subscribed?{' '}
                        <SignInButton mode="modal">
                          <span className="cursor-pointer underline hover:text-content-primary">
                            Log in
                          </span>
                        </SignInButton>
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Divider after boxes */}
          {!isPremium && (
            <div className="relative z-10 border-b border-border-subtle" />
          )}

          {/* Backup warning - shown when chats aren't backed up, or when
              encrypted backups exist remotely but this device can't decrypt
              them yet. */}
          {backupWarningVisible && (
            <div className="relative z-10 flex-none px-2 pt-2">
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="flex items-start gap-2">
                  <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                  <div className="flex-1">
                    <p className="font-aeonik text-xs font-semibold text-content-primary">
                      {backupWarningNeedsRecovery
                        ? "Can't access your existing backup"
                        : "Chats aren't being backed up"}
                    </p>
                    <p className="mt-1 text-xs text-content-secondary">
                      {backupWarningNeedsRecovery
                        ? 'Set up cloud sync on this device to unlock your existing chats.'
                        : 'Your chats only exist on this device.'}
                    </p>
                  </div>
                  {onDismissBackupWarning && (
                    <button
                      type="button"
                      onClick={onDismissBackupWarning}
                      className="-mr-1 -mt-1 flex-shrink-0 rounded p-1 text-content-muted transition-colors hover:bg-amber-500/10 hover:text-content-secondary"
                      aria-label="Dismiss"
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {onCloudSyncSetupClick && (
                  <button
                    type="button"
                    onClick={onCloudSyncSetupClick}
                    className="mt-2 w-full rounded-md bg-amber-500/90 px-2.5 py-1.5 font-aeonik text-xs font-medium text-white transition-colors hover:bg-amber-500"
                  >
                    {backupWarningNeedsRecovery
                      ? 'Set Up Cloud Sync'
                      : 'Enable Cloud Sync'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* New Chat button */}
          <div className="relative z-10 flex-none px-2 py-2">
            <Link
              href="/newchat"
              aria-disabled={currentChat?.isBlankChat}
              onClick={(e) => {
                if (
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey ||
                  e.button !== 0
                )
                  return
                e.preventDefault()
                if (currentChat?.isBlankChat) return
                createNewChat(activeTab === 'local', true)
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                window.open('/newchat', '_blank', 'noopener,noreferrer')
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-lg border px-2 py-2 text-sm transition-colors',
                currentChat?.isBlankChat
                  ? 'cursor-default border-transparent bg-transparent text-content-muted'
                  : isDarkMode
                    ? 'border-border-strong bg-surface-chat text-content-primary hover:bg-surface-chat/80'
                    : 'border-border-subtle bg-white text-content-primary hover:bg-gray-50',
              )}
            >
              <span className="flex items-center gap-2">
                <PiNotePencilLight className="h-4 w-4" />
                <span className="font-aeonik font-medium">New chat</span>
              </span>
              <span className="text-xs text-content-muted">
                {modKey}
                {isMac ? '⇧' : 'Shift+'}O
              </span>
            </Link>
          </div>

          {/* Projects dropdown - show for premium users */}
          {isSignedIn && isPremium && (
            <div className="relative z-10 flex-none border-t border-border-subtle">
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isProjectsExpanded}
                onClick={() => {
                  const newExpanded = !isProjectsExpanded
                  setIsProjectsExpanded(newExpanded)
                  if (newExpanded && projects.length === 0) {
                    refreshProjects()
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    const newExpanded = !isProjectsExpanded
                    setIsProjectsExpanded(newExpanded)
                    if (newExpanded && projects.length === 0) {
                      refreshProjects()
                    }
                  }
                }}
                onDragOver={(e) => {
                  if (
                    e.dataTransfer.types.includes('application/x-chat-id') &&
                    cloudSyncEnabled
                  ) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setIsDropTargetProjectsHeader(true)
                  }
                }}
                onDragEnter={(e) => {
                  if (
                    e.dataTransfer.types.includes('application/x-chat-id') &&
                    cloudSyncEnabled
                  ) {
                    e.preventDefault()
                    setIsDropTargetProjectsHeader(true)
                    if (!isProjectsExpanded) {
                      setIsProjectsExpanded(true)
                      if (projects.length === 0) {
                        refreshProjects()
                      }
                    }
                  }
                }}
                onDragLeave={() => {
                  setIsDropTargetProjectsHeader(false)
                }}
                onDrop={() => {
                  setIsDropTargetProjectsHeader(false)
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between bg-surface-sidebar px-4 py-3 text-sm transition-colors',
                  isDropTargetProjectsHeader
                    ? isDarkMode
                      ? 'border border-white/30 bg-white/10'
                      : 'border border-gray-400 bg-gray-200/30'
                    : isProjectMode
                      ? isDarkMode
                        ? 'text-emerald-400'
                        : 'text-emerald-600'
                      : isDarkMode
                        ? 'text-content-secondary hover:bg-surface-chat'
                        : 'text-content-secondary hover:bg-white',
                )}
              >
                <span className="flex items-center gap-2">
                  <FolderIcon className="h-4 w-4" />
                  <span className="font-aeonik font-medium">
                    {isProjectMode && activeProjectName
                      ? activeProjectName
                      : 'Projects'}
                  </span>
                </span>
                <div className="flex items-center gap-1">
                  {isProjectsExpanded ? (
                    <ChevronDownIcon className="h-4 w-4" />
                  ) : (
                    <ChevronRightIcon className="h-4 w-4" />
                  )}
                </div>
              </div>

              {/* Expanded projects list */}
              <AnimatePresence initial={false}>
                {isProjectsExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div
                      className={cn(
                        'min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2',
                        expandedPanelClass,
                      )}
                    >
                      {/* Cloud sync disabled message */}
                      {!cloudSyncEnabled ? (
                        <div className="px-3 py-2">
                          <p className="text-xs text-content-muted">
                            The projects feature requires end-to-end encrypted
                            cloud sync to be enabled on this device.
                          </p>
                          <button
                            onClick={async () => {
                              if (passkeySetupAvailable && onSetupPasskey) {
                                const success = await onSetupPasskey()
                                if (success) return
                              }
                              if (onCloudSyncSetupClick) {
                                onCloudSyncSetupClick()
                              }
                            }}
                            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-chat px-3 py-2 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat/80"
                          >
                            <CloudIcon className="h-3.5 w-3.5" />
                            Enable Cloud Sync
                          </button>
                        </div>
                      ) : (
                        <>
                          {/* Create new project button */}
                          {onCreateProject && (
                            <button
                              onClick={async () => {
                                setIsCreatingProject(true)
                                try {
                                  await onCreateProject()
                                  if (windowWidth < MOBILE_BREAKPOINT) {
                                    setIsOpen(false)
                                  }
                                } finally {
                                  setIsCreatingProject(false)
                                }
                              }}
                              disabled={isCreatingProject}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                                'text-content-secondary hover:text-content-primary',
                                isDarkMode
                                  ? 'hover:bg-surface-chat'
                                  : 'hover:bg-surface-sidebar',
                                isCreatingProject &&
                                  'cursor-not-allowed opacity-50',
                              )}
                            >
                              {isCreatingProject ? (
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-content-muted border-t-transparent" />
                              ) : (
                                <FolderPlusIcon className="h-4 w-4 shrink-0" />
                              )}
                              <span className="truncate">
                                {isCreatingProject
                                  ? 'Creating...'
                                  : 'New Project'}
                              </span>
                            </button>
                          )}

                          {/* Projects list */}
                          {projectsLoading && projects.length === 0 ? (
                            <div className="flex justify-center px-3 py-2">
                              <PiSpinner className="h-4 w-4 animate-spin text-content-muted" />
                            </div>
                          ) : projects.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-content-muted">
                              No projects yet
                            </div>
                          ) : (
                            <>
                              {projects.map((project) => (
                                <div
                                  key={project.id}
                                  role="button"
                                  tabIndex={project.decryptionFailed ? -1 : 0}
                                  onClick={async () => {
                                    if (project.decryptionFailed) return

                                    if (onEnterProject) {
                                      await onEnterProject(
                                        project.id,
                                        project.name,
                                      )
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (
                                      (e.key === 'Enter' || e.key === ' ') &&
                                      onEnterProject &&
                                      !project.decryptionFailed
                                    ) {
                                      e.preventDefault()
                                      onEnterProject(project.id, project.name)
                                    }
                                  }}
                                  onDragOver={(e) => {
                                    if (
                                      e.dataTransfer.types.includes(
                                        'application/x-chat-id',
                                      ) &&
                                      !project.decryptionFailed
                                    ) {
                                      e.preventDefault()
                                      e.dataTransfer.dropEffect = 'move'
                                      setDropTargetProject(project.id)
                                    }
                                  }}
                                  onDragEnter={(e) => {
                                    if (
                                      e.dataTransfer.types.includes(
                                        'application/x-chat-id',
                                      ) &&
                                      !project.decryptionFailed
                                    ) {
                                      e.preventDefault()
                                      setDropTargetProject(project.id)
                                      if (projectHoverTimerRef.current) {
                                        clearTimeout(
                                          projectHoverTimerRef.current,
                                        )
                                      }
                                      projectHoverTimerRef.current = setTimeout(
                                        () => {
                                          onEnterProject?.(
                                            project.id,
                                            project.name,
                                          )
                                        },
                                        400,
                                      )
                                    }
                                  }}
                                  onDragLeave={(e) => {
                                    // Only clear if actually leaving the button (not just moving between children)
                                    if (
                                      !e.currentTarget.contains(
                                        e.relatedTarget as Node,
                                      )
                                    ) {
                                      if (dropTargetProjectId === project.id) {
                                        setDropTargetProject(null)
                                      }
                                      if (projectHoverTimerRef.current) {
                                        clearTimeout(
                                          projectHoverTimerRef.current,
                                        )
                                        projectHoverTimerRef.current = null
                                      }
                                    }
                                  }}
                                  onDrop={async (e) => {
                                    e.preventDefault()
                                    if (projectHoverTimerRef.current) {
                                      clearTimeout(projectHoverTimerRef.current)
                                      projectHoverTimerRef.current = null
                                    }
                                    const chatId = e.dataTransfer.getData(
                                      'application/x-chat-id',
                                    )
                                    if (
                                      chatId &&
                                      onMoveChatToProject &&
                                      !project.decryptionFailed
                                    ) {
                                      // Convert local chat to cloud first if needed
                                      const chat = chats.find(
                                        (c) => c.id === chatId,
                                      )
                                      if (
                                        chat?.isLocalOnly &&
                                        onConvertChatToCloud
                                      ) {
                                        await onConvertChatToCloud(chatId)
                                      }
                                      await onMoveChatToProject(
                                        chatId,
                                        project.id,
                                      )
                                    }
                                    clearDragState()
                                  }}
                                  className={cn(
                                    'group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                                    dropTargetProjectId === project.id
                                      ? isDarkMode
                                        ? 'border-white/30 bg-white/10'
                                        : 'border-gray-400 bg-gray-200/30'
                                      : 'border-transparent hover:border-border-subtle',
                                    project.decryptionFailed
                                      ? 'cursor-default'
                                      : isDarkMode
                                        ? 'cursor-pointer text-content-secondary hover:bg-surface-chat'
                                        : 'cursor-pointer text-content-secondary hover:bg-surface-sidebar',
                                  )}
                                >
                                  {project.decryptionFailed ? (
                                    <FaLock className="mt-0.5 h-4 w-4 shrink-0 self-start text-orange-500" />
                                  ) : (
                                    <FolderIcon
                                      className={cn(
                                        'mt-0.5 h-4 w-4 shrink-0 self-start',
                                        !getProjectColor(project.color) &&
                                          'text-content-muted',
                                      )}
                                      style={
                                        getProjectColor(project.color)
                                          ? {
                                              color: getProjectColor(
                                                project.color,
                                              )!.hex,
                                            }
                                          : undefined
                                      }
                                    />
                                  )}
                                  <div className="flex min-w-0 flex-1 flex-col text-left">
                                    <span
                                      className={cn(
                                        'truncate leading-5',
                                        project.decryptionFailed &&
                                          'text-orange-500',
                                      )}
                                    >
                                      {project.name}
                                    </span>
                                    <span
                                      className={cn(
                                        'text-xs',
                                        project.decryptionFailed
                                          ? 'text-red-500'
                                          : 'text-content-muted',
                                      )}
                                    >
                                      {project.decryptionFailed
                                        ? 'Failed to decrypt: wrong key'
                                        : `Updated ${formatRelativeTime(new Date(project.updatedAt))}`}
                                    </span>
                                  </div>
                                  {project.decryptionFailed && (
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation()
                                        if (deletingProjectId === project.id)
                                          return
                                        setDeletingProjectId(project.id)
                                        try {
                                          await deleteProject(project.id)
                                          await refreshProjects()
                                        } catch (error) {
                                          toast({
                                            title: 'Failed to delete project',
                                            description:
                                              error instanceof Error
                                                ? error.message
                                                : 'Please try again.',
                                            variant: 'destructive',
                                          })
                                        } finally {
                                          setDeletingProjectId(null)
                                        }
                                      }}
                                      disabled={
                                        deletingProjectId === project.id
                                      }
                                      className={cn(
                                        'shrink-0 rounded p-1 transition-colors',
                                        isDarkMode
                                          ? 'text-content-muted hover:bg-surface-chat hover:text-white'
                                          : 'text-content-muted hover:bg-surface-sidebar hover:text-content-secondary',
                                        deletingProjectId === project.id &&
                                          'opacity-50',
                                      )}
                                      title="Delete encrypted project"
                                    >
                                      {deletingProjectId === project.id ? (
                                        <PiSpinner className="h-4 w-4 animate-spin" />
                                      ) : (
                                        <TrashIcon className="h-4 w-4" />
                                      )}
                                    </button>
                                  )}
                                </div>
                              ))}

                              {/* Load more button */}
                              {hasMoreProjects && (
                                <button
                                  onClick={() => loadMoreProjects()}
                                  disabled={projectsLoading}
                                  className={cn(
                                    'w-full rounded-lg border px-3 py-2 text-center text-xs transition-colors',
                                    isDarkMode
                                      ? 'border-border-strong text-content-muted hover:text-content-secondary'
                                      : 'border-border-subtle text-content-muted hover:text-content-secondary',
                                    projectsLoading &&
                                      'cursor-not-allowed opacity-50',
                                  )}
                                >
                                  {projectsLoading ? 'Loading...' : 'Load more'}
                                </button>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Chats Header */}
          <div
            className={cn(
              'relative z-10 flex-none border-t border-border-subtle',
              !isChatHistoryExpanded && 'border-b',
            )}
          >
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isChatHistoryExpanded}
              aria-label="Chats"
              onClick={() => setIsChatHistoryExpanded(!isChatHistoryExpanded)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setIsChatHistoryExpanded(!isChatHistoryExpanded)
                }
              }}
              onDragOver={(e) => {
                const chatId = e.dataTransfer.types.includes(
                  'application/x-chat-id',
                )
                if (chatId) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDropTargetChatHistory(true)
                }
              }}
              onDragEnter={(e) => {
                const chatId = e.dataTransfer.types.includes(
                  'application/x-chat-id',
                )
                if (chatId) {
                  e.preventDefault()
                  setDropTargetChatHistory(true)
                  setIsChatHistoryExpanded(true)
                }
              }}
              onDragLeave={() => {
                setDropTargetChatHistory(false)
              }}
              onDrop={async (e) => {
                e.preventDefault()
                const chatId = e.dataTransfer.getData('application/x-chat-id')
                if (chatId && onRemoveChatFromProject) {
                  await onRemoveChatFromProject(chatId)
                }
                clearDragState()
              }}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between bg-surface-sidebar px-4 py-3 text-sm transition-colors',
                isDropTargetChatHistory
                  ? isDarkMode
                    ? 'border border-white/30 bg-white/10'
                    : 'border border-gray-400 bg-gray-200/30'
                  : isDarkMode
                    ? 'text-content-secondary hover:bg-surface-chat'
                    : 'text-content-secondary hover:bg-white',
              )}
            >
              <span className="flex items-center gap-2">
                <IoChatbubblesOutline className="h-4 w-4" />
                <span className="truncate font-aeonik font-medium">Chats</span>
              </span>
              <div className="flex items-center gap-1">
                {isSignedIn && cloudSyncEnabled && onManualSync && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (isSyncing) return
                      void onManualSync()
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    disabled={isSyncing}
                    aria-label="Sync chats"
                    title="Sync chats"
                    className="rounded p-1 text-content-muted transition-colors hover:text-content-secondary disabled:cursor-default disabled:opacity-60"
                  >
                    {isSyncing ? (
                      <PiSpinner className="h-4 w-4 animate-spin" />
                    ) : (
                      <GoSync className="h-4 w-4" />
                    )}
                  </button>
                )}
                {isChatHistoryExpanded ? (
                  <ChevronDownIcon className="h-4 w-4" />
                ) : (
                  <ChevronRightIcon className="h-4 w-4" />
                )}
              </div>
            </div>

            {/* Expanded Chats content */}
            <AnimatePresence initial={false}>
              {isChatHistoryExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className={cn('overflow-hidden', expandedPanelClass)}
                >
                  {/* Tabs for Cloud/Local chats - show when signed in, cloud sync enabled, and local-only mode enabled */}
                  {isSignedIn && cloudSyncEnabled && localOnlyModeEnabled && (
                    <div
                      className="relative mx-4 mt-2 flex rounded-lg bg-surface-chat p-1"
                      role="tablist"
                      aria-label="Chat storage"
                    >
                      {/* Sliding background indicator */}
                      <div
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-y-1 w-[calc(50%-4px)] rounded-md shadow-sm transition-all duration-200 ease-in-out',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                          activeTab === 'cloud'
                            ? 'translate-x-0'
                            : 'translate-x-full',
                        )}
                        style={{ left: '4px' }}
                      />

                      <button
                        id="chat-cloud-tab"
                        role="tab"
                        aria-selected={activeTab === 'cloud'}
                        aria-controls="chat-storage-panel"
                        onClick={() => setActiveTab('cloud')}
                        onDragOver={(e) => {
                          if (
                            e.dataTransfer.types.includes(
                              'application/x-chat-id',
                            ) &&
                            onConvertChatToCloud
                          ) {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            setDropTargetTab('cloud')
                          }
                        }}
                        onDragEnter={(e) => {
                          if (
                            e.dataTransfer.types.includes(
                              'application/x-chat-id',
                            ) &&
                            onConvertChatToCloud
                          ) {
                            e.preventDefault()
                            setDropTargetTab('cloud')
                            setActiveTab('cloud')
                          }
                        }}
                        onDragLeave={() => {
                          if (dropTargetTab === 'cloud') {
                            setDropTargetTab(null)
                          }
                        }}
                        onDrop={async (e) => {
                          e.preventDefault()
                          const chatId = e.dataTransfer.getData(
                            'application/x-chat-id',
                          )
                          if (chatId) {
                            if (
                              draggingChatFromProjectId &&
                              onRemoveChatFromProject
                            ) {
                              // Chat from project is already cloud, just remove from project
                              await onRemoveChatFromProject(chatId)
                            } else if (onConvertChatToCloud) {
                              // Only convert if dragging from local (not from project)
                              await onConvertChatToCloud(chatId)
                            }
                          }
                          clearDragState()
                        }}
                        className={cn(
                          'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                          dropTargetTab === 'cloud'
                            ? isDarkMode
                              ? 'bg-white/10'
                              : 'bg-gray-200/30'
                            : activeTab === 'cloud'
                              ? isDarkMode
                                ? 'text-white'
                                : 'text-content-primary'
                              : 'text-content-muted hover:text-content-secondary',
                        )}
                      >
                        <CloudIcon className="h-3.5 w-3.5" />
                        Cloud
                      </button>
                      <button
                        id="chat-local-tab"
                        role="tab"
                        aria-selected={activeTab === 'local'}
                        aria-controls="chat-storage-panel"
                        onClick={() => setActiveTab('local')}
                        onDragOver={(e) => {
                          if (
                            e.dataTransfer.types.includes(
                              'application/x-chat-id',
                            ) &&
                            onConvertChatToLocal
                          ) {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            setDropTargetTab('local')
                          }
                        }}
                        onDragEnter={(e) => {
                          if (
                            e.dataTransfer.types.includes(
                              'application/x-chat-id',
                            ) &&
                            onConvertChatToLocal
                          ) {
                            e.preventDefault()
                            setActiveTab('local')
                            setDropTargetTab('local')
                          }
                        }}
                        onDragLeave={() => {
                          if (dropTargetTab === 'local') {
                            setDropTargetTab(null)
                          }
                        }}
                        onDrop={async (e) => {
                          e.preventDefault()
                          const chatId = e.dataTransfer.getData(
                            'application/x-chat-id',
                          )
                          if (chatId && onConvertChatToLocal) {
                            // convertChatToLocal also clears projectId
                            await onConvertChatToLocal(chatId)
                          }
                          clearDragState()
                        }}
                        className={cn(
                          'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                          dropTargetTab === 'local'
                            ? isDarkMode
                              ? 'bg-white/10'
                              : 'bg-gray-200/30'
                            : activeTab === 'local'
                              ? isDarkMode
                                ? 'text-white'
                                : 'text-content-primary'
                              : 'text-content-muted hover:text-content-secondary',
                        )}
                      >
                        <CiFloppyDisk className="h-3.5 w-3.5" />
                        Local
                      </button>
                    </div>
                  )}

                  {/* Description text - show when NOT displaying the cloud sync box */}
                  {(!isSignedIn || cloudSyncEnabled) && (
                    <div className="font-base mx-4 mt-1 min-h-[52px] pb-3 font-aeonik-fono text-xs text-content-muted">
                      {!isSignedIn ? (
                        'Your chats are stored temporarily in this browser tab. Create an account for persistent storage.'
                      ) : localOnlyModeEnabled && activeTab === 'local' ? (
                        "Local chats are stored only on this device and won't sync across devices."
                      ) : (
                        <>
                          Your chats are encrypted and synced to the cloud. The
                          encryption key is only stored on this browser and
                          never sent to Tinfoil.
                        </>
                      )}
                    </div>
                  )}

                  {/* Cloud Sync Setup - show when signed in and cloud sync is OFF */}
                  {isSignedIn && !cloudSyncEnabled && (
                    <div className="px-3 py-2">
                      <p className="text-xs text-content-muted">
                        Chat are only stored locally on this device. Set up
                        end-to-end encrypted cloud sync to back up and access
                        your data across multiple devices.
                      </p>
                      <button
                        onClick={async () => {
                          if (passkeySetupAvailable && onSetupPasskey) {
                            const success = await onSetupPasskey()
                            if (success) return
                          }
                          if (onCloudSyncSetupClick) {
                            onCloudSyncSetupClick()
                          }
                        }}
                        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-chat px-3 py-2 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat/80"
                      >
                        <CloudIcon className="h-3.5 w-3.5" />
                        Enable Cloud Sync
                      </button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Scrollable Chat List */}
          <AnimatePresence initial={false}>
            {isChatHistoryExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeInOut' }}
                className={cn('flex-1 overflow-hidden', expandedPanelClass)}
              >
                <div
                  id="chat-storage-panel"
                  role="tabpanel"
                  aria-labelledby={
                    activeTab === 'cloud' ? 'chat-cloud-tab' : 'chat-local-tab'
                  }
                  ref={chatListRef}
                  onDragOver={(e) => {
                    if (
                      e.dataTransfer.types.includes('application/x-chat-id')
                    ) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setIsDropTargetChatList(true)
                    }
                  }}
                  onDragEnter={(e) => {
                    if (
                      e.dataTransfer.types.includes('application/x-chat-id')
                    ) {
                      e.preventDefault()
                      setIsDropTargetChatList(true)
                    }
                  }}
                  onDragLeave={(e) => {
                    // Only clear if leaving the container entirely
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setIsDropTargetChatList(false)
                    }
                  }}
                  onDrop={async (e) => {
                    e.preventDefault()
                    const chatId = e.dataTransfer.getData(
                      'application/x-chat-id',
                    )
                    if (chatId) {
                      const chat = chats.find((c) => c.id === chatId)
                      if (draggingChatFromProjectId) {
                        // Dragging from project - remove from project
                        if (activeTab === 'local' && onConvertChatToLocal) {
                          await onConvertChatToLocal(chatId)
                        } else if (onRemoveChatFromProject) {
                          await onRemoveChatFromProject(chatId)
                        }
                      } else if (
                        chat?.isLocalOnly &&
                        activeTab === 'cloud' &&
                        onConvertChatToCloud
                      ) {
                        // Local chat dropped on cloud tab area - convert to cloud
                        await onConvertChatToCloud(chatId)
                      } else if (
                        !chat?.isLocalOnly &&
                        activeTab === 'local' &&
                        onConvertChatToLocal
                      ) {
                        // Cloud chat dropped on local tab area - convert to local
                        await onConvertChatToLocal(chatId)
                      }
                    }
                    setIsDropTargetChatList(false)
                    clearDragState()
                  }}
                  className={cn(
                    'relative z-10 h-full overflow-y-auto',
                    isChatListScrolled && 'border-t border-border-subtle',
                    isDropTargetChatList &&
                      (isDarkMode
                        ? 'border border-white/30 bg-white/10'
                        : 'border border-gray-400 bg-gray-200/30'),
                  )}
                >
                  {isClient && (
                    <ChatList
                      chats={sortedChats as ChatItemData[]}
                      currentChatId={currentChat?.id}
                      currentChatIsBlank={currentChat?.isBlankChat}
                      currentChatIsLocalOnly={currentChat?.isLocalOnly}
                      isDarkMode={isDarkMode}
                      showEncryptionStatus={true}
                      showSyncStatus={true}
                      enableTitleAnimation={true}
                      isDraggable={
                        isSignedIn &&
                        cloudSyncEnabled &&
                        (!!onMoveChatToProject ||
                          !!onConvertChatToCloud ||
                          !!onConvertChatToLocal)
                      }
                      showMoveToProject={
                        isSignedIn &&
                        isPremium &&
                        cloudSyncEnabled &&
                        !!onMoveChatToProject
                      }
                      onSelectChat={handleChatSelect}
                      onAfterSelect={undefined}
                      onUpdateTitle={updateChatTitle}
                      onDeleteChat={deleteChat}
                      onEncryptionKeyClick={onEncryptionKeyClick}
                      onDragStart={(chatId) => setDraggingChat(chatId, null)}
                      onDragEnd={() => {
                        clearDragState()
                      }}
                      projects={projects.map((p) => ({
                        id: p.id,
                        name: p.name,
                      }))}
                      onMoveToProject={
                        onMoveChatToProject
                          ? async (chatId, projectId) => {
                              // Convert local chat to cloud first if needed
                              const chat = chats.find((c) => c.id === chatId)
                              if (chat?.isLocalOnly && onConvertChatToCloud) {
                                await onConvertChatToCloud(chatId)
                              }
                              await onMoveChatToProject(chatId, projectId)
                            }
                          : undefined
                      }
                      loadingIndicator={
                        chatDecryptionProgress?.isDecrypting ? (
                          <div className="flex items-center gap-2 px-4 py-2 text-content-secondary">
                            <PiSpinner className="h-4 w-4 animate-spin" />
                            <span className="text-sm">
                              Loading chats
                              {chatDecryptionProgress.total > 0
                                ? ` (${chatDecryptionProgress.current}/${chatDecryptionProgress.total})`
                                : '...'}
                            </span>
                          </div>
                        ) : undefined
                      }
                      onConvertToCloud={onConvertChatToCloud}
                      onConvertToLocal={onConvertChatToLocal}
                      emptyState={
                        activeTab === 'local' ? (
                          <div className="rounded-lg border border-border-subtle bg-surface-sidebar p-4 text-center">
                            <p className="text-sm text-content-muted">
                              No local chats yet
                            </p>
                            <p className="mt-1 text-xs text-content-muted">
                              Disable cloud sync in settings to create
                              local-only chats
                            </p>
                          </div>
                        ) : undefined
                      }
                      loadMoreButton={
                        <>
                          {/* Sentinel element for intersection observer */}
                          <div ref={loadMoreSentinelRef} className="h-1" />
                          {/* Shimmer placeholder while loading or waiting for chats to render */}
                          {(isLoadingMore || pendingChatsRender) && (
                            <div className="space-y-1 px-2">
                              {[...Array(3)].map((_, i) => (
                                <div
                                  key={i}
                                  className="animate-pulse rounded-lg px-3 py-2"
                                >
                                  <div
                                    className={cn(
                                      'mb-1.5 h-3.5 w-3/4 rounded',
                                      isDarkMode
                                        ? 'bg-gray-700'
                                        : 'bg-gray-200',
                                    )}
                                  />
                                  <div
                                    className={cn(
                                      'h-3 w-1/3 rounded',
                                      isDarkMode
                                        ? 'bg-gray-700'
                                        : 'bg-gray-200',
                                    )}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                          {isSignedIn &&
                            !shouldShowLoadMore &&
                            !hasMoreRemote &&
                            hasAttemptedLoadMore && (
                              <div className="px-3 py-2 text-center text-xs text-content-muted">
                                No more chats
                              </div>
                            )}
                        </>
                      }
                    />
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* App Store button for iOS users */}
          {isClient && isIOS && (
            <div className="relative z-10 flex-none border-t border-border-subtle p-3">
              <div className="text-center">
                <p
                  className={`mb-2 text-sm font-medium ${'text-content-secondary'}`}
                >
                  Get the native app
                </p>
                <a
                  href="https://apps.apple.com/app/tinfoil/id6745201750"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full"
                >
                  <img
                    src={
                      isDarkMode ? '/appstore-dark.svg' : '/appstore-light.svg'
                    }
                    alt="Download on the App Store"
                    className="mx-auto h-10 w-auto transition-opacity hover:opacity-80"
                  />
                </a>
              </div>
            </div>
          )}

          {/* Terms and privacy policy */}
          <div className="relative z-10 mt-auto flex h-[56px] flex-none items-center justify-center border-t border-border-subtle bg-surface-sidebar p-3">
            <p className="text-center text-xs leading-relaxed text-content-secondary">
              By using this service, you agree to Tinfoil&apos;s{' '}
              <Link
                href="https://tinfoil.sh/terms"
                className={
                  isDarkMode
                    ? 'text-white underline hover:text-content-secondary'
                    : 'text-brand-accent-dark underline hover:text-brand-accent-dark/80'
                }
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                href="https://tinfoil.sh/privacy"
                className={
                  isDarkMode
                    ? 'text-white underline hover:text-content-secondary'
                    : 'text-brand-accent-dark underline hover:text-brand-accent-dark/80'
                }
              >
                Privacy Policy
              </Link>
            </p>
          </div>
        </div>
      </nav>

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
