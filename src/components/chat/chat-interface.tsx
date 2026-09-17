import {
  findSelectableModel,
  getAIModels,
  getCachedAIModels,
  getCachedSystemPromptAndRules,
  getReasoningHistoryPolicy,
  getResolvedModelContextWindowTokens,
  getSelectedModelLabel,
  getSystemPromptAndRules,
  resolveModelSelection,
  type BaseModel,
} from '@/config/models'
import { DEFAULT_CHAT_TITLE, TEMPORARY_CHAT_TITLE } from '@/constants/chat'
import { REQUEST_UPGRADE_EVENT } from '@/constants/chat-events'
import { PIXELATE_SIDEBAR_CHAT_TITLES_CHANGED_EVENT } from '@/constants/settings-events'
import {
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_GENUI_ENABLED,
  SETTINGS_HAS_SEEN_ONBOARDING,
  SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO,
  SETTINGS_PII_CHECK_ENABLED,
  SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED,
  SETTINGS_WEB_SEARCH_AVAILABLE,
  UI_EXPAND_PROJECT_DOCUMENTS,
} from '@/constants/storage-keys'
import {
  useChatRecoveryActiveTurnIds,
  useChatRecoveryDrafts,
} from '@/hooks/use-chat-recovery-drafts'
import { useChatRouter } from '@/hooks/use-chat-router'
import { useProjects } from '@/hooks/use-projects'
import { useRateLimit } from '@/hooks/use-rate-limit'
import { useSafeguardsLoader } from '@/hooks/use-safeguards'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { useSyncHealthAttention } from '@/hooks/use-sync-health'
import { useToast } from '@/hooks/use-toast'
import { isChatRecoveryActive } from '@/services/inference/chat-recovery-drafts'
import {
  getRateLimitInfo,
  getSessionToken,
  invalidateSessionCache,
} from '@/services/inference/tinfoil-client'
import { generateTitle, getTitleContent } from '@/services/inference/title'
import { useAuth, useUser } from '@clerk/nextjs'
import {
  ArrowDownIcon,
  ChatBubbleLeftRightIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import Link from 'next/link'
import { BiSolidLock, BiSolidLockOpen } from 'react-icons/bi'
import { GoSidebarCollapse } from 'react-icons/go'
import { IoShareOutline } from 'react-icons/io5'
import { PiFilePlusLight, PiNotePencilLight, PiSpinner } from 'react-icons/pi'
import { SlGhost } from 'react-icons/sl'
import { getMessageImages } from './attachment-helpers'

import {
  RateLimitBanner,
  shouldShowRateLimitBanner,
} from '@/components/chat/rate-limit-banner'
import { StreamErrorBanner } from '@/components/chat/stream-error-banner'
import { classifyCloudKeySetupError } from '@/components/modals/cloud-sync-setup-mode'
import {
  ProjectModeIndicator,
  ProjectSidebar,
  useProject,
  useProjectSystemPrompt,
} from '@/components/project'
import { GridTexture } from '@/components/ui/grid-texture'
import { LogoLoading } from '@/components/ui/logo-loading'
import { cn } from '@/components/ui/utils'
import { CLOUD_SYNC } from '@/config'
import { useCloudSync } from '@/hooks/use-cloud-sync'
import { usePasskeyBackup } from '@/hooks/use-passkey-backup'
import { usePinnedChats } from '@/hooks/use-pinned-chats'
import { useProfileSync } from '@/hooks/use-profile-sync'
import { runManualCloudSync } from '@/services/cloud/manual-cloud-sync'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import { hydratePinnedChatById } from '@/services/storage/pinned-chat-hydration'
import {
  canRequestChatPin,
  isResolvedFavoriteChat,
} from '@/services/storage/pinned-chats'

import { cloudSync, SyncInProgressError } from '@/services/cloud/cloud-sync'
import { encryptionService } from '@/services/encryption/encryption-service'
import { generateCodeExecutionAccessToken } from '@/services/exec-snapshot/access-token'
import { isPrfSupported, PrfNotSupportedError } from '@/services/passkey'
import { chatEvents } from '@/services/storage/chat-events'
import { chatStorage } from '@/services/storage/chat-storage'
import {
  INDEXED_DB_UPGRADE_BLOCKED_EVENT,
  isIndexedDBUpgradeBlocked,
} from '@/services/storage/indexed-db'
import { sessionChatStorage } from '@/services/storage/session-storage'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  isCloudSyncEnabled,
  setCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { isProbablyTextFile, isSupportedFile } from '@/utils/file-types'
import { getNewChatPath, isPlainPrimaryClick } from '@/utils/navigation'
import {
  PERFORMANCE_METRICS,
  recordPerformanceDuration,
  startPerformanceTimer,
} from '@/utils/performance-metrics'
import {
  estimateMessageTokens,
  estimateTokenCount,
  findContextStartIndex,
  getContextTokenBudget,
  getHistoryTokenBudget,
} from '@/utils/token-estimation'
import { TfTinSad } from '@tinfoilsh/tinfoil-icons'
import dynamic from 'next/dynamic'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { SubscribePromptModal } from '../modals/subscribe-prompt-modal'
import { UrlHashMessageHandler } from '../url-hash-message-handler'
import { UrlHashSettingsHandler } from '../url-hash-settings-handler'
import { ArtifactSidebar } from './artifact-sidebar'
import { AskSidebar } from './ask-sidebar'
import { ChatAnnouncer } from './chat-announcer'
import { ChatInput } from './chat-input'
import { ChatMessages } from './chat-messages'
import {
  getChatContentBottomScrollTop,
  getChatSpacerHeight,
  getDistanceFromChatContentBottom,
} from './chat-scroll'
import { ChatSidebar } from './chat-sidebar'
import { PromptPresetSuggestions } from './components/prompt-preset-suggestions'
import { CONSTANTS } from './constants'
import { getDocumentTextContent } from './document-content'
import { useDocumentUploader } from './document-uploader'
import { DragProvider } from './drag-context'
import { openFavoriteChat } from './favorite-navigation'
import {
  resolveProjectUploadTarget,
  routeChatFileUpload,
} from './file-upload-routing'
import { GenUIInputAreaRenderer } from './genui/GenUIInputAreaRenderer'
import { selectPendingInputToolCallFromChat } from './genui/pending-input-tool-call'
import {
  artifactPreviewTargetsEqual,
  OPEN_ARTIFACT_PREVIEW_EVENT,
  type ArtifactPreviewSidebarDetail,
  type ArtifactPreviewSidebarEventDetail,
} from './genui/widgets/ArtifactPreview'
import {
  canToggleTemporaryChat,
  createTemporaryChat,
  resolveWebSearchEnabled,
  upsertChatById,
} from './hooks/chat-operations'
import { useAutoIntelligence } from './hooks/use-auto-intelligence'
import { useBrowserTabChatTitle } from './hooks/use-browser-tab-chat-title'
import { useChatState } from './hooks/use-chat-state'
import { useCustomSystemPrompt } from './hooks/use-custom-system-prompt'
import { useMessageQueue } from './hooks/use-message-queue'
import { usePromptLibrary } from './hooks/use-prompt-library'
import {
  useReasoningEffort,
  useThinkingEnabled,
} from './hooks/use-reasoning-effort'
import { useSidebarChat } from './hooks/use-sidebar-chat'
import { MessageQueue } from './message-queue'
import { getBlankQueueId } from './message-queue-identity'
import { ModelSelector } from './model-selector'
import { ModelSelectorTriggerLabel } from './model-selector-trigger-label'
import { openProjectChat } from './project-navigation'
import { QuoteSelectionPopover } from './quote-selection-popover'
import { initializeRenderers } from './renderers/client'
import type { ProcessedDocument } from './renderers/types'
import type { SettingsTab } from './settings-modal'
import type { Attachment, Chat, DocumentPage } from './types'
// Lazy-load modals that aren't shown on initial load. The loaders are
// hoisted so they can be pre-warmed (see preloadCloudSyncModals) before
// the user clicks, keeping the chunk fetch off the click critical path.
const loadCloudSyncSetupModal = () => import('../modals/cloud-sync-setup-modal')

function preloadCloudSyncModals(): void {
  void loadCloudSyncSetupModal()
}

const CloudSyncSetupModal = dynamic(
  () => loadCloudSyncSetupModal().then((m) => m.CloudSyncSetupModal),
  { ssr: false },
)
const AddToProjectContextModal = dynamic(
  () =>
    import('../modals/add-to-project-context-modal').then(
      (m) => m.AddToProjectContextModal,
    ),
  { ssr: false },
)
// Lazy-load heavy, non-critical UI to reduce initial bundle and speed up FCP
const VerifierSidebarLazy = dynamic(
  () => import('../verification-sidebar').then((m) => m.VerifierSidebar),
  { ssr: false },
)
const SettingsModalLazy = dynamic(
  () => import('./settings-modal').then((m) => m.SettingsModal),
  { ssr: false },
)
const ShareModalLazy = dynamic(
  () => import('./share-modal').then((m) => m.ShareModal),
  { ssr: false },
)
const PromptLibraryModalLazy = dynamic(
  () => import('./prompt-library-modal').then((m) => m.PromptLibraryModal),
  { ssr: false },
)

const OnboardingView = dynamic(
  () => import('../onboarding/onboarding-view').then((m) => m.OnboardingView),
  { ssr: false },
)

type ChatInterfaceProps = {
  verificationState?: any
  showVerifyButton?: boolean
  minHeight?: string
  inputMinHeight?: string
  isDarkMode?: boolean
  initialChatId?: string | null
  initialProjectId?: string | null
  isLocalChatUrl?: boolean
  initialNewChatIsLocalOnly?: boolean
  /**
   * When true, suppresses auto-opening intro/setup modals on this mount
   * (onboarding, passkey setup/recovery prompts, cloud sync setup, and the
   * "passkey setup failed" warning). Used by routes like /newchat where the
   * user explicitly wants to start chatting without interruptions. The user
   * can still open these flows manually from settings.
   */
  suppressIntroModals?: boolean
}

function buildAttachment(opts: {
  id: string
  fileName: string
  imageData?: { base64: string; mimeType: string; thumbnailBase64?: string }
  textContent?: string
  description?: string
  pages?: DocumentPage[]
}): Attachment | undefined {
  if (opts.imageData) {
    return {
      id: opts.id,
      type: 'image',
      fileName: opts.fileName,
      mimeType: opts.imageData.mimeType,
      base64: opts.imageData.base64,
      thumbnailBase64: opts.imageData.thumbnailBase64,
      description: opts.description ?? opts.fileName,
    }
  }
  // Synthesize textContent from pages when the document was uploaded in
  // images mode and md_content is missing, so consumers that filter on
  // textContent (share, preview) still see the document.
  const textContent =
    getDocumentTextContent(opts.textContent ?? '', opts.pages) ?? undefined
  if (textContent || opts.pages?.length) {
    return {
      id: opts.id,
      type: 'document',
      fileName: opts.fileName,
      textContent: textContent || undefined,
      pages: opts.pages,
    }
  }
  return undefined
}

function buildCompletedAttachments(
  documents: ProcessedDocument[],
): Attachment[] {
  return documents
    .filter(
      (document) =>
        !document.isUploading &&
        !document.isGeneratingDescription &&
        !document.isUnsupported &&
        (!document.isImageDescription ||
          document.imageData ||
          document.attachment),
    )
    .map((document) => {
      if (document.attachment) return document.attachment
      return (
        buildAttachment({
          id: document.id,
          fileName: document.name,
          imageData: document.imageData ?? undefined,
          textContent: document.content ?? undefined,
          description:
            document.isImageDescription && document.content
              ? document.content
              : undefined,
        }) ?? {
          id: document.id,
          type: 'document' as const,
          fileName: document.name,
        }
      )
    })
}

export function ChatInterface({
  verificationState,
  minHeight,
  inputMinHeight = '28px',
  isDarkMode: propIsDarkMode,
  initialChatId,
  initialProjectId,
  isLocalChatUrl: isLocalChatUrlProp,
  initialNewChatIsLocalOnly = false,
  suppressIntroModals = false,
}: ChatInterfaceProps) {
  const { toast } = useToast()
  const router = useRouter()
  const indexedDBBlockedToastShownRef = useRef(false)

  useEffect(() => {
    const showUpgradeBlockedToast = () => {
      if (indexedDBBlockedToastShownRef.current) return
      indexedDBBlockedToastShownRef.current = true
      toast({
        title: 'Local cache upgrade blocked',
        description:
          'Close other Tinfoil tabs, then reload this page to enable local project caching.',
        variant: 'destructive',
      })
    }

    if (isIndexedDBUpgradeBlocked()) showUpgradeBlockedToast()
    window.addEventListener(
      INDEXED_DB_UPGRADE_BLOCKED_EVENT,
      showUpgradeBlockedToast,
    )
    return () =>
      window.removeEventListener(
        INDEXED_DB_UPGRADE_BLOCKED_EVENT,
        showUpgradeBlockedToast,
      )
  }, [toast])
  const { isSignedIn, isLoaded: isAuthLoaded, userId: authUserId } = useAuth()
  const [authRestorationStartedAt] = useState(startPerformanceTimer)
  useEffect(() => {
    if (isAuthLoaded) {
      recordPerformanceDuration(
        PERFORMANCE_METRICS.AUTH_RESTORATION,
        authRestorationStartedAt,
      )
    }
  }, [authRestorationStartedAt, isAuthLoaded])
  // TODO: unflip this
  const canUseCodeExecution = false
  const { user } = useUser()
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const rateLimit = useRateLimit()
  const [isSubscribePromptOpen, setIsSubscribePromptOpen] = useState(false)

  // Onboarding state (must be defined before usePasskeyBackup so we can gate it)
  const [showOnboarding, setShowOnboarding] = useState(false)

  // Signed-in users never see the first-open onboarding: anyone missing the
  // account flag is auto-tagged. This grandfathers accounts that predate the
  // flow and carries the localStorage flag over when an anonymous visitor who
  // already saw it signs in. The flag is also mirrored to localStorage so it
  // survives signing out on this device.
  useEffect(() => {
    if (!isSignedIn || !user) return
    localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
    if (!user.unsafeMetadata?.has_completed_onboarding) {
      user
        .update({
          unsafeMetadata: {
            ...user.unsafeMetadata,
            has_completed_onboarding: true,
          },
        })
        .catch((error) => {
          logError('Failed to backfill onboarding completion flag', error, {
            component: 'ChatInterface',
            action: 'backfillOnboardingFlag',
          })
        })
    }
  }, [isSignedIn, user])

  // iOS Safari keyboard fix: keep a CSS var in sync with the *visual* viewport height.
  // Without this, fixed full-screen layouts can leave an untouchable "dead zone"
  // after the keyboard is dismissed.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const root = document.documentElement
    const vv = window.visualViewport

    const update = () => {
      const height = vv?.height ?? window.innerHeight
      root.style.setProperty('--app-height', `${Math.round(height)}px`)
    }

    update()

    window.addEventListener('orientationchange', update)
    if (vv) {
      vv.addEventListener('resize', update)
      vv.addEventListener('scroll', update)
      return () => {
        window.removeEventListener('orientationchange', update)
        vv.removeEventListener('resize', update)
        vv.removeEventListener('scroll', update)
      }
    }

    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('orientationchange', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  // Track whether we've loaded the initial chat from URL (to prevent URL flickering)
  const initialUrlChatLoadedRef = useRef(false)
  const { isLoading: isSubscriptionLoading, chat_subscription_active } =
    useSubscriptionStatus()

  // Initialize cloud sync and passkey backup as two separate hooks.
  // usePasskeyBackup depends on useCloudSync's `initialized` and `encryptionKey`,
  // and bridges key changes back via onEncryptionKeyRecovered / updatePasskeyBackup.
  // Ref bridges the forward dependency: useCloudSync needs updatePasskeyBackup (from
  // usePasskeyBackup), which is defined after useCloudSync returns.
  const updatePasskeyBackupRef = useRef<(() => Promise<void>) | null>(null)

  const {
    syncing,
    lastSyncFailed,
    syncChats,
    smartSyncChats,
    encryptionKey,
    initialized: cloudSyncInitialized,
    setEncryptionKey,
    retryDecryptionWithNewKey,
    decryptionProgress,
  } = useCloudSync({
    onKeyChanged: () => {
      void updatePasskeyBackupRef.current?.()
    },
  })
  const [chatPagination, setChatPagination] = useState<{
    isReady: boolean
    userId?: string
  }>({ isReady: false })
  const [cloudSyncSettingEnabled, setCloudSyncSettingEnabled] =
    useState(isCloudSyncEnabled)

  useEffect(() => {
    const handleCloudSyncSettingChange = () => {
      setCloudSyncSettingEnabled(isCloudSyncEnabled())
    }
    window.addEventListener(
      CLOUD_SYNC_SETTING_CHANGED_EVENT,
      handleCloudSyncSettingChange,
    )
    window.addEventListener('storage', handleCloudSyncSettingChange)
    handleCloudSyncSettingChange()
    return () => {
      window.removeEventListener(
        CLOUD_SYNC_SETTING_CHANGED_EVENT,
        handleCloudSyncSettingChange,
      )
      window.removeEventListener('storage', handleCloudSyncSettingChange)
    }
  }, [])

  const {
    passkeyActive,
    passkeyRecoveryNeeded,
    manualRecoveryNeeded,
    passkeySetupAvailable,
    passkeyAddDeviceAvailable,
    passkeySetupFailed,
    passkeyRecoveryFailure,
    passkeyFirstTimePromptAvailable,
    setupPasskey,
    setupFirstTimePasskey,
    showFirstTimePasskeyPrompt,
    showPasskeyRecoveryPrompt,
    dismissFirstTimePasskeyPrompt,
    recoverWithPasskey,
    setupNewKeySplit,
    updatePasskeyBackup,
    dismissBackupWarning,
    skipPasskeyRecovery,
    addPasskeyToThisDevice,
    refreshBundleState,
  } = usePasskeyBackup({
    encryptionKey,
    initialized: cloudSyncInitialized && !showOnboarding,
    isSignedIn,
    user,
    onEncryptionKeyRecovered: useCallback(
      (key: string) => {
        void setEncryptionKey(key, { mode: 'recoverExisting' })
      },
      [setEncryptionKey],
    ),
  })
  updatePasskeyBackupRef.current = updatePasskeyBackup

  const {
    retryDecryption: retryProfileDecryption,
    syncFromCloud: syncProfileFromCloud,
    smartSyncFromCloud: smartSyncProfileFromCloud,
    syncToCloud: syncProfileToCloud,
  } = useProfileSync()

  // State for API data
  const [models, setModels] = useState<BaseModel[]>([])
  const [systemPrompt, setSystemPrompt] = useState<string>('')
  const [rules, setRules] = useState<string>('')
  const [isLoadingConfig, setIsLoadingConfig] = useState(true)
  const [configLoadFailed, setConfigLoadFailed] = useState(false)
  const [logoAnimDone, setLogoAnimDone] = useState(false)
  const handleLogoAnimFinished = useCallback(() => {
    setLogoAnimDone(true)
  }, [])

  // Show the first-open onboarding to anonymous visitors who haven't seen
  // it. Browsers with prior activity (web search intro flag) are treated as
  // existing users and backfilled instead of being shown the flow.
  useEffect(() => {
    if (suppressIntroModals) return
    if (!isAuthLoaded || isSignedIn) return
    if (localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)) return
    if (localStorage.getItem(SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO)) {
      localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
      return
    }
    setShowOnboarding(true)
  }, [isAuthLoaded, isSignedIn, suppressIntroModals])

  // State for right sidebar
  const [isVerifierSidebarOpen, setIsVerifierSidebarOpen] = useState(false)
  const [hasMountedVerifierSidebar, setHasMountedVerifierSidebar] =
    useState(false)

  // State for settings modal
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [hasMountedSettingsModal, setHasMountedSettingsModal] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    SettingsTab | undefined
  >(undefined)
  const syncNeedsAttention = useSyncHealthAttention()
  useSafeguardsLoader()

  // State for share modal
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [hasMountedShareModal, setHasMountedShareModal] = useState(false)

  // State for cloud sync setup modal
  const [showCloudSyncSetupModal, setShowCloudSyncSetupModal] = useState(false)
  const [isCloudSyncRoutePending, setIsCloudSyncRoutePending] = useState(false)
  // Tracks the in-flight first-time passkey setup call so the modal can
  // disable its buttons while the native dialog is showing.
  const [isFirstTimePasskeySetupBusy, setIsFirstTimePasskeySetupBusy] =
    useState(false)

  useEffect(() => {
    if (suppressIntroModals) return
    // Passkey-based recovery auto-opens because remote chats need unlocking.
    // Fresh passkey setup also starts here so the cloud-sync intro is shown
    // before the dedicated passkey prompt. Manual recovery remains available
    // from the sidebar warning.
    if (passkeyRecoveryNeeded || passkeyFirstTimePromptAvailable) {
      setShowCloudSyncSetupModal(true)
    }
  }, [
    passkeyFirstTimePromptAvailable,
    passkeyRecoveryNeeded,
    suppressIntroModals,
  ])

  // State for add-to-project-context modal
  const [showAddToProjectModal, setShowAddToProjectModal] = useState(false)
  const [pendingProjectUpload, setPendingProjectUpload] = useState<{
    projectId: string
    files: File[]
  } | null>(null)

  // Quote state for highlighted text from messages
  const [quote, setQuote] = useState<string | null>(null)

  // Ask-sidebar state: a disposable side conversation seeded with highlighted
  // text. Nothing is persisted unless the user clicks "Open as chat".
  const [isAskSidebarOpen, setIsAskSidebarOpen] = useState(false)

  // Temporary chat mode: when active the current chat is replaced with an
  // ephemeral in-memory chat that is never persisted (no IndexedDB, no session
  // storage, no cloud sync). Disabling restores the previously active chat.
  // The mode is derived from currentChat.isTemporary further below, after
  // useChatState provides currentChat.
  const previousChatRef = useRef<Pick<
    Chat,
    'id' | 'isBlankChat' | 'isLocalOnly'
  > | null>(null)

  // Artifact-sidebar state — opened when a `render_artifact_preview` inline
  // card dispatches `OPEN_ARTIFACT_PREVIEW_EVENT` on the window.
  const [isArtifactSidebarOpen, setIsArtifactSidebarOpen] = useState(false)
  const [artifactSidebarWidth, setArtifactSidebarWidth] = useState<number>(
    CONSTANTS.ARTIFACT_SIDEBAR_WIDTH_PX,
  )
  const [artifactPreview, setArtifactPreview] =
    useState<ArtifactPreviewSidebarDetail | null>(null)
  const [activeArtifactToolCallId, setActiveArtifactToolCallId] = useState<
    string | null
  >(null)

  const [webSearchAvailable, setWebSearchAvailable] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = localStorage.getItem(SETTINGS_WEB_SEARCH_AVAILABLE)
    return saved === null ? true : saved === 'true'
  })

  // State for code execution toggle (persisted in localStorage, defaults to off)
  const [codeExecutionEnabled, setCodeExecutionEnabled] = useState(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem(SETTINGS_CODE_EXECUTION_ENABLED)
    return saved === null ? false : saved === 'true'
  })

  // PII check setting (controlled from settings modal, defaults to on)
  const [piiCheckEnabled, setPiiCheckEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = localStorage.getItem(SETTINGS_PII_CHECK_ENABLED)
    return saved === null ? true : saved === 'true'
  })

  const [pixelateSidebarChatTitles, setPixelateSidebarChatTitles] = useState(
    () => {
      if (typeof window === 'undefined') return true
      const saved = localStorage.getItem(
        SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED,
      )
      return saved === null ? true : saved === 'true'
    },
  )

  // Generative UI setting (controlled from settings modal, defaults to on)
  const [genUIEnabled, setGenUIEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = localStorage.getItem(SETTINGS_GENUI_ENABLED)
    return saved === null ? true : saved === 'true'
  })

  // State for tracking processed documents
  const [processedDocuments, setProcessedDocuments] = useState<
    ProcessedDocument[]
  >([])

  // State for global drag and drop overlay
  const [isGlobalDragActive, setIsGlobalDragActive] = useState(false)
  const dragCounterRef = useRef(0)

  // State for tracking verification document
  const [verificationDocument, setVerificationDocument] = useState<any>(null)
  const [verificationStatus, setVerificationStatus] = useState<
    'pending' | 'verified' | 'failed'
  >('pending')

  const userEmail = user?.primaryEmailAddress?.emailAddress || ''

  const isPremium = !isSubscriptionLoading && chat_subscription_active

  useEffect(() => {
    if (!router.isReady || router.query.upgrade !== 'projects') return
    setIsSubscribePromptOpen(true)
    void router.replace('/chat', undefined, { shallow: true })
  }, [router])

  // Load projects for move to project functionality
  const { projects } = useProjects({
    autoLoad: isSignedIn && isCloudSyncEnabled() && isPremium,
  })

  // Reasoning controls — graded effort for models that support it, on/off
  // toggle for models that expose a thinking flag. Both are persisted globally
  // (not per-model) and only surfaced for models whose reasoningConfig opts in.
  const { reasoningEffort, setReasoningEffort } = useReasoningEffort()
  const { thinkingEnabled, setThinkingEnabled } = useThinkingEnabled()
  const { autoIntelligence, setAutoIntelligence } = useAutoIntelligence()

  // Detect platform for keyboard shortcut display
  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return true
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  }, [])
  const modKey = isMac ? '⌘' : 'Ctrl+'
  const shiftKey = isMac ? '⇧' : 'Shift+'

  // Prompt library: per-chat preset that overrides the default system prompt.
  // activePresetId mirrors currentChat.presetId and is kept in sync via an
  // effect after useChatState resolves currentChat below.
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [isPromptLibraryModalOpen, setIsPromptLibraryModalOpen] =
    useState(false)
  const [hasMountedPromptLibrary, setHasMountedPromptLibrary] = useState(false)
  const { getPresetById } = usePromptLibrary()
  const activePreset = getPresetById(activePresetId)

  const { effectiveSystemPrompt, processedRules } = useCustomSystemPrompt(
    systemPrompt,
    rules,
    activePreset?.systemPrompt ?? null,
  )

  // Use project system prompt hook to inject project context
  const {
    isProjectMode,
    activeProject,
    enterProjectMode,
    exitProjectMode,
    createProject,
    loadingProject,
    error: projectError,
    uploadDocument: uploadProjectDocument,
    addUploadingFile,
    removeUploadingFile,
  } = useProject()

  useEffect(() => {
    if (!pendingProjectUpload) return

    if (loadingProject) {
      if (loadingProject.id === pendingProjectUpload.projectId) return
      setPendingProjectUpload(null)
      setShowAddToProjectModal(false)
      toast({
        title: 'Upload canceled',
        description: 'The file was not attached because the project changed.',
        variant: 'destructive',
        position: 'top-right',
      })
      return
    }

    if (activeProject?.id === pendingProjectUpload.projectId) {
      setShowAddToProjectModal(true)
      return
    }

    if (projectError) {
      setPendingProjectUpload(null)
      setShowAddToProjectModal(false)
      toast({
        title: 'Project unavailable',
        description:
          'The file was not attached because the project failed to load.',
        variant: 'destructive',
        position: 'top-right',
      })
      return
    }

    setPendingProjectUpload(null)
    setShowAddToProjectModal(false)
    toast({
      title: 'Upload canceled',
      description: activeProject?.id
        ? 'The file was not attached because the project changed.'
        : 'The file was not attached because project mode ended.',
      variant: 'destructive',
      position: 'top-right',
    })
  }, [
    activeProject?.id,
    loadingProject,
    pendingProjectUpload,
    projectError,
    toast,
  ])
  const { effectiveSystemPrompt: finalSystemPrompt } = useProjectSystemPrompt({
    baseSystemPrompt: effectiveSystemPrompt,
    baseRules: processedRules,
  })

  // URL routing for deep links
  const {
    updateUrlForChat,
    updateUrlForLocalChat,
    updateUrlForProject,
    clearUrl,
    isLocalChatUrl: isLocalChatUrlFromRouter,
  } = useChatRouter()

  // Combine prop and router detection for local chat URL
  const isLocalChatUrl = isLocalChatUrlProp || isLocalChatUrlFromRouter

  useEffect(() => {
    initializeRenderers()
  }, [])

  // Load models and system prompt immediately in parallel. Cached values
  // seed the first render, but the controlplane response is authoritative:
  // a failed fetch blocks the app even when a cache exists.
  useEffect(() => {
    let cancelled = false
    const configStartedAt = startPerformanceTimer()
    let recordedConfigReady = false
    const recordConfigReady = () => {
      if (recordedConfigReady) return
      recordedConfigReady = true
      recordPerformanceDuration(
        PERFORMANCE_METRICS.CONFIG_READY,
        configStartedAt,
      )
    }
    const loadInitial = async () => {
      const cachedPrompt = getCachedSystemPromptAndRules()
      const cachedModels = getCachedAIModels()
      if (cachedPrompt) {
        setSystemPrompt(cachedPrompt.systemPrompt)
        setRules(cachedPrompt.rules)
      }
      if (cachedModels) {
        setModels(cachedModels)
      }
      if (cachedPrompt && cachedModels) {
        setIsLoadingConfig(false)
        recordConfigReady()
      }

      try {
        const [promptData, models] = await Promise.all([
          getSystemPromptAndRules(),
          getAIModels(),
        ])

        if (cancelled) return
        if (!promptData || !models) {
          setConfigLoadFailed(true)
          setIsLoadingConfig(false)
          return
        }
        setSystemPrompt(promptData.systemPrompt)
        setRules(promptData.rules)
        setModels(models)
        setIsLoadingConfig(false)
        recordConfigReady()
      } catch (error) {
        logError('Failed to load chat configuration', error, {
          component: 'ChatInterface',
          action: 'loadConfig',
        })
        if (!cancelled) {
          setConfigLoadFailed(true)
          setIsLoadingConfig(false)
        }
      }
    }

    loadInitial()
    return () => {
      cancelled = true
    }
  }, [])

  // State for scroll button - define early so it can be used in useChatState
  const [showScrollButton, setShowScrollButton] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const inputAreaObserverRef = useRef<ResizeObserver | null>(null)
  const [inputAreaHeight, setInputAreaHeight] = useState(0)
  const inputAreaRef = useCallback((node: HTMLDivElement | null) => {
    inputAreaObserverRef.current?.disconnect()
    inputAreaObserverRef.current = null
    if (!node) {
      setInputAreaHeight(0)
      return
    }
    setInputAreaHeight(node.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setInputAreaHeight(node.offsetHeight)
    })
    observer.observe(node)
    inputAreaObserverRef.current = observer
  }, [])
  const scrollCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  // Function to scroll to bottom with optional smooth behavior
  const scrollToBottom = useCallback((smooth = true) => {
    if (scrollContainerRef.current) {
      const el = scrollContainerRef.current
      const top = getChatContentBottomScrollTop(
        el.scrollHeight,
        el.clientHeight,
        getChatSpacerHeight(el),
      )
      if (smooth) {
        el.scrollTo({
          top,
          behavior: 'smooth',
        })
      } else {
        el.scrollTop = top
      }
    }
  }, [])

  // Scroll the last user message to the top of the viewport (with offset for header)
  const scrollUserMessageToTop = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    // Wait for DOM to render, then scroll
    setTimeout(() => {
      const userMessages = container.querySelectorAll(
        '[data-message-role="user"]',
      )
      const lastUserMessage = userMessages[
        userMessages.length - 1
      ] as HTMLElement | null

      if (lastUserMessage) {
        // Calculate scroll position with offset for header buttons
        // Mobile needs more offset due to overlapping header buttons
        const messageTop = lastUserMessage.offsetTop
        const isMobile = window.innerWidth < CONSTANTS.MOBILE_BREAKPOINT
        const headerOffset = isMobile ? 80 : 16
        container.scrollTo({
          top: messageTop - headerOffset,
          behavior: 'smooth',
        })
      }
    }, 100)
  }, [])

  // Scroll to the last message (for the scroll button)
  const scrollToLastMessage = useCallback(() => {
    scrollToBottom(true)
    // Move keyboard/screen-reader focus to the latest message so it is read
    // out and becomes the navigation anchor. preventScroll avoids fighting the
    // smooth scroll above.
    const container = scrollContainerRef.current
    if (!container) return
    const messageEls = container.querySelectorAll('[data-message-role]')
    const lastMessage = messageEls[messageEls.length - 1] as HTMLElement | null
    lastMessage?.focus({ preventScroll: true })
  }, [scrollToBottom])

  const {
    // State
    chats,
    currentChat,
    input,
    loadingState,
    retryInfo,
    inputRef,
    isClient,
    isSidebarOpen,
    isDarkMode,
    themeMode,
    isInitialLoad,
    isChatHydrating,
    isThinking,
    isWaitingForResponse,
    isStreaming,
    streamError,
    dismissStreamError,
    retryLastMessage,
    selectedModel,
    hasValidatedModel,
    expandedLabel,
    windowWidth,
    codeExecutionEncryptionKey,

    // Setters
    setInput,
    setIsSidebarOpen,
    setIsInitialLoad,
    setChats,
    setCurrentChat,

    // Actions
    handleQuery,
    createNewChat: createNewChatWithoutNavigationInvalidation,
    deleteChat,
    handleChatSelect: handleChatSelectWithoutNavigationInvalidation,
    toggleTheme,
    setThemeMode,
    openAndExpandVerifier,
    handleInputFocus,
    handleLabelClick,
    handleModelSelect,
    cancelGeneration,
    updateChatTitle,
    reloadChats,
    editMessage,
    deleteMessage,
    editAssistantMessage,
    continueAssistantMessage,
    regenerateMessage,
    resolveInputToolCall,
    retryToolCall,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
    initialChatLoadFailed,
    cloudChatNotFound,
    retryInitialChatLoad,
    loadChatById: loadChatByIdWithoutNavigationInvalidation,
  } = useChatState({
    systemPrompt: finalSystemPrompt,
    rules: processedRules,
    storeHistory: isSignedIn || !isCloudSyncEnabled(), // Enable storage for signed-in users OR local-only mode
    models: models,
    // Scroll user message to top of viewport when sending
    scrollToBottom: scrollUserMessageToTop,
    reasoningEffort,
    thinkingEnabled,
    autoIntelligence,
    initialChatId,
    isLocalChatUrl,
    initialNewChatIsLocalOnly,
    webSearchAvailable,
    // Feature flag gates key derivation in useExecSnapshot; the toggle
    // gates request plumbing. Both layers must be on to use code-exec.
    canUseCodeExecution,
    codeExecutionEnabled: canUseCodeExecution ? codeExecutionEnabled : false,
    piiCheckEnabled,
    genUIEnabled,
  })

  const favoriteNavigationGenerationRef = useRef(0)
  const invalidateFavoriteNavigation = useCallback(() => {
    favoriteNavigationGenerationRef.current += 1
  }, [])
  useEffect(
    () => () => {
      invalidateFavoriteNavigation()
    },
    [invalidateFavoriteNavigation],
  )
  useEffect(() => {
    invalidateFavoriteNavigation()
  }, [authUserId, invalidateFavoriteNavigation])
  const createNewChat = useCallback(
    (isLocalOnly?: boolean, fromUserAction?: boolean) => {
      invalidateFavoriteNavigation()
      createNewChatWithoutNavigationInvalidation(isLocalOnly, fromUserAction)
    },
    [createNewChatWithoutNavigationInvalidation, invalidateFavoriteNavigation],
  )
  const handleChatSelect = useCallback(
    (chatId: string) => {
      invalidateFavoriteNavigation()
      handleChatSelectWithoutNavigationInvalidation(chatId)
    },
    [
      handleChatSelectWithoutNavigationInvalidation,
      invalidateFavoriteNavigation,
    ],
  )
  const loadChatById = useCallback(
    async (chatId: string, isLocalUrl: boolean) => {
      invalidateFavoriteNavigation()
      await loadChatByIdWithoutNavigationInvalidation(chatId, isLocalUrl)
    },
    [invalidateFavoriteNavigation, loadChatByIdWithoutNavigationInvalidation],
  )

  const { pinnedChatIds, pinChat, unpinChat, unpinChats } =
    usePinnedChats(authUserId)
  const favoriteHydrationGenerationRef = useRef(0)
  const favoriteHydrationAccountRef = useRef(authUserId)
  const currentFavoriteAccountRef = useRef(authUserId)
  currentFavoriteAccountRef.current = authUserId
  const favoriteHydrationCloudSyncRef = useRef(cloudSyncSettingEnabled)
  const favoriteHydrationMountedRef = useRef(false)
  const attemptedFavoriteHydrationsRef = useRef(new Set<string>())
  const unavailableFavoriteHydrationsRef = useRef(new Set<string>())
  const favoriteHydrationRetrySignalRef = useRef(0)
  const [favoriteHydrationRetryVersion, setFavoriteHydrationRetryVersion] =
    useState(0)
  const retryUnavailableFavoriteHydrations = useCallback(() => {
    favoriteHydrationRetrySignalRef.current += 1
    if (unavailableFavoriteHydrationsRef.current.size === 0) return
    for (const chatId of unavailableFavoriteHydrationsRef.current) {
      attemptedFavoriteHydrationsRef.current.delete(chatId)
    }
    unavailableFavoriteHydrationsRef.current.clear()
    setFavoriteHydrationRetryVersion((version) => version + 1)
  }, [])
  const missingPinnedChatIds = useMemo(() => {
    const loadedIds = new Set(chats.map((chat) => chat.id))
    return pinnedChatIds.filter((chatId) => !loadedIds.has(chatId))
  }, [chats, pinnedChatIds])
  const missingPinnedChatIdsKey = missingPinnedChatIds.join('\u0000')

  useEffect(() => {
    favoriteHydrationMountedRef.current = true
    return () => {
      favoriteHydrationMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (
      favoriteHydrationAccountRef.current === authUserId &&
      favoriteHydrationCloudSyncRef.current === cloudSyncSettingEnabled
    ) {
      return
    }
    favoriteHydrationAccountRef.current = authUserId
    favoriteHydrationCloudSyncRef.current = cloudSyncSettingEnabled
    favoriteHydrationGenerationRef.current += 1
    attemptedFavoriteHydrationsRef.current.clear()
    unavailableFavoriteHydrationsRef.current.clear()
  }, [authUserId, cloudSyncSettingEnabled])

  useEffect(() => {
    const unsubscribeChats = chatEvents.on((event) => {
      if (
        event.reason === 'sync' ||
        event.reason === 'pagination' ||
        event.reason === 'recovery'
      ) {
        retryUnavailableFavoriteHydrations()
      }
    })
    window.addEventListener('online', retryUnavailableFavoriteHydrations)
    window.addEventListener(
      ENCRYPTION_KEY_CHANGED_EVENT,
      retryUnavailableFavoriteHydrations,
    )
    return () => {
      unsubscribeChats()
      window.removeEventListener('online', retryUnavailableFavoriteHydrations)
      window.removeEventListener(
        ENCRYPTION_KEY_CHANGED_EVENT,
        retryUnavailableFavoriteHydrations,
      )
    }
  }, [retryUnavailableFavoriteHydrations])

  useEffect(() => {
    const pinnedIds = new Set(pinnedChatIds)
    const loadedIds = new Set(chats.map((chat) => chat.id))
    for (const attemptedId of attemptedFavoriteHydrationsRef.current) {
      if (!pinnedIds.has(attemptedId) || loadedIds.has(attemptedId)) {
        attemptedFavoriteHydrationsRef.current.delete(attemptedId)
        unavailableFavoriteHydrationsRef.current.delete(attemptedId)
      }
    }
    const invalidLoadedFavoriteIds = chats
      .filter(
        (chat) =>
          pinnedIds.has(chat.id) &&
          (chat.isBlankChat || chat.isTemporary || chat.dataCorrupted),
      )
      .map((chat) => chat.id)
    if (invalidLoadedFavoriteIds.length > 0) {
      unpinChats(invalidLoadedFavoriteIds)
    }
    if (!isSignedIn || !cloudSyncSettingEnabled || !missingPinnedChatIdsKey)
      return

    const chatIds = missingPinnedChatIds.filter(
      (chatId) => !attemptedFavoriteHydrationsRef.current.has(chatId),
    )
    if (chatIds.length === 0) return
    chatIds.forEach((chatId) =>
      attemptedFavoriteHydrationsRef.current.add(chatId),
    )
    const generation = favoriteHydrationGenerationRef.current
    const retrySignal = favoriteHydrationRetrySignalRef.current
    const accountId = authUserId

    const hydrateFavorites = async () => {
      const results = await Promise.all(
        chatIds.map(async (chatId) => {
          try {
            return { chatId, result: await hydratePinnedChatById(chatId) }
          } catch (error) {
            logError('Failed to hydrate favorite', error, {
              component: 'ChatInterface',
              action: 'hydrateFavorites',
              metadata: { chatId },
            })
            return { chatId, result: { status: 'unavailable' } as const }
          }
        }),
      )
      if (
        !favoriteHydrationMountedRef.current ||
        currentFavoriteAccountRef.current !== accountId ||
        favoriteHydrationGenerationRef.current !== generation
      ) {
        return
      }

      const idsToPrune = results
        .filter(({ result }) => result.status === 'invalid')
        .map(({ chatId }) => chatId)
      if (idsToPrune.length > 0) unpinChats(idsToPrune)
      let shouldRetry = false
      for (const { chatId, result } of results) {
        if (result.status === 'unavailable') {
          if (favoriteHydrationRetrySignalRef.current !== retrySignal) {
            attemptedFavoriteHydrationsRef.current.delete(chatId)
            shouldRetry = true
          } else {
            unavailableFavoriteHydrationsRef.current.add(chatId)
          }
        }
      }
      if (shouldRetry) {
        setFavoriteHydrationRetryVersion((version) => version + 1)
      }

      const hydratedChats = results.flatMap(({ result }) =>
        result.status === 'ready' ? [result.chat] : [],
      )
      if (hydratedChats.length === 0) return
      setChats((current) => {
        let updated = current
        for (const hydrated of hydratedChats) {
          if (updated.some((chat) => chat.id === hydrated.id)) continue
          updated = upsertChatById(updated, hydrated)
        }
        return updated
      })
    }

    void hydrateFavorites()
  }, [
    authUserId,
    chats,
    cloudSyncSettingEnabled,
    favoriteHydrationRetryVersion,
    isSignedIn,
    missingPinnedChatIds,
    missingPinnedChatIdsKey,
    pinnedChatIds,
    setChats,
    unpinChats,
  ])

  const isTemporaryMode = currentChat?.isTemporary === true
  const currentChatId = currentChat?.id
  const recoveryDrafts = useChatRecoveryDrafts(currentChatId ?? '')
  const activeRecoveryTurnIds = useChatRecoveryActiveTurnIds(
    currentChatId ?? '',
  )
  const hasPendingRecovery = Boolean(currentChat?.pendingRecoveries?.length)
  const hasPendingRecoveryRef = useRef(hasPendingRecovery)
  hasPendingRecoveryRef.current = hasPendingRecovery

  const effectiveWebSearchEnabled = resolveWebSearchEnabled(
    webSearchAvailable,
    currentChat?.webSearchEnabled,
  )

  const currentChatRef = useRef<Chat | null>(null)
  useEffect(() => {
    currentChatRef.current = currentChat ?? null
  }, [currentChat])

  useEffect(() => {
    setActivePresetId(currentChat?.presetId ?? null)
  }, [currentChat?.id, currentChat?.presetId])

  const handleSetActivePreset = useCallback(
    (presetId: string | null) => {
      setActivePresetId(presetId)
      if (!currentChat) return
      const updatedChat: Chat = {
        ...currentChat,
        presetId: presetId ?? undefined,
      }
      setCurrentChat(updatedChat)
      // Blank chats share an empty id (one per storage mode), so also match
      // the mode to avoid rewriting the other blank entry.
      setChats((prev) =>
        prev.map((c) =>
          c.id === currentChat.id &&
          (!currentChat.isBlankChat ||
            c.isLocalOnly === currentChat.isLocalOnly)
            ? updatedChat
            : c,
        ),
      )
      const storeHistory = isSignedIn || !isCloudSyncEnabled()
      if (!updatedChat.isTemporary && storeHistory) {
        chatStorage.saveChat(updatedChat).catch((err) => {
          logError('Failed to persist prompt preset selection', err, {
            component: 'ChatInterface',
            metadata: { chatId: updatedChat.id, presetId },
          })
        })
      }
    },
    [currentChat, setCurrentChat, setChats, isSignedIn],
  )

  const handleOpenPromptLibrary = useCallback(() => {
    setHasMountedPromptLibrary(true)
    setIsPromptLibraryModalOpen(true)
  }, [])

  const handleClosePromptLibrary = useCallback(() => {
    setIsPromptLibraryModalOpen(false)
  }, [])

  // Only the free-tier daily quota gates sending and the subscribe prompt. The
  // per-account hourly cap (subscribers) reuses the same indicator channel but
  // must not block the queue or prompt subscribing; those sends fail fast with
  // an in-chat rate-limit message and recover once the hourly window resets.
  //
  // Reads the live cache rather than the mirrored `rateLimit` state so the
  // queue pump's pre-dequeue check can never lag behind handleQuery's own
  // quota gate (which reads the same cache): a stale mirror would let the
  // pump dequeue a message the gate then drops. `rateLimit` stays a
  // dependency so the queue-resume effect re-fires when the limit clears.
  const isRateLimited = useCallback(() => {
    void rateLimit
    const limit = getRateLimitInfo()
    return Boolean(limit && limit.remaining <= 0 && limit.kind !== 'hourly')
  }, [rateLimit])

  const handleQueueRateLimited = useCallback(() => {
    setIsSubscribePromptOpen(true)
  }, [])

  // Queue of user messages submitted while the assistant is busy. The hook
  // observes `loadingState` and dispatches one queued message per idle
  // window, so the user's in-progress input is never wiped.
  const {
    queuedMessages,
    submit: submitMessage,
    removeQueuedMessage,
    sendQueuedMessage,
    notifyGenerationCancelled,
  } = useMessageQueue({
    chatId: currentChat?.id ?? null,
    queueId: currentChat?.id
      ? currentChat.id
      : getBlankQueueId(currentChat?.isLocalOnly === true),
    persistQueue: !isTemporaryMode,
    loadingState,
    handleQuery,
    isRateLimited,
    isDispatchBlocked: () =>
      models.length === 0 ||
      isChatHydrating ||
      hasPendingRecoveryRef.current ||
      (currentChatId ? isChatRecoveryActive(currentChatId) : false),
    dispatchBlocked:
      models.length === 0 ||
      isChatHydrating ||
      hasPendingRecovery ||
      activeRecoveryTurnIds.length > 0,
    onRateLimited: handleQueueRateLimited,
    cancelGeneration,
  })

  // Stop button path: tell the queue about the cancellation first so its
  // pump abandons the cancelled dispatch (whose promise may never settle)
  // and resumes draining queued messages once the chat goes idle.
  const cancelGenerationAndResumeQueue = useCallback(() => {
    const id = currentChat?.id
    if (id != null) notifyGenerationCancelled(id)
    void cancelGeneration()
  }, [currentChat?.id, notifyGenerationCancelled, cancelGeneration])

  const canEnableCodeExecution =
    canUseCodeExecution && codeExecutionEncryptionKey != null

  // Ask sidebar - ephemeral streaming only. Nothing is persisted until the
  // user clicks "Open as chat", which creates a new real chat seeded with the
  // sidebar's messages.
  const sidebarChat = useSidebarChat({
    systemPrompt: finalSystemPrompt,
    rules: processedRules,
    models,
    selectedModel,
    reasoningEffort,
    thinkingEnabled,
    autoIntelligence,
    webSearchEnabled: effectiveWebSearchEnabled,
    piiCheckEnabled,
  })

  // Sync URL with current chat state
  useEffect(() => {
    // Don't update URL during initial load
    if (isInitialLoad) return
    // Don't clear URL when showing error screens
    if (initialChatDecryptionFailed) return
    if (initialChatLoadFailed) return
    if (cloudChatNotFound) return
    if (localChatNotFound) return

    // Track when we've successfully loaded the initial chat from URL
    if (initialChatId && currentChat.id === initialChatId) {
      initialUrlChatLoadedRef.current = true
    }

    // Temporary chats are ephemeral and never appear in the URL.
    if (currentChat.isTemporary) {
      clearUrl()
      return
    }

    // In local-only mode, a blank "new chat" should live at `/` (not `/chat/local`)
    // so it never depends on host routing for that path.
    if (currentChat.isLocalOnly && currentChat.isBlankChat) {
      clearUrl()
      return
    }

    // Local-only chats get /chat/local/[chatId] URLs (regardless of sign-in status)
    if (currentChat.isLocalOnly) {
      updateUrlForLocalChat(currentChat.id)
      return
    }

    // For local chat URLs that are still loading, don't clear the URL yet
    // (the chat will be loaded from IndexedDB and set as currentChat)
    // Only apply this guard if we haven't yet loaded the initial chat from URL
    if (
      isLocalChatUrl &&
      currentChat.isBlankChat &&
      initialChatId &&
      !initialUrlChatLoadedRef.current
    ) {
      return
    }

    // Non-signed-in users don't get URLs (their chats are temporary sessionStorage)
    if (!isSignedIn) {
      clearUrl()
      return
    }

    if (currentChat.isBlankChat) {
      // In project mode, show /project/[projectId] for blank chats
      if (isProjectMode && activeProject?.id) {
        updateUrlForProject(activeProject.id)
      } else {
        clearUrl()
      }
      return
    }

    // Update URL based on whether we're in project mode
    if (isProjectMode && activeProject?.id) {
      updateUrlForChat(currentChat.id, activeProject.id)
    } else if (currentChat.projectId) {
      // Chat belongs to a project but we're not in project mode yet
      // Use the chat's projectId for the URL
      updateUrlForChat(currentChat.id, currentChat.projectId)
    } else {
      // Regular chat, no project
      updateUrlForChat(currentChat.id)
    }
  }, [
    currentChat.id,
    currentChat.isBlankChat,
    currentChat.isLocalOnly,
    currentChat.isTemporary,
    currentChat.projectId,
    isProjectMode,
    activeProject?.id,
    isInitialLoad,
    initialChatDecryptionFailed,
    initialChatLoadFailed,
    cloudChatNotFound,
    localChatNotFound,
    isSignedIn,
    isLocalChatUrl,
    initialChatId,
    updateUrlForChat,
    updateUrlForLocalChat,
    updateUrlForProject,
    clearUrl,
  ])

  // Compute the browser-tab title from the active chat. The value is emitted
  // declaratively via <Head> in the render below so Next.js owns head
  // reconciliation — an imperative document.title write would be overwritten
  // on the next render by the <title> declared in _app.tsx's <Head>.
  // Blank/placeholder/temporary chats keep the base title because their
  // displayed "title" is a generic label.
  const chatTitle = currentChat?.title
  const chatTitleState = currentChat?.titleState
  const chatIsBlank = currentChat?.isBlankChat
  const chatIsTemporary = currentChat?.isTemporary
  const showChatTitleInTab = useBrowserTabChatTitle()
  const documentTitle = useMemo(() => {
    const base = CONSTANTS.BASE_DOCUMENT_TITLE
    const trimmed = chatTitle?.trim()
    const hasMeaningfulTitle =
      showChatTitleInTab &&
      !chatIsBlank &&
      !chatIsTemporary &&
      chatTitleState !== 'placeholder' &&
      !!trimmed &&
      trimmed !== 'New Chat'
    return hasMeaningfulTitle ? `${trimmed} · ${base}` : base
  }, [
    showChatTitleInTab,
    chatTitle,
    chatTitleState,
    chatIsBlank,
    chatIsTemporary,
  ])

  // Initialize tinfoil client once when page loads
  useEffect(() => {
    let active = true
    const initTinfoil = async () => {
      try {
        const { getVerificationDocument } =
          await import('@/services/inference/tinfoil-client')
        const doc = await getVerificationDocument()
        if (active && doc) {
          setVerificationDocument(doc)
          setVerificationStatus(
            doc.securityVerified === true
              ? 'verified'
              : doc.securityVerified === false
                ? 'failed'
                : 'pending',
          )
        } else if (active) {
          setVerificationStatus('failed')
        }
      } catch (error) {
        logError('Failed to initialize tinfoil client', error, {
          component: 'ChatInterface',
          action: 'initTinfoil',
        })
        if (active) setVerificationStatus('failed')
      }
    }
    void initTinfoil()
    return () => {
      active = false
    }
  }, [])

  // Refresh credentials after sign-in or an entitlement transition so a
  // free-tier token cannot remain cached after upgrade and a premium token
  // cannot remain cached after access ends.
  useEffect(() => {
    if (!isSignedIn || !cloudSyncInitialized) return
    invalidateSessionCache()
    void getSessionToken().catch(() => {
      // best-effort; the next real request will retry
    })
  }, [isSignedIn, cloudSyncInitialized, chat_subscription_active])

  // Handle upgrade requests from error CTA buttons and quota-gated sends
  useEffect(() => {
    const handleRequestUpgrade = () => {
      setIsSubscribePromptOpen(true)
    }
    window.addEventListener(REQUEST_UPGRADE_EVENT, handleRequestUpgrade)
    return () => {
      window.removeEventListener(REQUEST_UPGRADE_EVENT, handleRequestUpgrade)
    }
  }, [])

  const handleWebSearchToggle = useCallback(() => {
    if (!currentChat) return
    const next = !resolveWebSearchEnabled(true, currentChat.webSearchEnabled)
    const updatedChat: Chat = {
      ...currentChat,
      webSearchEnabled: next,
    }
    setCurrentChat(updatedChat)
    // Blank chats share an empty id (one per storage mode), so also match
    // the mode to avoid rewriting the other blank entry.
    setChats((prev) =>
      prev.map((c) =>
        c.id === currentChat.id &&
        (!currentChat.isBlankChat || c.isLocalOnly === currentChat.isLocalOnly)
          ? updatedChat
          : c,
      ),
    )
    const storeHistory = isSignedIn || !isCloudSyncEnabled()
    if (!updatedChat.isTemporary && !updatedChat.isBlankChat && storeHistory) {
      chatStorage.saveChat(updatedChat).catch((err) => {
        logError('Failed to persist web search preference', err, {
          component: 'ChatInterface',
          metadata: { chatId: updatedChat.id, webSearchEnabled: next },
        })
      })
    }
  }, [currentChat, setCurrentChat, setChats, isSignedIn])

  // Persist code execution toggle to localStorage
  useEffect(() => {
    localStorage.setItem(
      SETTINGS_CODE_EXECUTION_ENABLED,
      String(codeExecutionEnabled),
    )
  }, [codeExecutionEnabled])

  const handleCodeExecutionToggle = useCallback(() => {
    setCodeExecutionEnabled((prev) => {
      const next = !prev
      window.dispatchEvent(
        new CustomEvent('codeExecutionEnabledChanged', {
          detail: { enabled: next },
        }),
      )
      return next
    })
  }, [])

  useEffect(() => {
    const handleWebSearchAvailableChange = (
      event: CustomEvent<{ enabled: boolean }>,
    ) => {
      setWebSearchAvailable(event.detail.enabled)
    }
    const handleCodeExecutionChange = (
      event: CustomEvent<{ enabled: boolean }>,
    ) => {
      setCodeExecutionEnabled(event.detail.enabled)
    }

    window.addEventListener(
      'webSearchAvailableChanged',
      handleWebSearchAvailableChange as EventListener,
    )
    window.addEventListener(
      'codeExecutionEnabledChanged',
      handleCodeExecutionChange as EventListener,
    )

    return () => {
      window.removeEventListener(
        'webSearchAvailableChanged',
        handleWebSearchAvailableChange as EventListener,
      )
      window.removeEventListener(
        'codeExecutionEnabledChanged',
        handleCodeExecutionChange as EventListener,
      )
    }
  }, [])

  // Listen for privacy setting changes from settings modal
  useEffect(() => {
    const handlePiiCheckChange = (event: CustomEvent<{ enabled: boolean }>) => {
      setPiiCheckEnabled(event.detail.enabled)
    }
    const handlePixelateSidebarChatTitlesChange = (
      event: CustomEvent<{ enabled: boolean }>,
    ) => {
      setPixelateSidebarChatTitles(event.detail.enabled)
    }
    const handlePixelateSidebarChatTitlesStorageChange = (
      event: StorageEvent,
    ) => {
      if (
        event.key !== null &&
        event.key !== SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED
      ) {
        return
      }
      setPixelateSidebarChatTitles(
        event.newValue === null ? true : event.newValue === 'true',
      )
    }

    window.addEventListener(
      'piiCheckEnabledChanged',
      handlePiiCheckChange as EventListener,
    )
    window.addEventListener(
      PIXELATE_SIDEBAR_CHAT_TITLES_CHANGED_EVENT,
      handlePixelateSidebarChatTitlesChange as EventListener,
    )
    window.addEventListener(
      'storage',
      handlePixelateSidebarChatTitlesStorageChange,
    )

    return () => {
      window.removeEventListener(
        'piiCheckEnabledChanged',
        handlePiiCheckChange as EventListener,
      )
      window.removeEventListener(
        PIXELATE_SIDEBAR_CHAT_TITLES_CHANGED_EVENT,
        handlePixelateSidebarChatTitlesChange as EventListener,
      )
      window.removeEventListener(
        'storage',
        handlePixelateSidebarChatTitlesStorageChange,
      )
    }
  }, [])

  // Listen for Generative UI setting changes from settings modal
  useEffect(() => {
    const handleGenUIChange = (event: CustomEvent<{ enabled: boolean }>) => {
      setGenUIEnabled(event.detail.enabled)
    }

    window.addEventListener(
      'genUIEnabledChanged',
      handleGenUIChange as EventListener,
    )

    return () => {
      window.removeEventListener(
        'genUIEnabledChanged',
        handleGenUIChange as EventListener,
      )
    }
  }, [])

  // Effect to handle window resize and enforce single sidebar rule
  useEffect(() => {
    // When window becomes narrow and both types of sidebars are open, close the right one
    if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
      if (
        isSidebarOpen &&
        (isVerifierSidebarOpen ||
          isSettingsModalOpen ||
          isAskSidebarOpen ||
          isArtifactSidebarOpen)
      ) {
        // Close right sidebars to prioritize left sidebar
        setIsVerifierSidebarOpen(false)
        setIsSettingsModalOpen(false)
        setIsAskSidebarOpen(false)
        setIsArtifactSidebarOpen(false)
      }
    }
  }, [
    windowWidth,
    isSidebarOpen,
    isVerifierSidebarOpen,
    isSettingsModalOpen,
    isAskSidebarOpen,
    isArtifactSidebarOpen,
  ])

  // Listen for `OPEN_ARTIFACT_PREVIEW_EVENT` dispatched by the
  // `render_artifact_preview` inline card. Shows the artifact in the right
  // slide-over and closes any other right-side panel so only one is visible.
  useEffect(() => {
    const handleOpenArtifactPreview = (
      event: CustomEvent<ArtifactPreviewSidebarEventDetail>,
    ) => {
      if (!event.detail) return
      const { action, artifact, toolCallId } = event.detail
      // Toggle: clicking the inline card while its artifact is already open
      // closes the sidebar instead of re-opening it.
      const sameArtifact =
        artifactPreview !== null &&
        isArtifactSidebarOpen &&
        artifactPreviewTargetsEqual(
          artifactPreview,
          activeArtifactToolCallId,
          artifact,
          toolCallId,
        )
      if (action === 'toggle' && sameArtifact) {
        setIsArtifactSidebarOpen(false)
        return
      }
      setArtifactPreview(artifact)
      setActiveArtifactToolCallId(toolCallId ?? null)
      setIsArtifactSidebarOpen(true)
      setIsVerifierSidebarOpen(false)
      setIsSettingsModalOpen(false)
      setIsAskSidebarOpen(false)
      if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
        setIsSidebarOpen(false)
      }
    }
    window.addEventListener(
      OPEN_ARTIFACT_PREVIEW_EVENT,
      handleOpenArtifactPreview as EventListener,
    )
    return () => {
      window.removeEventListener(
        OPEN_ARTIFACT_PREVIEW_EVENT,
        handleOpenArtifactPreview as EventListener,
      )
    }
  }, [
    windowWidth,
    setIsSidebarOpen,
    isArtifactSidebarOpen,
    artifactPreview,
    activeArtifactToolCallId,
  ])

  // Auto-focus input when component mounts and is ready (no autoscroll)
  // Keyed on the chat id, not the chat object: the object's identity changes
  // on every stream flush and sync update, which would re-run this effect and
  // repeatedly steal focus from whatever the user is typing in.
  useEffect(() => {
    if (isClient && !isLoadingConfig && currentChatId) {
      // Skip auto-focus when sidebar is open on mobile — focusing the input
      // triggers handleInputFocus which closes the sidebar
      if (isSidebarOpen && windowWidth < CONSTANTS.MOBILE_BREAKPOINT) {
        return
      }
      // Small delay to ensure DOM is ready and input is rendered
      const timer = setTimeout(() => {
        // Re-runs triggered by viewport or sidebar changes (e.g. the mobile
        // keyboard resizing the window) must never yank the caret out of
        // another editable element the user is already typing in.
        const active = document.activeElement
        if (
          active instanceof HTMLElement &&
          active !== inputRef.current &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable)
        ) {
          return
        }
        inputRef.current?.focus()
      }, 200)
      return () => clearTimeout(timer)
    }
  }, [
    isClient,
    isLoadingConfig,
    currentChatId,
    inputRef,
    isSidebarOpen,
    windowWidth,
  ])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+. (or Ctrl+.) to toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        setIsSidebarOpen((prev) => !prev)
        return
      }

      // Shift+Cmd+O (or Shift+Ctrl+O) for new chat
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'o'
      ) {
        e.preventDefault()
        if (currentChat?.messages?.length !== 0) {
          createNewChat()
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setIsSidebarOpen, currentChat?.messages?.length, createNewChat])

  // Get the selected model details
  const selectedModelDetails = findSelectableModel(selectedModel, models) as
    BaseModel | undefined
  const prefersMultimodalContext = useMemo(
    () =>
      currentChat?.messages.some(
        (message) => getMessageImages(message).length > 0,
      ) ||
      processedDocuments.some(
        (document) =>
          Boolean(document.imageData) || document.attachment?.type === 'image',
      ),
    [currentChat?.messages, processedDocuments],
  )
  const contextModelSelection = resolveModelSelection(selectedModel, models, {
    preferMultimodal: prefersMultimodalContext,
    preferToolCalling:
      effectiveWebSearchEnabled || codeExecutionEnabled || genUIEnabled,
  })
  const reasoningHistoryPolicy = getReasoningHistoryPolicy(
    contextModelSelection,
  )
  const contextWindowTokens = getResolvedModelContextWindowTokens(
    contextModelSelection,
  )
  const pendingAttachments = buildCompletedAttachments(processedDocuments)
  const pendingContextTokens = estimateMessageTokens({
    role: 'user',
    content: input.trim(),
    attachments: pendingAttachments,
    quote: quote ?? undefined,
    timestamp: new Date(),
  })

  // Initialize document uploader hook
  const { handleDocumentUpload, describeImageWithMultimodal } =
    useDocumentUploader(selectedModelDetails?.multimodal)

  // Generate descriptions for images when switching to a non-multimodal model
  useEffect(() => {
    if (selectedModelDetails?.multimodal) return

    const imagesNeedingDescriptions = processedDocuments.filter(
      (doc) =>
        (doc.imageData ||
          (doc.attachment?.type === 'image' && doc.attachment?.base64)) &&
        !doc.hasDescription &&
        !doc.isUploading &&
        !doc.isGeneratingDescription,
    )

    if (imagesNeedingDescriptions.length === 0) return

    // Mark images as generating descriptions
    setProcessedDocuments((prev) =>
      prev.map((doc) =>
        imagesNeedingDescriptions.some((img) => img.id === doc.id)
          ? { ...doc, isGeneratingDescription: true }
          : doc,
      ),
    )

    Promise.all(
      imagesNeedingDescriptions.map(async (doc) => {
        const base64 = doc.attachment?.base64 ?? doc.imageData?.base64
        const mimeType = doc.attachment?.mimeType ?? doc.imageData?.mimeType
        if (!base64 || !mimeType)
          return { id: doc.id, name: doc.name, description: '', success: false }
        try {
          const description = await describeImageWithMultimodal(
            base64,
            mimeType,
          )
          return { id: doc.id, name: doc.name, description, success: true }
        } catch (error) {
          logError('Lazy image description failed', error, {
            component: 'ChatInterface',
            action: 'lazyDescribeImage',
            metadata: { documentId: doc.id, fileName: doc.name },
          })
          return { id: doc.id, name: doc.name, description: '', success: false }
        }
      }),
    ).then((results) => {
      const failedImages = results.filter((r) => !r.success)
      if (failedImages.length > 0) {
        toast({
          title: 'Image processing failed',
          description: `Could not process ${failedImages.length === 1 ? `"${failedImages[0].name}"` : `${failedImages.length} images`} for this model. Please try uploading again.`,
          variant: 'destructive',
          position: 'top-right',
        })
      }

      setProcessedDocuments((prev) =>
        prev
          .filter((doc) => {
            const result = results.find((r) => r.id === doc.id)
            return !result || result.success
          })
          .map((doc) => {
            const result = results.find((r) => r.id === doc.id)
            if (result) {
              return {
                ...doc,
                content: result.description,
                hasDescription: true,
                isGeneratingDescription: false,
                // Update description on the attachment if present
                attachment: doc.attachment
                  ? { ...doc.attachment, description: result.description }
                  : undefined,
              }
            }
            return doc
          }),
      )
    })
  }, [
    selectedModelDetails?.multimodal,
    processedDocuments,
    describeImageWithMultimodal,
    toast,
  ])

  const activeProjectIdForSync = activeProject?.id

  // Sync chats when user signs in and periodically
  // Profile sync is handled separately by useProfileSync hook
  // Context-aware: syncs personal chats when not in project mode, project chats when in project mode
  useEffect(() => {
    if (
      !isAuthLoaded ||
      !isSignedIn ||
      !cloudSyncInitialized ||
      !cloudSyncSettingEnabled ||
      !encryptionService.getKey()
    ) {
      setChatPagination({ isReady: false, userId: authUserId ?? undefined })
      return
    }

    let cancelled = false
    setChatPagination({ isReady: false, userId: authUserId ?? undefined })

    // Initial sync based on current mode
    const initialSync =
      isProjectMode && activeProjectIdForSync
        ? () => smartSyncChats(activeProjectIdForSync)
        : () => syncChats()

    const runInitialSync = async () => {
      while (!cancelled) {
        try {
          return await initialSync()
        } catch (error) {
          if (!(error instanceof SyncInProgressError)) throw error
          await cloudSync.waitForCurrentSync()
        }
      }
      return false
    }

    runInitialSync()
      .then(async () => {
        await reloadChats()
        if (!cancelled && !isProjectMode) {
          setChatPagination({
            isReady: true,
            userId: authUserId ?? undefined,
          })
        }
      })
      .catch((error) => {
        if (!cancelled && !isProjectMode) {
          setChatPagination({
            isReady: true,
            userId: authUserId ?? undefined,
          })
        }
        logError('Failed to sync chats on page load', error, {
          component: 'ChatInterface',
          action: 'initialSync',
          metadata: { isProjectMode, projectId: activeProjectIdForSync },
        })
      })

    // Use smart sync at regular intervals - checks sync status first to reduce bandwidth
    // Syncs project chats when in project mode, personal chats otherwise
    const interval = setInterval(() => {
      const projectId =
        isProjectMode && activeProjectIdForSync
          ? activeProjectIdForSync
          : undefined
      smartSyncChats(projectId)
        .then((result) => {
          // Only reload chats if something was actually synced
          if (result.uploaded > 0 || result.downloaded > 0) {
            return reloadChats()
          }
        })
        .catch((error) => {
          logError('Failed to sync chats (periodic)', error, {
            component: 'ChatInterface',
            action: 'periodicSync',
            metadata: { isProjectMode, projectId: activeProjectIdForSync },
          })
        })
    }, CLOUD_SYNC.CHAT_SYNC_INTERVAL)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [
    isAuthLoaded,
    isSignedIn,
    authUserId,
    cloudSyncInitialized,
    cloudSyncSettingEnabled,
    isProjectMode,
    activeProjectIdForSync,
    syncChats,
    smartSyncChats,
    reloadChats,
  ])

  // Reload chats when the chat encryption key changes (manual entry,
  // passkey recovery, etc.). Without this, previously-undecryptable chats
  // stay hidden until the user manually refreshes.
  useEffect(() => {
    const handler = () => {
      reloadChats().catch((error) => {
        logError('Failed to reload chats after encryption key change', error, {
          component: 'ChatInterface',
          action: 'encryptionKeyChangedReload',
        })
      })
    }
    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, handler)
    return () =>
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, handler)
  }, [reloadChats])

  const handleManualSync = useCallback(async () => {
    try {
      return await runManualCloudSync({
        syncChats,
        syncProfile: syncProfileFromCloud,
        reloadChats,
      })
    } catch (error) {
      logError('Manual cloud sync failed', error, {
        component: 'ChatInterface',
        action: 'handleManualSync',
      })
      return false
    }
  }, [syncChats, syncProfileFromCloud, reloadChats])

  // Handler for opening verifier sidebar
  const handleOpenVerifierSidebar = () => {
    if (isVerifierSidebarOpen) {
      // If already open, close it
      handleSetVerifierSidebarOpen(false)
    } else {
      // Open verifier and close other right-side panels
      handleSetVerifierSidebarOpen(true)
      setIsSettingsModalOpen(false)
      setIsAskSidebarOpen(false)
      setIsArtifactSidebarOpen(false)
      sidebarChat.reset()
    }
  }

  // Handler for setting verifier sidebar state
  const handleSetVerifierSidebarOpen = (isOpen: boolean) => {
    if (isOpen) setHasMountedVerifierSidebar(true)
    setIsVerifierSidebarOpen(isOpen)
    if (isOpen) {
      // If window is narrow, close left sidebar when opening right sidebar
      if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
        setIsSidebarOpen(false)
      }
    }
  }

  // Handler for settings modal
  const handleOpenSettingsModal = () => {
    if (isSettingsModalOpen) {
      // If already open, close it
      setIsSettingsModalOpen(false)
    } else {
      // Open settings and close verifier if open
      setSettingsInitialTab(syncNeedsAttention ? 'cloud-sync' : undefined)
      setHasMountedSettingsModal(true)
      setIsSettingsModalOpen(true)
      handleSetVerifierSidebarOpen(false)
      setIsAskSidebarOpen(false)
      setIsArtifactSidebarOpen(false)
      // If window is narrow, close left sidebar when opening settings
      if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
        setIsSidebarOpen(false)
      }
    }
  }

  // Handler for opening share modal
  const handleOpenShareModal = () => {
    setHasMountedShareModal(true)
    setIsShareModalOpen(true)
  }

  // Handler for encryption key button - opens settings modal to cloud-sync tab
  const handleOpenEncryptionKeyModal = () => {
    setSettingsInitialTab('cloud-sync')
    setHasMountedSettingsModal(true)
    setIsSettingsModalOpen(true)
    handleSetVerifierSidebarOpen(false)
    if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
      setIsSidebarOpen(false)
    }
  }

  // Handler for cloud sync setup. When the user has no local key we first
  // check if the backend already holds a passkey credential — if so, route
  // them back to passkey recovery even if they previously dismissed it, so
  // clicking "Enable Cloud Sync" is always a valid re-entry path. Next
  // show the cloud-sync intro for brand-new signed-in users, then let its
  // Continue action route to passkey or manual setup. Remote data bypasses
  // the intro and routes directly to recovery.
  const handleOpenCloudSyncSetup = useCallback(async () => {
    if (!encryptionService.getKey()) {
      // Open the modal immediately for instant feedback. It renders
      // its recovery / manual UI from the live hook state, so we don't
      // block the popup on the slow enclave key-state probe. The
      // probes below run in the background and the modal reacts to the
      // resulting state changes (e.g. a manual-recovery warning getting
      // upgraded to a passkey-recovery flow).
      setShowCloudSyncSetupModal(true)
      setIsCloudSyncRoutePending(true)
      try {
        const recovered = await showPasskeyRecoveryPrompt()
        if (recovered) return
        await showFirstTimePasskeyPrompt()
      } finally {
        setIsCloudSyncRoutePending(false)
      }
      return
    }
    setShowCloudSyncSetupModal(true)
  }, [showPasskeyRecoveryPrompt, showFirstTimePasskeyPrompt])

  // Pre-warm the cloud-sync modal chunks as soon as a cloud-sync entry
  // point is reachable, so clicking the sidebar prompt opens the popup
  // without first paying for an on-demand chunk fetch.
  useEffect(() => {
    if (!isSignedIn) return
    if (
      passkeyRecoveryNeeded ||
      manualRecoveryNeeded ||
      passkeySetupFailed ||
      passkeySetupAvailable ||
      passkeyAddDeviceAvailable
    ) {
      preloadCloudSyncModals()
    }
  }, [
    isSignedIn,
    passkeyRecoveryNeeded,
    manualRecoveryNeeded,
    passkeySetupFailed,
    passkeySetupAvailable,
    passkeyAddDeviceAvailable,
  ])

  const handleKeyChanged = useCallback(
    async (
      key: string,
      options?: {
        mode?: 'recoverExisting' | 'explicitStartFresh'
      },
    ) => {
      const syncResult = await setEncryptionKey(key, options)
      if (syncResult) {
        await retryProfileDecryption()
        await reloadChats()
        // `encryptionKeyChanged` is fired by encryptionService itself
        // from setKey → persistKeyState; no need to dispatch here.
      }
    },
    [setEncryptionKey, retryProfileDecryption, reloadChats],
  )

  // After an explicit "start fresh" the new key lives only on this
  // device. If the platform supports passkeys and the user doesn't
  // already have one, create a passkey now so the fresh key stays
  // recoverable. Users who already have an active passkey get their
  // backup re-encrypted by the key-change handler in useCloudSync, so
  // there's nothing to do for them here. Best-effort: a cancel or
  // failure just leaves the sidebar backup warning in place.
  const backupStartFreshKeyWithPasskey = useCallback(async () => {
    if (passkeyActive) return
    try {
      if (!(await isPrfSupported())) return
      await setupPasskey()
    } catch (error) {
      if (error instanceof PrfNotSupportedError) return
      logError(
        'Failed to back up new key with passkey after start fresh',
        error,
        {
          component: 'ChatInterface',
          action: 'backupStartFreshKeyWithPasskey',
        },
      )
    }
  }, [passkeyActive, setupPasskey])

  const handleCreateProject = useCallback(async () => {
    if (!isPremium) {
      setIsSubscribePromptOpen(true)
      return
    }
    invalidateFavoriteNavigation()
    try {
      const name = `My Project #${projects.length + 1}`
      const project = await createProject({ name, description: '' })
      await openProjectChat({
        projectId: project.id,
        createNewChat,
        enterProjectMode,
      })
    } catch (error) {
      logError('Failed to create project', error, {
        component: 'ChatInterface',
        action: 'handleCreateProject',
      })
      toast({
        title: 'Failed to create project',
        description: 'Please try again.',
        variant: 'destructive',
      })
    }
  }, [
    createProject,
    createNewChat,
    enterProjectMode,
    invalidateFavoriteNavigation,
    isPremium,
    projects.length,
    toast,
  ])

  // Handler for exiting project mode - creates a new chat and exits
  const handleExitProject = useCallback(() => {
    setPendingProjectUpload(null)
    setShowAddToProjectModal(false)
    createNewChat(false, true)
    exitProjectMode()
  }, [createNewChat, exitProjectMode])

  useEffect(() => {
    if (
      isSubscriptionLoading ||
      isPremium ||
      (!isProjectMode && !currentChat.projectId)
    )
      return
    setPendingProjectUpload(null)
    setShowAddToProjectModal(false)
    createNewChat(false, true)
    exitProjectMode()
    clearUrl()
  }, [
    clearUrl,
    createNewChat,
    currentChat.projectId,
    exitProjectMode,
    isPremium,
    isProjectMode,
    isSubscriptionLoading,
  ])

  const handleToggleTemporaryMode = useCallback(() => {
    invalidateFavoriteNavigation()
    if (!canToggleTemporaryChat(currentChat)) return

    const hasMessages = (currentChat?.messages?.length ?? 0) > 0
    const storeHistory = isSignedIn || !isCloudSyncEnabled()

    if (currentChat?.isTemporary) {
      // Deselecting temporary mode on a started chat saves it permanently.
      if (hasMessages) {
        const permanentChat: Chat = {
          ...currentChat,
          isTemporary: false,
          isBlankChat: false,
          title:
            currentChat.title === TEMPORARY_CHAT_TITLE
              ? DEFAULT_CHAT_TITLE
              : currentChat.title,
          codeExecutionAccessToken:
            currentChat.codeExecutionAccessToken ??
            generateCodeExecutionAccessToken(),
          createdAt: currentChat.createdAt ?? new Date(),
        }
        previousChatRef.current = null
        setCurrentChat(permanentChat)
        setChats((prev) => upsertChatById(prev, permanentChat))
        const persist = (chat: Chat) => {
          if (storeHistory) {
            chatStorage.saveChatAndSync(chat).catch((err) => {
              logError('Failed to save temporary chat as permanent', err, {
                component: 'ChatInterface',
                action: 'handleToggleTemporaryMode.save',
                metadata: { chatId: chat.id },
              })
            })
          } else {
            sessionChatStorage.saveChat(chat)
          }
        }
        persist(permanentChat)

        // Temporary chats never get titles generated during streaming, so
        // generate one now from the first user message (falling back to
        // attachment text) to avoid a list full of "Untitled" entries.
        if (permanentChat.title === DEFAULT_CHAT_TITLE) {
          const firstUser = permanentChat.messages.find(
            (m) => m.role === 'user',
          )
          const titleContent = firstUser ? getTitleContent(firstUser) : ''
          if (titleContent) {
            generateTitle([{ role: 'user', content: titleContent }])
              .then((generated) => {
                if (!generated || generated === DEFAULT_CHAT_TITLE) return
                // If the user navigated away while the title was generating,
                // skip persistence for the inactive chat.
                const active = currentChatRef.current
                if (
                  !active ||
                  active.id !== permanentChat.id ||
                  active.isTemporary
                ) {
                  return
                }
                const titled: Chat = {
                  ...active,
                  title: generated,
                  titleState: 'generated',
                }
                setCurrentChat((cur) => (cur?.id === titled.id ? titled : cur))
                setChats((prev) =>
                  prev.map((c) => (c.id === titled.id ? titled : c)),
                )
                persist(titled)
              })
              .catch(() => {})
          }
        }
        return
      }

      const previousChat = previousChatRef.current
      previousChatRef.current = null
      const restored = previousChat?.isBlankChat
        ? chats.find(
            (chat) =>
              chat.isBlankChat && chat.isLocalOnly === previousChat.isLocalOnly,
          )
        : chats.find((chat) => chat.id === previousChat?.id)
      if (restored) {
        setCurrentChat(restored)
      } else {
        createNewChat(false, true)
      }
      return
    }

    previousChatRef.current = currentChat
      ? {
          id: currentChat.id,
          isBlankChat: currentChat.isBlankChat,
          isLocalOnly: currentChat.isLocalOnly,
        }
      : null
    const tempChat = createTemporaryChat({
      presetId: currentChat?.presetId,
      webSearchEnabled: currentChat?.webSearchEnabled,
      isLocalOnly: currentChat?.isLocalOnly,
    })
    setCurrentChat(tempChat)
  }, [
    chats,
    createNewChat,
    currentChat,
    invalidateFavoriteNavigation,
    isSignedIn,
    setChats,
    setCurrentChat,
  ])

  useEffect(() => {
    if (!isTemporaryMode && previousChatRef.current !== null) {
      previousChatRef.current = null
    }
  }, [isTemporaryMode])

  // Handler for exiting project mode while dragging - does NOT create a new chat
  // so the drag operation can continue and drop into cloud/local tabs
  const handleExitProjectWhileDragging = useCallback(() => {
    invalidateFavoriteNavigation()
    setPendingProjectUpload(null)
    setShowAddToProjectModal(false)
    exitProjectMode()
  }, [exitProjectMode, invalidateFavoriteNavigation])

  // Handler for moving a chat to a project via drag and drop
  const handleMoveChatToProject = useCallback(
    async (chatId: string, projectId: string) => {
      if (!isPremium) {
        setIsSubscribePromptOpen(true)
        return
      }
      try {
        await chatStorage.moveChatToProject(chatId, projectId)

        // Reload chats to update the UI
        await reloadChats()

        // If the moved chat was the current chat, create a new blank chat
        if (currentChat.id === chatId) {
          createNewChat(false, true)
        }

        toast({
          title: 'Chat moved to project',
          description: 'The chat has been moved successfully.',
        })
      } catch (error) {
        logError('Failed to move chat to project', error, {
          component: 'ChatInterface',
          action: 'handleMoveChatToProject',
          metadata: { chatId, projectId },
        })

        // Rollback: reload chats to restore original state
        await reloadChats()

        toast({
          title: 'Failed to move chat',
          description: 'Please try again.',
          variant: 'destructive',
        })
      }
    },
    [currentChat.id, createNewChat, isPremium, reloadChats, toast],
  )

  // Handler for removing a chat from a project via drag and drop
  const handleRemoveChatFromProject = useCallback(
    async (chatId: string): Promise<void> => {
      if (!isPremium) {
        setIsSubscribePromptOpen(true)
        return
      }
      try {
        await chatStorage.removeChatFromProject(chatId)

        await reloadChats()

        toast({
          title: 'Chat removed from project',
          description: 'The chat is now in your main chat list.',
        })
      } catch (error) {
        logError('Failed to remove chat from project', error, {
          component: 'ChatInterface',
          action: 'handleRemoveChatFromProject',
          metadata: { chatId },
        })

        // Rollback: reload chats to restore original state
        await reloadChats()

        toast({
          title: 'Failed to remove chat',
          description: 'Please try again.',
          variant: 'destructive',
        })
      }
    },
    [isPremium, reloadChats, toast],
  )

  // Handler for deleting every chat that belongs to a project. Reloads from
  // storage afterwards so the deleted chats disappear locally without a
  // page refresh.
  const handleDeleteProjectChats = useCallback(
    async (projectId: string): Promise<void> => {
      if (!isPremium) {
        setIsSubscribePromptOpen(true)
        return
      }
      try {
        const deletedChatIds =
          await chatStorage.deleteChatsByProjectWithIds(projectId)
        unpinChats(deletedChatIds)
        await reloadChats()
      } catch (error) {
        logError('Failed to delete project chats', error, {
          component: 'ChatInterface',
          action: 'handleDeleteProjectChats',
          metadata: { projectId },
        })

        // Rollback: reload chats to restore original state
        await reloadChats()

        throw error
      }
    },
    [isPremium, reloadChats, unpinChats],
  )

  // Handler for converting a local-only chat to cloud chat via drag and drop
  const handleConvertChatToCloud = useCallback(
    async (chatId: string): Promise<boolean> => {
      try {
        await chatStorage.convertChatToCloud(chatId)
        await reloadChats()

        toast({
          title: 'Chat moved to cloud',
          description: 'The chat will now sync across your devices.',
        })
        return true
      } catch (error) {
        logError('Failed to convert chat to cloud', error, {
          component: 'ChatInterface',
          action: 'handleConvertChatToCloud',
          metadata: { chatId },
        })

        toast({
          title: 'Failed to move chat to cloud',
          description: 'Please try again.',
          variant: 'destructive',
        })
        return false
      }
    },
    [reloadChats, toast],
  )

  const handleToggleFavorite = useCallback(
    async (favorite: Pick<Chat, 'id' | 'isLocalOnly'>) => {
      if (pinnedChatIds.includes(favorite.id)) {
        unpinChat(favorite.id)
        return
      }

      const accountId = authUserId
      const hydrationGeneration = favoriteHydrationGenerationRef.current
      let chat = chats.find((candidate) => candidate.id === favorite.id)
      if (!chat) {
        try {
          const hydration = await hydratePinnedChatById(favorite.id)
          if (
            hydration.status !== 'ready' ||
            currentFavoriteAccountRef.current !== accountId ||
            favoriteHydrationGenerationRef.current !== hydrationGeneration
          ) {
            return
          }
          chat = hydration.chat
          const loadedChat = chat
          setChats((current) => upsertChatById(current, loadedChat))
        } catch (error) {
          logError('Failed to load chat before pinning', error, {
            component: 'ChatInterface',
            action: 'handleToggleFavorite',
            metadata: { chatId: favorite.id },
          })
          return
        }
      }
      if (!canRequestChatPin(chat)) {
        return
      }
      if (chat.isLocalOnly && !(await handleConvertChatToCloud(chat.id))) return
      if (
        currentFavoriteAccountRef.current !== accountId ||
        favoriteHydrationGenerationRef.current !== hydrationGeneration
      ) {
        return
      }
      pinChat(chat.id)
    },
    [
      chats,
      authUserId,
      handleConvertChatToCloud,
      pinChat,
      pinnedChatIds,
      setChats,
      unpinChat,
    ],
  )

  const handleOpenFavorite = useCallback(
    async (favorite: Pick<Chat, 'id' | 'projectId'>) => {
      const generation = favoriteNavigationGenerationRef.current + 1
      favoriteNavigationGenerationRef.current = generation
      await openFavoriteChat({
        favorite,
        activeProjectId: activeProject?.id,
        isProjectMode,
        enterProjectMode: (projectId, isCurrent) =>
          enterProjectMode(projectId, undefined, { isCurrent }),
        exitProjectMode,
        openChat: (chatId) =>
          loadChatByIdWithoutNavigationInvalidation(chatId, false),
        isCurrent: () => favoriteNavigationGenerationRef.current === generation,
      })
    },
    [
      activeProject?.id,
      enterProjectMode,
      exitProjectMode,
      isProjectMode,
      loadChatByIdWithoutNavigationInvalidation,
    ],
  )

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

  // Handler for converting a cloud chat to local-only via drag and drop
  const handleConvertChatToLocal = useCallback(
    async (chatId: string): Promise<void> => {
      try {
        await chatStorage.convertChatToLocal(chatId)
        unpinChat(chatId)
        await reloadChats()

        toast({
          title: 'Chat moved to local',
          description: 'The chat is now only stored on this device.',
        })
      } catch (error) {
        logError('Failed to convert chat to local', error, {
          component: 'ChatInterface',
          action: 'handleConvertChatToLocal',
          metadata: { chatId },
        })

        toast({
          title: 'Failed to move chat to local',
          description: 'Please try again.',
          variant: 'destructive',
        })
      }
    },
    [reloadChats, toast, unpinChat],
  )

  // Helper to process file and add to chat attachments
  const processFileForChat = useCallback(
    async (file: File) => {
      const tempDocId = crypto.randomUUID()

      if (!isSupportedFile(file.name) && !(await isProbablyTextFile(file))) {
        setProcessedDocuments((prev) => [
          ...prev,
          {
            id: tempDocId,
            name: file.name,
            time: new Date(),
            isUnsupported: true,
          },
        ])
        return
      }

      setProcessedDocuments((prev) => [
        ...prev,
        {
          id: tempDocId,
          name: file.name,
          time: new Date(),
          isUploading: true,
        },
      ])

      await handleDocumentUpload(
        file,
        (content, documentId, imageData, hasDescription, pages) => {
          const newDocTokens = estimateTokenCount(content)
          const contextBudget = getContextTokenBudget(contextWindowTokens)

          // Attachments are part of the next message, which cannot be
          // archived, so all pending attachments together must fit within
          // the context budget.
          const pendingTokens = processedDocuments.reduce(
            (total, doc) => total + estimateTokenCount(doc.content),
            0,
          )

          if (pendingTokens + newDocTokens > contextBudget) {
            setProcessedDocuments((prev) =>
              prev.filter((doc) => doc.id !== tempDocId),
            )

            toast({
              title: 'Attachment too large for this model',
              description: `"${file.name}" needs ~${Math.round(newDocTokens / 1000)}k tokens but this model can fit ~${Math.round((contextBudget - pendingTokens) / 1000)}k. Remove an attachment or switch to a model with a larger context window.`,
              variant: 'destructive',
              position: 'top-right',
            })
            return
          }

          // Build an Attachment object from the upload result
          const attachment = buildAttachment({
            id: documentId,
            fileName: file.name,
            imageData: imageData ?? undefined,
            textContent: content ?? undefined,
            description: hasDescription && content ? content : undefined,
            pages,
          })

          setProcessedDocuments((prev) => {
            return prev.map((doc) =>
              doc.id === tempDocId
                ? {
                    id: documentId,
                    name: file.name,
                    time: new Date(),
                    content,
                    imageData,
                    attachment,
                    isImageDescription: !!imageData,
                    hasDescription: hasDescription ?? !!content,
                    isGeneratingDescription: false,
                  }
                : doc,
            )
          })
        },
        (error) => {
          setProcessedDocuments((prev) =>
            prev.filter((doc) => doc.id !== tempDocId),
          )

          toast({
            title: 'Processing failed',
            description: error.message || 'Failed to process document',
            variant: 'destructive',
            position: 'top-right',
          })
        },
        (documentId, imageData) => {
          // Called when image description generation starts
          const imgAttachment = buildAttachment({
            id: documentId,
            fileName: file.name,
            imageData: imageData ?? undefined,
          })

          setProcessedDocuments((prev) =>
            prev.map((doc) =>
              doc.id === tempDocId
                ? {
                    ...doc,
                    isUploading: false,
                    isGeneratingDescription: true,
                    imageData,
                    attachment: imgAttachment,
                  }
                : doc,
            ),
          )
        },
      )
    },
    [handleDocumentUpload, processedDocuments, contextWindowTokens, toast],
  )

  // Helper to process file and add to project context
  const addFileToProjectContext = useCallback(
    async (file: File) => {
      const uploadId = crypto.randomUUID()

      // Add to shared uploading state so sidebar shows progress
      addUploadingFile({
        id: uploadId,
        name: file.name,
        size: file.size,
      })

      // Open sidebar and expand documents section immediately
      sessionStorage.setItem(UI_EXPAND_PROJECT_DOCUMENTS, 'true')
      setIsSidebarOpen(true)

      await handleDocumentUpload(
        file,
        async (content, _documentId, _imageData, _hasDescription, pages) => {
          try {
            const projectContent = getDocumentTextContent(content, pages)
            if (!projectContent) {
              throw new Error('No readable content was found in this document.')
            }
            await uploadProjectDocument(file, projectContent)
          } catch (error) {
            toast({
              title: 'Upload failed',
              description:
                error instanceof Error
                  ? error.message
                  : 'Failed to add document to project context.',
              variant: 'destructive',
              position: 'top-right',
            })
          } finally {
            removeUploadingFile(uploadId)
          }
        },
        (error) => {
          toast({
            title: 'Processing failed',
            description: error.message || 'Failed to process document',
            variant: 'destructive',
            position: 'top-right',
          })
          removeUploadingFile(uploadId)
        },
        undefined,
        { requireTextContent: true },
      )
    },
    [
      handleDocumentUpload,
      uploadProjectDocument,
      toast,
      setIsSidebarOpen,
      addUploadingFile,
      removeUploadingFile,
    ],
  )

  // Handler for modal confirmation
  const handleAddToProjectConfirm = useCallback(
    async (addToProject: boolean) => {
      if (
        !pendingProjectUpload ||
        activeProject?.id !== pendingProjectUpload.projectId
      ) {
        setPendingProjectUpload(null)
        setShowAddToProjectModal(false)
        toast({
          title: 'Upload canceled',
          description: 'The file was not attached because the project changed.',
          variant: 'destructive',
          position: 'top-right',
        })
        return
      }

      // Capture files and close modal immediately
      const filesToUpload = pendingProjectUpload.files
      setPendingProjectUpload(null)
      setShowAddToProjectModal(false)

      // Then process uploads (UI will show upload progress)
      if (addToProject) {
        // Start all uploads before awaiting so every file registers its
        // "Uploading..." placeholder immediately, mirroring the sidebar's
        // own upload path. A sequential loop would surface one row at a
        // time as each upload finishes.
        await Promise.all(
          filesToUpload.map((file) => addFileToProjectContext(file)),
        )
      } else {
        for (const file of filesToUpload) {
          await processFileForChat(file)
        }
      }
    },
    [
      activeProject?.id,
      pendingProjectUpload,
      addFileToProjectContext,
      processFileForChat,
      toast,
    ],
  )

  // Document upload handler wrapper
  const handleFileUpload = useCallback(
    async (file: File) => {
      const projectTarget = resolveProjectUploadTarget({
        activeProjectId: activeProject?.id,
        loadingProjectId: loadingProject?.id,
      })

      await routeChatFileUpload(file, {
        projectTarget,
        requestDestination: (pendingFile, target) => {
          if (
            pendingProjectUpload &&
            pendingProjectUpload.projectId !== target.projectId
          ) {
            toast({
              title: 'Previous upload canceled',
              description: 'The project changed before the file was attached.',
              variant: 'destructive',
              position: 'top-right',
            })
          }
          setPendingProjectUpload((previous) => ({
            projectId: target.projectId,
            files:
              previous?.projectId === target.projectId
                ? [...previous.files, pendingFile]
                : [pendingFile],
          }))
          if (target.isReady) {
            setShowAddToProjectModal(true)
          }
        },
        processFileForChat,
      })
    },
    [
      activeProject,
      loadingProject,
      pendingProjectUpload,
      processFileForChat,
      toast,
    ],
  )

  // Global drag and drop handlers
  const handleGlobalDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const hasFiles = e.dataTransfer.types.includes('Files')
    if (hasFiles && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      dragCounterRef.current += 1
      if (dragCounterRef.current === 1) {
        setIsGlobalDragActive(true)
      }
    }
  }, [])

  const handleGlobalDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleGlobalDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) {
      setIsGlobalDragActive(false)
    }
  }, [])

  const handleGlobalDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      dragCounterRef.current = 0
      setIsGlobalDragActive(false)

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        for (const file of Array.from(files)) {
          handleFileUpload(file)
        }
      }
    },
    [handleFileUpload],
  )

  // Handler for removing documents
  const removeDocument = (id: string) => {
    setProcessedDocuments((prev) => prev.filter((doc) => doc.id !== id))
  }

  // Calculate context usage (memoized to prevent re-calculation during streaming)
  const contextUsage = useMemo(() => {
    const limitTokens = getContextTokenBudget(contextWindowTokens)

    let usedTokens = pendingContextTokens

    // Count tokens from messages (including their attachments), skipping
    // archived messages that are excluded from the prompt
    if (currentChat?.messages) {
      const messages = currentChat.messages
      const historyBudget = getHistoryTokenBudget(
        contextWindowTokens,
        pendingContextTokens,
      )
      const startIndex = findContextStartIndex(messages, historyBudget, {
        reasoningHistoryPolicy,
        keepMostRecent: pendingContextTokens === 0,
      })
      for (let i = startIndex; i < messages.length; i++) {
        usedTokens += estimateMessageTokens(messages[i], {
          reasoningHistoryPolicy,
        })
      }
    }

    return {
      percentage: (usedTokens / limitTokens) * 100,
      usedTokens,
      limitTokens,
    }
  }, [
    currentChat?.messages,
    contextWindowTokens,
    reasoningHistoryPolicy,
    pendingContextTokens,
  ])

  // Tracks whether the user already saw and dismissed the rate-limit modal
  // for the current depleted window. Without this, dismissing via the close
  // button immediately refocuses the textarea and the focus handler would
  // pop the same modal right back open.
  const rateLimitModalDismissedRef = useRef(false)

  useEffect(() => {
    if (rateLimit && rateLimit.remaining > 0) {
      rateLimitModalDismissedRef.current = false
    }
  }, [rateLimit])

  const handleCloseSubscribePrompt = useCallback(() => {
    setIsSubscribePromptOpen(false)
    if (rateLimit && rateLimit.remaining <= 0) {
      rateLimitModalDismissedRef.current = true
    }
  }, [rateLimit])

  const handleInputFocusWithRateLimitCheck = useCallback(() => {
    if (
      rateLimit &&
      rateLimit.remaining <= 0 &&
      rateLimit.kind !== 'hourly' &&
      !rateLimitModalDismissedRef.current
    ) {
      setIsSubscribePromptOpen(true)
    }
    handleInputFocus()
  }, [rateLimit, handleInputFocus])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (isChatHydrating) return

    if (rateLimit && rateLimit.remaining <= 0 && rateLimit.kind !== 'hourly') {
      setIsSubscribePromptOpen(true)
      return
    }

    const messageText = input.trim()
    const attachments = buildCompletedAttachments(processedDocuments)

    // Don't proceed if there's no input text, no quote, and no documents
    if (!messageText && !quote && attachments.length === 0) {
      return
    }

    // Don't auto-scroll here - let the message append handler do it
    // This prevents the dip when thoughts start streaming

    setInput('')
    submitMessage({
      text: messageText,
      attachments,
      quote: quote ?? undefined,
    })

    // Clear the quote after submission
    if (quote) {
      setQuote(null)
    }

    // Keep documents that are still uploading or generating descriptions
    const remainingDocuments = processedDocuments.filter(
      (doc) => doc.isUploading || doc.isGeneratingDescription,
    )
    setProcessedDocuments(remainingDocuments)
  }

  // Check if scroll button should be shown (throttled for performance)
  const checkScrollPosition = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return

    // Show button when user has scrolled up from the bottom by more than threshold
    // Subtract spacer height since it's empty space, not content
    const distanceFromBottom = getDistanceFromChatContentBottom(
      el.scrollHeight,
      el.scrollTop,
      el.clientHeight,
      getChatSpacerHeight(el),
    )
    const SCROLL_THRESHOLD = 200

    setShowScrollButton(distanceFromBottom > SCROLL_THRESHOLD)
  }, [])

  // Throttled scroll handler
  const lastScrollCheckRef = useRef<number>(0)
  const handleScroll = useCallback(() => {
    const now = Date.now()
    const timeSinceLastCheck = now - lastScrollCheckRef.current

    // Check immediately if enough time has passed since last check
    if (timeSinceLastCheck >= 100) {
      checkScrollPosition()
      lastScrollCheckRef.current = now
    } else {
      // Otherwise schedule a check after the remaining throttle time
      if (scrollCheckTimeoutRef.current) {
        clearTimeout(scrollCheckTimeoutRef.current)
      }
      scrollCheckTimeoutRef.current = setTimeout(() => {
        checkScrollPosition()
        lastScrollCheckRef.current = Date.now()
      }, 100 - timeSinceLastCheck)
    }
  }, [checkScrollPosition])

  // Check scroll position when content or layout changes
  useEffect(() => {
    checkScrollPosition()
    // Scroll to bottom when switching to a chat with messages
    if (currentChat?.messages && currentChat.messages.length > 0) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        scrollToBottom(false)
      }, 50)
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkScrollPosition, currentChat?.id, scrollToBottom])

  // Re-check button visibility when content size changes (no scrolling)
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return

    let rafId: number | null = null
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        checkScrollPosition()
        rafId = null
      })
    })

    const content = container.firstElementChild
    if (content) observer.observe(content)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [checkScrollPosition])

  // Re-check on window resize
  useEffect(() => {
    const onResize = () => checkScrollPosition()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [checkScrollPosition])

  // Re-check when messages/streaming state updates (no scrolling)
  useEffect(() => {
    checkScrollPosition()
  }, [
    checkScrollPosition,
    currentChat?.messages,
    isWaitingForResponse,
    loadingState,
  ])

  // Nudge scroll slightly when content starts after thinking, only if near bottom
  const contentStartSnapshotRef = useRef<{
    key: string
    contentLen: number
    wasThinking: boolean
  } | null>(null)
  const scrolledForContentStartKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const el = scrollContainerRef.current
    const messages = currentChat?.messages
    if (!el || !messages || messages.length === 0) return

    const last = messages[messages.length - 1]
    if (last.role !== 'assistant') {
      contentStartSnapshotRef.current = null
      return
    }

    const key = `${
      last.timestamp instanceof Date
        ? last.timestamp.getTime()
        : String(last.timestamp || '')
    }`

    const prev = contentStartSnapshotRef.current
    const prevSame = prev && prev.key === key
    const prevContentLen = prevSame ? prev.contentLen : 0
    const nowContentLen = (last.content || '').length
    const nowThinkingish = Boolean(
      last.isThinking ||
      ((last.thoughts || '').length > 0 && nowContentLen === 0),
    )

    const contentStartedNow =
      prevSame && prevContentLen === 0 && nowContentLen > 0
    const wasThinkingBefore = Boolean(prev?.wasThinking)

    if (
      contentStartedNow &&
      wasThinkingBefore &&
      scrolledForContentStartKeyRef.current !== key
    ) {
      const distanceFromBottom = getDistanceFromChatContentBottom(
        el.scrollHeight,
        el.scrollTop,
        el.clientHeight,
        getChatSpacerHeight(el),
      )
      const ANCHOR_THRESHOLD = 140
      const isNearBottom = distanceFromBottom <= ANCHOR_THRESHOLD
      if (isNearBottom) {
        scrolledForContentStartKeyRef.current = key
        el.scrollTo({ top: el.scrollTop + 120, behavior: 'smooth' })
      }
    }

    // Update snapshot
    contentStartSnapshotRef.current = {
      key,
      contentLen: nowContentLen,
      wasThinking: nowThinkingish || Boolean(prev?.wasThinking),
    }
  }, [currentChat?.messages])

  // Show loading while auth or config is still loading
  const needsAuthLoading = (initialChatId || initialProjectId) && !isAuthLoaded
  const needsLoading = needsAuthLoading || isLoadingConfig
  if (needsLoading || !logoAnimDone) {
    return (
      <LogoLoading
        isLoading={!!needsLoading}
        onFinished={handleLogoAnimFinished}
      />
    )
  }

  // Show sign-in required message when accessing a cloud chat/project URL while not signed in
  if (
    ((initialChatId && !isLocalChatUrl) || initialProjectId) &&
    isAuthLoaded &&
    !isSignedIn
  ) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="rounded-full bg-surface-chat p-4">
              <svg
                className="h-8 w-8 text-content-secondary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                />
              </svg>
            </div>
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Sign in required
          </h2>
          <p className="mb-6 text-content-secondary">
            You need to sign in to access this chat.
          </p>
          <Link
            href="/signin"
            className="inline-block rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Sign in
          </Link>
        </div>
      </div>
    )
  }

  // Show decryption failed message when accessing a chat that couldn't be decrypted
  if (initialChatId && initialChatDecryptionFailed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="rounded-full bg-surface-chat p-4">
              <svg
                className="h-8 w-8 text-orange-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                />
              </svg>
            </div>
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Unable to decrypt chat
          </h2>
          <p className="mb-6 text-content-secondary">
            This chat was encrypted with a different key. You can update the key
            in settings.
          </p>
          <button
            onClick={() => clearInitialChatDecryptionFailed()}
            className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  // Show local chat not found message when accessing a local chat URL that doesn't exist
  if (isLocalChatUrl && localChatNotFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="rounded-full bg-surface-chat p-4">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-content-secondary" />
            </div>
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Chat not found
          </h2>
          <p className="mb-6 text-content-secondary">
            This local chat may have been deleted from your browser.
          </p>
          <Link
            href="/"
            className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Start new chat
          </Link>
        </div>
      </div>
    )
  }

  // Cloud chat referenced by the URL does not exist on the server.
  if (cloudChatNotFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="rounded-full bg-surface-chat p-4">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-content-secondary" />
            </div>
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Chat not found
          </h2>
          <p className="mb-6 text-content-secondary">
            This chat may have been deleted or is no longer available.
          </p>
          <Link
            href="/"
            className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Start new chat
          </Link>
        </div>
      </div>
    )
  }

  // While the chat referenced by the URL is still being fetched, show a
  // loading screen instead of flashing the welcome screen before the chat
  // appears. The ref keeps later in-app chat switches from re-triggering it.
  if (
    initialChatId &&
    !initialUrlChatLoadedRef.current &&
    currentChat.id !== initialChatId &&
    !initialChatLoadFailed
  ) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-chat-background px-4 font-aeonik">
        <PiSpinner className="h-8 w-8 animate-spin text-content-secondary" />
        <p className="text-content-secondary">Loading chat...</p>
      </div>
    )
  }

  // Cloud chat failed to load due to a transient error (network, key
  // not ready, etc.). Offer a retry instead of silently landing on a
  // blank new chat and losing the URL.
  if (initialChatLoadFailed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="rounded-full bg-surface-chat p-4">
              <TfTinSad className="h-8 w-8 text-content-secondary" />
            </div>
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Couldn&apos;t load chat
          </h2>
          <p className="mb-6 text-content-secondary">
            A network error occurred while loading this chat. Please try again.
          </p>
          <div className="flex justify-center gap-3">
            <button
              onClick={retryInitialChatLoad}
              className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
            >
              Try again
            </button>
            <Link
              href="/"
              className="rounded-lg border border-border-subtle px-6 py-2.5 text-content-primary transition-colors hover:bg-surface-chat"
            >
              Start new chat
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Show error state if no models are available (configuration error)
  if (!isLoadingConfig && (configLoadFailed || models.length === 0)) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <TfTinSad className="h-24 w-24 text-content-secondary" />
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Something went wrong
          </h2>
          <p className="mb-6 text-content-secondary">
            Tinfoil Chat is experiencing some technical difficulties. We&apos;re
            working on resolving it. Please try again later.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Try Now
          </button>
        </div>
      </div>
    )
  }

  const showEmptyChatGrid =
    (currentChat?.messages.length ?? 0) === 0 && !isWaitingForResponse

  return (
    <div
      className="flex overflow-hidden bg-surface-chat-background"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 'var(--app-height, 100dvh)',
        maxHeight: 'var(--app-height, 100dvh)',
        minHeight: '-webkit-fill-available',
        overscrollBehavior: 'none',
      }}
      onDragEnter={handleGlobalDragEnter}
      onDragOver={handleGlobalDragOver}
      onDragLeave={handleGlobalDragLeave}
      onDrop={handleGlobalDrop}
    >
      <Head>
        <title>{documentTitle}</title>
      </Head>

      {/* Global drag and drop overlay */}
      {isGlobalDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4">
            <PiFilePlusLight className="h-20 w-20 text-white" />
            <p className="text-lg font-medium text-white">
              Drop files here to add to chat
            </p>
          </div>
        </div>
      )}

      {/* URL Hash Message Handler */}
      <UrlHashMessageHandler
        isReady={
          !isLoadingConfig && isClient && !!currentChat && hasValidatedModel
        }
        onMessageReady={(message) => {
          handleQuery(message)
        }}
      />

      {/* URL Hash Settings Handler */}
      <UrlHashSettingsHandler
        isReady={
          !isLoadingConfig && isClient && !!currentChat && hasValidatedModel
        }
        onSettingsTabReady={(tab) => {
          setSettingsInitialTab(tab)
          setHasMountedSettingsModal(true)
          setIsSettingsModalOpen(true)
          handleSetVerifierSidebarOpen(false)
          if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
            setIsSidebarOpen(false)
          }
        }}
      />

      {/* Mobile sidebar toggle - only visible when collapsed sidebar rail is hidden */}
      {windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT &&
        !isSidebarOpen &&
        !(isVerifierSidebarOpen || isSettingsModalOpen || isAskSidebarOpen) && (
          <div className="group relative">
            <button
              className="fixed left-4 top-4 z-50 flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:bg-surface-chat hover:text-content-primary"
              onClick={() => {
                setIsSidebarOpen(true)
                setIsVerifierSidebarOpen(false)
                setIsSettingsModalOpen(false)
              }}
              aria-label="Open sidebar"
            >
              <GoSidebarCollapse className="h-5 w-5" />
            </button>
            <span className="pointer-events-none fixed left-4 top-16 z-50 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              Open sidebar{' '}
              <span className="ml-1.5 text-content-muted">{modKey}.</span>
            </span>
          </div>
        )}

      {/* Temporary chat indicator (top-left, fills inner corner) */}
      {(isTemporaryMode || currentChat?.isTemporary) && (
        <div
          className="pointer-events-none fixed top-0 z-40 flex items-center gap-1.5 rounded-br-lg bg-[hsl(18,90%,92%)] py-7 pl-16 pr-3 text-xs font-medium text-orange-600 transition-all duration-300 dark:bg-[hsl(20,40%,15%)] dark:text-orange-500 md:py-2 md:pl-3"
          style={{
            left: (() => {
              const isMobile = windowWidth < CONSTANTS.MOBILE_BREAKPOINT
              if (isMobile) {
                return isSidebarOpen ? '-9999px' : '0px'
              }
              if (isSidebarOpen) {
                return `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`
              }
              return `${CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX}px`
            })(),
          }}
        >
          <SlGhost className="h-3.5 w-3.5 shrink-0" />
          <span>Temporary chat</span>
        </div>
      )}

      {/* Right side toggle buttons */}
      {!(
        windowWidth < CONSTANTS.MOBILE_BREAKPOINT &&
        (isSidebarOpen ||
          isVerifierSidebarOpen ||
          isSettingsModalOpen ||
          isAskSidebarOpen ||
          isArtifactSidebarOpen)
      ) && (
        <div
          className="fixed top-4 z-50 flex gap-2 transition-all duration-300"
          style={{
            right:
              windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
                ? isArtifactSidebarOpen
                  ? `${artifactSidebarWidth + 24}px`
                  : isAskSidebarOpen
                    ? `${CONSTANTS.ASK_SIDEBAR_WIDTH_PX + 24}px`
                    : isVerifierSidebarOpen
                      ? `${CONSTANTS.VERIFIER_SIDEBAR_WIDTH_PX + 24}px`
                      : '16px'
                : '16px',
          }}
        >
          {/* New chat button - only show on mobile when there are messages */}
          {windowWidth < CONSTANTS.MOBILE_BREAKPOINT &&
            currentChat?.messages &&
            currentChat.messages.length > 0 && (
              <Link
                href={getNewChatPath({
                  isLocalOnly: currentChat.isLocalOnly,
                  projectId: activeProject?.id,
                })}
                onClick={(e) => {
                  if (!isPlainPrimaryClick(e)) return
                  e.preventDefault()
                  createNewChat(currentChat.isLocalOnly, true)
                }}
                className="flex items-center justify-center rounded-lg border border-border-subtle bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:bg-surface-chat hover:text-content-primary"
                aria-label="New chat"
              >
                <PiNotePencilLight className="h-4 w-4" />
              </Link>
            )}

          {canToggleTemporaryChat(currentChat) &&
            (() => {
              const hasMessages =
                !!currentChat?.messages && currentChat.messages.length > 0
              const label = isTemporaryMode
                ? hasMessages
                  ? 'Save chat'
                  : 'Exit temporary chat'
                : 'Temporary chat'
              return (
                <div className="group relative">
                  <button
                    type="button"
                    onClick={handleToggleTemporaryMode}
                    aria-label={label}
                    aria-pressed={isTemporaryMode}
                    className={cn(
                      'flex items-center justify-center rounded-lg border p-2.5 transition-all duration-200',
                      isTemporaryMode
                        ? 'border-orange-500/40 bg-surface-chat-background bg-gradient-to-b from-orange-500/15 to-orange-500/15 text-orange-500 hover:from-orange-500/25 hover:to-orange-500/25'
                        : 'border-border-subtle bg-surface-chat-background text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                    )}
                  >
                    <SlGhost className="h-4 w-4" />
                  </button>
                  <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                    {label}
                  </span>
                </div>
              )
            })()}

          {/* Share button - only show when there are messages and chat is not temporary */}
          {!currentChat?.isTemporary &&
            currentChat?.messages &&
            currentChat.messages.length > 0 && (
              <button
                type="button"
                onClick={handleOpenShareModal}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:bg-surface-chat hover:text-content-primary md:px-3 md:py-2"
                aria-label="Share"
              >
                <IoShareOutline className="h-4 w-4" />
                <span className="hidden text-sm md:inline">Share</span>
              </button>
            )}

          {/* Verifier toggle button */}
          <div className="group relative">
            <button
              id="verification-status"
              className={cn(
                'relative flex items-center justify-center gap-2 rounded-lg border border-border-subtle p-2.5 transition-all duration-200',
                'bg-surface-chat-background text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                isVerifierSidebarOpen &&
                  'cursor-default bg-surface-chat text-content-muted hover:text-content-muted',
              )}
              onClick={handleOpenVerifierSidebar}
              aria-label={
                isVerifierSidebarOpen
                  ? 'Close verification panel'
                  : 'Open verification panel'
              }
              aria-pressed={isVerifierSidebarOpen}
            >
              {verificationStatus === 'pending' ? (
                <>
                  <PiSpinner className="h-4 w-4 animate-spin" />
                  <span className="text-sm leading-none">Verifying...</span>
                </>
              ) : verificationStatus === 'verified' ? (
                <>
                  <BiSolidLock className="h-4 w-4 text-brand-accent-dark dark:text-brand-accent-light" />
                  <span className="text-sm leading-none text-brand-accent-dark dark:text-brand-accent-light">
                    Verified
                  </span>
                </>
              ) : (
                <>
                  <BiSolidLockOpen className="h-4 w-4 text-red-500" />
                  <span className="text-sm leading-none text-red-500">
                    Error
                  </span>
                </>
              )}
            </button>
            <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              {isVerifierSidebarOpen ? 'Close verification' : 'View details'}
            </span>
          </div>
        </div>
      )}

      {/* Left Sidebar Component - Show ProjectSidebar when in project mode or loading */}
      <DragProvider>
        <AnimatePresence mode="wait" initial={false}>
          {isProjectMode || loadingProject ? (
            <motion.div
              key="sidebar-project-context"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="z-40"
            >
              {isProjectMode && activeProject ? (
                <ProjectSidebar
                  isOpen={isSidebarOpen}
                  setIsOpen={setIsSidebarOpen}
                  project={activeProject}
                  isDarkMode={isDarkMode}
                  pixelateSidebarChatTitles={pixelateSidebarChatTitles}
                  onExitProject={handleExitProject}
                  onExitProjectWhileDragging={handleExitProjectWhileDragging}
                  onNewChat={() => createNewChat(false, true)}
                  onSelectChat={handleChatSelect}
                  currentChatId={currentChat?.id}
                  isClient={isClient}
                  chats={chats
                    .filter((c) => c.projectId === activeProject.id)
                    .map((c) => ({
                      id: c.id,
                      title: c.title,
                      messageCount: c.isMetadataOnly
                        ? (c.messageCount ?? 0)
                        : c.messages.length,
                      createdAt: c.createdAt,
                      updatedAt: c.updatedAt,
                      projectId: c.projectId,
                      isBlankChat: c.isBlankChat,
                      decryptionFailed: c.decryptionFailed,
                      dataCorrupted: c.dataCorrupted,
                      isTemporary: c.isTemporary,
                      pendingSave: c.pendingSave,
                    }))}
                  deleteChat={deleteChat}
                  updateChatTitle={updateChatTitle}
                  onEncryptionKeyClick={
                    isSignedIn ? handleOpenEncryptionKeyModal : undefined
                  }
                  onRemoveChatFromProject={handleRemoveChatFromProject}
                  onDeleteProjectChats={handleDeleteProjectChats}
                  onAddChatToProject={(chatId) =>
                    handleMoveChatToProject(chatId, activeProject.id)
                  }
                  onMoveChatToProject={handleMoveChatToProject}
                  projects={projects.map((p) => ({
                    id: p.id,
                    name: p.name,
                  }))}
                  onSettingsClick={handleOpenSettingsModal}
                  favoriteChats={favoriteChats}
                  pinnedChatIds={pinnedChatIds}
                  onToggleFavorite={handleToggleFavorite}
                  onRemoveFavorite={unpinChat}
                  onOpenFavorite={handleOpenFavorite}
                  cloudSyncEnabled={cloudSyncSettingEnabled}
                  windowWidth={windowWidth}
                  onManualSync={handleManualSync}
                  isSyncing={syncing}
                  lastSyncFailed={lastSyncFailed}
                />
              ) : (
                <ProjectSidebar
                  isOpen={isSidebarOpen}
                  setIsOpen={setIsSidebarOpen}
                  project={null}
                  loadingProjectId={loadingProject?.id}
                  projectName={loadingProject?.name}
                  isLoading={true}
                  isDarkMode={isDarkMode}
                  pixelateSidebarChatTitles={pixelateSidebarChatTitles}
                  onExitProject={handleExitProject}
                  onExitProjectWhileDragging={handleExitProjectWhileDragging}
                  onNewChat={() => {}}
                  onSelectChat={handleChatSelect}
                  currentChatId={currentChat?.id}
                  isClient={isClient}
                  chats={chats
                    .filter((c) => c.projectId === loadingProject?.id)
                    .map((c) => ({
                      id: c.id,
                      title: c.title,
                      messageCount: c.isMetadataOnly
                        ? (c.messageCount ?? 0)
                        : c.messages.length,
                      createdAt: c.createdAt,
                      updatedAt: c.updatedAt,
                      projectId: c.projectId,
                      isBlankChat: c.isBlankChat,
                      decryptionFailed: c.decryptionFailed,
                      dataCorrupted: c.dataCorrupted,
                      isTemporary: c.isTemporary,
                      pendingSave: c.pendingSave,
                    }))}
                  deleteChat={deleteChat}
                  updateChatTitle={updateChatTitle}
                  onSettingsClick={handleOpenSettingsModal}
                  favoriteChats={favoriteChats}
                  pinnedChatIds={pinnedChatIds}
                  onToggleFavorite={handleToggleFavorite}
                  onRemoveFavorite={unpinChat}
                  onOpenFavorite={handleOpenFavorite}
                  cloudSyncEnabled={cloudSyncSettingEnabled}
                  windowWidth={windowWidth}
                  onManualSync={handleManualSync}
                  isSyncing={syncing}
                  lastSyncFailed={lastSyncFailed}
                />
              )}
            </motion.div>
          ) : (
            <motion.div
              key="sidebar-chat-context"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="z-40"
            >
              <ChatSidebar
                isOpen={isSidebarOpen}
                setIsOpen={setIsSidebarOpen}
                chats={chats}
                currentChat={currentChat}
                isDarkMode={isDarkMode}
                pixelateSidebarChatTitles={pixelateSidebarChatTitles}
                createNewChat={createNewChat}
                handleChatSelect={handleChatSelect}
                onOpenChatById={(chatId) => loadChatById(chatId, false)}
                updateChatTitle={updateChatTitle}
                deleteChat={deleteChat}
                isClient={isClient}
                isPremium={isPremium}
                isSubscriptionLoading={isSubscriptionLoading}
                onEncryptionKeyClick={
                  isSignedIn ? handleOpenEncryptionKeyModal : undefined
                }
                onCloudSyncSetupClick={
                  isSignedIn ? handleOpenCloudSyncSetup : undefined
                }
                passkeySetupAvailable={passkeySetupAvailable}
                onSetupPasskey={setupPasskey}
                onAddPasskeyToThisDevice={addPasskeyToThisDevice}
                passkeyAddDeviceAvailable={passkeyAddDeviceAvailable}
                backupWarningVisible={
                  isSignedIn &&
                  (passkeySetupFailed || manualRecoveryNeeded) &&
                  !passkeyRecoveryNeeded
                }
                backupWarningNeedsRecovery={manualRecoveryNeeded}
                onDismissBackupWarning={dismissBackupWarning}
                onChatsUpdated={reloadChats}
                isInitialChatPageReady={
                  chatPagination.userId === authUserId && chatPagination.isReady
                }
                onManualSync={handleManualSync}
                isSyncing={syncing}
                lastSyncFailed={lastSyncFailed}
                isProjectMode={isProjectMode}
                activeProjectName={activeProject?.name}
                onEnterProject={async (projectId, projectName) => {
                  // Create a new blank chat before entering project mode
                  // This prevents the current chat from being associated with the project
                  await openProjectChat({
                    projectId,
                    projectName,
                    createNewChat,
                    enterProjectMode,
                  })
                }}
                onCreateProject={handleCreateProject}
                onMoveChatToProject={handleMoveChatToProject}
                onRemoveChatFromProject={handleRemoveChatFromProject}
                onConvertChatToCloud={handleConvertChatToCloud}
                onConvertChatToLocal={handleConvertChatToLocal}
                onSettingsClick={handleOpenSettingsModal}
                pinnedChatIds={pinnedChatIds}
                onToggleFavorite={handleToggleFavorite}
                onRemoveFavorite={unpinChat}
                onOpenFavorite={handleOpenFavorite}
                windowWidth={windowWidth}
                chatDecryptionProgress={decryptionProgress}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </DragProvider>

      {/* Right Verifier Sidebar */}
      {hasMountedVerifierSidebar && (
        <VerifierSidebarLazy
          isOpen={isVerifierSidebarOpen}
          setIsOpen={handleSetVerifierSidebarOpen}
          onVerificationComplete={(success) =>
            setVerificationStatus(success ? 'verified' : 'failed')
          }
          onVerificationUpdate={setVerificationDocument}
          isDarkMode={isDarkMode}
          isClient={isClient}
        />
      )}

      {/* Ask Sidebar - ephemeral, context-aware side conversation seeded from
          highlighted text. Discarded on close or on the next "Ask" click. */}
      <AskSidebar
        isOpen={isAskSidebarOpen}
        onClose={() => {
          setIsAskSidebarOpen(false)
          sidebarChat.reset()
        }}
        onQuote={(text) => {
          // Highlighting text inside the sidebar quotes back into the main
          // chat's input. The sidebar itself has no input.
          setQuote(text)
          setIsAskSidebarOpen(false)
          sidebarChat.reset()
          // Defer focus so the layout has settled after the sidebar closes.
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
        state={sidebarChat}
        models={models}
        selectedModel={selectedModel}
        isDarkMode={isDarkMode}
      />

      <ArtifactSidebar
        isOpen={isArtifactSidebarOpen}
        onClose={() => setIsArtifactSidebarOpen(false)}
        artifact={artifactPreview}
        isDarkMode={isDarkMode}
        width={artifactSidebarWidth}
        onWidthChange={setArtifactSidebarWidth}
        isResizable={windowWidth >= CONSTANTS.MOBILE_BREAKPOINT}
      />

      {/* Share Modal */}
      {hasMountedShareModal && (
        <ShareModalLazy
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          messages={currentChat?.messages || []}
          isDarkMode={isDarkMode}
          isSidebarOpen={
            isSidebarOpen && windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
          }
          isRightSidebarOpen={
            (isVerifierSidebarOpen ||
              isSettingsModalOpen ||
              isAskSidebarOpen ||
              isArtifactSidebarOpen) &&
            windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
          }
          chatTitle={currentChat?.title}
          chatCreatedAt={currentChat?.createdAt}
          chatId={currentChat?.id}
        />
      )}

      {/* Prompt Library Modal */}
      {hasMountedPromptLibrary && (
        <PromptLibraryModalLazy
          isOpen={isPromptLibraryModalOpen}
          onClose={handleClosePromptLibrary}
          activePresetId={activePresetId}
          onSelectPreset={handleSetActivePreset}
          isSidebarOpen={
            isSidebarOpen && windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
          }
          isRightSidebarOpen={
            (isVerifierSidebarOpen ||
              isSettingsModalOpen ||
              isAskSidebarOpen ||
              isArtifactSidebarOpen) &&
            windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
          }
        />
      )}

      {/* Settings Modal */}
      {hasMountedSettingsModal && (
        <SettingsModalLazy
          isOpen={isSettingsModalOpen}
          setIsOpen={setIsSettingsModalOpen}
          isDarkMode={isDarkMode}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          isClient={isClient}
          defaultSystemPrompt={systemPrompt}
          onOpenPromptLibrary={handleOpenPromptLibrary}
          onCloudSyncSetupClick={
            isSignedIn ? handleOpenCloudSyncSetup : undefined
          }
          onChatsUpdated={reloadChats}
          isSignedIn={isSignedIn}
          isPremium={isPremium}
          encryptionKey={encryptionKey}
          passkeyActive={passkeyActive}
          passkeySetupAvailable={passkeySetupAvailable}
          passkeyAddDeviceAvailable={passkeyAddDeviceAvailable}
          onSetupPasskey={setupPasskey}
          onAddPasskeyToThisDevice={addPasskeyToThisDevice}
          onRefreshBundleState={refreshBundleState}
          initialTab={settingsInitialTab}
          chats={chats}
        />
      )}

      {/* Main Chat Area - Modified for sliding effect */}
      <div
        className="absolute overflow-hidden transition-all duration-200"
        style={{
          right:
            windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
              ? isArtifactSidebarOpen
                ? `${artifactSidebarWidth}px`
                : isAskSidebarOpen
                  ? `${CONSTANTS.ASK_SIDEBAR_WIDTH_PX}px`
                  : isVerifierSidebarOpen
                    ? `${CONSTANTS.VERIFIER_SIDEBAR_WIDTH_PX}px`
                    : '0'
              : '0',
          bottom: 0,
          left:
            windowWidth >= CONSTANTS.MOBILE_BREAKPOINT
              ? isSidebarOpen
                ? `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`
                : `${CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX}px`
              : '0',
          top: 0,
        }}
      >
        {(isProjectMode && activeProject) || loadingProject ? (
          <ProjectModeIndicator
            projectName={activeProject?.name || loadingProject?.name || ''}
            color={activeProject?.color}
          />
        ) : null}
        <div
          className={cn(
            'relative flex h-full flex-col transition-colors',
            isTemporaryMode
              ? 'bg-orange-500/15 p-2'
              : 'bg-surface-chat-background',
          )}
        >
          <div
            className={cn(
              'relative flex h-full flex-col',
              isTemporaryMode
                ? 'overflow-hidden rounded-lg bg-surface-chat-background'
                : '',
            )}
          >
            {showEmptyChatGrid && <GridTexture />}
            {/* Rate Limit Banner (desktop) — on mobile this renders as a
                floating pill above the chat input instead. */}
            {shouldShowRateLimitBanner(rateLimit) && (
              <RateLimitBanner
                rateLimit={rateLimit}
                isDarkMode={isDarkMode}
                className="hidden md:flex"
              />
            )}

            {/* Messages Area */}
            <QuoteSelectionPopover
              containerRef={scrollContainerRef}
              onQuote={(text) => {
                setQuote(text)
                inputRef.current?.focus()
              }}
              onAsk={(text) => {
                setIsVerifierSidebarOpen(false)
                setIsSettingsModalOpen(false)
                setIsArtifactSidebarOpen(false)
                if (
                  windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT &&
                  isSidebarOpen
                ) {
                  setIsSidebarOpen(false)
                }
                setIsAskSidebarOpen(true)
                // Hand the current chat transcript to the sidebar so the model
                // can reason about the highlighted snippet in context. The
                // transcript is sent as a hidden user message; only the quote
                // and assistant reply are shown in the sidebar UI.
                sidebarChat.askQuote(text, currentChat?.messages ?? [])
              }}
            />
            <div className="relative flex min-h-0 flex-1">
              <ChatAnnouncer
                messages={currentChat?.messages || []}
                isStreaming={isStreaming}
                isWaitingForResponse={isWaitingForResponse}
              />
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                data-scroll-container="main"
                role="main"
                aria-label="Conversation"
                className={cn(
                  'relative z-0 flex-1 overflow-y-auto',
                  showEmptyChatGrid
                    ? 'bg-transparent'
                    : 'bg-surface-chat-background',
                )}
                style={
                  {
                    paddingBottom:
                      inputAreaHeight > 0
                        ? inputAreaHeight + CONSTANTS.CHAT_INPUT_BOTTOM_GAP_PX
                        : 0,
                    '--input-area-height': `${inputAreaHeight}px`,
                  } as React.CSSProperties
                }
              >
                <div className="flex min-h-full min-w-0 flex-1 [container-type:inline-size]">
                  {isChatHydrating ? (
                    <div
                      className="flex min-h-full flex-1 items-center justify-center text-content-secondary"
                      role="status"
                      aria-label="Loading chat history"
                    >
                      <PiSpinner className="h-6 w-6 animate-spin" />
                    </div>
                  ) : (
                    <ChatMessages
                      messages={currentChat?.messages || []}
                      pendingRecoveries={currentChat?.pendingRecoveries}
                      recoveryDrafts={recoveryDrafts}
                      activeRecoveryTurnIds={activeRecoveryTurnIds}
                      reasoningHistoryPolicy={reasoningHistoryPolicy}
                      contextWindowTokens={contextWindowTokens}
                      pendingContextTokens={pendingContextTokens}
                      isDarkMode={isDarkMode}
                      chatId={currentChat.id}
                      isWaitingForResponse={isWaitingForResponse}
                      isStreamingResponse={isStreaming}
                      activeArtifactToolCallId={
                        isArtifactSidebarOpen ? activeArtifactToolCallId : null
                      }
                      isPremium={isPremium}
                      models={models}
                      onSubmit={handleSubmit}
                      input={input}
                      setInput={setInput}
                      loadingState={loadingState}
                      retryInfo={retryInfo}
                      cancelGeneration={cancelGenerationAndResumeQueue}
                      inputRef={inputRef}
                      handleInputFocus={handleInputFocusWithRateLimitCheck}
                      handleDocumentUpload={handleFileUpload}
                      processedDocuments={processedDocuments}
                      removeDocument={removeDocument}
                      selectedModel={selectedModel}
                      handleModelSelect={handleModelSelect}
                      expandedLabel={expandedLabel}
                      handleLabelClick={handleLabelClick}
                      onEditMessage={editMessage}
                      onRegenerateMessage={regenerateMessage}
                      onDeleteMessage={
                        currentChat.messages.length > 1
                          ? deleteMessage
                          : undefined
                      }
                      onEditAssistantMessage={editAssistantMessage}
                      onContinueAssistantMessage={continueAssistantMessage}
                      onRetryToolCall={retryToolCall}
                      showScrollButton={showScrollButton}
                      webSearchEnabled={effectiveWebSearchEnabled}
                      onWebSearchToggle={
                        webSearchAvailable ? handleWebSearchToggle : undefined
                      }
                      reasoningEffort={reasoningEffort}
                      setReasoningEffort={setReasoningEffort}
                      thinkingEnabled={thinkingEnabled}
                      setThinkingEnabled={setThinkingEnabled}
                      autoIntelligence={autoIntelligence}
                      setAutoIntelligence={setAutoIntelligence}
                      codeExecutionEnabled={
                        canEnableCodeExecution ? codeExecutionEnabled : false
                      }
                      onCodeExecutionToggle={
                        canEnableCodeExecution
                          ? handleCodeExecutionToggle
                          : undefined
                      }
                      isTemporaryMode={isTemporaryMode}
                      activePromptPreset={activePreset}
                      onOpenPromptLibrary={handleOpenPromptLibrary}
                      onSelectPromptPreset={handleSetActivePreset}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Input Form - Show on mobile always, on desktop only when there are messages */}
            {isClient &&
              !isChatHydrating &&
              (windowWidth < CONSTANTS.MOBILE_BREAKPOINT ||
                (currentChat?.messages && currentChat.messages.length > 0)) && (
                <div
                  ref={inputAreaRef}
                  data-chat-input-area
                  className="pointer-events-none absolute inset-x-0 bottom-0 isolate z-20 px-4 pb-4"
                  style={{
                    minHeight: '80px',
                    maxHeight: '50dvh',
                    paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)',
                  }}
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-0"
                    style={{
                      top: `-${CONSTANTS.CHAT_INPUT_FADE_HEIGHT_PX}px`,
                      background: `linear-gradient(to bottom, hsl(var(--surface-chat-background) / 0) 0%, hsl(var(--surface-chat-background)) ${CONSTANTS.CHAT_INPUT_FADE_SOLID_AT_PX}px)`,
                    }}
                  />
                  {selectPendingInputToolCallFromChat(currentChat) ? (
                    <div className="pointer-events-auto relative z-10 mx-auto max-w-3xl rounded-xl border border-border-subtle bg-surface-card p-3 px-1 md:px-8">
                      <GenUIInputAreaRenderer
                        pending={selectPendingInputToolCallFromChat(
                          currentChat,
                        )!}
                        isDarkMode={isDarkMode}
                        onResolve={resolveInputToolCall}
                      />
                    </div>
                  ) : (
                    <form
                      onSubmit={handleSubmit}
                      className="pointer-events-auto relative z-10 mx-auto max-w-3xl px-1 md:px-8"
                    >
                      {shouldShowRateLimitBanner(rateLimit) && (
                        <RateLimitBanner
                          rateLimit={rateLimit}
                          isDarkMode={isDarkMode}
                          className="mb-2 flex md:hidden"
                          pillClassName="rounded-full border"
                        />
                      )}
                      {streamError && (
                        <StreamErrorBanner
                          error={streamError}
                          onDismiss={dismissStreamError}
                          onRetry={retryLastMessage}
                          isDarkMode={isDarkMode}
                        />
                      )}
                      <MessageQueue
                        queue={queuedMessages}
                        onRemove={removeQueuedMessage}
                        onSend={sendQueuedMessage}
                      />
                      <ChatInput
                        input={input}
                        setInput={setInput}
                        handleSubmit={handleSubmit}
                        loadingState={loadingState}
                        cancelGeneration={cancelGenerationAndResumeQueue}
                        inputRef={inputRef}
                        handleInputFocus={handleInputFocusWithRateLimitCheck}
                        inputMinHeight={inputMinHeight}
                        isDarkMode={isDarkMode}
                        handleDocumentUpload={handleFileUpload}
                        processedDocuments={processedDocuments}
                        removeDocument={removeDocument}
                        isPremium={isPremium}
                        contextUsage={contextUsage}
                        quote={quote}
                        onClearQuote={() => setQuote(null)}
                        isTemporaryMode={isTemporaryMode}
                        activePromptPreset={activePreset}
                        onOpenPromptLibrary={handleOpenPromptLibrary}
                        onClearPromptPreset={() => handleSetActivePreset(null)}
                        mobileHeader={
                          // With a preset active, the preset tab attached to
                          // the input card already opens the library; the
                          // mobile Prompts button would collide with it.
                          !currentChat?.messages?.length && !activePreset ? (
                            <div className="mb-3 md:hidden">
                              <PromptPresetSuggestions
                                activePreset={activePreset}
                                onSetActive={handleSetActivePreset}
                                onOpenLibrary={handleOpenPromptLibrary}
                              />
                            </div>
                          ) : undefined
                        }
                        hasMessages={
                          currentChat?.messages &&
                          currentChat.messages.length > 0
                        }
                        audioModel={
                          (
                            models.find(
                              (m) =>
                                m.modelName === CONSTANTS.DEFAULT_AUDIO_MODEL,
                            ) || models.find((m) => m.type === 'audio')
                          )?.modelName
                        }
                        modelSelectorButton={
                          models.length > 0 &&
                          selectedModel &&
                          handleModelSelect ? (
                            <div className="relative">
                              <button
                                type="button"
                                data-model-selector
                                aria-haspopup="menu"
                                aria-expanded={expandedLabel === 'model'}
                                aria-label={`Current model ${getSelectedModelLabel(selectedModel, models, autoIntelligence) ?? ''}`}
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleLabelClick('model', () => {})
                                }}
                                className="flex items-center gap-1 py-1.5 text-content-secondary transition-colors hover:text-content-primary"
                              >
                                <ModelSelectorTriggerLabel
                                  selectedModel={selectedModel}
                                  models={models}
                                  autoIntelligence={autoIntelligence}
                                  isOpen={expandedLabel === 'model'}
                                />
                              </button>

                              {expandedLabel === 'model' && (
                                <ModelSelector
                                  selectedModel={selectedModel}
                                  onSelect={handleModelSelect}
                                  isDarkMode={isDarkMode}
                                  models={models}
                                  reasoningEffort={reasoningEffort}
                                  onEffortChange={setReasoningEffort}
                                  thinkingEnabled={thinkingEnabled}
                                  onThinkingEnabledChange={setThinkingEnabled}
                                  autoIntelligence={autoIntelligence}
                                  onAutoIntelligenceChange={setAutoIntelligence}
                                />
                              )}
                            </div>
                          ) : undefined
                        }
                        webSearchEnabled={effectiveWebSearchEnabled}
                        onWebSearchToggle={
                          webSearchAvailable ? handleWebSearchToggle : undefined
                        }
                        codeExecutionEnabled={
                          canEnableCodeExecution ? codeExecutionEnabled : false
                        }
                        onCodeExecutionToggle={
                          canEnableCodeExecution
                            ? handleCodeExecutionToggle
                            : undefined
                        }
                      />
                    </form>
                  )}

                  {/* Scroll to bottom button - absolutely positioned in parent */}
                  {showScrollButton && currentChat?.messages?.length > 0 && (
                    <div className="pointer-events-auto absolute -top-[50px] left-1/2 z-10 -translate-x-1/2">
                      <button
                        onClick={() => scrollToLastMessage()}
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-border-subtle bg-surface-sidebar-button shadow-md transition-colors hover:bg-surface-sidebar-button-hover"
                        aria-label="Scroll to bottom"
                      >
                        <ArrowDownIcon
                          className="h-4 w-4 text-content-secondary"
                          strokeWidth={2}
                        />
                      </button>
                    </div>
                  )}
                </div>
              )}
          </div>
        </div>
      </div>

      {/* Cloud Sync Setup Modal - manually triggered from settings */}
      {showCloudSyncSetupModal && (
        <CloudSyncSetupModal
          isOpen={showCloudSyncSetupModal}
          onClose={() => {
            setShowCloudSyncSetupModal(false)
            if (passkeyFirstTimePromptAvailable) {
              dismissFirstTimePasskeyPrompt()
            }
            // If no key was set, turn off cloud sync
            if (!encryptionService.getKey()) {
              setCloudSyncEnabled(false)
            }
          }}
          onSetupComplete={async (key: string, mode) => {
            try {
              await handleKeyChanged(key, { mode })
              if (mode === 'explicitStartFresh') {
                void backupStartFreshKeyWithPasskey()
              }
              return { ok: true }
            } catch (error) {
              return { ok: false, reason: classifyCloudKeySetupError(error) }
            }
          }}
          isDarkMode={isDarkMode}
          prfSupported={
            passkeyActive ||
            passkeyRecoveryNeeded ||
            passkeySetupAvailable ||
            passkeyAddDeviceAvailable ||
            passkeyFirstTimePromptAvailable
          }
          passkeyRecoveryNeeded={passkeyRecoveryNeeded}
          manualRecoveryNeeded={manualRecoveryNeeded}
          passkeyRecoveryFailure={passkeyRecoveryFailure}
          isContinuePending={isCloudSyncRoutePending}
          onSetupWithPasskey={
            passkeyFirstTimePromptAvailable
              ? async () => {
                  setIsFirstTimePasskeySetupBusy(true)
                  try {
                    return await setupFirstTimePasskey()
                  } finally {
                    setIsFirstTimePasskeySetupBusy(false)
                  }
                }
              : undefined
          }
          isPasskeySetupBusy={isFirstTimePasskeySetupBusy}
          onSkipRecovery={() => {
            skipPasskeyRecovery()
            setShowCloudSyncSetupModal(false)
          }}
          onRecoverWithPasskey={async () => {
            const key = await recoverWithPasskey()
            if (!key) return false
            try {
              await handleKeyChanged(key, { mode: 'recoverExisting' })
            } catch {
              return false
            }
            return true
          }}
          onSetupNewKey={async () => {
            const key = await setupNewKeySplit()
            if (!key) return null
            try {
              await handleKeyChanged(key, { mode: 'explicitStartFresh' })
            } catch {
              return null
            }
            return key
          }}
        />
      )}

      {/* Add to Project Context Modal */}
      <AddToProjectContextModal
        isOpen={showAddToProjectModal}
        onClose={() => {
          setPendingProjectUpload(null)
          setShowAddToProjectModal(false)
        }}
        onConfirm={handleAddToProjectConfirm}
        fileName={
          pendingProjectUpload?.files.length === 1
            ? pendingProjectUpload.files[0].name
            : `${pendingProjectUpload?.files.length ?? 0} files`
        }
        projectName={activeProject?.name ?? ''}
        isDarkMode={isDarkMode}
      />

      <AnimatePresence>
        {showOnboarding && (
          <OnboardingView onComplete={() => setShowOnboarding(false)} />
        )}
      </AnimatePresence>

      <SubscribePromptModal
        isOpen={isSubscribePromptOpen}
        onClose={handleCloseSubscribePrompt}
        isSignedIn={!!isSignedIn}
      />
    </div>
  )
}
