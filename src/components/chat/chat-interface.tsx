import {
  getAIModels,
  getSystemPromptAndRules,
  type BaseModel,
} from '@/config/models'
import {
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO,
  SETTINGS_PII_CHECK_ENABLED,
  SETTINGS_WEB_SEARCH_ENABLED,
  UI_EXPAND_PROJECT_DOCUMENTS,
} from '@/constants/storage-keys'
import { useChatRouter } from '@/hooks/use-chat-router'
import { useProjects } from '@/hooks/use-projects'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { useToast } from '@/hooks/use-toast'
import {
  getRateLimitInfo,
  getSessionToken,
  invalidateAnonymousSessionCache,
  snapshotAndDecrementRemaining,
  type RateLimitInfo,
} from '@/services/inference/tinfoil-client'
import { generateTitle } from '@/services/inference/title'
import { SignInButton, useAuth, useUser } from '@clerk/nextjs'
import {
  ArrowDownIcon,
  ChatBubbleLeftRightIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { BiSolidLock, BiSolidLockOpen } from 'react-icons/bi'
import { GoSidebarCollapse } from 'react-icons/go'
import { IoShareOutline } from 'react-icons/io5'
import { PiFilePlusLight, PiNotePencilLight, PiSpinner } from 'react-icons/pi'
import { SlGhost } from 'react-icons/sl'

import {
  RateLimitBanner,
  shouldShowRateLimitBanner,
} from '@/components/chat/rate-limit-banner'
import { StreamErrorBanner } from '@/components/chat/stream-error-banner'
import { classifyCloudKeySetupError } from '@/components/modals/cloud-sync-setup-mode'
import {
  ProjectModeBanner,
  ProjectSidebar,
  useProject,
  useProjectSystemPrompt,
} from '@/components/project'
import { LogoLoading } from '@/components/ui/logo-loading'
import { cn } from '@/components/ui/utils'
import { CLOUD_SYNC } from '@/config'
import { useCloudSync } from '@/hooks/use-cloud-sync'
import { usePasskeyBackup } from '@/hooks/use-passkey-backup'
import { useProfileSync } from '@/hooks/use-profile-sync'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'

import { cloudSync } from '@/services/cloud/cloud-sync'
import { encryptionService } from '@/services/encryption/encryption-service'
import { generateCodeExecutionAccessToken } from '@/services/exec-snapshot/access-token'
import { isPrfSupported, PrfNotSupportedError } from '@/services/passkey'
import { chatStorage } from '@/services/storage/chat-storage'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { sessionChatStorage } from '@/services/storage/session-storage'
import {
  isCloudSyncEnabled,
  setCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { isProbablyTextFile, isSupportedFile } from '@/utils/file-types'
import {
  getProjectUploadPreference,
  setProjectUploadPreference,
} from '@/utils/project-upload-preference'
import { generateReverseId } from '@/utils/reverse-id'
import {
  estimateMessageTokens,
  estimateTokenCount,
  findContextStartIndex,
  getContextTokenBudget,
} from '@/utils/token-estimation'
import { TfTinSad } from '@tinfoilsh/tinfoil-icons'
import dynamic from 'next/dynamic'
import Head from 'next/head'
import {
  useLayoutEffect as reactUseLayoutEffect,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

const useLayoutEffect =
  typeof window !== 'undefined' ? reactUseLayoutEffect : useEffect

import { SubscribePromptModal } from '../modals/subscribe-prompt-modal'
import { UrlHashMessageHandler } from '../url-hash-message-handler'
import { UrlHashSettingsHandler } from '../url-hash-settings-handler'
import { ArtifactSidebar } from './artifact-sidebar'
import { AskSidebar } from './ask-sidebar'
import { ChatAnnouncer } from './chat-announcer'
import { ChatInput } from './chat-input'
import { ChatMessages } from './chat-messages'
import { ChatSidebar } from './chat-sidebar'
import { PromptPresetSuggestions } from './components/prompt-preset-suggestions'
import { CONSTANTS } from './constants'
import { useDocumentUploader } from './document-uploader'
import { DragProvider } from './drag-context'
import { GenUIInputAreaRenderer } from './genui/GenUIInputAreaRenderer'
import { selectPendingInputToolCallFromChat } from './genui/pending-input-tool-call'
import {
  artifactDetailsEqual,
  OPEN_ARTIFACT_PREVIEW_EVENT,
  type ArtifactPreviewSidebarDetail,
} from './genui/widgets/ArtifactPreview'
import { sortChats } from './hooks/chat-operations'
import { useChatState } from './hooks/use-chat-state'
import { useCustomSystemPrompt } from './hooks/use-custom-system-prompt'
import { useMessageQueue } from './hooks/use-message-queue'
import { usePromptLibrary } from './hooks/use-prompt-library'
import {
  isReasoningModel,
  supportsReasoningEffort,
  supportsThinkingToggle,
  useReasoningEffort,
  useThinkingEnabled,
} from './hooks/use-reasoning-effort'
import { useSidebarChat } from './hooks/use-sidebar-chat'
import { MessageQueue } from './message-queue'
import { ModelSelector } from './model-selector'
import { QuoteSelectionPopover } from './quote-selection-popover'
import { ReasoningEffortSelector } from './reasoning-effort-selector'
import { initializeRenderers } from './renderers/client'
import type { ProcessedDocument } from './renderers/types'
import type { SettingsTab } from './settings-modal'
import type { Attachment, Chat, DocumentPage } from './types'
// Lazy-load modals that aren't shown on initial load. The loaders are
// hoisted so they can be pre-warmed (see preloadCloudSyncModals) before
// the user clicks, keeping the chunk fetch off the click critical path.
const loadCloudSyncSetupModal = () => import('../modals/cloud-sync-setup-modal')
const loadPasskeySetupPromptModal = () =>
  import('../modals/passkey-setup-prompt-modal')

function preloadCloudSyncModals(): void {
  void loadCloudSyncSetupModal()
  void loadPasskeySetupPromptModal()
}

const CloudSyncSetupModal = dynamic(
  () => loadCloudSyncSetupModal().then((m) => m.CloudSyncSetupModal),
  { ssr: false },
)
const PasskeySetupPromptModal = dynamic(
  () => loadPasskeySetupPromptModal().then((m) => m.PasskeySetupPromptModal),
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

const OnboardingModal = dynamic(
  () => import('../onboarding/onboarding-modal').then((m) => m.OnboardingModal),
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
    opts.textContent ||
    opts.pages
      ?.map((p) => p.text)
      .filter(Boolean)
      .join('\n\n---\n\n')
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

export function ChatInterface({
  verificationState,
  minHeight,
  inputMinHeight = '28px',
  isDarkMode: propIsDarkMode,
  initialChatId,
  initialProjectId,
  isLocalChatUrl: isLocalChatUrlProp,
  suppressIntroModals = false,
}: ChatInterfaceProps) {
  const { toast } = useToast()
  const { isSignedIn, isLoaded: isAuthLoaded } = useAuth()
  // TODO: unflip this
  const canUseCodeExecution = false
  const { user } = useUser()
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null)
  const [isSubscribePromptOpen, setIsSubscribePromptOpen] = useState(false)

  // Onboarding state (must be defined before usePasskeyBackup so we can gate it)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const isExistingUser =
    !!user?.unsafeMetadata?.has_seen_passkey_intro ||
    (typeof window !== 'undefined' &&
      !!localStorage.getItem(SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO))
  const onboardingNeeded =
    isSignedIn &&
    !!user &&
    !user.unsafeMetadata?.has_completed_onboarding &&
    !isExistingUser

  // Backfill: ensure existing users also get the onboarding flag set
  useEffect(() => {
    if (
      isSignedIn &&
      user &&
      isExistingUser &&
      !user.unsafeMetadata?.has_completed_onboarding
    ) {
      user
        .update({
          unsafeMetadata: {
            ...user.unsafeMetadata,
            has_completed_onboarding: true,
          },
        })
        .catch(() => {})
    }
  }, [isSignedIn, user, isExistingUser])

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
  const { chat_subscription_active } = useSubscriptionStatus()

  // Initialize cloud sync and passkey backup as two separate hooks.
  // usePasskeyBackup depends on useCloudSync's `initialized` and `encryptionKey`,
  // and bridges key changes back via onEncryptionKeyRecovered / updatePasskeyBackup.
  // Ref bridges the forward dependency: useCloudSync needs updatePasskeyBackup (from
  // usePasskeyBackup), which is defined after useCloudSync returns.
  const updatePasskeyBackupRef = useRef<(() => Promise<void>) | null>(null)

  const {
    syncing,
    syncChats,
    smartSyncChats,
    syncProjectChats,
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
  const [logoAnimDone, setLogoAnimDone] = useState(false)
  const handleLogoAnimFinished = useCallback(() => {
    setLogoAnimDone(true)
  }, [])

  // Show onboarding once models are loaded for new users
  useEffect(() => {
    if (suppressIntroModals) return
    if (onboardingNeeded && models.length > 0) {
      setShowOnboarding(true)
    }
  }, [onboardingNeeded, models.length, suppressIntroModals])

  // State for right sidebar
  const [isVerifierSidebarOpen, setIsVerifierSidebarOpen] = useState(false)

  // State for settings modal
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    SettingsTab | undefined
  >(undefined)

  // State for share modal
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)

  // State for cloud sync setup modal
  const [showCloudSyncSetupModal, setShowCloudSyncSetupModal] = useState(false)
  // Tracks the in-flight first-time passkey setup call so the modal can
  // disable its buttons while the native dialog is showing.
  const [isFirstTimePasskeySetupBusy, setIsFirstTimePasskeySetupBusy] =
    useState(false)

  useEffect(() => {
    if (suppressIntroModals) return
    // Passkey-based recovery always auto-opens: a remote passkey credential
    // means the user *has* chats backed up and can't see them on this device
    // until they unlock, regardless of whether the local sync toggle is on.
    // The manual-recovery and "chats not being backed up" cases are surfaced
    // through the sidebar warning instead of an auto-popup, so the user can
    // act on them at their own pace.
    if (passkeyRecoveryNeeded) {
      setShowCloudSyncSetupModal(true)
    }
  }, [passkeyRecoveryNeeded, suppressIntroModals])

  // State for add-to-project-context modal
  const [showAddToProjectModal, setShowAddToProjectModal] = useState(false)
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([])

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
  const previousChatIdRef = useRef<string | null>(null)

  // Artifact-sidebar state — opened when a `render_artifact_preview` inline
  // card dispatches `OPEN_ARTIFACT_PREVIEW_EVENT` on the window.
  const [isArtifactSidebarOpen, setIsArtifactSidebarOpen] = useState(false)
  const [artifactSidebarWidth, setArtifactSidebarWidth] = useState<number>(
    CONSTANTS.ARTIFACT_SIDEBAR_WIDTH_PX,
  )
  const [artifactPreview, setArtifactPreview] =
    useState<ArtifactPreviewSidebarDetail | null>(null)

  // State for web search toggle (persisted in localStorage)
  const [webSearchEnabled, setWebSearchEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = localStorage.getItem(SETTINGS_WEB_SEARCH_ENABLED)
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

  // State for tracking processed documents
  const [processedDocuments, setProcessedDocuments] = useState<
    ProcessedDocument[]
  >([])

  // State for global drag and drop overlay
  const [isGlobalDragActive, setIsGlobalDragActive] = useState(false)
  const dragCounterRef = useRef(0)

  // State for tracking verification document
  const [verificationDocument, setVerificationDocument] = useState<any>(null)

  const userEmail = user?.primaryEmailAddress?.emailAddress || ''

  const isPremium = chat_subscription_active ?? false

  // Load projects for move to project functionality
  const { projects } = useProjects({
    autoLoad: isSignedIn && isCloudSyncEnabled() && isPremium,
  })

  // Reasoning controls — graded effort for models that support it, on/off
  // toggle for models that expose a thinking flag. Both are persisted globally
  // (not per-model) and only surfaced for models whose reasoningConfig opts in.
  const { reasoningEffort, setReasoningEffort } = useReasoningEffort()
  const { thinkingEnabled, setThinkingEnabled } = useThinkingEnabled()

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
    uploadDocument: uploadProjectDocument,
    addUploadingFile,
    removeUploadingFile,
  } = useProject()
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

  // Load models and system prompt immediately in parallel.
  useEffect(() => {
    let cancelled = false
    const loadInitial = async () => {
      try {
        const [promptData, models] = await Promise.all([
          getSystemPromptAndRules(),
          getAIModels(),
        ])

        if (!cancelled) {
          setSystemPrompt(promptData.systemPrompt)
          setRules(promptData.rules)
          setModels(models)
          setIsLoadingConfig(false)
        }
      } catch (error) {
        logError('Failed to load chat configuration', error, {
          component: 'ChatInterface',
          action: 'loadConfig',
        })
        if (!cancelled) {
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
      if (smooth) {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth',
        })
      } else {
        el.scrollTop = el.scrollHeight
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
    messagesEndRef,
    isInitialLoad,
    isThinking,
    verificationComplete,
    verificationSuccess,
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
    setVerificationComplete,
    setVerificationSuccess,
    setChats,
    setCurrentChat,

    // Actions
    handleQuery,
    createNewChat,
    deleteChat,
    handleChatSelect,
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
    regenerateMessage,
    resolveInputToolCall,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
  } = useChatState({
    systemPrompt: finalSystemPrompt,
    rules: processedRules,
    storeHistory: isSignedIn || !isCloudSyncEnabled(), // Enable storage for signed-in users OR local-only mode
    models: models,
    // Scroll user message to top of viewport when sending
    scrollToBottom: scrollUserMessageToTop,
    reasoningEffort,
    thinkingEnabled,
    initialChatId,
    isLocalChatUrl,
    webSearchEnabled,
    // Feature flag gates key derivation in useExecSnapshot; the toggle
    // gates request plumbing. Both layers must be on to use code-exec.
    canUseCodeExecution,
    codeExecutionEnabled: canUseCodeExecution ? codeExecutionEnabled : false,
    piiCheckEnabled,
  })

  const isTemporaryMode = currentChat?.isTemporary === true

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
      setChats((prev) =>
        prev.map((c) => (c.id === currentChat.id ? updatedChat : c)),
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
    setIsPromptLibraryModalOpen(true)
  }, [])

  const handleClosePromptLibrary = useCallback(() => {
    setIsPromptLibraryModalOpen(false)
  }, [])

  // Only the free-tier daily quota gates sending and the subscribe prompt. The
  // per-account hourly cap (subscribers) reuses the same indicator channel but
  // must not block the queue or prompt subscribing; those sends fail fast with
  // an in-chat rate-limit message and recover once the hourly window resets.
  const isRateLimited = useCallback(
    () =>
      Boolean(
        rateLimit && rateLimit.remaining <= 0 && rateLimit.kind !== 'hourly',
      ),
    [rateLimit],
  )

  const handleQueueDispatch = useCallback(() => {
    if (rateLimit) snapshotAndDecrementRemaining()
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
  } = useMessageQueue({
    chatId: currentChat?.id ?? null,
    loadingState,
    handleQuery,
    isRateLimited,
    onBeforeDispatch: handleQueueDispatch,
    onRateLimited: handleQueueRateLimited,
  })

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
    webSearchEnabled,
    piiCheckEnabled,
  })

  // Sync URL with current chat state
  useEffect(() => {
    // Don't update URL during initial load
    if (isInitialLoad) return
    // Don't clear URL when showing decryption failed screen
    if (initialChatDecryptionFailed) return

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
  const documentTitle = useMemo(() => {
    const base = CONSTANTS.BASE_DOCUMENT_TITLE
    const trimmed = chatTitle?.trim()
    const hasMeaningfulTitle =
      !chatIsBlank &&
      !chatIsTemporary &&
      chatTitleState !== 'placeholder' &&
      !!trimmed &&
      trimmed !== 'New Chat'
    return hasMeaningfulTitle ? `${trimmed} · ${base}` : base
  }, [chatTitle, chatTitleState, chatIsBlank, chatIsTemporary])

  // Initialize tinfoil client once when page loads
  useEffect(() => {
    const initTinfoil = async () => {
      try {
        const { getVerificationDocument } =
          await import('@/services/inference/tinfoil-client')
        const doc = await getVerificationDocument()
        if (doc) {
          setVerificationDocument(doc)
          // Set verification status based on document
          if (doc.securityVerified !== undefined) {
            setVerificationComplete(true)
            setVerificationSuccess(doc.securityVerified)
          }
        }
      } catch (error) {
        logError('Failed to initialize tinfoil client', error, {
          component: 'ChatInterface',
          action: 'initTinfoil',
        })
      }
    }
    initTinfoil()
  }, [setVerificationComplete, setVerificationSuccess])

  // Sync rate limit info from tinfoil-client via custom events
  useEffect(() => {
    const handleRateLimitUpdate = () => {
      setRateLimit(getRateLimitInfo())
    }
    // Sync any already-cached value (the initial fetchSessionToken may
    // have resolved before this listener was registered).
    handleRateLimitUpdate()
    window.addEventListener('rateLimitUpdated', handleRateLimitUpdate)
    return () => {
      window.removeEventListener('rateLimitUpdated', handleRateLimitUpdate)
    }
  }, [])

  // Once the user signs in (and the auth token manager has been
  // initialized via useCloudSync), discard any anonymous session token /
  // free-tier rate-limit info cached before sign-in and force a fresh
  // fetch so the banner reflects the authenticated user's quota.
  useEffect(() => {
    if (!isSignedIn || !cloudSyncInitialized) return
    invalidateAnonymousSessionCache()
    void getSessionToken().catch(() => {
      // best-effort; the next real request will retry
    })
  }, [isSignedIn, cloudSyncInitialized])

  // Handle upgrade requests from error CTA buttons
  useEffect(() => {
    const handleRequestUpgrade = () => {
      setIsSubscribePromptOpen(true)
    }
    window.addEventListener('requestUpgrade', handleRequestUpgrade)
    return () => {
      window.removeEventListener('requestUpgrade', handleRequestUpgrade)
    }
  }, [])

  // Persist web search toggle to localStorage
  useEffect(() => {
    localStorage.setItem(SETTINGS_WEB_SEARCH_ENABLED, String(webSearchEnabled))
  }, [webSearchEnabled])

  const handleWebSearchToggle = useCallback(() => {
    setWebSearchEnabled((prev) => {
      const next = !prev
      window.dispatchEvent(
        new CustomEvent('webSearchEnabledChanged', {
          detail: { enabled: next },
        }),
      )
      return next
    })
  }, [])

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
    const handleWebSearchChange = (
      event: CustomEvent<{ enabled: boolean }>,
    ) => {
      setWebSearchEnabled(event.detail.enabled)
    }
    const handleCodeExecutionChange = (
      event: CustomEvent<{ enabled: boolean }>,
    ) => {
      setCodeExecutionEnabled(event.detail.enabled)
    }

    window.addEventListener(
      'webSearchEnabledChanged',
      handleWebSearchChange as EventListener,
    )
    window.addEventListener(
      'codeExecutionEnabledChanged',
      handleCodeExecutionChange as EventListener,
    )

    return () => {
      window.removeEventListener(
        'webSearchEnabledChanged',
        handleWebSearchChange as EventListener,
      )
      window.removeEventListener(
        'codeExecutionEnabledChanged',
        handleCodeExecutionChange as EventListener,
      )
    }
  }, [])

  // Listen for PII check setting changes from settings modal
  useEffect(() => {
    const handlePiiCheckChange = (event: CustomEvent<{ enabled: boolean }>) => {
      setPiiCheckEnabled(event.detail.enabled)
    }

    window.addEventListener(
      'piiCheckEnabledChanged',
      handlePiiCheckChange as EventListener,
    )

    return () => {
      window.removeEventListener(
        'piiCheckEnabledChanged',
        handlePiiCheckChange as EventListener,
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
      event: CustomEvent<ArtifactPreviewSidebarDetail>,
    ) => {
      if (!event.detail) return
      // Toggle: clicking the inline card while its artifact is already open
      // closes the sidebar instead of re-opening it.
      setArtifactPreview((prev) => {
        const sameArtifact =
          prev !== null &&
          isArtifactSidebarOpen &&
          artifactDetailsEqual(prev, event.detail)
        if (sameArtifact) {
          setIsArtifactSidebarOpen(false)
          return prev
        }
        setIsArtifactSidebarOpen(true)
        setIsVerifierSidebarOpen(false)
        setIsSettingsModalOpen(false)
        setIsAskSidebarOpen(false)
        if (windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
          setIsSidebarOpen(false)
        }
        return event.detail
      })
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
  }, [windowWidth, setIsSidebarOpen, isArtifactSidebarOpen])

  // Auto-focus input when component mounts and is ready (no autoscroll)
  useEffect(() => {
    if (isClient && !isLoadingConfig && currentChat) {
      // Skip auto-focus when sidebar is open on mobile — focusing the input
      // triggers handleInputFocus which closes the sidebar
      if (isSidebarOpen && windowWidth < CONSTANTS.MOBILE_BREAKPOINT) {
        return
      }
      // Small delay to ensure DOM is ready and input is rendered
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 200)
      return () => clearTimeout(timer)
    }
  }, [
    isClient,
    isLoadingConfig,
    currentChat,
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
  const selectedModelDetails = models.find(
    (model) => model.modelName === selectedModel,
  ) as BaseModel | undefined

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

  // Sync chats when user signs in and periodically
  // Profile sync is handled separately by useProfileSync hook
  // Context-aware: syncs personal chats when not in project mode, project chats when in project mode
  useEffect(() => {
    if (!isAuthLoaded || !isSignedIn || !cloudSyncInitialized) return

    // Initial sync based on current mode
    const initialSync =
      isProjectMode && activeProject
        ? () => syncProjectChats(activeProject.id)
        : () => syncChats()

    initialSync()
      .then(() => reloadChats())
      .catch((error) => {
        logError('Failed to sync chats on page load', error, {
          component: 'ChatInterface',
          action: 'initialSync',
          metadata: { isProjectMode, projectId: activeProject?.id },
        })
      })

    // Use smart sync at regular intervals - checks sync status first to reduce bandwidth
    // Syncs project chats when in project mode, personal chats otherwise
    const interval = setInterval(() => {
      const projectId =
        isProjectMode && activeProject ? activeProject.id : undefined
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
            metadata: { isProjectMode, projectId: activeProject?.id },
          })
        })
    }, CLOUD_SYNC.CHAT_SYNC_INTERVAL)

    return () => clearInterval(interval)
  }, [
    isAuthLoaded,
    isSignedIn,
    cloudSyncInitialized,
    isProjectMode,
    activeProject,
    syncChats,
    smartSyncChats,
    syncProjectChats,
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

  // Manual full sync triggered from the sidebar "Sync" button. Pages
  // through the entire remote history (deep) so older chats that aren't on
  // the first page land locally, then refreshes the visible list.
  const handleManualSync = useCallback(async () => {
    try {
      await syncChats({ deep: true })
      await reloadChats()
    } catch (error) {
      logError('Manual chat sync failed', error, {
        component: 'ChatInterface',
        action: 'handleManualSync',
      })
    }
  }, [syncChats, reloadChats])

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
      setSettingsInitialTab(undefined)
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
    setIsShareModalOpen(true)
  }

  // Handler for encryption key button - opens settings modal to cloud-sync tab
  const handleOpenEncryptionKeyModal = () => {
    setSettingsInitialTab('cloud-sync')
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
  // prefer the friendly "Back Up Your Chats" prompt for brand-new signed-in
  // users so they don't get dropped into the raw key-generator UI. Fall
  // back to the manual cloud-sync setup modal otherwise (existing key,
  // remote data without a passkey, or PRF unsupported).
  const handleOpenCloudSyncSetup = useCallback(async () => {
    if (!encryptionService.getKey()) {
      // Open the modal immediately for instant feedback. It renders
      // its recovery / manual UI from the live hook state, so we don't
      // block the popup on the slow enclave key-state probe. The
      // probes below run in the background and the modal reacts to the
      // resulting state changes (e.g. a manual-recovery warning getting
      // upgraded to a passkey-recovery flow).
      setShowCloudSyncSetupModal(true)
      const recovered = await showPasskeyRecoveryPrompt()
      if (recovered) return
      const routed = await showFirstTimePasskeyPrompt()
      if (routed) {
        // A brand-new user with no remote data is better served by the
        // dedicated first-time prompt; hand off to it.
        setShowCloudSyncSetupModal(false)
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
    try {
      const name = `My Project #${projects.length + 1}`
      const project = await createProject({ name, description: '' })
      await enterProjectMode(project.id)
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
  }, [createProject, enterProjectMode, projects.length, toast])

  // Handler for exiting project mode - creates a new chat and exits
  const handleExitProject = useCallback(() => {
    createNewChat(false, true)
    exitProjectMode()
  }, [createNewChat, exitProjectMode])

  const handleToggleTemporaryMode = useCallback(() => {
    const hasMessages = (currentChat?.messages?.length ?? 0) > 0
    const storeHistory = isSignedIn || !isCloudSyncEnabled()

    if (currentChat?.isTemporary) {
      // Deselecting temporary mode on a started chat saves it permanently.
      if (hasMessages) {
        const { id: newId } = generateReverseId()
        const permanentChat: Chat = {
          ...currentChat,
          id: newId,
          isTemporary: false,
          isBlankChat: false,
          title:
            currentChat.title === 'Temporary Chat'
              ? 'Untitled'
              : currentChat.title,
          codeExecutionAccessToken:
            currentChat.codeExecutionAccessToken ??
            generateCodeExecutionAccessToken(),
          createdAt: currentChat.createdAt ?? new Date(),
        }
        previousChatIdRef.current = null
        setCurrentChat(permanentChat)
        setChats((prev) => sortChats([permanentChat, ...prev]))
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
        if (permanentChat.title === 'Untitled') {
          const firstUser = permanentChat.messages.find(
            (m) => m.role === 'user',
          )
          const titleContent =
            firstUser?.content?.trim() ||
            (firstUser?.attachments
              ?.map((a) => a.textContent || a.description || a.fileName)
              .filter(Boolean)
              .join('\n') ??
              '')
          if (titleContent) {
            generateTitle([{ role: 'user', content: titleContent }])
              .then((generated) => {
                if (!generated || generated === 'Untitled') return
                // If the user re-converted this chat to temporary (or
                // navigated away) while the title was generating, skip
                // persistence so the async completion can't resurrect a
                // chat the user just removed.
                const active = currentChatRef.current
                if (
                  !active ||
                  active.id !== permanentChat.id ||
                  active.isTemporary
                ) {
                  return
                }
                const titled: Chat = {
                  ...permanentChat,
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

      const previousId = previousChatIdRef.current
      previousChatIdRef.current = null
      const restored = previousId
        ? chats.find((c) => c.id === previousId)
        : undefined
      if (restored) {
        setCurrentChat(restored)
      } else {
        createNewChat(false, true)
      }
      return
    }

    // Selecting temporary mode on a started chat removes it from history and
    // keeps the conversation in memory only.
    if (hasMessages && currentChat) {
      const chatId = currentChat.id
      const tempChat: Chat = {
        ...currentChat,
        id: `temp-${Date.now()}`,
        isTemporary: true,
        isBlankChat: false,
      }
      previousChatIdRef.current = null
      setCurrentChat(tempChat)
      setChats((prev) => prev.filter((c) => c.id !== chatId))
      if (storeHistory) {
        chatStorage.deleteChat(chatId).catch((err) => {
          logError('Failed to remove chat during temporary conversion', err, {
            component: 'ChatInterface',
            action: 'handleToggleTemporaryMode.remove',
            metadata: { chatId },
          })
        })
      } else {
        sessionChatStorage.deleteChat(chatId)
      }
      return
    }

    previousChatIdRef.current = currentChat?.id ?? null
    const tempChat: Chat = {
      id: `temp-${Date.now()}`,
      title: 'Temporary Chat',
      titleState: 'placeholder',
      messages: [],
      createdAt: new Date(),
      isBlankChat: true,
      isTemporary: true,
      presetId: currentChat?.presetId,
    }
    setCurrentChat(tempChat)
  }, [chats, createNewChat, currentChat, isSignedIn, setChats, setCurrentChat])

  useEffect(() => {
    if (!isTemporaryMode && previousChatIdRef.current) {
      previousChatIdRef.current = null
    }
  }, [isTemporaryMode])

  // Handler for exiting project mode while dragging - does NOT create a new chat
  // so the drag operation can continue and drop into cloud/local tabs
  const handleExitProjectWhileDragging = useCallback(() => {
    exitProjectMode()
  }, [exitProjectMode])

  // Handler for moving a chat to a project via drag and drop
  const handleMoveChatToProject = useCallback(
    async (chatId: string, projectId: string) => {
      try {
        // Update local storage first (optimistic)
        await indexedDBStorage.updateChatProject(chatId, projectId)

        // Update cloud storage, then re-upload encrypted blob to keep it consistent
        await cloudSync.updateChatProject(chatId, projectId)
        await cloudSync.backupChat(chatId)

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
    [currentChat.id, createNewChat, reloadChats, toast],
  )

  // Handler for removing a chat from a project via drag and drop
  const handleRemoveChatFromProject = useCallback(
    async (chatId: string): Promise<void> => {
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
    [reloadChats, toast],
  )

  // Handler for deleting every chat that belongs to a project. Reloads from
  // storage afterwards so the deleted chats disappear locally without a
  // page refresh.
  const handleDeleteProjectChats = useCallback(
    async (projectId: string): Promise<void> => {
      try {
        await chatStorage.deleteChatsByProject(projectId)
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
    [reloadChats],
  )

  // Handler for converting a local-only chat to cloud chat via drag and drop
  const handleConvertChatToCloud = useCallback(
    async (chatId: string): Promise<void> => {
      try {
        await chatStorage.convertChatToCloud(chatId)
        await reloadChats()

        toast({
          title: 'Chat moved to cloud',
          description: 'The chat will now sync across your devices.',
        })
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
      }
    },
    [reloadChats, toast],
  )

  // Handler for converting a cloud chat to local-only via drag and drop
  const handleConvertChatToLocal = useCallback(
    async (chatId: string): Promise<void> => {
      try {
        await chatStorage.convertChatToLocal(chatId)
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
    [reloadChats, toast],
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
          const contextBudget = getContextTokenBudget(
            selectedModelDetails?.contextWindow,
          )

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
    [
      handleDocumentUpload,
      processedDocuments,
      selectedModelDetails?.contextWindow,
      toast,
    ],
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
        async (content) => {
          try {
            await uploadProjectDocument(file, content)
          } catch {
            toast({
              title: 'Upload failed',
              description: 'Failed to add document to project context.',
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
    async (addToProject: boolean, rememberChoice: boolean) => {
      if (rememberChoice) {
        setProjectUploadPreference(addToProject ? 'project' : 'chat')
      }

      // Capture files and close modal immediately
      const filesToUpload = pendingUploadFiles
      setPendingUploadFiles([])
      setShowAddToProjectModal(false)

      // Then process uploads (UI will show upload progress)
      for (const file of filesToUpload) {
        if (addToProject) {
          await addFileToProjectContext(file)
        } else {
          await processFileForChat(file)
        }
      }
    },
    [pendingUploadFiles, addFileToProjectContext, processFileForChat],
  )

  // Document upload handler wrapper
  const handleFileUpload = useCallback(
    async (file: File) => {
      // Check if in project mode
      if (isProjectMode && activeProject) {
        const preference = getProjectUploadPreference()

        if (preference === 'project') {
          await addFileToProjectContext(file)
          return
        } else if (preference === 'chat') {
          await processFileForChat(file)
          return
        } else {
          // No preference saved - queue file and show dialog
          setPendingUploadFiles((prev) => [...prev, file])
          setShowAddToProjectModal(true)
          return
        }
      }

      // Not in project mode - use normal chat flow
      await processFileForChat(file)
    },
    [isProjectMode, activeProject, addFileToProjectContext, processFileForChat],
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
    const limitTokens = getContextTokenBudget(
      selectedModelDetails?.contextWindow,
    )

    let usedTokens = estimateTokenCount(input)

    // Count tokens from messages (including their attachments), skipping
    // archived messages that are excluded from the prompt
    if (currentChat?.messages) {
      const messages = currentChat.messages
      const startIndex = findContextStartIndex(messages, limitTokens)
      for (let i = startIndex; i < messages.length; i++) {
        usedTokens += estimateMessageTokens(messages[i])
      }
    }

    // Count tokens from pending documents not yet attached to a message
    if (processedDocuments) {
      processedDocuments.forEach((doc) => {
        usedTokens += estimateTokenCount(doc.content)
      })
    }

    return {
      percentage: (usedTokens / limitTokens) * 100,
      usedTokens,
      limitTokens,
    }
  }, [
    input,
    currentChat?.messages,
    processedDocuments,
    selectedModelDetails?.contextWindow,
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

    if (rateLimit && rateLimit.remaining <= 0 && rateLimit.kind !== 'hourly') {
      setIsSubscribePromptOpen(true)
      return
    }

    // Filter out documents that are still uploading or generating descriptions
    const completedDocuments = processedDocuments.filter(
      (doc) =>
        !doc.isUploading && !doc.isGeneratingDescription && !doc.isUnsupported,
    )

    const messageText = input.trim()

    // Don't proceed if there's no input text, no quote, and no documents
    if (!messageText && !quote && completedDocuments.length === 0) {
      return
    }

    // Don't auto-scroll here - let the message append handler do it
    // This prevents the dip when thoughts start streaming

    // Build unified attachments array from completed documents
    const attachments: Attachment[] = completedDocuments
      .filter(
        (doc) => !doc.isImageDescription || doc.imageData || doc.attachment,
      )
      .map((doc) => {
        // Use pre-built attachment if available
        if (doc.attachment) return doc.attachment

        // Build attachment from legacy ProcessedDocument fields
        return (
          buildAttachment({
            id: doc.id,
            fileName: doc.name,
            imageData: doc.imageData ?? undefined,
            textContent: doc.content ?? undefined,
            description:
              doc.isImageDescription && doc.content ? doc.content : undefined,
          }) ?? { id: doc.id, type: 'document' as const, fileName: doc.name }
        )
      })

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

    // Check if spacer is present and get its height
    const spacer = el.querySelector('[data-spacer]') as HTMLElement | null
    const spacerHeight = spacer?.offsetHeight || 0

    // Show button when user has scrolled up from the bottom by more than threshold
    // Subtract spacer height since it's empty space, not content
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight - spacerHeight
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

  // Preserve scroll position when user has scrolled up during streaming.
  // When new content appears below the viewport (e.g., thoughts start streaming),
  // some mobile browsers may jump the scroll position. This saves scrollTop
  // before React commits DOM changes and restores it after.
  const savedScrollTopRef = useRef<number | null>(null)
  if (showScrollButton && scrollContainerRef.current) {
    savedScrollTopRef.current = scrollContainerRef.current.scrollTop
  } else {
    savedScrollTopRef.current = null
  }
  useLayoutEffect(() => {
    if (
      savedScrollTopRef.current !== null &&
      scrollContainerRef.current &&
      showScrollButton
    ) {
      const el = scrollContainerRef.current
      if (el.scrollTop !== savedScrollTopRef.current) {
        el.scrollTop = savedScrollTopRef.current
      }
    }
  }, [currentChat?.messages, showScrollButton])

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
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight
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
          <SignInButton mode="modal">
            <button className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90">
              Sign in
            </button>
          </SignInButton>
        </div>
      </div>
    )
  }

  // Config loading is handled by the combined loading screen above.

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
          <button
            onClick={() => {
              clearUrl()
              window.location.href = '/'
            }}
            className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Start new chat
          </button>
        </div>
      </div>
    )
  }

  // Show error state if no models are available (configuration error)
  if (!isLoadingConfig && models.length === 0) {
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
              <button
                type="button"
                onClick={() => createNewChat()}
                className="flex items-center justify-center rounded-lg border border-border-subtle bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:bg-surface-chat hover:text-content-primary"
                aria-label="New chat"
              >
                <PiNotePencilLight className="h-4 w-4" />
              </button>
            )}

          {/* Temporary chat toggle. Remains available after a chat has
              started so it can convert between temporary and permanent:
              turning it off saves the conversation, turning it on removes
              it from history again. */}
          {(() => {
            const hasMessages =
              !!currentChat?.messages && currentChat.messages.length > 0
            const label = hasMessages
              ? isTemporaryMode
                ? 'Save chat'
                : 'Make temporary'
              : isTemporaryMode
                ? 'Exit temporary chat'
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
                      ? 'border-orange-500/40 bg-orange-500/15 text-orange-500 hover:bg-orange-500/25'
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
              {!verificationComplete ? (
                <>
                  <PiSpinner className="h-4 w-4 animate-spin" />
                  <span className="text-sm leading-none">Verifying...</span>
                </>
              ) : verificationSuccess ? (
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
                      messageCount: c.messages.length,
                      createdAt: c.createdAt,
                      projectId: c.projectId,
                      isBlankChat: c.isBlankChat,
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
                  windowWidth={windowWidth}
                />
              ) : (
                <ProjectSidebar
                  isOpen={isSidebarOpen}
                  setIsOpen={setIsSidebarOpen}
                  project={null}
                  projectName={loadingProject?.name}
                  isLoading={true}
                  isDarkMode={isDarkMode}
                  onExitProject={handleExitProject}
                  onExitProjectWhileDragging={handleExitProjectWhileDragging}
                  onNewChat={() => {}}
                  onSelectChat={() => {}}
                  isClient={isClient}
                  onSettingsClick={handleOpenSettingsModal}
                  windowWidth={windowWidth}
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
                createNewChat={createNewChat}
                handleChatSelect={handleChatSelect}
                updateChatTitle={updateChatTitle}
                deleteChat={deleteChat}
                isClient={isClient}
                verificationComplete={verificationComplete}
                verificationSuccess={verificationSuccess}
                onVerificationComplete={(success) => {
                  setVerificationComplete(true)
                  setVerificationSuccess(success)
                }}
                isPremium={isPremium}
                onEncryptionKeyClick={
                  isSignedIn ? handleOpenEncryptionKeyModal : undefined
                }
                onCloudSyncSetupClick={
                  isSignedIn ? handleOpenCloudSyncSetup : undefined
                }
                onSetupPasskey={setupPasskey}
                passkeySetupAvailable={passkeySetupAvailable}
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
                onManualSync={handleManualSync}
                isSyncing={syncing}
                isProjectMode={isProjectMode}
                activeProjectName={activeProject?.name}
                onEnterProject={async (projectId, projectName) => {
                  // Create a new blank chat before entering project mode
                  // This prevents the current chat from being associated with the project
                  createNewChat(false, true)
                  await enterProjectMode(projectId, projectName)
                }}
                onCreateProject={handleCreateProject}
                onMoveChatToProject={handleMoveChatToProject}
                onRemoveChatFromProject={handleRemoveChatFromProject}
                onConvertChatToCloud={handleConvertChatToCloud}
                onConvertChatToLocal={handleConvertChatToLocal}
                onSettingsClick={handleOpenSettingsModal}
                windowWidth={windowWidth}
                chatDecryptionProgress={decryptionProgress}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </DragProvider>

      {/* Right Verifier Sidebar */}
      <VerifierSidebarLazy
        isOpen={isVerifierSidebarOpen}
        setIsOpen={handleSetVerifierSidebarOpen}
        verificationComplete={verificationComplete}
        verificationSuccess={verificationSuccess}
        onVerificationComplete={(success) => {
          setVerificationComplete(true)
          setVerificationSuccess(success)
        }}
        onVerificationUpdate={setVerificationDocument}
        isDarkMode={isDarkMode}
        isClient={isClient}
      />

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

      {/* Prompt Library Modal */}
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

      {/* Settings Modal */}
      <SettingsModalLazy
        isOpen={isSettingsModalOpen}
        setIsOpen={setIsSettingsModalOpen}
        isDarkMode={isDarkMode}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        isClient={isClient}
        defaultSystemPrompt={systemPrompt}
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
            {/* Project Mode Banner */}
            {(isProjectMode && activeProject) || loadingProject ? (
              <ProjectModeBanner
                projectName={activeProject?.name || loadingProject?.name || ''}
                isDarkMode={isDarkMode}
              />
            ) : null}

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
                className="relative z-0 flex-1 overflow-y-auto bg-surface-chat-background"
                style={
                  {
                    paddingBottom:
                      inputAreaHeight + CONSTANTS.CHAT_INPUT_BOTTOM_GAP_PX,
                    '--input-area-height': `${inputAreaHeight}px`,
                  } as React.CSSProperties
                }
              >
                <div className="flex min-h-full min-w-0 flex-1 [container-type:inline-size]">
                  <ChatMessages
                    messages={currentChat?.messages || []}
                    isDarkMode={isDarkMode}
                    chatId={currentChat.id}
                    isWaitingForResponse={isWaitingForResponse}
                    isStreamingResponse={isStreaming}
                    isPremium={isPremium}
                    models={models}
                    onSubmit={handleSubmit}
                    input={input}
                    setInput={setInput}
                    loadingState={loadingState}
                    retryInfo={retryInfo}
                    cancelGeneration={cancelGeneration}
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
                    showScrollButton={showScrollButton}
                    webSearchEnabled={webSearchEnabled}
                    onWebSearchToggle={handleWebSearchToggle}
                    reasoningEffort={reasoningEffort}
                    setReasoningEffort={setReasoningEffort}
                    thinkingEnabled={thinkingEnabled}
                    setThinkingEnabled={setThinkingEnabled}
                    codeExecutionEnabled={
                      canEnableCodeExecution ? codeExecutionEnabled : false
                    }
                    onCodeExecutionToggle={
                      canEnableCodeExecution
                        ? handleCodeExecutionToggle
                        : undefined
                    }
                    onOpenVerifier={() => setIsVerifierSidebarOpen(true)}
                    isTemporaryMode={isTemporaryMode}
                    activePromptPreset={activePreset}
                    onOpenPromptLibrary={handleOpenPromptLibrary}
                    onSelectPromptPreset={handleSetActivePreset}
                  />
                </div>
              </div>
            </div>

            {/* Input Form - Show on mobile always, on desktop only when there are messages */}
            {isClient &&
              (windowWidth < CONSTANTS.MOBILE_BREAKPOINT ||
                (currentChat?.messages && currentChat.messages.length > 0)) && (
                <div
                  ref={inputAreaRef}
                  data-chat-input-area
                  className="pointer-events-none absolute inset-x-0 bottom-0 isolate z-30 px-4 pb-4"
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
                        pending={
                          selectPendingInputToolCallFromChat(currentChat)!
                        }
                        isDarkMode={isDarkMode}
                        onResolve={resolveInputToolCall}
                      />
                    </div>
                  ) : (
                    <form
                      onSubmit={handleSubmit}
                      className="pointer-events-auto relative z-10 mx-auto max-w-3xl px-1 md:px-8"
                    >
                      {!currentChat?.messages?.length && (
                        <div className="mb-3 md:hidden">
                          <PromptPresetSuggestions
                            activePreset={activePreset}
                            onSetActive={handleSetActivePreset}
                            onOpenLibrary={handleOpenPromptLibrary}
                          />
                        </div>
                      )}
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
                          message={streamError}
                          onDismiss={dismissStreamError}
                          onRetry={retryLastMessage}
                          isDarkMode={isDarkMode}
                        />
                      )}
                      <MessageQueue
                        queue={queuedMessages}
                        onRemove={removeQueuedMessage}
                      />
                      <ChatInput
                        input={input}
                        setInput={setInput}
                        handleSubmit={handleSubmit}
                        loadingState={loadingState}
                        cancelGeneration={cancelGeneration}
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
                                aria-label={`Current model ${models.find((m) => m.modelName === selectedModel)?.name ?? ''}`}
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleLabelClick('model', () => {})
                                }}
                                className="flex items-center gap-1 py-1.5 text-content-secondary transition-colors hover:text-content-primary"
                              >
                                {(() => {
                                  const model = models.find(
                                    (m) => m.modelName === selectedModel,
                                  )
                                  if (!model) return null
                                  return (
                                    <>
                                      <span className="text-xs font-medium">
                                        {model.name}
                                      </span>
                                      <svg
                                        className={`h-3 w-3 transition-transform ${expandedLabel === 'model' ? 'rotate-180' : ''}`}
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth={2}
                                          d="M19 9l-7 7-7-7"
                                        />
                                      </svg>
                                    </>
                                  )
                                })()}
                              </button>

                              {expandedLabel === 'model' && (
                                <ModelSelector
                                  selectedModel={selectedModel}
                                  onSelect={handleModelSelect}
                                  isDarkMode={isDarkMode}
                                  models={models}
                                />
                              )}
                            </div>
                          ) : undefined
                        }
                        reasoningSelectorButton={(() => {
                          const m = models.find(
                            (mm) => mm.modelName === selectedModel,
                          )
                          const supportsEffort = supportsReasoningEffort(m)
                          const supportsToggle = supportsThinkingToggle(m)
                          if (
                            !isReasoningModel(m) ||
                            (!supportsEffort && !supportsToggle)
                          )
                            return undefined
                          return (
                            <ReasoningEffortSelector
                              supportsEffort={supportsEffort}
                              supportsToggle={supportsToggle}
                              reasoningEffort={reasoningEffort}
                              onEffortChange={setReasoningEffort}
                              thinkingEnabled={thinkingEnabled}
                              onThinkingEnabledChange={setThinkingEnabled}
                              isOpen={expandedLabel === 'reasoning'}
                              onToggle={() =>
                                handleLabelClick('reasoning', () => {})
                              }
                              onClose={() =>
                                handleLabelClick('reasoning', () => {})
                              }
                            />
                          )
                        })()}
                        webSearchEnabled={webSearchEnabled}
                        onWebSearchToggle={handleWebSearchToggle}
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
            // If no key was set, turn off cloud sync
            if (!encryptionService.getKey()) {
              setCloudSyncEnabled(false)
            }
          }}
          onSetupComplete={async (key: string, mode) => {
            try {
              await handleKeyChanged(key, { mode })
              setShowCloudSyncSetupModal(false)
              if (mode === 'explicitStartFresh') {
                void backupStartFreshKeyWithPasskey()
              }
              return { ok: true }
            } catch (error) {
              return { ok: false, reason: classifyCloudKeySetupError(error) }
            }
          }}
          isDarkMode={isDarkMode}
          initialCloudSyncEnabled={true}
          prfSupported={
            passkeyActive ||
            passkeyRecoveryNeeded ||
            passkeySetupAvailable ||
            passkeyAddDeviceAvailable
          }
          passkeyRecoveryNeeded={passkeyRecoveryNeeded}
          manualRecoveryNeeded={manualRecoveryNeeded}
          passkeyRecoveryFailure={passkeyRecoveryFailure}
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
            setShowCloudSyncSetupModal(false)
            return true
          }}
          onSetupNewKey={async () => {
            const key = await setupNewKeySplit()
            if (!key) return false
            try {
              await handleKeyChanged(key, { mode: 'explicitStartFresh' })
            } catch {
              return false
            }
            setShowCloudSyncSetupModal(false)
            return true
          }}
        />
      )}

      {/* First-time passkey setup confirmation - shown to brand-new users so
          we never invoke the native WebAuthn dialog without an explicit click. */}
      {passkeyFirstTimePromptAvailable && !suppressIntroModals && (
        <PasskeySetupPromptModal
          isOpen={passkeyFirstTimePromptAvailable}
          isBusy={isFirstTimePasskeySetupBusy}
          onEnable={async () => {
            setIsFirstTimePasskeySetupBusy(true)
            try {
              await setupFirstTimePasskey()
            } finally {
              setIsFirstTimePasskeySetupBusy(false)
            }
          }}
          onDismiss={() => {
            dismissFirstTimePasskeyPrompt()
            setCloudSyncEnabled(false)
          }}
        />
      )}

      {/* Add to Project Context Modal */}
      <AddToProjectContextModal
        isOpen={showAddToProjectModal}
        onClose={() => {
          setPendingUploadFiles([])
          setShowAddToProjectModal(false)
        }}
        onConfirm={handleAddToProjectConfirm}
        fileName={
          pendingUploadFiles.length === 1
            ? pendingUploadFiles[0].name
            : `${pendingUploadFiles.length} files`
        }
        projectName={activeProject?.name ?? ''}
        isDarkMode={isDarkMode}
      />

      <OnboardingModal
        isOpen={showOnboarding}
        onComplete={(selectedModel) => {
          if (selectedModel) handleModelSelect(selectedModel)
          setShowOnboarding(false)
        }}
        models={models}
        isDarkMode={isDarkMode}
      />

      <SubscribePromptModal
        isOpen={isSubscribePromptOpen}
        onClose={handleCloseSubscribePrompt}
        isSignedIn={!!isSignedIn}
      />
    </div>
  )
}
