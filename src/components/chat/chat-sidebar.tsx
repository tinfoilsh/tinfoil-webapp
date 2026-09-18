import { PAGINATION } from '@/config'
import {
  UI_EXPAND_PROJECTS_ON_MOUNT,
  UI_SIDEBAR_ACTIVE_TAB,
  UI_SIDEBAR_CHAT_HISTORY_EXPANDED,
  UI_SIDEBAR_EXPAND_SECTION,
  UI_SIDEBAR_FAVORITES_EXPANDED,
  UI_SIDEBAR_PROJECTS_EXPANDED,
  USER_PREFS_NATIVE_APP_DISMISSED,
} from '@/constants/storage-keys'
import { useProjects } from '@/hooks/use-projects'
import {
  useSyncHealthAttention,
  useSyncHealthFailed,
} from '@/hooks/use-sync-health'
import { toast } from '@/hooks/use-toast'
import { useUpgradeToPro } from '@/hooks/use-upgrade-to-pro'
import { encryptionService } from '@/services/encryption/encryption-service'
import { chatStorage } from '@/services/storage/chat-storage'
import { isResolvedFavoriteChat } from '@/services/storage/pinned-chats'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  hasUserSetLocalOnlyPreference,
  isCloudSyncEnabled,
  isLocalOnlyModeEnabled,
  recordCloudSyncPreference,
  setLocalOnlyModeEnabled as setLocalOnlyModeSetting,
} from '@/utils/cloud-sync-settings'
import { logInfo } from '@/utils/error-handling'
import { postAuthRedirectTarget } from '@/utils/redirect-url'
import { useAuth, useUser } from '@clerk/nextjs'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { useRouter } from 'next/router'
import { CiFloppyDisk } from 'react-icons/ci'
import { FaLock } from 'react-icons/fa6'
import { GoSidebarCollapse, GoSidebarExpand } from 'react-icons/go'
import { IoChatbubblesOutline } from 'react-icons/io5'
import {
  PiFolder,
  PiMicrophone,
  PiNotePencilLight,
  PiPushPin,
  PiSparkle,
  PiSpinner,
} from 'react-icons/pi'
import { ChatList, type ChatItemData } from './chat-list'
import { formatRelativeTime } from './chat-list-utils'
import { CONSTANTS } from './constants'
import { useDrag } from './drag-context'
import { consumeFavoriteDrop } from './favorite-drag'
import type { SettingsTab } from './settings-modal'
import { SidebarAccountMenu } from './sidebar-account-menu'
import { getSidebarUpsellVariant } from './sidebar-upsell-state'
import { useFavoriteDropTarget } from './use-favorite-drop-target'

import { useProject } from '@/components/project/project-context'
import { SidebarPatternEdge } from '@/components/ui/sidebar-pattern-edge'
import { cn } from '@/components/ui/utils'
import {
  getProjectColor,
  PROJECT_COLOR_SIDEBAR_TINT_OPACITY,
  projectColorTintLayer,
} from '@/constants/project-colors'
import { useCloudPagination } from '@/hooks/use-cloud-pagination'

import { logError } from '@/utils/error-handling'
import {
  getChatPath,
  getNewChatPath,
  isPlainPrimaryClick,
} from '@/utils/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '../link'
import { Logo } from '../logo'
import { SidebarPanel, SidebarRail } from './sidebar-layout'
import { getChatLoadMoreAction } from './sidebar-pagination'
import type { Chat } from './types'

const FAVORITES_PANEL_ID = 'sidebar-favorites-panel'
const ENCRYPTION_NOTE_ID = 'sidebar-encryption-note'
const STORAGE_TAB_CLASS_NAME =
  'flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors'
const STORAGE_TAB_ACTIVE_CLASS_NAME =
  'border-tinfoil-accent-blue bg-tinfoil-accent-blue text-white hover:bg-tinfoil-accent-blue-hover'
const STORAGE_TAB_INACTIVE_CLASS_NAME =
  'border-border-subtle bg-surface-chat-background text-content-secondary hover:border-border-strong hover:text-content-primary'
const STORAGE_TAB_DROP_TARGET_CLASS_NAME =
  'border-tinfoil-accent-blue ring-2 ring-tinfoil-accent-blue-soft'

const SIDEBAR_CTA_CLASS_NAME =
  'block w-full rounded-md bg-brand-accent-dark px-4 py-2 text-center text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90'

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
  pixelateSidebarChatTitles: boolean
  createNewChat: (isLocalOnly?: boolean, fromUserAction?: boolean) => void
  handleChatSelect: (chatId: string) => void
  updateChatTitle: (chatId: string, newTitle: string) => void
  deleteChat: (chatId: string) => void
  isClient: boolean
  isPremium?: boolean
  isSubscriptionLoading?: boolean
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
  onChatsUpdated?: () => void | Promise<void>
  isInitialChatPageReady?: boolean
  /** Triggers an account revision sync from the sidebar "Sync" button. */
  onManualSync?: () => Promise<boolean>
  /** True while a cloud sync is in progress; drives the Sync button spinner. */
  isSyncing?: boolean
  /** Whether the most recent cloud sync attempt failed. */
  lastSyncFailed?: boolean
  isProjectMode?: boolean
  activeProjectName?: string
  onEnterProject?: (projectId: string, projectName?: string) => Promise<void>
  onCreateProject?: () => Promise<void>
  onMoveChatToProject?: (chatId: string, projectId: string) => Promise<void>
  onRemoveChatFromProject?: (chatId: string) => Promise<void>
  onConvertChatToCloud?: (chatId: string) => Promise<boolean>
  onConvertChatToLocal?: (chatId: string) => Promise<void>
  onSettingsClick?: (tab?: SettingsTab) => void
  onReportBugClick?: () => void
  onSearchClick?: () => void
  pinnedChatIds?: readonly string[]
  onToggleFavorite?: (chat: ChatItemData) => void | Promise<void>
  onRemoveFavorite?: (chatId: string) => void
  onOpenFavorite?: (chat: ChatItemData) => void | Promise<void>
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
  pixelateSidebarChatTitles,
  createNewChat,
  handleChatSelect,
  updateChatTitle,
  deleteChat,
  isClient,
  isPremium = true,
  isSubscriptionLoading = false,
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
  isInitialChatPageReady = false,
  onManualSync,
  isSyncing = false,
  lastSyncFailed = false,
  isProjectMode,
  activeProjectName,
  onEnterProject,
  onCreateProject,
  onMoveChatToProject,
  onRemoveChatFromProject,
  onConvertChatToCloud,
  onConvertChatToLocal,
  onSettingsClick,
  onReportBugClick,
  onSearchClick,
  pinnedChatIds = [],
  onToggleFavorite,
  onRemoveFavorite,
  onOpenFavorite,
  windowWidth,
  chatDecryptionProgress,
}: ChatSidebarProps) {
  const router = useRouter()
  const authRedirectUrl = postAuthRedirectTarget(router.asPath)
  const syncNeedsAttention = useSyncHealthAttention()
  const syncHealthFailed = useSyncHealthFailed()
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
  const [isFavoritesExpanded, setIsFavoritesExpanded] = useState(false)
  const hasLoadedFavoritesExpandedRef = useRef(false)
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
      // Accordion invariant: Projects and Chats are never open together.
      // Stored states predating the accordion (or written independently)
      // can both be 'true'; Projects wins and Chats stays collapsed.
      if (sessionStorage.getItem(UI_SIDEBAR_PROJECTS_EXPANDED) === 'true') {
        return false
      }
      const stored = sessionStorage.getItem(UI_SIDEBAR_CHAT_HISTORY_EXPANDED)
      if (stored !== null) {
        return stored === 'true'
      }
    }
    return true
  })
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const favoritesSectionRef = useRef<HTMLElement>(null)
  // Hides the sidebar scrollbar while a section expand/collapse animates;
  // the scroll height changes every frame and the scrollbar would flicker.
  const [hideScrollbarDuringAnimation, setHideScrollbarDuringAnimation] =
    useState(false)
  const scrollbarHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const [isIOS, setIsIOS] = useState(false)
  const [nativeAppDismissed, setNativeAppDismissed] = useState(false)
  const {
    startUpgrade: handleUpgradeToPro,
    upgradeLoading,
    upgradeError,
  } = useUpgradeToPro()
  const [activeTab, setActiveTab] = useState<'cloud' | 'local'>(() => {
    if (currentChat?.isBlankChat && currentChat.isLocalOnly) {
      return 'local'
    }
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
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth()
  const upsellVariant = getSidebarUpsellVariant({
    isAuthLoaded,
    isSignedIn,
    isSubscriptionLoading,
    isPremium,
  })
  const favoritesAvailable = Boolean(isSignedIn && cloudSyncEnabled)
  const { user } = useUser()

  const {
    draggingChatId,
    draggingChatFromProjectId,
    draggingChatSource,
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
  const newChatHref = getNewChatPath({ isLocalOnly: activeTab === 'local' })
  const isCurrentNewChat =
    currentChat?.isBlankChat &&
    !currentChat.isTemporary &&
    Boolean(currentChat.isLocalOnly) === (activeTab === 'local')
  const syncFailed = lastSyncFailed || syncHealthFailed

  const {
    projects,
    loading: projectsLoading,
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
  // Opaque so pinned panels hide content scrolling beneath them.
  const expandedPanelClass = 'bg-surface-sidebar-panel'

  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  )

  // Cloud pagination state via hook
  const {
    hasMore: hasMoreRemote,
    isLoading: isLoadingMore,
    hasAttempted: hasAttemptedLoadMore,
    isInitialized: isPaginationInitialized,
    canRetryInitialization,
    loadMore: loadMorePage,
  } = useCloudPagination({
    isSignedIn: !!isSignedIn,
    userId: user?.id,
    isInitialPageReady: isInitialChatPageReady,
  })
  const [visibleCloudChatCount, setVisibleCloudChatCount] = useState<number>(
    PAGINATION.CHATS_PER_PAGE,
  )

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

  useEffect(() => {
    if (!hasLoadedFavoritesExpandedRef.current) {
      hasLoadedFavoritesExpandedRef.current = true
      const stored = sessionStorage.getItem(UI_SIDEBAR_FAVORITES_EXPANDED)
      const requestedSection = sessionStorage.getItem(UI_SIDEBAR_EXPAND_SECTION)
      const shouldExpand =
        stored === 'true' && !isProjectsExpanded && requestedSection !== 'chats'
      setIsFavoritesExpanded(shouldExpand)
      if (shouldExpand) {
        setIsProjectsExpanded(false)
        setIsChatHistoryExpanded(false)
      }
      return
    }
    sessionStorage.setItem(
      UI_SIDEBAR_FAVORITES_EXPANDED,
      isFavoritesExpanded ? 'true' : 'false',
    )
  }, [isFavoritesExpanded, isProjectsExpanded])

  useEffect(() => {
    if (isAuthLoaded && !favoritesAvailable && isFavoritesExpanded) {
      setIsFavoritesExpanded(false)
      if (!isProjectsExpanded) setIsChatHistoryExpanded(true)
    }
  }, [
    favoritesAvailable,
    isAuthLoaded,
    isFavoritesExpanded,
    isProjectsExpanded,
  ])

  // Listen for cloud sync setting changes
  useEffect(() => {
    const handleCloudSyncChange = () => {
      setCloudSyncEnabled(isCloudSyncEnabled())
    }

    // Listen for both storage events and custom events
    window.addEventListener('storage', handleCloudSyncChange)
    window.addEventListener(
      CLOUD_SYNC_SETTING_CHANGED_EVENT,
      handleCloudSyncChange,
    )

    return () => {
      window.removeEventListener('storage', handleCloudSyncChange)
      window.removeEventListener(
        CLOUD_SYNC_SETTING_CHANGED_EVENT,
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

  // Detect iOS device
  useEffect(() => {
    if (isClient) {
      setIsIOS(isIOSDevice())
      try {
        setNativeAppDismissed(
          localStorage.getItem(USER_PREFS_NATIVE_APP_DISMISSED) === 'true',
        )
      } catch {
        setNativeAppDismissed(false)
      }
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
        setIsFavoritesExpanded(false)
        refreshProjects()
      } else if (expandSection === 'chats') {
        setIsProjectsExpanded(false)
        setIsChatHistoryExpanded(true)
        setIsFavoritesExpanded(false)
      }
      sessionStorage.removeItem(UI_SIDEBAR_EXPAND_SECTION)
    }
  }, [isOpen, refreshProjects])

  // Track if we're waiting for newly loaded chats to render (prevents scroll jump)
  const [pendingChatsRender, setPendingChatsRender] = useState(false)

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

  // Drives both the Projects section's visibility and the Chats header's
  // sticky offset so the two can never drift apart.
  const hasPinnedProjectsHeader = Boolean(isSignedIn && isPremium)
  // Heal stale accordion state: a stored Projects=true flag (e.g. from a
  // premium session) would otherwise leave a signed-out/non-premium user
  // with no Projects section AND a collapsed chat list — an empty sidebar.
  useEffect(() => {
    if (isAuthLoaded && !hasPinnedProjectsHeader && isProjectsExpanded) {
      setIsProjectsExpanded(false)
      setIsFavoritesExpanded(false)
      setIsChatHistoryExpanded(true)
    }
  }, [hasPinnedProjectsHeader, isAuthLoaded, isProjectsExpanded])

  const hideScrollbarWhileSectionsAnimate = useCallback(() => {
    setHideScrollbarDuringAnimation(true)
    if (scrollbarHideTimeoutRef.current !== null) {
      clearTimeout(scrollbarHideTimeoutRef.current)
    }
    scrollbarHideTimeoutRef.current = setTimeout(() => {
      scrollbarHideTimeoutRef.current = null
      setHideScrollbarDuringAnimation(false)
    }, CONSTANTS.SIDEBAR_SECTION_SCROLLBAR_HIDE_MS)
  }, [])

  useEffect(
    () => () => {
      if (scrollbarHideTimeoutRef.current !== null) {
        clearTimeout(scrollbarHideTimeoutRef.current)
      }
    },
    [],
  )

  // Favorites, Projects, and Chats behave as an accordion: expanding one
  // collapses the others. This keeps the newly opened section at the top
  // of the scroll area. Expanding while scrolled deep into another section
  // would otherwise appear to do nothing, since the new content renders at its
  // flow position far above the viewport) and resets the scroll so the
  // opened section's content is immediately visible.
  const expandProjectsSection = useCallback(() => {
    hideScrollbarWhileSectionsAnimate()
    setIsProjectsExpanded(true)
    setIsChatHistoryExpanded(false)
    setIsFavoritesExpanded(false)
    sidebarScrollRef.current?.scrollTo({ top: 0 })
    if (projects.length === 0) {
      refreshProjects()
    }
  }, [projects.length, refreshProjects, hideScrollbarWhileSectionsAnimate])

  const expandChatsSection = useCallback(() => {
    hideScrollbarWhileSectionsAnimate()
    setIsChatHistoryExpanded(true)
    setIsProjectsExpanded(false)
    setIsFavoritesExpanded(false)
    sidebarScrollRef.current?.scrollTo({ top: 0 })
  }, [hideScrollbarWhileSectionsAnimate])

  const expandFavoritesSection = useCallback(() => {
    hideScrollbarWhileSectionsAnimate()
    setIsFavoritesExpanded(true)
    setIsProjectsExpanded(false)
    setIsChatHistoryExpanded(false)
  }, [hideScrollbarWhileSectionsAnimate])

  const filteredChats = useMemo(() => {
    // The incoming `chats` array is already sorted by `sortChats`
    // (blank-first, then most-recently-updated). We only filter
    // here; the display order matches the server's pagination so
    // newly-loaded pages slot in at the bottom without reshuffling.
    if (isSignedIn && cloudSyncEnabled) {
      if (localOnlyModeEnabled && activeTab === 'local') {
        return chats.filter(
          (chat) => chat.isLocalOnly && !chat.projectId && !chat.isBlankChat,
        )
      }
      return chats.filter(
        (chat) => !chat.isLocalOnly && !chat.projectId && !chat.isBlankChat,
      )
    }
    return chats.filter(
      (chat) =>
        (chat as any).isLocalOnly && !chat.projectId && !chat.isBlankChat,
    )
  }, [chats, activeTab, isSignedIn, cloudSyncEnabled, localOnlyModeEnabled])

  const favoriteChats = useMemo(() => {
    const chatsById = new Map(chats.map((chat) => [chat.id, chat]))
    return pinnedChatIds
      .map((chatId) => chatsById.get(chatId))
      .filter((chat): chat is Chat =>
        Boolean(
          chat &&
          isResolvedFavoriteChat(chat) &&
          (isPremium || !chat.projectId),
        ),
      )
  }, [chats, isPremium, pinnedChatIds])

  const { isFavoriteDropTarget, favoriteDropTargetProps } =
    useFavoriteDropTarget({
      chats,
      pinnedChatIds,
      draggingChatId,
      onToggleFavorite,
      onActivate: expandFavoritesSection,
      clearDragState,
    })

  const paginatesCloudChats =
    isSignedIn &&
    cloudSyncEnabled &&
    (!localOnlyModeEnabled || activeTab === 'cloud')
  const sortedChats = useMemo(
    () =>
      paginatesCloudChats
        ? filteredChats.slice(0, visibleCloudChatCount)
        : filteredChats,
    [filteredChats, paginatesCloudChats, visibleCloudChatCount],
  )
  const hasMoreLoadedChats = filteredChats.length > visibleCloudChatCount
  const canLoadRemoteChats =
    isInitialChatPageReady &&
    ((isPaginationInitialized && hasMoreRemote) || canRetryInitialization)
  const shouldShowLoadMore =
    paginatesCloudChats && (hasMoreLoadedChats || canLoadRemoteChats)

  useEffect(() => {
    setVisibleCloudChatCount(PAGINATION.CHATS_PER_PAGE)
  }, [user?.id, isInitialChatPageReady])

  const loadMoreChats = useCallback(async (): Promise<void> => {
    if (isLoadingMore || !isSignedIn) return

    const action = getChatLoadMoreAction({
      loadedChatCount: filteredChats.length,
      visibleChatCount: visibleCloudChatCount,
      hasRemoteCursor: hasMoreRemote,
      canRetryRemoteInitialization: canRetryInitialization,
    })
    if (action === 'none') return
    if (action === 'reveal-local') {
      setVisibleCloudChatCount((count) => count + PAGINATION.CHATS_PER_PAGE)
      return
    }

    try {
      const result = await loadMorePage()
      if (!result || result.saved === 0) return

      setPendingChatsRender(true)
      try {
        await onChatsUpdated?.()
      } catch (error) {
        logError('Failed to reload chats after pagination', error, {
          component: 'ChatSidebar',
          action: 'loadMoreChats',
        })
      } finally {
        setVisibleCloudChatCount((count) => count + PAGINATION.CHATS_PER_PAGE)
        setPendingChatsRender(false)
      }
    } catch (error) {
      setPendingChatsRender(false)
      logError('Failed to load more chats', error, {
        component: 'ChatSidebar',
        action: 'loadMoreChats',
      })
    }
  }, [
    canRetryInitialization,
    filteredChats.length,
    hasMoreRemote,
    isLoadingMore,
    isSignedIn,
    loadMorePage,
    onChatsUpdated,
    visibleCloudChatCount,
  ])

  // Prefer backing up the existing key with a passkey (PRF-capable devices
  // must stay in the passkey-only flow); fall back to the manual cloud-sync
  // setup modal only when passkey setup is unavailable or fails.
  const trySetupPasskeyFirst = async (): Promise<boolean> => {
    if (!passkeySetupAvailable || !onSetupPasskey) return false
    try {
      return await onSetupPasskey()
    } catch (error) {
      logError('Passkey setup from sidebar failed', error, {
        component: 'ChatSidebar',
        action: 'trySetupPasskeyFirst',
      })
      return false
    }
  }

  const openCloudSyncSetup = async () => {
    if (await trySetupPasskeyFirst()) return
    if (onCloudSyncSetupClick) {
      onCloudSyncSetupClick()
    }
  }

  const [isEncryptionNoteExpanded, setIsEncryptionNoteExpanded] =
    useState(false)

  const handleCloudSyncToggle = async (enabled: boolean) => {
    if (enabled) {
      // Check if encryption key exists
      if (!encryptionService.getKey()) {
        if (await trySetupPasskeyFirst()) return

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
      recordCloudSyncPreference(true)
    } else {
      // Disabling cloud sync
      setCloudSyncEnabled(false)
      recordCloudSyncPreference(false)

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
  }

  // Check if mobile
  const isMobile = windowWidth < MOBILE_BREAKPOINT

  return (
    <>
      {/* Collapsed sidebar rail - shown on desktop when sidebar is closed. */}
      {!isMobile && (
        <SidebarRail
          isOpen={isOpen}
          tintStyle={sidebarTintStyle}
          aria-label="Chat history"
        >
          {/* Logo icon - shows expand icon on hover */}
          <div className="flex h-16 flex-none items-center justify-center">
            <button
              onClick={() => setIsOpen(true)}
              className="group/logo relative rounded-lg p-2"
              aria-label="Expand sidebar"
            >
              <img
                src={isDarkMode ? '/icon-dark.png' : '/icon-light.png'}
                alt=""
                className="h-6 w-6 group-hover/logo:opacity-0"
              />
              <GoSidebarCollapse className="absolute inset-0 m-auto h-5 w-5 text-content-secondary opacity-0 group-hover/logo:opacity-100" />
            </button>
          </div>
          {/* Action buttons */}
          <div className="flex flex-col items-center gap-1 px-2">
            {/* New chat button */}
            <div className="group relative">
              <Link
                href={newChatHref}
                onClick={(e) => {
                  if (!isPlainPrimaryClick(e)) return
                  e.preventDefault()
                  createNewChat(activeTab === 'local', true)
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

            {isSignedIn && cloudSyncEnabled && (
              <div className="group relative" {...favoriteDropTargetProps}>
                <button
                  onClick={() => {
                    expandFavoritesSection()
                    setIsOpen(true)
                    requestAnimationFrame(() =>
                      favoritesSectionRef.current?.scrollIntoView({
                        block: 'start',
                      }),
                    )
                  }}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                    'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                    isFavoriteDropTarget &&
                      (isDarkMode
                        ? 'border border-white/30 bg-white/10'
                        : 'border border-gray-400 bg-gray-200/30'),
                  )}
                  aria-label="Favorites"
                >
                  <PiPushPin className="h-5 w-5" />
                </button>
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  Favorites
                </span>
              </div>
            )}

            {/* Projects button - only for premium users */}
            {isSignedIn && isPremium && (
              <div className="group relative">
                <button
                  onClick={() => {
                    sessionStorage.setItem(
                      UI_SIDEBAR_EXPAND_SECTION,
                      'projects',
                    )
                    expandProjectsSection()
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
                  expandChatsSection()
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
                onClick={() => onSettingsClick?.()}
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
        </SidebarRail>
      )}

      {/* Expanded sidebar wrapper */}
      <SidebarPanel
        aria-label="Chat history"
        isOpen={isOpen}
        isMobile={isMobile}
        animate={!isInitialLoad}
        style={sidebarTintStyle}
      >
        <SidebarPatternEdge isDarkMode={isDarkMode} />
        {/* Header */}
        <div className="flex h-16 flex-none items-center justify-between p-4">
          <Link href="/" title="Home" className="-ml-1 flex items-center">
            <Logo className="h-6 w-auto" dark={isDarkMode} />
          </Link>
          {/* Close sidebar button */}
          <div className="group relative flex items-center">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-1.5 text-content-muted transition-colors hover:bg-surface-chat hover:text-content-secondary"
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

        {/* Main sidebar content - one scroll area covering the upsell box,
            New Chat button, Projects, and Chats so long project or chat
            lists never squeeze each other out of view. The footer (and iOS
            banner) stay pinned below. */}
        <div
          ref={sidebarScrollRef}
          className={cn(
            'relative flex min-h-0 flex-1 flex-col overflow-y-auto',
            hideScrollbarDuringAnimation && 'scrollbar-hide',
          )}
        >
          {/* Toolbar: New chat */}
          <div className="relative z-20 flex flex-none items-center gap-2 px-2">
            <Link
              href={newChatHref}
              aria-current={isCurrentNewChat ? 'page' : undefined}
              onClick={(e) => {
                if (!isPlainPrimaryClick(e)) return
                e.preventDefault()
                if (isCurrentNewChat) return
                createNewChat(activeTab === 'local', true)
              }}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-between rounded-lg border px-2 py-2 text-sm transition-all duration-200',
                isCurrentNewChat
                  ? 'cursor-default border-border-subtle bg-surface-chat text-content-muted'
                  : 'border-transparent text-content-secondary hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary',
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

          {/* Message for non-premium users (signed in or not) */}
          {upsellVariant && (
            <div
              className={cn(
                'relative z-10 m-2 flex-none rounded-lg border border-border-subtle bg-surface-chat p-4 transition-all duration-300',
              )}
            >
              <div className="flex-1">
                <h4 className="mb-3 text-sm font-semibold text-content-primary">
                  Get more out of Tinfoil Chat
                </h4>
                {upsellVariant === 'premium' ? (
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
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-3 text-xs text-content-secondary">
                      <IoChatbubblesOutline className="h-4 w-4 flex-shrink-0 text-content-muted" />
                      <span>Keep your chat history</span>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-content-secondary">
                      <CloudIcon className="h-4 w-4 flex-shrink-0 text-content-muted" />
                      <span>Encrypted sync across devices</span>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-content-secondary">
                      <PiPushPin className="h-4 w-4 flex-shrink-0 text-content-muted" />
                      <span>Save your favorite chats</span>
                    </div>
                  </div>
                )}
                <div className="mt-4">
                  {upsellVariant === 'premium' ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void handleUpgradeToPro()
                        }}
                        disabled={upgradeLoading}
                        className={cn(
                          SIDEBAR_CTA_CLASS_NAME,
                          upgradeLoading && 'cursor-not-allowed opacity-70',
                        )}
                      >
                        {upgradeLoading
                          ? 'Redirecting…'
                          : 'Subscribe to Premium'}
                      </button>
                      {upgradeError && (
                        <p className="mt-2 text-xs text-destructive">
                          {upgradeError}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <Link
                        href={`/signup?redirect_url=${authRedirectUrl}`}
                        className={cn(
                          SIDEBAR_CTA_CLASS_NAME,
                          'relative cursor-pointer',
                        )}
                      >
                        Create account
                      </Link>
                      <p className="text-center text-xs text-content-secondary">
                        Already signed up?{' '}
                        <Link
                          href={`/signin?redirect_url=${authRedirectUrl}`}
                          className="cursor-pointer underline hover:text-content-primary"
                        >
                          Log in
                        </Link>
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
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
                    className="mt-2 w-full rounded-md bg-tinfoil-accent-blue px-2.5 py-1.5 font-aeonik text-xs font-medium text-white transition-colors hover:bg-tinfoil-accent-blue-hover"
                  >
                    {backupWarningNeedsRecovery
                      ? 'Set Up Cloud Sync'
                      : 'Enable Cloud Sync'}
                  </button>
                )}
              </div>
            </div>
          )}

          {isSignedIn && cloudSyncEnabled && (
            <section
              ref={favoritesSectionRef}
              {...favoriteDropTargetProps}
              className={cn(
                'relative z-10 mt-2 flex-none transition-colors',
                isFavoriteDropTarget &&
                  (isDarkMode ? 'bg-white/10' : 'bg-gray-200/50'),
              )}
            >
              <button
                type="button"
                aria-expanded={isFavoritesExpanded}
                aria-controls={FAVORITES_PANEL_ID}
                onClick={() => {
                  if (isFavoritesExpanded) {
                    hideScrollbarWhileSectionsAnimate()
                    setIsFavoritesExpanded(false)
                  } else {
                    expandFavoritesSection()
                  }
                }}
                className={cn(
                  'relative z-10 mx-2 flex w-[calc(100%-1rem)] items-center justify-between rounded-lg border bg-surface-sidebar px-4 py-3 text-sm text-content-secondary transition-colors hover:border-border-subtle hover:text-content-primary',
                  isFavoritesExpanded
                    ? 'border-border-subtle'
                    : 'border-transparent',
                  isFavoriteDropTarget &&
                    (isDarkMode
                      ? 'border-white/30 bg-white/10'
                      : 'border-gray-400 bg-gray-200/50'),
                )}
              >
                <span className="flex items-center gap-2">
                  <PiPushPin className="h-4 w-4" aria-hidden="true" />
                  <span
                    role="heading"
                    aria-level={2}
                    className="font-aeonik font-medium"
                  >
                    Favorites
                  </span>
                </span>
                {isFavoritesExpanded ? (
                  <ChevronDownIcon className="h-4 w-4" />
                ) : (
                  <ChevronRightIcon className="h-4 w-4" />
                )}
              </button>
              <AnimatePresence initial={false}>
                {isFavoritesExpanded && (
                  <motion.div
                    id={FAVORITES_PANEL_ID}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      duration: CONSTANTS.SIDEBAR_SECTION_ANIMATION_S,
                      ease: 'easeInOut',
                    }}
                    className={cn(
                      '-mt-3 overflow-hidden rounded-t-lg pt-3',
                      expandedPanelClass,
                    )}
                  >
                    {favoriteChats.length > 0 ? (
                      <ChatList
                        chats={favoriteChats}
                        currentChatId={currentChat?.id}
                        isDarkMode={isDarkMode}
                        pixelateSidebarChatTitles={pixelateSidebarChatTitles}
                        getChatHref={(chat) =>
                          getChatPath(chat.id, { projectId: chat.projectId })
                        }
                        onSelectChat={(chatId) => {
                          const favorite = favoriteChats.find(
                            (chat) => chat.id === chatId,
                          )
                          if (favorite) void onOpenFavorite?.(favorite)
                        }}
                        onUpdateTitle={updateChatTitle}
                        onDeleteChat={deleteChat}
                        isDraggable={Boolean(onRemoveFavorite)}
                        onDragStart={(chatId) =>
                          setDraggingChat(chatId, null, 'favorites')
                        }
                        onDragEnd={clearDragState}
                        pinnedChatIds={pinnedChatIds}
                        showPinnedIndicators={false}
                        onTogglePin={onToggleFavorite}
                      />
                    ) : (
                      <p className="px-4 pb-3 font-aeonik-fono text-xs text-content-muted">
                        Pin chats for quick access.
                      </p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}

          {/* Projects dropdown - show for premium users. */}
          {hasPinnedProjectsHeader && (
            <>
              <div
                className="sticky top-0 z-30 flex-none bg-surface-sidebar px-2"
                style={{ paddingTop: `${CONSTANTS.SIDEBAR_SECTION_GAP_PX}px` }}
              >
                {isProjectsExpanded && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-3 rounded-t-lg bg-surface-sidebar-panel"
                  />
                )}
                <button
                  type="button"
                  aria-expanded={isProjectsExpanded}
                  onClick={() => {
                    if (isProjectsExpanded) {
                      hideScrollbarWhileSectionsAnimate()
                      setIsProjectsExpanded(false)
                    } else {
                      expandProjectsSection()
                    }
                  }}
                  onDragOver={(e) => {
                    if (
                      e.dataTransfer.types.includes('application/x-chat-id') &&
                      cloudSyncEnabled
                    ) {
                      e.preventDefault()
                      if (draggingChatSource !== 'favorites') {
                        e.dataTransfer.dropEffect = 'move'
                        setIsDropTargetProjectsHeader(true)
                      }
                    }
                  }}
                  onDragEnter={(e) => {
                    if (
                      e.dataTransfer.types.includes('application/x-chat-id') &&
                      cloudSyncEnabled
                    ) {
                      e.preventDefault()
                      if (draggingChatSource !== 'favorites') {
                        setIsDropTargetProjectsHeader(true)
                        if (!isProjectsExpanded) {
                          expandProjectsSection()
                        }
                      }
                    }
                  }}
                  onDragLeave={() => {
                    setIsDropTargetProjectsHeader(false)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const chatId = e.dataTransfer.getData(
                      'application/x-chat-id',
                    )
                    if (chatId) {
                      consumeFavoriteDrop({
                        source: draggingChatSource,
                        chatId,
                        pinnedChatIds,
                        onRemoveFavorite,
                      })
                    }
                    setIsDropTargetProjectsHeader(false)
                    clearDragState()
                  }}
                  style={{
                    height: `${CONSTANTS.SIDEBAR_PINNED_HEADER_OFFSET_PX}px`,
                  }}
                  className={cn(
                    'relative z-10 flex w-full cursor-pointer items-center justify-between rounded-lg border bg-surface-sidebar px-4 text-sm transition-colors hover:border-border-subtle',
                    isProjectsExpanded
                      ? 'border-border-subtle'
                      : 'border-transparent',
                    isDropTargetProjectsHeader
                      ? isDarkMode
                        ? 'border border-white/30 bg-white/10'
                        : 'border border-gray-400 bg-gray-200/30'
                      : isProjectMode
                        ? isDarkMode
                          ? 'text-brand-accent-light'
                          : 'text-brand-accent-dark'
                        : 'text-content-secondary',
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
                  <span className="flex items-center gap-1">
                    {isProjectsExpanded ? (
                      <ChevronDownIcon className="h-4 w-4" />
                    ) : (
                      <ChevronRightIcon className="h-4 w-4" />
                    )}
                  </span>
                </button>
              </div>

              {/* Expanded projects list. flex-none matters here too: this
                  panel is a direct child of the flex-col scroll container,
                  and overflow-hidden (required by the height animation)
                  would otherwise clip the list when flexbox shrinks it to
                  the viewport instead of letting the sidebar scroll. */}
              <AnimatePresence initial={false}>
                {isProjectsExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      duration: CONSTANTS.SIDEBAR_SECTION_ANIMATION_S,
                      ease: 'easeInOut',
                    }}
                    className={cn(
                      '-mt-3 flex-none overflow-hidden rounded-t-lg pt-3',
                      expandedPanelClass,
                    )}
                  >
                    <div className="space-y-1 px-2 py-2">
                      {/* Cloud sync disabled message */}
                      {!cloudSyncEnabled ? (
                        <div className="px-3 py-2">
                          <p className="text-xs text-content-muted">
                            The projects feature requires end-to-end encrypted
                            cloud sync to be enabled on this device.
                          </p>
                          <button
                            onClick={openCloudSyncSetup}
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
                              {projects.map((project) => {
                                const projectContent = (
                                  <>
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
                                          'truncate font-aeonik-fono text-sm font-medium leading-5',
                                          project.decryptionFailed
                                            ? 'text-orange-500'
                                            : 'text-content-primary',
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
                                        type="button"
                                        onClick={async () => {
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
                                        aria-label="Delete encrypted project"
                                        title="Delete encrypted project"
                                      >
                                        {deletingProjectId === project.id ? (
                                          <PiSpinner className="h-4 w-4 animate-spin" />
                                        ) : (
                                          <TrashIcon className="h-4 w-4" />
                                        )}
                                      </button>
                                    )}
                                  </>
                                )
                                const projectClassName = cn(
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
                                )
                                const projectDragHandlers = {
                                  onDragOver: (
                                    e: React.DragEvent<HTMLElement>,
                                  ) => {
                                    if (
                                      e.dataTransfer.types.includes(
                                        'application/x-chat-id',
                                      ) &&
                                      !project.decryptionFailed
                                    ) {
                                      e.preventDefault()
                                      if (draggingChatSource !== 'favorites') {
                                        e.dataTransfer.dropEffect = 'move'
                                        setDropTargetProject(project.id)
                                      }
                                    }
                                  },
                                  onDragEnter: (
                                    e: React.DragEvent<HTMLElement>,
                                  ) => {
                                    if (
                                      e.dataTransfer.types.includes(
                                        'application/x-chat-id',
                                      ) &&
                                      !project.decryptionFailed
                                    ) {
                                      e.preventDefault()
                                      if (draggingChatSource !== 'favorites') {
                                        setDropTargetProject(project.id)
                                        if (projectHoverTimerRef.current) {
                                          clearTimeout(
                                            projectHoverTimerRef.current,
                                          )
                                        }
                                        projectHoverTimerRef.current =
                                          setTimeout(() => {
                                            onEnterProject?.(
                                              project.id,
                                              project.name,
                                            )
                                          }, 400)
                                      }
                                    }
                                  },
                                  onDragLeave: (
                                    e: React.DragEvent<HTMLElement>,
                                  ) => {
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
                                  },
                                  onDrop: async (
                                    e: React.DragEvent<HTMLElement>,
                                  ) => {
                                    e.preventDefault()
                                    if (projectHoverTimerRef.current) {
                                      clearTimeout(projectHoverTimerRef.current)
                                      projectHoverTimerRef.current = null
                                    }
                                    const chatId = e.dataTransfer.getData(
                                      'application/x-chat-id',
                                    )
                                    const favoriteDropConsumed = chatId
                                      ? consumeFavoriteDrop({
                                          source: draggingChatSource,
                                          chatId,
                                          pinnedChatIds,
                                          onRemoveFavorite,
                                        })
                                      : false
                                    if (
                                      !favoriteDropConsumed &&
                                      chatId &&
                                      onMoveChatToProject &&
                                      !project.decryptionFailed
                                    ) {
                                      await onMoveChatToProject(
                                        chatId,
                                        project.id,
                                      )
                                    }
                                    clearDragState()
                                  },
                                }

                                if (project.decryptionFailed) {
                                  return (
                                    <div
                                      key={project.id}
                                      className={projectClassName}
                                    >
                                      {projectContent}
                                    </div>
                                  )
                                }

                                return (
                                  <Link
                                    key={project.id}
                                    href={getNewChatPath({
                                      projectId: project.id,
                                    })}
                                    prefetch={false}
                                    draggable={false}
                                    onClick={(e) => {
                                      if (
                                        !isPlainPrimaryClick(e) ||
                                        !onEnterProject
                                      )
                                        return
                                      e.preventDefault()
                                      void onEnterProject(
                                        project.id,
                                        project.name,
                                      )
                                    }}
                                    className={projectClassName}
                                    {...projectDragHandlers}
                                  >
                                    {projectContent}
                                  </Link>
                                )
                              })}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}

          {/* Chats section. Like Projects, header and content sit directly
              in the scroll container; the header pins below the Projects
              header while the chat list scrolls. */}
          <div
            className={cn(
              'relative isolate z-10 flex flex-col',
              // When expanded the section takes the rest of the sidebar and
              // the list scrolls inside it, so the header, tabs, and note
              // never move. Collapsed, it just takes its natural height.
              isChatHistoryExpanded ? 'min-h-0 flex-1' : 'flex-none',
            )}
          >
            <div
              className="relative z-30 flex-none px-2"
              style={{ paddingTop: `${CONSTANTS.SIDEBAR_SECTION_GAP_PX}px` }}
            >
              <div
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
                    if (
                      !isChatHistoryExpanded &&
                      draggingChatSource !== 'favorites'
                    ) {
                      expandChatsSection()
                    }
                  }
                }}
                onDragLeave={() => {
                  setDropTargetChatHistory(false)
                }}
                onDrop={async (e) => {
                  e.preventDefault()
                  const chatId = e.dataTransfer.getData('application/x-chat-id')
                  const favoriteDropConsumed = chatId
                    ? consumeFavoriteDrop({
                        source: draggingChatSource,
                        chatId,
                        pinnedChatIds,
                        onRemoveFavorite,
                      })
                    : false
                  if (
                    !favoriteDropConsumed &&
                    chatId &&
                    onRemoveChatFromProject
                  ) {
                    await onRemoveChatFromProject(chatId)
                  }
                  clearDragState()
                }}
                className={cn(
                  'relative flex w-full items-center rounded-lg border bg-surface-sidebar text-sm transition-colors hover:border-border-subtle',
                  isChatHistoryExpanded
                    ? 'border-border-subtle'
                    : 'border-transparent',
                  isDropTargetChatHistory
                    ? isDarkMode
                      ? 'border border-white/30 bg-white/10'
                      : 'border border-gray-400 bg-gray-200/30'
                    : 'text-content-secondary',
                )}
                style={{
                  height: `${CONSTANTS.SIDEBAR_PINNED_HEADER_OFFSET_PX}px`,
                }}
              >
                <button
                  type="button"
                  aria-expanded={isChatHistoryExpanded}
                  onClick={() => {
                    if (isChatHistoryExpanded) {
                      hideScrollbarWhileSectionsAnimate()
                      setIsChatHistoryExpanded(false)
                    } else {
                      expandChatsSection()
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between py-3 pl-4 pr-4 text-left"
                >
                  <span className="flex items-center gap-2">
                    <IoChatbubblesOutline className="h-4 w-4" />
                    <span className="truncate font-aeonik font-medium">
                      Chats
                    </span>
                  </span>
                  {isChatHistoryExpanded ? (
                    <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
                {onSearchClick && (
                  <div className="group absolute right-10 top-1/2 z-10 flex -translate-y-1/2 items-center">
                    <button
                      type="button"
                      onClick={onSearchClick}
                      aria-label="Search chats"
                      className="rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-chat hover:text-content-primary"
                    >
                      <MagnifyingGlassIcon
                        className="h-4 w-4"
                        aria-hidden="true"
                      />
                    </button>
                    <span className="pointer-events-none absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                      Search{' '}
                      <span className="text-content-muted">{modKey}K</span>
                    </span>
                  </div>
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
                  transition={{
                    duration: CONSTANTS.SIDEBAR_SECTION_ANIMATION_S,
                    ease: 'easeInOut',
                  }}
                  className={cn(
                    // The -mt-3 tucks the panel's rounded top under the
                    // header card above.
                    'relative z-20 -mt-3 flex-none overflow-hidden rounded-t-lg border-b border-border-subtle',
                    expandedPanelClass,
                  )}
                >
                  <div className="pt-3">
                    {/* Tabs for Cloud/Local chats - show when signed in, cloud sync enabled, and local-only mode enabled */}
                    {isSignedIn && cloudSyncEnabled && localOnlyModeEnabled && (
                      <div
                        className="mx-4 mt-4 flex gap-2"
                        role="tablist"
                        aria-label="Chat storage"
                      >
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
                              if (draggingChatSource !== 'favorites') {
                                e.dataTransfer.dropEffect = 'move'
                                setDropTargetTab('cloud')
                              }
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
                              if (draggingChatSource !== 'favorites') {
                                setDropTargetTab('cloud')
                                setActiveTab('cloud')
                              }
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
                              const favoriteDropConsumed = consumeFavoriteDrop({
                                source: draggingChatSource,
                                chatId,
                                pinnedChatIds,
                                onRemoveFavorite,
                              })
                              if (
                                !favoriteDropConsumed &&
                                draggingChatFromProjectId &&
                                onRemoveChatFromProject
                              ) {
                                // Chat from project is already cloud, just remove from project
                                await onRemoveChatFromProject(chatId)
                              } else if (
                                !favoriteDropConsumed &&
                                onConvertChatToCloud
                              ) {
                                // Only convert if dragging from local (not from project)
                                await onConvertChatToCloud(chatId)
                              }
                            }
                            clearDragState()
                          }}
                          className={cn(
                            STORAGE_TAB_CLASS_NAME,
                            activeTab === 'cloud'
                              ? STORAGE_TAB_ACTIVE_CLASS_NAME
                              : STORAGE_TAB_INACTIVE_CLASS_NAME,
                            dropTargetTab === 'cloud' &&
                              STORAGE_TAB_DROP_TARGET_CLASS_NAME,
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
                              if (draggingChatSource !== 'favorites') {
                                e.dataTransfer.dropEffect = 'move'
                                setDropTargetTab('local')
                              }
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
                              if (draggingChatSource !== 'favorites') {
                                setActiveTab('local')
                                setDropTargetTab('local')
                              }
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
                            const favoriteDropConsumed = chatId
                              ? consumeFavoriteDrop({
                                  source: draggingChatSource,
                                  chatId,
                                  pinnedChatIds,
                                  onRemoveFavorite,
                                })
                              : false
                            if (
                              !favoriteDropConsumed &&
                              chatId &&
                              onConvertChatToLocal
                            ) {
                              // convertChatToLocal also clears projectId
                              await onConvertChatToLocal(chatId)
                            }
                            clearDragState()
                          }}
                          className={cn(
                            STORAGE_TAB_CLASS_NAME,
                            activeTab === 'local'
                              ? STORAGE_TAB_ACTIVE_CLASS_NAME
                              : STORAGE_TAB_INACTIVE_CLASS_NAME,
                            dropTargetTab === 'local' &&
                              STORAGE_TAB_DROP_TARGET_CLASS_NAME,
                          )}
                        >
                          <CiFloppyDisk className="h-3.5 w-3.5" />
                          Local
                        </button>
                      </div>
                    )}

                    {/* Description text - show when NOT displaying the cloud sync box */}
                    {(!isSignedIn || cloudSyncEnabled) && (
                      <div className="font-base mx-4 min-h-[36px] pb-3 pt-3 font-aeonik-fono text-xs text-content-muted">
                        {!isSignedIn ? (
                          'Your chats are stored temporarily in this browser tab. Create an account for persistent storage.'
                        ) : localOnlyModeEnabled && activeTab === 'local' ? (
                          "Local chats are stored only on this device and won't sync across devices."
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-expanded={isEncryptionNoteExpanded}
                              aria-controls={ENCRYPTION_NOTE_ID}
                              onClick={() =>
                                setIsEncryptionNoteExpanded((open) => !open)
                              }
                              className="flex w-full items-center gap-2 text-left transition-colors hover:text-content-secondary"
                            >
                              <FaLock
                                className="h-3 w-3 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="flex-1">
                                Your chats are end-to-end encrypted.
                              </span>
                              <ChevronDownIcon
                                className={cn(
                                  'h-3.5 w-3.5 shrink-0 transition-transform',
                                  isEncryptionNoteExpanded && 'rotate-180',
                                )}
                                aria-hidden="true"
                              />
                            </button>
                            <AnimatePresence initial={false}>
                              {isEncryptionNoteExpanded && (
                                <motion.p
                                  id={ENCRYPTION_NOTE_ID}
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={{
                                    duration:
                                      CONSTANTS.SIDEBAR_SECTION_ANIMATION_S,
                                    ease: 'easeInOut',
                                  }}
                                  className="overflow-hidden pl-5"
                                >
                                  <span className="block pt-1.5">
                                    Your chats are synced to the cloud. The
                                    encryption key is only stored on this
                                    browser and never sent to Tinfoil.
                                  </span>
                                </motion.p>
                              )}
                            </AnimatePresence>
                          </>
                        )}
                      </div>
                    )}

                    {/* Cloud Sync Setup - show when signed in and cloud sync is OFF */}
                    {isSignedIn && !cloudSyncEnabled && (
                      <div className="px-3 py-2">
                        <p className="text-xs text-content-muted">
                          Chats are only stored locally on this device. Set up
                          end-to-end encrypted cloud sync to back up and access
                          your data across multiple devices.
                        </p>
                        <button
                          onClick={openCloudSyncSetup}
                          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-chat px-3 py-2 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat/80"
                        >
                          <CloudIcon className="h-3.5 w-3.5" />
                          Enable Cloud Sync
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Chat List - flows within the unified sidebar scroll area */}
            <AnimatePresence initial={false}>
              {isChatHistoryExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{
                    duration: CONSTANTS.SIDEBAR_SECTION_ANIMATION_S,
                    ease: 'easeInOut',
                  }}
                  className={cn(
                    'relative isolate z-0 flex min-h-0 flex-1 flex-col overflow-hidden',
                    expandedPanelClass,
                  )}
                >
                  <div
                    id="chat-storage-panel"
                    role="tabpanel"
                    aria-labelledby={
                      activeTab === 'cloud'
                        ? 'chat-cloud-tab'
                        : 'chat-local-tab'
                    }
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
                        const favoriteDropConsumed = consumeFavoriteDrop({
                          source: draggingChatSource,
                          chatId,
                          pinnedChatIds,
                          onRemoveFavorite,
                        })
                        if (
                          !favoriteDropConsumed &&
                          draggingChatFromProjectId
                        ) {
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
                      'relative z-10 min-h-0 flex-1 overflow-y-auto',
                      hideScrollbarDuringAnimation && 'scrollbar-hide',
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
                        pixelateSidebarChatTitles={pixelateSidebarChatTitles}
                        showEncryptionStatus={true}
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
                        getChatHref={(chat) =>
                          chat.isBlankChat
                            ? getNewChatPath({
                                isLocalOnly: chat.isLocalOnly,
                              })
                            : getChatPath(chat.id, {
                                isLocalOnly: chat.isLocalOnly,
                              })
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
                        pinnedChatIds={pinnedChatIds}
                        onTogglePin={onToggleFavorite}
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
                            {shouldShowLoadMore && (
                              <div className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => void loadMoreChats()}
                                  disabled={isLoadingMore || pendingChatsRender}
                                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-sidebar px-3 py-2 text-xs font-medium text-content-secondary transition-colors hover:border-border-strong hover:text-content-primary disabled:cursor-wait disabled:opacity-60"
                                >
                                  {(isLoadingMore || pendingChatsRender) && (
                                    <PiSpinner className="h-3.5 w-3.5 animate-spin" />
                                  )}
                                  {isLoadingMore || pendingChatsRender
                                    ? 'Loading chats...'
                                    : 'Load more chats'}
                                </button>
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
          </div>
        </div>

        {/* App Store button for iOS users - pinned below the scroll area */}
        {isClient && isIOS && !nativeAppDismissed && (
          <div className="relative z-10 flex-none border-t border-border-subtle p-3">
            <button
              type="button"
              onClick={() => {
                setNativeAppDismissed(true)
                try {
                  localStorage.setItem(USER_PREFS_NATIVE_APP_DISMISSED, 'true')
                } catch {}
              }}
              aria-label="Dismiss"
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-content-muted transition-colors hover:text-content-primary"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
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

        {/* Account menu: settings, sync, help. Pinned below the scroll area. */}
        <div className="relative z-10 mt-auto flex-none border-t border-border-subtle bg-surface-sidebar p-2">
          <SidebarAccountMenu
            isSidebarOpen={isOpen}
            isSignedIn={Boolean(isSignedIn)}
            isPremium={Boolean(isPremium)}
            isDarkMode={isDarkMode}
            canSync={Boolean(isSignedIn && cloudSyncEnabled)}
            isSyncing={isSyncing}
            syncFailed={syncFailed}
            syncNeedsAttention={syncNeedsAttention}
            onSync={onManualSync}
            onOpenSettings={(tab) => onSettingsClick?.(tab)}
            onReportBug={() => onReportBugClick?.()}
          />
        </div>
      </SidebarPanel>

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
