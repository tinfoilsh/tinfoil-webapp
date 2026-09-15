import { getSelectedModelLabel } from '@/config/models'
import { useProjects } from '@/hooks/use-projects'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { useToast } from '@/hooks/use-toast'
import { useAuth, useUser } from '@clerk/nextjs'
import { ArrowDownIcon } from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import Link from 'next/link'
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
  ProjectModeIndicator,
  ProjectSidebar,
  useProject,
} from '@/components/project'
import { GridTexture } from '@/components/ui/grid-texture'
import { cn } from '@/components/ui/utils'
import { usePasskeyBackup } from '@/hooks/use-passkey-backup'

import { encryptionService } from '@/services/encryption/encryption-service'
import { getNewChatPath, isPlainPrimaryClick } from '@/utils/navigation'
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
import { ChatSidebar } from './chat-sidebar'
import { PromptPresetSuggestions } from './components/prompt-preset-suggestions'
import { CONSTANTS } from './constants'
import { DragProvider } from './drag-context'
import { GenUIInputAreaRenderer } from './genui/GenUIInputAreaRenderer'
import { selectPendingInputToolCallFromChat } from './genui/pending-input-tool-call'
import {
  artifactPreviewTargetsEqual,
  OPEN_ARTIFACT_PREVIEW_EVENT,
  type ArtifactPreviewSidebarDetail,
  type ArtifactPreviewSidebarEventDetail,
} from './genui/widgets/ArtifactPreview'
import { useAutoIntelligence } from './hooks/use-auto-intelligence'
import { usePromptLibrary } from './hooks/use-prompt-library'
import {
  useReasoningEffort,
  useThinkingEnabled,
} from './hooks/use-reasoning-effort'
import { useSidebarChat } from './hooks/use-sidebar-chat'
import { MessageQueue } from './message-queue'
import { ModelSelector } from './model-selector'
import { ModelSelectorTriggerLabel } from './model-selector-trigger-label'
import { openProjectChat } from './project-navigation'
import { QuoteSelectionPopover } from './quote-selection-popover'
import { initializeRenderers } from './renderers/client'
import type { ProcessedDocument } from './renderers/types'
import type { SettingsTab } from './settings-modal'
import type { Chat } from './types'
// Lazy-load modals that aren't shown on initial load. The loaders are
// hoisted so they can be pre-warmed (see preloadCloudSyncModals) before
// the user clicks, keeping the chunk fetch off the click critical path.
const loadCloudSyncSetupModal = () => import('../modals/cloud-sync-setup-modal')

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

import { displayModels } from '@/config/models'
import { useHarness } from '@/services/harness/provider'
import type {
  Attachment as HarnessAttachment,
  Turn,
} from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { attachmentView } from '@/services/harness/view-model'
import {
  authorizeCurrentPrimaryKeyOrThrow,
  registerStartFreshKeyIfNeeded,
} from '@/services/keys/cloud-key-authorization'
import { useUIState } from './hooks/use-ui-state'

type ChatInterfaceProps = {
  initialChatId?: string | null
  initialProjectId?: string | null
  isLocalChatUrl?: boolean
  initialNewChatIsLocalOnly?: boolean
  suppressIntroModals?: boolean
  inputMinHeight?: string
}
export function ChatInterface({
  initialChatId,
  initialProjectId,
  initialNewChatIsLocalOnly = false,
  suppressIntroModals = false,
  inputMinHeight = '60px',
}: ChatInterfaceProps) {
  const { api, session, profile, keyReady, error: sessionError } = useHarness()
  const { isSignedIn } = useAuth()
  const { user } = useUser()
  const { toast } = useToast()
  const router = useRouter()
  const {
    isClient,
    isSidebarOpen,
    setIsSidebarOpen,
    isDarkMode,
    themeMode,
    setThemeMode,
    windowWidth,
    handleInputFocus,
  } = useUIState()
  const {
    activeProject,
    loadingProject,
    isProjectMode,
    enterProjectMode,
    exitProjectMode,
    createProject,
    uploadDocument,
  } = useProject()
  const { projects } = useProjects({ autoLoad: !!isSignedIn })
  const thread = useThread(
    initialChatId,
    activeProject?.id ?? initialProjectId,
    initialNewChatIsLocalOnly,
  )
  const {
    chat: currentChat,
    chats,
    loading: isChatHydrating,
    running: isStreaming,
    model: selectedModel,
    presetId: activePresetId,
  } = thread
  useEffect(() => {
    if (
      !currentChat.id ||
      currentChat.isTemporary ||
      currentChat.id === initialChatId
    )
      return
    const path = currentChat.projectId
      ? `/project/${currentChat.projectId}/chat/${currentChat.id}`
      : `/chat/${currentChat.id}`
    if (window.location.pathname !== path)
      void router
        .replace(path, undefined, { shallow: true })
        .catch(thread.report)
  }, [
    currentChat.id,
    currentChat.isTemporary,
    currentChat.projectId,
    initialChatId,
    router,
    thread.report,
  ])
  const models = useMemo(() => displayModels(session), [session])
  const isLoadingConfig = !session
  const hasValidatedModel = !!session
  const loadingState = isStreaming ? 'streaming' : 'idle'
  const isWaitingForResponse =
    isStreaming && currentChat.messages.at(-1)?.role !== 'assistant'
  const isTemporaryMode = thread.temporary
  const rateLimit =
    thread.state.snapshot.rateLimit ?? session?.rateLimit ?? null
  const retryInfo = null
  const streamError = thread.error
    ? {
        message: thread.error,
        code: thread.state.error?.code,
        timestamp: Date.now(),
        retryable: true,
      }
    : null
  const dismissStreamError = thread.dismissError
  const {
    isLoading: isSubscriptionLoading,
    chat_subscription_active: isPremium,
  } = useSubscriptionStatus()
  const encryptionKey = encryptionService.getKey()
  const cloudSyncSettingEnabled = !!isSignedIn
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [expandedLabel, setExpandedLabel] = useState<
    'model' | 'verify' | 'info' | null
  >(null)
  const handleLabelClick = (
    label: 'model' | 'verify' | 'info',
    action: () => void,
  ) => {
    setExpandedLabel((value) => (value === label ? null : label))
    action()
  }
  const [processedDocuments, setProcessedDocuments] = useState<
    ProcessedDocument[]
  >([])
  const [quote, setQuote] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  useEffect(() => {
    if (
      !suppressIntroModals &&
      session &&
      keyReady &&
      !profile.hasSeenOnboarding &&
      localStorage.getItem('tinfoil-settings-has-seen-onboarding') !== 'true'
    )
      setShowOnboarding(true)
  }, [suppressIntroModals, session, keyReady, profile.hasSeenOnboarding])
  const [isVerifierSidebarOpen, setIsVerifierSidebarOpen] = useState(false)
  const [hasMountedVerifierSidebar, setHasMountedVerifierSidebar] =
    useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [hasMountedSettingsModal, setHasMountedSettingsModal] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>()
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [hasMountedShareModal, setHasMountedShareModal] = useState(false)
  const [isPromptLibraryModalOpen, setIsPromptLibraryModalOpen] =
    useState(false)
  const [hasMountedPromptLibrary, setHasMountedPromptLibrary] = useState(false)
  const [showCloudSyncSetupModal, setShowCloudSyncSetupModal] = useState(false)
  const [isFirstTimePasskeySetupBusy, setIsFirstTimePasskeySetupBusy] =
    useState(false)
  const [isSubscribePromptOpen, setIsSubscribePromptOpen] = useState(false)
  const [isAskSidebarOpen, setIsAskSidebarOpen] = useState(false)
  const [isArtifactSidebarOpen, setIsArtifactSidebarOpen] = useState(false)
  const [artifactSidebarWidth, setArtifactSidebarWidth] = useState<number>(
    CONSTANTS.ASK_SIDEBAR_WIDTH_PX,
  )
  const [artifactPreview, setArtifactPreview] =
    useState<ArtifactPreviewSidebarDetail | null>(null)
  const [activeArtifactToolCallId, setActiveArtifactToolCallId] = useState<
    string | null
  >(null)
  const [, setVerificationDocument] = useState<unknown>(null)
  const [verificationStatus, setVerificationStatus] = useState<
    'pending' | 'verified' | 'failed'
  >('pending')
  const [showAddToProjectModal, setShowAddToProjectModal] = useState(false)
  const [pendingProjectUpload, setPendingProjectUpload] = useState<{
    projectId: string
    files: File[]
  } | null>(null)
  const [isGlobalDragActive, setIsGlobalDragActive] = useState(false)
  const dragCounterRef = useRef(0)
  const { reasoningEffort, setReasoningEffort } = useReasoningEffort()
  const { thinkingEnabled, setThinkingEnabled } = useThinkingEnabled()
  const { autoIntelligence, setAutoIntelligence } = useAutoIntelligence()
  const { getPresetById } = usePromptLibrary()
  const activePreset = getPresetById(activePresetId)
  const pixelateSidebarChatTitles =
    profile.pixelateSidebarChatTitlesEnabled ?? true
  const webSearchAvailable = session?.features.webSearch ?? false
  const effectiveWebSearchEnabled =
    currentChat.webSearchEnabled ?? profile.webSearchEnabled ?? true
  const codeExecutionEnabled = profile.codeExecutionEnabled ?? false
  const canEnableCodeExecution = session?.features.codeExecution ?? false
  const contextUsage = thread.state.snapshot.thread?.contextUsage ?? undefined
  const modKey =
    typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
      ? '⌘'
      : 'Ctrl+'
  const documentTitle =
    (profile.browserTabChatTitleEnabled ?? true) &&
    currentChat.titleState !== 'placeholder'
      ? `${currentChat.title} · Tinfoil`
      : 'Tinfoil Private Chat'
  const handleInputFocusWithRateLimitCheck = handleInputFocus
  const reloadChats = () => thread.refresh()
  const createNewChat = (_temporary?: boolean, _fromUserAction?: boolean) => {
    thread.newChat()
    setInput('')
    setQuote(null)
    setProcessedDocuments([])
    void router.push(
      activeProject ? `/project/${activeProject.id}` : '/',
      undefined,
      { shallow: true },
    )
  }
  const handleChatSelect = (id: string) => {
    setProcessedDocuments([])
    setQuote(null)
    void thread
      .open(id)
      .then(() =>
        router.push(
          activeProject
            ? `/project/${activeProject.id}/chat/${id}`
            : `/chat/${id}`,
          undefined,
          { shallow: true },
        ),
      )
      .catch(thread.report)
  }
  const loadChatById = (id: string, _local?: boolean) => thread.open(id)
  const deleteChat = (id: string) => {
    void thread.remove(id).catch(thread.report)
  }
  const updateChatTitle = (id: string, title: string) => {
    void thread.update(id, { title }).catch(thread.report)
  }
  const handleModelSelect = (model: string) => {
    thread.setModel(model)
    setExpandedLabel(null)
    if (currentChat.id && !isTemporaryMode)
      void thread.update(currentChat.id, { model }).catch(thread.report)
    void api.updateProfile({ selectedModel: model }).catch(thread.report)
  }
  const handleSetActivePreset = (presetId: string | null) => {
    thread.setPresetId(presetId)
    if (currentChat.id && !isTemporaryMode)
      void thread.update(currentChat.id, { presetId }).catch(thread.report)
  }
  const options = {
    model: selectedModel,
    autoIntelligence,
    reasoningEffort,
    thinking: thinkingEnabled,
    webSearch: effectiveWebSearchEnabled,
    codeExecution: codeExecutionEnabled,
    piiCheck: profile.piiCheckEnabled ?? true,
    genUI: profile.genUIEnabled ?? true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
  const handleQuery = (content: string, fields: Partial<Turn> = {}) => {
    try {
      return thread.send({ content, options, ...fields })
    } catch (cause) {
      thread.report(cause)
    }
  }
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (
      isChatHydrating ||
      processedDocuments.some((d) => d.isUploading) ||
      (!input.trim() && !processedDocuments.length)
    )
      return
    const result = handleQuery(input, {
      quote: quote ?? undefined,
      attachments: processedDocuments.flatMap((d) =>
        d.attachment ? [d.attachment.id] : [],
      ),
    })
    if (result) {
      setInput('')
      setQuote(null)
      setProcessedDocuments([])
    }
  }
  const editMessage = (index: number, content: string) => {
    void handleQuery(content, {
      kind: 'edit',
      messageId: currentChat.messages[index]?.id,
    })
  }
  const regenerateMessage = (index: number) => {
    void handleQuery('', {
      kind: 'regenerate',
      messageId: currentChat.messages[index]?.id,
    })
  }
  const resolveInputToolCall = (
    toolCallId: string,
    text: string,
    data?: unknown,
  ) => {
    void handleQuery('', {
      kind: 'resolve',
      toolCallId,
      resolution: { text, data: data as any },
    })
  }
  const retryToolCall = async (index: number, toolCallId: string) => {
    return Boolean(
      await handleQuery('', {
        kind: 'retryToolCall',
        messageId: currentChat.messages[index]?.id,
        toolCallId,
      }),
    )
  }
  const retryLastMessage = () => {
    void thread.reconnect().catch(thread.report)
  }
  const cancelGenerationAndResumeQueue = () => {
    void thread.cancel().catch(thread.report)
  }
  const queuedMessages = thread.state.snapshot.queue.map((q) => ({
    id: q.queueId,
    text: q.content,
  }))
  const removeQueuedMessage = (id: string) => {
    void thread.removeQueued(id).catch(thread.report)
  }
  const pinnedChatIds = thread.threads.filter((t) => t.pinned).map((t) => t.id)
  const favoriteChats = chats.filter((c) => c.pinned)
  const unpinChat = (id: string) => {
    void thread.update(id, { pinned: false }).catch(thread.report)
  }
  const handleToggleFavorite = (chat: { id: string }) =>
    thread.update(chat.id, { pinned: !pinnedChatIds.includes(chat.id) })
  const handleOpenFavorite = (chat: { id: string }) => handleChatSelect(chat.id)
  const handleMoveChatToProject = (id: string, projectId: string) =>
    thread.update(id, { projectId }).then(reloadChats)
  const handleRemoveChatFromProject = (id: string) =>
    thread.update(id, { projectId: null }).then(reloadChats)
  const handleDeleteProjectChats = async () => {
    if (!activeProject) return
    await api.post('/v1/threads/delete-all', { projectId: activeProject.id })
    thread.newChat()
    await thread.refresh()
  }
  const handleCreateProject = async () => {
    const project = await createProject({ name: 'New Project' })
    await enterProjectMode(project.id)
    createNewChat()
  }
  const handleExitProject = () => {
    exitProjectMode()
    thread.newChat()
    void router.push('/')
  }
  const handleExitProjectWhileDragging = handleExitProject
  const canToggleTemporaryChat = (chat: Chat) =>
    !chat.id && !processedDocuments.length && !isStreaming
  const handleToggleTemporaryMode = () => {
    if (canToggleTemporaryChat(currentChat))
      thread.setTemporary(!thread.temporary)
  }
  const handleWebSearchToggle = () => {
    if (currentChat.id && !isTemporaryMode)
      void thread
        .update(currentChat.id, {
          webSearchEnabled: !effectiveWebSearchEnabled,
        })
        .catch(thread.report)
    void api
      .updateProfile({ webSearchEnabled: !effectiveWebSearchEnabled })
      .catch(thread.report)
  }
  const handleCodeExecutionToggle = () => {
    void api
      .updateProfile({ codeExecutionEnabled: !codeExecutionEnabled })
      .catch(thread.report)
  }
  const handleOpenVerifierSidebar = () => {
    setHasMountedVerifierSidebar(true)
    setIsVerifierSidebarOpen((value) => !value)
  }
  const handleSetVerifierSidebarOpen = setIsVerifierSidebarOpen
  const handleOpenSettingsModal = () => {
    setHasMountedSettingsModal(true)
    setIsSettingsModalOpen(true)
  }
  const handleOpenEncryptionKeyModal = () => {
    setSettingsInitialTab('cloud-sync')
    handleOpenSettingsModal()
  }
  const handleOpenShareModal = () => {
    setHasMountedShareModal(true)
    setIsShareModalOpen(true)
  }
  const handleOpenPromptLibrary = () => {
    setHasMountedPromptLibrary(true)
    setIsPromptLibraryModalOpen(true)
  }
  const handleClosePromptLibrary = () => setIsPromptLibraryModalOpen(false)
  const handleOpenCloudSyncSetup = () => setShowCloudSyncSetupModal(true)
  const handleCloseSubscribePrompt = () => setIsSubscribePromptOpen(false)
  const handleKeyChanged = async (key: string, options?: { mode?: string }) => {
    const previous = encryptionService.getKey()
    await encryptionService.setKey(key, { persist: false })
    try {
      if (options?.mode === 'explicitStartFresh')
        await registerStartFreshKeyIfNeeded()
      else await authorizeCurrentPrimaryKeyOrThrow()
      api.lifetime.signal.throwIfAborted()
      encryptionService.persistCurrentKeyState()
      await api.refresh()
    } catch (cause) {
      if (!api.lifetime.signal.aborted) {
        if (previous)
          await encryptionService.setKey(previous, { persist: false })
        else encryptionService.clearKey({ persist: false })
      }
      throw cause
    }
  }
  const backupStartFreshKeyWithPasskey = async () => {
    await setupPasskey()
  }
  const isCloudSyncRoutePending = false
  const sidebarChat = useSidebarChat({ threadId: currentChat.id, options })
  async function processFileForChat(file: File) {
    const localId = crypto.randomUUID()
    setProcessedDocuments((previous) => [
      ...previous,
      { id: localId, name: file.name, time: new Date(), isUploading: true },
    ])
    try {
      const attachment = await api.upload<HarnessAttachment>(
        '/v1/attachments/upload',
        file,
        {
          ephemeral: String(isTemporaryMode),
          ...(currentChat.id ? { threadId: currentChat.id } : {}),
        },
      )
      setProcessedDocuments((previous) =>
        previous.map((d) =>
          d.id === localId
            ? {
                id: attachment.id,
                name: attachment.fileName,
                time: d.time,
                attachment: attachmentView(attachment),
              }
            : d,
        ),
      )
    } catch (cause) {
      setProcessedDocuments((previous) =>
        previous.filter((d) => d.id !== localId),
      )
      thread.report(cause)
    }
  }
  const handleFileUpload = async (file: File) => {
    if (activeProject) {
      setPendingProjectUpload((previous) => ({
        projectId: activeProject.id,
        files: [...(previous?.files ?? []), file],
      }))
      setShowAddToProjectModal(true)
    } else await processFileForChat(file)
  }
  const handleAddToProjectConfirm = async (addToProject: boolean) => {
    const pending = pendingProjectUpload
    setPendingProjectUpload(null)
    setShowAddToProjectModal(false)
    for (const file of pending?.files ?? []) {
      if (addToProject) await uploadDocument(file, '')
      else await processFileForChat(file)
    }
  }
  const removeDocument = (id: string) =>
    setProcessedDocuments((previous) => previous.filter((d) => d.id !== id))
  useEffect(() => {
    initializeRenderers()
    void api.client
      .ready()
      .then(() => setVerificationStatus('verified'))
      .catch(() => setVerificationStatus('failed'))
  }, [api])
  useEffect(() => {
    if (!initialProjectId || !keyReady) return
    void enterProjectMode(initialProjectId).catch(thread.report)
  }, [initialProjectId, keyReady, enterProjectMode, thread.report])
  useEffect(() => {
    if (!suppressIntroModals && session && isSignedIn && !keyReady)
      setShowCloudSyncSetupModal(true)
  }, [suppressIntroModals, session, isSignedIn, keyReady])
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
    dismissFirstTimePasskeyPrompt,
    recoverWithPasskey,
    setupNewKeySplit,
    dismissBackupWarning,
    skipPasskeyRecovery,
    addPasskeyToThisDevice,
    refreshBundleState,
  } = usePasskeyBackup({
    encryptionKey,
    initialized: !!session,
    isSignedIn,
    user,
    onEncryptionKeyRecovered: useCallback(
      (key: string) => {
        void api.refresh().catch(thread.report)
      },
      [api, thread.report],
    ),
  })
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

  const handleGlobalDrop = (e: React.DragEvent) => {
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
  }

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [inputAreaHeight, setInputAreaHeight] = useState(0)
  const inputAreaObserver = useRef<ResizeObserver | null>(null)
  const inputAreaRef = useCallback((node: HTMLDivElement | null) => {
    inputAreaObserver.current?.disconnect()
    if (!node) return
    const measure = () =>
      setInputAreaHeight(node.getBoundingClientRect().height)
    measure()
    inputAreaObserver.current = new ResizeObserver(measure)
    inputAreaObserver.current.observe(node)
  }, [])
  useEffect(() => () => inputAreaObserver.current?.disconnect(), [])
  const handleScroll = () => {
    const el = scrollContainerRef.current
    if (el)
      setShowScrollButton(
        el.scrollHeight - el.scrollTop - el.clientHeight > 200,
      )
  }
  const scrollToLastMessage = () => {
    const el = scrollContainerRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  useEffect(() => {
    if (!showScrollButton) {
      const el = scrollContainerRef.current
      el?.scrollTo({ top: el.scrollHeight })
    }
  }, [currentChat.messages.length, isStreaming, showScrollButton])
  const showEmptyChatGrid =
    currentChat.messages.length === 0 && !isWaitingForResponse
  if (!session)
    return (
      <div
        role="status"
        className="flex h-screen items-center justify-center bg-surface-chat-background text-content-primary"
      >
        {sessionError ?? 'Connecting to chat…'}
      </div>
    )
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
          !isLoadingConfig &&
          isClient &&
          keyReady &&
          !!currentChat &&
          hasValidatedModel
        }
        onMessageReady={(message) => {
          handleQuery(message)
        }}
      />

      {/* URL Hash Settings Handler */}
      <UrlHashSettingsHandler
        isReady={
          !isLoadingConfig &&
          isClient &&
          keyReady &&
          !!currentChat &&
          hasValidatedModel
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

          {!!isSignedIn &&
            canToggleTemporaryChat(currentChat) &&
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
                  hasMore={!!thread.cursor}
                  onLoadMore={() => thread.refresh(thread.cursor ?? undefined)}
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
                />
              ) : (
                <ProjectSidebar
                  hasMore={!!thread.cursor}
                  onLoadMore={() => thread.refresh(thread.cursor ?? undefined)}
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
                hasMore={!!thread.cursor}
                onLoadMore={() => thread.refresh(thread.cursor ?? undefined)}
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
                onSettingsClick={handleOpenSettingsModal}
                pinnedChatIds={pinnedChatIds}
                onToggleFavorite={handleToggleFavorite}
                onRemoveFavorite={unpinChat}
                onOpenFavorite={handleOpenFavorite}
                windowWidth={windowWidth}
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
          onOpenPromptLibrary={handleOpenPromptLibrary}
          onCloudSyncSetupClick={
            isSignedIn ? handleOpenCloudSyncSetup : undefined
          }
          onChatsUpdated={reloadChats}
          onAllChatsDeleted={createNewChat}
          onAllProjectsDeleted={() => {
            exitProjectMode()
            thread.newChat()
            void router.push('/')
          }}
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
                sidebarChat.askQuote(text)
              }}
            />
            <div className="relative flex min-h-0 flex-1">
              {thread.hasOlder && (
                <button
                  className="absolute top-16 z-10 rounded-full border border-border-subtle px-4 py-2 text-content-secondary"
                  onClick={() => void thread.older().catch(thread.report)}
                >
                  Load earlier messages
                </button>
              )}
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
                        onSend={(queueId) => {
                          void thread.sendQueued(queueId).catch(thread.report)
                        }}
                        queue={queuedMessages}
                        onRemove={removeQueuedMessage}
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
          <OnboardingView
            onComplete={() => {
              setShowOnboarding(false)
              localStorage.setItem(
                'tinfoil-settings-has-seen-onboarding',
                'true',
              )
              void api
                .updateProfile({ hasSeenOnboarding: true })
                .catch(thread.report)
            }}
          />
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
