import {
  getAIModels,
  getSystemPromptAndRules,
  type BaseModel,
} from '@/config/models'
import {
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_COMPUTER_USE_ENABLED,
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
import { SignInButton, useAuth, useClerk, useUser } from '@clerk/nextjs'
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
import { chatStorage } from '@/services/storage/chat-storage'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import {
  isCloudSyncEnabled,
  setCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { isSupportedFile } from '@/utils/file-types'
import {
  getProjectUploadPreference,
  setProjectUploadPreference,
} from '@/utils/project-upload-preference'
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

import {
  getStoredConnection,
  useComputerUseSession,
  type CapabilityManifest,
  type LoopEvent,
} from '@/services/computer-use'
import { UrlHashMessageHandler } from '../url-hash-message-handler'
import { UrlHashSettingsHandler } from '../url-hash-settings-handler'
import { ArtifactSidebar } from './artifact-sidebar'
import { AskSidebar } from './ask-sidebar'
import { ChatInput } from './chat-input'
import { ChatMessages } from './chat-messages'
import { ChatSidebar } from './chat-sidebar'
import {
  ComputerUseConsentContext,
  type ComputerUseConsentContextValue,
} from './computer-use-context'
import {
  ComputerUseFunnelContext,
  type ComputerUseFunnelContextValue,
} from './computer-use-funnel-context'
import { ComputerUseSessionDialog } from './ComputerUseSessionDialog'
import { ComputerUseSessionThread } from './ComputerUseSessionThread'
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
import { useChatState } from './hooks/use-chat-state'
import { useCustomSystemPrompt } from './hooks/use-custom-system-prompt'
import { useMaxMessages } from './hooks/use-max-messages'
import { useMessageQueue } from './hooks/use-message-queue'
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
// Lazy-load modals that aren't shown on initial load
const CloudSyncSetupModal = dynamic(
  () =>
    import('../modals/cloud-sync-setup-modal').then(
      (m) => m.CloudSyncSetupModal,
    ),
  { ssr: false },
)
const PasskeySetupPromptModal = dynamic(
  () =>
    import('../modals/passkey-setup-prompt-modal').then(
      (m) => m.PasskeySetupPromptModal,
    ),
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

// Helper to roughly estimate token count based on character length (≈4 chars per token)
const estimateTokenCount = (text: string | undefined): number => {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// Helper to parse values like "64k tokens" → 64000
const parseContextWindowTokens = (contextWindow?: string): number => {
  if (!contextWindow) return 64000 // sensible default
  const match = contextWindow.match(/(\d+)(k)?/i)
  if (!match) return 64000
  let tokens = parseInt(match[1], 10)
  if (match[2]) {
    tokens *= 1000
  }
  return tokens
}

// Generate a silly privacy-themed project name
function generateProjectName(): string {
  const adjectives = [
    'Private',
    'Secret',
    'Encrypted',
    'Anonymous',
    'Stealth',
    'Incognito',
    'Covert',
    'Hidden',
    'Shadowy',
    'Mysterious',
    'Whispered',
    'Cloaked',
    'Veiled',
    'Masked',
    'Undercover',
  ]

  const animals = [
    'Orangutan',
    'Penguin',
    'Platypus',
    'Armadillo',
    'Chameleon',
    'Pangolin',
    'Narwhal',
    'Capybara',
    'Axolotl',
    'Quokka',
    'Wombat',
    'Hedgehog',
    'Otter',
    'Sloth',
    'Lemur',
  ]

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)]
  const animal = animals[Math.floor(Math.random() * animals.length)]

  return `${adjective} ${animal}`
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
  const { openSignIn } = useClerk()
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null)

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
    addRecoveryKey,
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
    passkeySetupFailed,
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
  // Sync the latest callback into the ref via an effect so we don't mutate a
  // ref during render (React Compiler advisory: `react-hooks/refs`). The ref
  // is used from callbacks fired after commit, so an effect is the right
  // place to wire it.
  useEffect(() => {
    updatePasskeyBackupRef.current = updatePasskeyBackup
  }, [updatePasskeyBackup])

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

  // Show onboarding once models are loaded for new users.
  // The Compiler-aware lint flags the setState-in-effect, but the open state
  // is also toggled by user action (dismiss/finish) — pure derivation would
  // require a separate dismiss tracker for no behavioural gain, and the
  // open-on-condition pattern is the right shape here.
  useEffect(() => {
    if (suppressIntroModals) return
    if (onboardingNeeded && models.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // State for computer use toggle (persisted in localStorage, defaults to off).
  // Whether it's actually exposed to the model also depends on driver readiness
  // and model vision-capability (resolved at request build time).
  const [computerUseEnabled, setComputerUseEnabled] = useState(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem(SETTINGS_COMPUTER_USE_ENABLED)
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

  const { effectiveSystemPrompt, processedRules } = useCustomSystemPrompt(
    systemPrompt,
    rules,
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
  }, [scrollToBottom])

  // Bridge for model-initiated computer-use: useChatState (below) needs the
  // callback, but the session hook it targets needs `selectedModel` (returned by
  // useChatState). A stable ref breaks the cycle; it's populated once the
  // session hook exists, well before any `computer_begin` can fire.
  const onComputerBeginRef = useRef<
    | ((manifest: CapabilityManifest, task: string, reason?: string) => void)
    | null
  >(null)
  const onComputerBegin = useCallback(
    (manifest: CapabilityManifest, task: string, reason?: string) =>
      onComputerBeginRef.current?.(manifest, task, reason),
    [],
  )

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
    computerUseEnabled,
    onComputerBegin,
  })

  const isTemporaryMode = currentChat?.isTemporary === true

  const isRateLimited = useCallback(
    () => Boolean(rateLimit && rateLimit.remaining <= 0),
    [rateLimit],
  )

  const handleQueueDispatch = useCallback(() => {
    if (rateLimit) snapshotAndDecrementRemaining()
  }, [rateLimit])

  const handleQueueRateLimited = useCallback(() => {
    if (!isSignedIn) {
      void openSignIn()
      return
    }
    setIsSidebarOpen(true)
    window.dispatchEvent(
      new CustomEvent('highlightSidebarBox', {
        detail: { isPremium },
      }),
    )
  }, [isSignedIn, openSignIn, setIsSidebarOpen, isPremium])

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
  const sidebarMaxMessages = useMaxMessages()
  const sidebarChat = useSidebarChat({
    systemPrompt: finalSystemPrompt,
    rules: processedRules,
    models,
    selectedModel,
    maxMessages: sidebarMaxMessages,
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
      if (!isSignedIn) {
        void openSignIn()
      } else {
        setIsSidebarOpen(true)
        window.dispatchEvent(
          new CustomEvent('highlightSidebarBox', {
            detail: { isPremium },
          }),
        )
      }
    }
    window.addEventListener('requestUpgrade', handleRequestUpgrade)
    return () => {
      window.removeEventListener('requestUpgrade', handleRequestUpgrade)
    }
  }, [isSignedIn, isPremium, openSignIn, setIsSidebarOpen])

  // Persist web search toggle to localStorage
  useEffect(() => {
    localStorage.setItem(SETTINGS_WEB_SEARCH_ENABLED, String(webSearchEnabled))
  }, [webSearchEnabled])

  // Persist code execution toggle to localStorage
  useEffect(() => {
    localStorage.setItem(
      SETTINGS_CODE_EXECUTION_ENABLED,
      String(codeExecutionEnabled),
    )
  }, [codeExecutionEnabled])

  // Persist computer use toggle to localStorage
  useEffect(() => {
    localStorage.setItem(
      SETTINGS_COMPUTER_USE_ENABLED,
      String(computerUseEnabled),
    )
  }, [computerUseEnabled])

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
        // Close right sidebars to prioritize left sidebar. The cascade is
        // intentional (imperative cleanup on a viewport-class change) and
        // doesn't trigger a render loop — each setter sees the same effect
        // run, and the resulting state stops the predicate above from being
        // true on the next pass.
        // eslint-disable-next-line react-hooks/set-state-in-effect
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
  )

  // In-chat computer-use session (pairing → consent → agentic loop). Opened when
  // the model emits `computer_begin` (see onComputerBegin / use-chat-messaging).
  const computerUseSession = useComputerUseSession(selectedModel)
  // Destructure the stable handle the effect actually needs so exhaustive-deps
  // doesn't pull in the whole session (which is a fresh object each render).
  const { start: startComputerUseSession, connect: connectComputerUseSession } =
    computerUseSession
  useEffect(() => {
    onComputerBeginRef.current = (manifest, task, reason) => {
      void startComputerUseSession(task, manifest, reason)
    }
  }, [startComputerUseSession])

  // One-time pairing trigger for the connect banner + unpaired-toggle click.
  // Drives session.connect() (which just runs pairing, no consent/loop), and
  // on success auto-flips the per-conversation toggle ON: the user already
  // demonstrated intent by clicking Connect, so making them click the
  // toggle separately would be needless friction.
  const handleComputerUseConnect = useCallback(async () => {
    const ok = await connectComputerUseSession()
    if (ok) setComputerUseEnabled(true)
    return ok
  }, [connectComputerUseSession])

  // Setup-sandbox handler: drives `POST /images/setup-default` on the driver.
  // The driver runs pull + provision in the background; progress shows up in
  // the next /status poll's setup_job field (surfaced by `useDriverStatus`
  // inside ChatInput, which then feeds it into the setup banner). Errors
  // here are also reflected via setup_job.state="error", so the banner's
  // "Retry" path covers them — the console.error below is dev-side only.
  const handleComputerUseSetup = useCallback(async () => {
    const conn = getStoredConnection()
    if (!conn) {
      // Defensive: the setup banner only renders when paired, so a missing
      // connection here means the credential just got cleared. Bail silently.
      return
    }
    try {
      await conn.client.setupDefaultImage()
    } catch (err) {
      logError('image setup-default failed', err, {
        component: 'ChatInterface',
        action: 'computerUseSetup',
      })
    }
  }, [])

  // First-touch "ask Tin about computer use" handler. Fires when the user
  // clicks the toggle in the driver-absent + never-engaged state — same
  // predicate that switches the tooltip cursor to a question mark. Commits
  // a static install-funnel assistant message directly (no model involvement);
  // the install card is a deterministic onboarding step, not a model-driven
  // suggestion. The message is filtered out of the model's context by
  // chat-query-builder so future turns aren't confused by it.
  const handleComputerUseAsk = useCallback(() => {
    setCurrentChat((c) => ({
      ...c,
      messages: [
        ...c.messages,
        {
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          computerUseInstallSuggestion: {},
        },
      ],
    }))
  }, [setCurrentChat])

  // Commit a consent-prompt message the moment the session enters `consent`,
  // so the agent's "I'd like permission" appears chronologically in chat
  // (right after its computer_begin tool-call message) instead of as a
  // context-stealing modal. The renderer for these messages reads the live
  // session's approve/cancel via `ComputerUseConsentContext` (provided
  // below) and falls back to a read-only history view on reload.
  //
  // Each consent message is identified by `task`; the approve/cancel
  // wrappers below update the SAME message in-place. Without this dedupe
  // ref, transient phase oscillations would commit duplicates.
  const committedConsentTaskRef = useRef<string | null>(null)
  const committedPairingRef = useRef<string | null>(null)
  // Lift the sub-state read out of the effect so exhaustive-deps sees plain
  // primitive deps (not `computerUseSession.state.*` chains) and the lint
  // matches the way the done/error commit effect below depends on the
  // session.
  const consentPhase = computerUseSession.state.phase
  const consentTask = computerUseSession.state.task
  const consentManifest = computerUseSession.state.manifest
  const consentReason = computerUseSession.state.reason
  const pairingCode = computerUseSession.state.pairingCode
  const pairingState = computerUseSession.state.pairingState

  // Commit an inline pairing-prompt message the moment the session enters
  // `pairing`, so the user sees the code in the chat (matching what the tray
  // shows) instead of a modal. The same key-by-task dedupe pattern as the
  // consent commit. Code may be undefined on the first render — we still
  // commit so the layout doesn't jump when the code arrives; the renderer
  // shows "····" placeholder.
  useEffect(() => {
    if (consentPhase !== 'pairing' || !consentTask) return
    if (committedPairingRef.current === consentTask) {
      // Already committed — keep `pairingCode` in sync on the matching
      // message if the code arrived after the initial commit.
      if (pairingCode) {
        setCurrentChat((c) => {
          const idx = c.messages
            .map((msg, i) => ({ msg, i }))
            .filter(
              (x) =>
                x.msg.computerUsePairingStatus === 'pending' &&
                !x.msg.computerUsePairingCode,
            )
            .pop()?.i
          if (idx === undefined) return c
          const next = c.messages.slice()
          next[idx] = {
            ...next[idx],
            computerUsePairingCode: pairingCode,
          }
          return { ...c, messages: next }
        })
      }
      return
    }
    committedPairingRef.current = consentTask
    setCurrentChat((c) => ({
      ...c,
      messages: [
        ...c.messages,
        {
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          computerUsePairingCode: pairingCode,
          computerUsePairingStatus: 'pending',
        },
      ],
    }))
  }, [consentPhase, consentTask, pairingCode, setCurrentChat])

  // When the pairing phase ends, resolve the pending pairing message. On
  // a SUCCESSFUL pairing the message is REMOVED — the session-record card
  // below carries the audit trail and "pairing complete + ready" is
  // implicit. On denial / cancel / timeout we leave a terminal record so
  // the user can see what happened.
  useEffect(() => {
    if (consentPhase === 'pairing') return
    setCurrentChat((c) => {
      const idx = c.messages
        .map((msg, i) => ({ msg, i }))
        .filter((x) => x.msg.computerUsePairingStatus === 'pending')
        .pop()?.i
      if (idx === undefined) return c
      // `pairingState === 'denied'` is authoritative for the denial case;
      // otherwise infer from the phase transition. Phases consent / running
      // / done / handoff all mean "pairing succeeded" → drop the message.
      const succeeded =
        pairingState !== 'denied' &&
        (consentPhase === 'consent' ||
          consentPhase === 'running' ||
          consentPhase === 'done' ||
          consentPhase === 'handoff')
      if (succeeded) {
        return { ...c, messages: c.messages.filter((_, i) => i !== idx) }
      }
      const status: 'denied' | 'cancelled' =
        pairingState === 'denied' ? 'denied' : 'cancelled'
      const next = c.messages.slice()
      next[idx] = { ...next[idx], computerUsePairingStatus: status }
      return { ...c, messages: next }
    })
    if (!consentTask) {
      committedPairingRef.current = null
    }
  }, [consentPhase, consentTask, pairingState, setCurrentChat])
  useEffect(() => {
    if (consentPhase !== 'consent' || !consentTask || !consentManifest) return
    if (committedConsentTaskRef.current === consentTask) return
    committedConsentTaskRef.current = consentTask
    setCurrentChat((c) => ({
      ...c,
      messages: [
        ...c.messages,
        {
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          computerUseProposedManifest: consentManifest,
          computerUseTaskReason: consentReason,
          computerUseConsentStatus: 'pending',
        },
      ],
    }))
  }, [
    consentPhase,
    consentTask,
    consentManifest,
    consentReason,
    setCurrentChat,
  ])

  // Approve wrapper: REMOVES the pending consent message from chat (rather
  // than mutating it to an "approved" record) so the chat doesn't show two
  // computer-use cards in a row — the session-record committed below carries
  // the approved manifest + the frame trail. The user's click on Approve is
  // ack enough; we don't need a separate "✓ Sandbox approved" tombstone.
  // (Cancel still leaves a record — see cancelConsentForChat below.)
  const approveConsentForChat = useCallback(
    (m: CapabilityManifest) => {
      setCurrentChat((c) => {
        const idx = c.messages
          .map((msg, i) => ({ msg, i }))
          .filter((x) => x.msg.computerUseConsentStatus === 'pending')
          .pop()?.i
        if (idx === undefined) return c
        return {
          ...c,
          messages: c.messages.filter((_, i) => i !== idx),
        }
      })
      void computerUseSession.approve(m)
    },
    [computerUseSession, setCurrentChat],
  )

  // Cancel wrapper for the consent UI: marks the pending consent message as
  // cancelled (so the chronological record reflects the user's choice), then
  // tears the session down. Used when the user clicks "Cancel" in the
  // editor; other cancellation paths (tray reject, driver error) go through
  // the session's own error path and clear committedConsentTaskRef below.
  const cancelConsentForChat = useCallback(() => {
    setCurrentChat((c) => {
      const idx = c.messages
        .map((msg, i) => ({ msg, i }))
        .filter((x) => x.msg.computerUseConsentStatus === 'pending')
        .pop()?.i
      if (idx === undefined) return c
      const next = c.messages.slice()
      next[idx] = {
        ...next[idx],
        computerUseConsentStatus: 'cancelled',
      }
      return { ...c, messages: next }
    })
    computerUseSession.cancel()
  }, [computerUseSession, setCurrentChat])

  // Once the session leaves the consent phase we should be willing to commit
  // a fresh consent message for the next computer_begin. The dedupe ref is
  // keyed on `task`, which `cancel()` zeroes — so this also catches the
  // `cancel`-from-tray path that skips approveConsentForChat /
  // cancelConsentForChat. We do NOT touch the chat history here (it's the
  // approve/cancel wrappers' job); this is purely about future runs.
  useEffect(() => {
    if (consentPhase !== 'consent') {
      // Keep the ref in lockstep with `task`: once task clears (after
      // cancel()) the next start() can commit a new consent message.
      if (!consentTask) {
        committedConsentTaskRef.current = null
      }
    }
  }, [consentPhase, consentTask])

  // Context value for the consent renderer: stable across renders, so the
  // renderer doesn't tear down its inputs on every parent re-render.
  const consentContextValue = useMemo<ComputerUseConsentContextValue>(
    () => ({
      approve: approveConsentForChat,
      cancel: cancelConsentForChat,
      images: computerUseSession.state.images,
    }),
    [
      approveConsentForChat,
      cancelConsentForChat,
      computerUseSession.state.images,
    ],
  )

  // Drop a message at `index` from chat history. Used by the session-record
  // card's red light (and the install-funnel context) to let the user clear
  // a failed/stale run. Because the model context is built from the same
  // `currentChat.messages` array, removing here also removes from context.
  const handleRemoveMessage = useCallback(
    (index: number) => {
      setCurrentChat((c) =>
        index < 0 || index >= c.messages.length
          ? c
          : { ...c, messages: c.messages.filter((_, i) => i !== index) },
      )
    },
    [setCurrentChat],
  )

  // Wrap session.cancel() for the inline pairing card's "Cancel pairing"
  // button. Cancelling the session is enough — the pairing-commit effect
  // above watches the phase transition and flips the message to
  // `cancelled` automatically.
  const handleCancelPairing = useCallback(() => {
    computerUseSession.cancel()
  }, [computerUseSession])

  // Context for in-chat computer-use cards (install funnel + session record
  // + pairing card) to drive whole-session actions. Stable; doesn't depend
  // on session state.
  const funnelContextValue = useMemo<ComputerUseFunnelContextValue>(
    () => ({
      connect: handleComputerUseConnect,
      cancelPairing: handleCancelPairing,
      removeMessage: handleRemoveMessage,
    }),
    [handleComputerUseConnect, handleCancelPairing, handleRemoveMessage],
  )

  // Commit a finished session's audit trail into chat history at its
  // chronological position. Builds TWO messages:
  //
  //   1) Session-record message — frames + manifest + (on error) the error
  //      banner. `content` stays empty so the chat-query builder skips it on
  //      future turns (it's an audit trail; the model already saw every frame
  //      in the loop). Picks `ComputerUseSessionRenderer`, which reads like
  //      the live thread did.
  //   2) Final answer — a plain assistant turn carrying the model's last
  //      message, so it reads as a normal chat bubble and round-trips to the
  //      model on follow-up turns.
  //
  // Pure with respect to the session: it reads only the snapshot passed in,
  // so the caller can `cancel()` immediately after (which zeroes the live
  // state) without racing the commit. Shared by the explicit-stop handler
  // (red traffic light) and the pre-begin error path below.
  const commitSessionRecord = useCallback(
    (snapshot: {
      frames: LoopEvent[]
      finalText?: string
      error?: string
      manifest?: CapabilityManifest
      isError: boolean
    }) => {
      const { frames, finalText, error, manifest, isError } = snapshot
      // Strip the trailing model_message that matches finalText so the card
      // doesn't render the answer twice (the loop emits a model_message for
      // every turn, including the final no-tool-calls one that IS the answer).
      const trimmedFrames =
        finalText && frames.length > 0
          ? (() => {
              const last = frames[frames.length - 1]
              return last &&
                last.type === 'model_message' &&
                last.content === finalText
                ? frames.slice(0, -1)
                : frames
            })()
          : frames
      // Ordered timestamps (record first, answer 1ms later) so chat sorting
      // is unambiguous and scroll-to-bottom lands on the answer.
      const recordTs = new Date()
      const answerTs = new Date(recordTs.getTime() + 1)
      setCurrentChat((c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: 'assistant',
            content: '',
            timestamp: recordTs,
            computerUseFrames: trimmedFrames,
            ...(manifest ? { computerUseManifest: manifest } : {}),
            ...(isError
              ? { isError: true, computerUseError: error ?? 'Session failed.' }
              : {}),
          },
          // Only emit the answer when the model produced one. On error (or a
          // silent finish) we omit it — the record carries the signal.
          ...(finalText
            ? [
                {
                  role: 'assistant' as const,
                  content: finalText,
                  timestamp: answerTs,
                },
              ]
            : []),
        ],
      }))
      // Scroll to bottom so the newly-committed answer is the first thing the
      // user sees. The 60ms delay covers the DOM commit + the synthetic
      // message's image frames laying out.
      setTimeout(() => {
        const el = scrollContainerRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      }, 60)
    },
    [setCurrentChat],
  )

  // Explicit stop (red traffic light on the live session thread). Snapshot
  // the run into history, THEN tear the VM down. Deferring the commit until
  // the operator stops is what keeps the live view + terminal usable after
  // the agent finishes its turn — the run no longer vanishes into a static
  // card the moment the model stops emitting actions.
  const handleStopSession = useCallback(() => {
    const { phase, frames, finalText, error, manifest } =
      computerUseSession.state
    commitSessionRecord({
      frames,
      finalText,
      error,
      manifest,
      isError: phase === 'error',
    })
    computerUseSession.cancel()
  }, [computerUseSession, commitSessionRecord])

  // A session that errors BEFORE it ever produced a VM (pairing / provision /
  // consent failure — no `sessionId`, so the live thread never mounts to
  // offer a red light) has nothing for the operator to keep using. Commit its
  // error record straight to history and reset so the failure is visible in
  // the scroll. Post-begin errors keep the thread mounted and are committed
  // via `handleStopSession` instead.
  const committedSessionTaskRef = useRef<string | null>(null)
  useEffect(() => {
    const { phase, task, sessionId, frames, error, manifest } =
      computerUseSession.state
    if (phase !== 'error' || sessionId) return
    const key = `${task}::error`
    if (committedSessionTaskRef.current === key) return
    committedSessionTaskRef.current = key
    commitSessionRecord({
      frames,
      error: error ?? 'Session failed.',
      manifest,
      isError: true,
    })
    computerUseSession.cancel()
    // `cancel()` zeroes `state.task`, so reset the dedupe key for future runs.
    committedSessionTaskRef.current = null
  }, [computerUseSession, commitSessionRecord])

  // Initialize document uploader hook
  const { handleDocumentUpload, describeImageWithMultimodal } =
    useDocumentUploader(isPremium, selectedModelDetails?.multimodal)

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

    // Mark images as generating descriptions. The setState-in-effect is the
    // right pattern here: we're reacting to a model switch (prop change) by
    // kicking off async work, and the flag in the state IS the kickoff (the
    // rendering branch reads it to spawn the description job).
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
          position: 'top-left',
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
      const recovered = await showPasskeyRecoveryPrompt()
      if (recovered) {
        setShowCloudSyncSetupModal(true)
        return
      }
      const routed = await showFirstTimePasskeyPrompt()
      if (routed) return
    }
    setShowCloudSyncSetupModal(true)
  }, [showPasskeyRecoveryPrompt, showFirstTimePasskeyPrompt])

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

  const handleAddRecoveryKey = useCallback(
    async (key: string) => {
      await addRecoveryKey(key)
      await retryProfileDecryption()
      await reloadChats()
    },
    [addRecoveryKey, retryProfileDecryption, reloadChats],
  )

  // Handler for creating a new project with a random name
  const handleCreateProject = useCallback(async () => {
    try {
      const name = generateProjectName()
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
  }, [createProject, enterProjectMode, toast])

  // Handler for exiting project mode - creates a new chat and exits
  const handleExitProject = useCallback(() => {
    createNewChat(false, true)
    exitProjectMode()
  }, [createNewChat, exitProjectMode])

  // Extract optional-chain values to local consts so the React Compiler can
  // recognize the memoization (`preserve-manual-memoization` doesn't see
  // through `currentChat?.id`-style deps).
  const currentChatId = currentChat?.id
  const isCurrentChatTemporary = currentChat?.isTemporary
  const handleToggleTemporaryMode = useCallback(() => {
    if (isCurrentChatTemporary) {
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

    previousChatIdRef.current = currentChatId ?? null
    const tempChat: Chat = {
      id: `temp-${Date.now()}`,
      title: 'Temporary Chat',
      titleState: 'placeholder',
      messages: [],
      createdAt: new Date(),
      isBlankChat: true,
      isTemporary: true,
    }
    setCurrentChat(tempChat)
  }, [
    chats,
    createNewChat,
    currentChatId,
    isCurrentChatTemporary,
    setCurrentChat,
  ])

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

      if (!isSupportedFile(file.name)) {
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
          const contextLimit = parseContextWindowTokens(
            selectedModelDetails?.contextWindow,
          )

          const existingTokens = processedDocuments.reduce(
            (total, doc) => total + estimateTokenCount(doc.content),
            0,
          )

          if (existingTokens + newDocTokens > contextLimit) {
            setProcessedDocuments((prev) =>
              prev.filter((doc) => doc.id !== tempDocId),
            )

            toast({
              title: 'Context window saturated',
              description:
                "The selected model's context window is full. Remove a document or choose a model with a larger context window before uploading more files.",
              variant: 'destructive',
              position: 'top-left',
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
            position: 'top-left',
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
              position: 'top-left',
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
            position: 'top-left',
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

  // Calculate context usage percentage (memoized to prevent re-calculation during streaming)
  const contextUsagePercentage = useMemo(() => {
    // Calculate context usage
    const contextLimit = parseContextWindowTokens(
      selectedModelDetails?.contextWindow,
    )

    let totalTokens = 0

    // Count tokens from messages
    if (currentChat?.messages) {
      currentChat.messages.forEach((msg) => {
        totalTokens += estimateTokenCount(msg.content)
        if (msg.thoughts) {
          totalTokens += estimateTokenCount(msg.thoughts)
        }
      })
    }

    // Count tokens from documents
    if (processedDocuments) {
      processedDocuments.forEach((doc) => {
        totalTokens += estimateTokenCount(doc.content)
      })
    }

    return (totalTokens / contextLimit) * 100
  }, [
    currentChat?.messages,
    processedDocuments,
    selectedModelDetails?.contextWindow,
  ])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (rateLimit && rateLimit.remaining <= 0) {
      if (!isSignedIn) {
        void openSignIn()
      } else {
        setIsSidebarOpen(true)
        window.dispatchEvent(
          new CustomEvent('highlightSidebarBox', {
            detail: { isPremium },
          }),
        )
      }
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
  //
  // Reading/writing the ref during render is intentional here: by the time a
  // useLayoutEffect fires the DOM has already been mutated, so capturing the
  // pre-commit scrollTop has to happen during render. The companion
  // useLayoutEffect below restores. (react-hooks/refs flags this as advisory;
  // it is the correct pattern for scroll preservation.)
  const savedScrollTopRef = useRef<number | null>(null)
  // eslint-disable-next-line react-hooks/refs
  if (showScrollButton && scrollContainerRef.current) {
    // eslint-disable-next-line react-hooks/refs
    savedScrollTopRef.current = scrollContainerRef.current.scrollTop
  } else {
    // eslint-disable-next-line react-hooks/refs
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

          {/* Temporary chat toggle - hidden once a chat has started */}
          {!(currentChat?.messages && currentChat.messages.length > 0) && (
            <div className="group relative">
              <button
                type="button"
                onClick={handleToggleTemporaryMode}
                aria-label={
                  isTemporaryMode
                    ? 'Exit temporary chat'
                    : 'Start temporary chat'
                }
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
                {isTemporaryMode ? 'Exit temporary chat' : 'Temporary chat'}
              </span>
            </div>
          )}

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
                  isPremium={isPremium}
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
                  isPremium={isPremium}
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
                backupWarningVisible={
                  isSignedIn &&
                  (passkeySetupFailed || manualRecoveryNeeded) &&
                  !passkeyRecoveryNeeded
                }
                backupWarningNeedsRecovery={manualRecoveryNeeded}
                onDismissBackupWarning={dismissBackupWarning}
                onChatsUpdated={reloadChats}
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

      <ComputerUseSessionDialog session={computerUseSession} />

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
        onKeyChange={handleKeyChanged}
        onAddRecoveryKey={handleAddRecoveryKey}
        passkeyActive={passkeyActive}
        passkeySetupAvailable={passkeySetupAvailable}
        onSetupPasskey={setupPasskey}
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

            {/* Rate Limit Banner */}
            {shouldShowRateLimitBanner(rateLimit) && (
              <RateLimitBanner rateLimit={rateLimit} isDarkMode={isDarkMode} />
            )}

            {/* Decryption Progress Banner */}
            {decryptionProgress && decryptionProgress.isDecrypting && (
              <div className="border-b border-border-subtle bg-surface-chat px-4 py-2 text-content-secondary">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PiSpinner className="h-4 w-4 animate-spin text-content-secondary" />
                    <span className="text-sm">
                      Decrypting chats with new key...
                    </span>
                  </div>
                  {decryptionProgress.total > 0 && (
                    <span className="text-sm">
                      {decryptionProgress.current} / {decryptionProgress.total}
                    </span>
                  )}
                </div>
              </div>
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
              {streamError && (
                <StreamErrorBanner
                  message={streamError}
                  onDismiss={dismissStreamError}
                  isDarkMode={isDarkMode}
                />
              )}
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                data-scroll-container="main"
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
                  {/* Expose the live session's approve/cancel + ready images
                      to ComputerUseConsentRenderer, which sits inside the
                      ChatMessages tree. Without this provider a consent
                      message renders as a read-only history record (the
                      reload-mid-prompt case). */}
                  <ComputerUseConsentContext.Provider
                    value={consentContextValue}
                  >
                    <ComputerUseFunnelContext.Provider
                      value={funnelContextValue}
                    >
                      <ChatMessages
                        messages={currentChat?.messages || []}
                        isDarkMode={isDarkMode}
                        chatId={currentChat.id}
                        isWaitingForResponse={isWaitingForResponse}
                        isStreamingResponse={isStreaming}
                        computerUseSession={
                          <ComputerUseSessionThread
                            session={computerUseSession}
                            onStop={handleStopSession}
                          />
                        }
                        isPremium={isPremium}
                        models={models}
                        onSubmit={handleSubmit}
                        input={input}
                        setInput={setInput}
                        loadingState={loadingState}
                        retryInfo={retryInfo}
                        cancelGeneration={cancelGeneration}
                        inputRef={inputRef}
                        handleInputFocus={handleInputFocus}
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
                        onWebSearchToggle={() =>
                          setWebSearchEnabled((prev) => !prev)
                        }
                        reasoningEffort={reasoningEffort}
                        setReasoningEffort={setReasoningEffort}
                        thinkingEnabled={thinkingEnabled}
                        setThinkingEnabled={setThinkingEnabled}
                        codeExecutionEnabled={
                          canEnableCodeExecution ? codeExecutionEnabled : false
                        }
                        onCodeExecutionToggle={
                          canEnableCodeExecution
                            ? () => setCodeExecutionEnabled((prev) => !prev)
                            : undefined
                        }
                        computerUseEnabled={computerUseEnabled}
                        onComputerUseToggle={() =>
                          setComputerUseEnabled((prev) => !prev)
                        }
                        onComputerUseConnect={handleComputerUseConnect}
                        onComputerUseSetup={handleComputerUseSetup}
                        onComputerUseAsk={handleComputerUseAsk}
                        computerUseModel={selectedModelDetails}
                        onOpenVerifier={() => setIsVerifierSidebarOpen(true)}
                        isTemporaryMode={isTemporaryMode}
                      />
                    </ComputerUseFunnelContext.Provider>
                  </ComputerUseConsentContext.Provider>
                </div>
              </div>
            </div>

            {/* Input Form - Show on mobile always, on desktop only when there are messages */}
            {isClient &&
              (windowWidth < CONSTANTS.MOBILE_BREAKPOINT ||
                (currentChat?.messages && currentChat.messages.length > 0)) && (
                <div
                  ref={inputAreaRef}
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
                        handleInputFocus={handleInputFocus}
                        inputMinHeight={inputMinHeight}
                        isDarkMode={isDarkMode}
                        handleDocumentUpload={handleFileUpload}
                        processedDocuments={processedDocuments}
                        removeDocument={removeDocument}
                        isPremium={isPremium}
                        quote={quote}
                        onClearQuote={() => setQuote(null)}
                        isTemporaryMode={isTemporaryMode}
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
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleLabelClick('model', () => {})
                                }}
                                className="flex items-center gap-1 text-content-secondary transition-colors hover:text-content-primary"
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
                          if (!isReasoningModel(m)) return undefined
                          return (
                            <ReasoningEffortSelector
                              supportsEffort={supportsReasoningEffort(m)}
                              supportsToggle={supportsThinkingToggle(m)}
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
                        onWebSearchToggle={() =>
                          setWebSearchEnabled((prev) => !prev)
                        }
                        codeExecutionEnabled={
                          canEnableCodeExecution ? codeExecutionEnabled : false
                        }
                        onCodeExecutionToggle={
                          canEnableCodeExecution
                            ? () => setCodeExecutionEnabled((prev) => !prev)
                            : undefined
                        }
                        computerUseEnabled={computerUseEnabled}
                        onComputerUseToggle={() =>
                          setComputerUseEnabled((prev) => !prev)
                        }
                        onComputerUseConnect={handleComputerUseConnect}
                        onComputerUseSetup={handleComputerUseSetup}
                        onComputerUseAsk={handleComputerUseAsk}
                        computerUseModel={selectedModelDetails}
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
              return true
            } catch {
              return false
            }
          }}
          isDarkMode={isDarkMode}
          initialCloudSyncEnabled={true}
          prfSupported={
            passkeyActive || passkeyRecoveryNeeded || passkeySetupAvailable
          }
          passkeyRecoveryNeeded={passkeyRecoveryNeeded}
          manualRecoveryNeeded={manualRecoveryNeeded}
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
    </div>
  )
}
