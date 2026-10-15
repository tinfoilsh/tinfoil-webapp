import { getSelectedModelLabel } from '@/config/models'
import { REQUEST_UPGRADE_EVENT } from '@/constants/chat-events'
import { useOnboarding } from '@/hooks/use-onboarding'
import { useProjects } from '@/hooks/use-projects'
import { useRateLimit } from '@/hooks/use-rate-limit'
import {
  useFlaggedChatIds,
  useSafeguardsLoaded,
  useSafeguardsLoader,
  useSafeguardStatusNotification,
} from '@/hooks/use-safeguards'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { toast } from '@/hooks/use-toast'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth, useUser } from '@clerk/react'
import { ArrowDownIcon } from '@heroicons/react/24/outline'
import {
  TfChat2,
  TfDocumentPlus,
  TfGhost2,
  TfLockLocked,
  TfLockOpened,
  TfShare,
  TfSidebarOpen,
  TfTinSad,
  TfWriting2,
} from '@tinfoilsh/tinfoil-icons'
import { AnimatePresence, motion } from 'framer-motion'
import Link from 'next/link'
import { PiSpinner } from 'react-icons/pi'

import {
  RateLimitBanner,
  shouldShowRateLimitBanner,
} from '@/components/chat/rate-limit-banner'
import { SafeguardFlagBanner } from '@/components/chat/safeguard-flag-banner'
import { StreamErrorBanner } from '@/components/chat/stream-error-banner'
import { classifyCloudKeySetupError } from '@/components/modals/cloud-sync-setup-mode'
import {
  ProjectModeIndicator,
  ProjectSidebar,
  useProject,
} from '@/components/project'
import { GridTexture } from '@/components/ui/grid-texture'
import { LogoLoading } from '@/components/ui/logo-loading'
import { cn } from '@/components/ui/utils'
import { usePasskeyBackup } from '@/hooks/use-passkey-backup'

import { encryptionService } from '@/services/encryption/encryption-service'
import { useCloudSyncSetting } from '@/services/harness/storage-mode'
import {
  isCloudSyncEnabled,
  setCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import {
  getChatPath,
  getNewChatPath,
  isPlainPrimaryClick,
} from '@/utils/navigation'
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
import { ChatHeader } from './chat-header'
import { ChatInput } from './chat-input'
import { ChatMessages } from './chat-messages'
import { ChatSidebar } from './chat-sidebar'
import { PromptPresetSuggestions } from './components/prompt-preset-suggestions'
import { CONSTANTS } from './constants'
import { DragProvider } from './drag-context'
import { ForkOverlay } from './fork-overlay'
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
import { SIDEBAR_PANEL_ID } from './sidebar-layout'
import type { Chat } from './types'
import { uploadErrorMessage } from './upload-error'
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
const ChatSearchModalLazy = dynamic(
  () => import('./chat-search-modal').then((m) => m.ChatSearchModal),
  { ssr: false },
)
const ReportBugModalLazy = dynamic(
  () => import('../modals/report-bug-modal').then((m) => m.ReportBugModal),
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
import { isAttachmentsUnavailable } from '@/services/harness/transfer'
import type { Turn } from '@/services/harness/types'
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
  isLocalChatUrl = false,
  initialNewChatIsLocalOnly = false,
  suppressIntroModals = false,
  inputMinHeight = '60px',
}: ChatInterfaceProps) {
  const {
    api,
    session,
    profile,
    keyReady,
    profileReady,
    error: sessionError,
  } = useHarness()
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth()
  // The harness stores chats only for a signed-in account with cloud sync;
  // otherwise every chat stays on this device.
  const cloudSyncSetting = useCloudSyncSetting()
  const cloudSyncEnabled = !!isSignedIn && cloudSyncSetting
  const { user } = useUser()
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
  const { projects } = useProjects({ autoLoad: cloudSyncEnabled })
  const thread = useThread(
    initialChatId,
    activeProject?.id ?? initialProjectId,
    {
      local: isLocalChatUrl,
      newChatLocal: initialNewChatIsLocalOnly,
    },
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
      currentChat.pendingSave ||
      currentChat.id === initialChatId
    )
      return
    const path = getChatPath(currentChat.id, {
      isLocalOnly: currentChat.isLocalOnly,
      projectId: currentChat.projectId,
    })
    if (window.location.pathname !== path)
      void router
        .replace(path, undefined, { shallow: true })
        .catch(thread.report)
  }, [
    currentChat.id,
    currentChat.isTemporary,
    currentChat.isLocalOnly,
    currentChat.pendingSave,
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
  useSafeguardsLoader()
  useSafeguardStatusNotification()
  const safeguardsLoaded = useSafeguardsLoaded()
  const flaggedChatIds = useFlaggedChatIds()
  // A chat the safeguards flagged is read-only, by its chat id, which the
  // harness gives the safeguards as the conversation id.
  const currentChatIsFlagged = Boolean(
    currentChat.id && flaggedChatIds[currentChat.id],
  )
  const waitingForSafeguards =
    !isAuthLoaded || (!!isSignedIn && !safeguardsLoaded)
  const generationBlocked = currentChatIsFlagged || waitingForSafeguards
  const submitAfterSafeguards = useRef(false)
  const rateLimit = useRateLimit()
  const retryInfo = null
  const failure = thread.state.error
  const streamError = thread.error
    ? {
        message: thread.error,
        code: failure?.code,
        kind: failure?.kind,
        resetsAt: failure?.resetsAt,
        retryAfter: failure?.retryAfter,
        upstreamCode: failure?.upstreamCode,
        timestamp: thread.errorAt,
      }
    : null
  // A capped subscriber's cap may lift before it resets.
  const checkQuota = () => api.refresh()
  const dismissStreamError = thread.dismissError
  const { isLoading: isSubscriptionLoading, chat_subscription_active } =
    useSubscriptionStatus()
  const isPremium = !isSubscriptionLoading && chat_subscription_active
  // The composer only uses premium status to decide which controls to show,
  // and the server enforces access on every request. Using the cached value
  // while auth loads keeps the toolbar from reflowing once Clerk resolves.
  const showPremiumComposerControls = chat_subscription_active
  const encryptionKey = encryptionService.getKey()
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
  // Onboarding is shown to signed-in users once their profile has loaded.
  const { showOnboarding, dismissOnboarding } = useOnboarding({
    isAuthLoaded: isAuthLoaded && !!session,
    isSignedIn,
    userId: user?.id,
    hasCompletedOnboarding: !profileReady || profile.hasSeenOnboarding === true,
    suppressIntroModals,
  })
  const [logoAnimDone, setLogoAnimDone] = useState(false)
  const handleLogoAnimFinished = useCallback(() => {
    setLogoAnimDone(true)
  }, [])
  const [isVerifierSidebarOpen, setIsVerifierSidebarOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [hasMountedSettingsModal, setHasMountedSettingsModal] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>()
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [hasMountedShareModal, setHasMountedShareModal] = useState(false)
  const [isPromptLibraryModalOpen, setIsPromptLibraryModalOpen] =
    useState(false)
  const [hasMountedPromptLibrary, setHasMountedPromptLibrary] = useState(false)
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false)
  const [hasMountedSearchModal, setHasMountedSearchModal] = useState(false)
  const [isReportBugModalOpen, setIsReportBugModalOpen] = useState(false)
  const [hasMountedReportBugModal, setHasMountedReportBugModal] =
    useState(false)
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
  const { getPresetById, pruneUnavailableModels, userPresets } =
    usePromptLibrary()
  // A saved prompt may name a model the catalog has since retired.
  const pruneRef = useRef(pruneUnavailableModels)
  pruneRef.current = pruneUnavailableModels
  useEffect(() => {
    if (!profileReady) return
    const pruned = pruneRef.current(models)
    if (pruned.length)
      logInfo('Cleared unavailable models from prompt presets', {
        component: 'ChatInterface',
        metadata: { presetIds: pruned },
      })
  }, [models, profileReady, userPresets])

  const activePreset = getPresetById(activePresetId)
  const pixelateSidebarChatTitles =
    profile.pixelateSidebarChatTitlesEnabled ?? false
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
  const features = session?.features ?? {}
  // A chat on this device changes its own copy; a stored chat needs the
  // harness's message actions, and a temporary one is not stored at all.
  const canChangeMessages =
    !!currentChat.id &&
    (thread.runsLocally || (!isTemporaryMode && !!features.messageActions))
  const canFork =
    !!currentChat.id &&
    !currentChat.isTemporary &&
    !currentChat.isBlankChat &&
    (currentChat.isLocalOnly || !!features.fork)
  const canShare =
    !!isSignedIn &&
    !currentChat.isTemporary &&
    currentChat.messages.length > 0 &&
    (!currentChat.isLocalOnly || !!session?.features.localShare)
  const canChat = profileReady && (thread.runsLocally || keyReady)
  const reloadChats = () => thread.refresh()
  const createNewChat = (isLocalOnly = false, fromUserAction = true) => {
    thread.newChat({ local: isLocalOnly })
    setInput('')
    setQuote(null)
    setProcessedDocuments([])
    // The sidebar switches a blank chat to its tab's storage without moving
    // the page, which may still be opening a chat from its URL.
    if (!fromUserAction) return
    void router.push(
      activeProject ? `/project/${activeProject.id}` : '/',
      undefined,
      { shallow: true },
    )
  }
  const handleChatSelect = (id: string) => {
    setProcessedDocuments([])
    setQuote(null)
    const isLocalOnly =
      !cloudSyncEnabled || !!chats.find((chat) => chat.id === id)?.isLocalOnly
    void thread
      .open(id, { local: isLocalOnly })
      .then(() =>
        router.push(
          getChatPath(id, {
            isLocalOnly,
            projectId: isLocalOnly ? undefined : activeProject?.id,
          }),
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
  // Choosing a prompt also applies its model and web search setting.
  const handleSetActivePreset = (presetId: string | null) => {
    void thread.selectPreset(presetId).catch(thread.report)
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
    if (generationBlocked) return
    try {
      return thread.send({ content, options, ...fields })
    } catch (cause) {
      thread.report(cause)
    }
  }
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (currentChatIsFlagged) return
    // A send waits for the account's safeguard flags, so a flagged chat
    // cannot be continued before its flag is known.
    if (waitingForSafeguards) {
      submitAfterSafeguards.current = true
      return
    }
    submitComposer()
  }
  const submitComposer = () => {
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
    if (generationBlocked) return
    void thread.regenerate(index, { options }).catch(thread.report)
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
    if (generationBlocked) return
    void thread.retry({ options }).catch(thread.report)
  }
  // Message actions wait for the reply in progress, as on main.
  const deleteMessage = (index: number) => {
    if (isStreaming || currentChatIsFlagged) return
    void thread.deleteMessage(index).catch(thread.report)
  }
  const editAssistantMessage = (index: number, content: string) => {
    if (isStreaming || currentChatIsFlagged) return
    void thread.editReply(index, content).catch(thread.report)
  }
  const continueAssistantMessage = (index: number) => {
    if (isStreaming || generationBlocked) return
    try {
      void thread.continueReply(index, { options })
    } catch (cause) {
      thread.report(cause)
    }
  }
  const [isForking, setIsForking] = useState(false)
  const forkInFlight = useRef(false)
  const handleForkMessage = async (index: number) => {
    if (isStreaming || forkInFlight.current) return
    forkInFlight.current = true
    setIsForking(true)
    const startedAt = Date.now()
    try {
      const forkId = await thread.fork(index)
      if (!forkId) return
      setProcessedDocuments([])
      setQuote(null)
      // The overlay stays long enough to read as a step, not a flicker.
      const elapsed = Date.now() - startedAt
      if (elapsed < CONSTANTS.FORK_OVERLAY_MIN_VISIBLE_MS)
        await new Promise((resolve) =>
          setTimeout(resolve, CONSTANTS.FORK_OVERLAY_MIN_VISIBLE_MS - elapsed),
        )
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      logError('Failed to fork conversation', cause, {
        component: 'ChatInterface',
        action: 'handleForkMessage',
      })
      toast({
        title: 'Failed to fork conversation',
        description: 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      forkInFlight.current = false
      setIsForking(false)
    }
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
  // Chats move between the cloud and this device when the harness offers it.
  const canMoveChats = cloudSyncEnabled && !!features.transfer
  const isAbort = (cause: unknown) =>
    cause instanceof DOMException && cause.name === 'AbortError'
  const handleConvertChatToCloud = async (chatId: string): Promise<boolean> => {
    try {
      await thread.moveToCloud(chatId)
      await reloadChats()
      toast({
        title: 'Chat moved to cloud',
        description: 'The chat will now sync across your devices.',
      })
      return true
    } catch (error) {
      if (isAbort(error)) return false
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
  }
  const handleConvertChatToLocal = async (chatId: string): Promise<void> => {
    try {
      await thread.moveToDevice(chatId)
      await reloadChats()
      toast({
        title: 'Chat moved to local',
        description: 'The chat is now only stored on this device.',
      })
    } catch (error) {
      if (isAbort(error)) return
      logError('Failed to convert chat to local', error, {
        component: 'ChatInterface',
        action: 'handleConvertChatToLocal',
        metadata: { chatId },
      })
      toast({
        title: 'Failed to move chat to local',
        description: isAttachmentsUnavailable(error)
          ? 'Some attachments in this chat could not be downloaded. Check your connection and try again.'
          : 'Please try again.',
        variant: 'destructive',
      })
    }
  }
  // Pinning a chat kept on this device moves it to the cloud first, where
  // favorites are stored.
  const handleToggleFavorite = async (favorite: {
    id: string
    isLocalOnly?: boolean
  }) => {
    if (pinnedChatIds.includes(favorite.id)) {
      unpinChat(favorite.id)
      return
    }
    const chat = chats.find((candidate) => candidate.id === favorite.id)
    if (chat?.isLocalOnly ?? favorite.isLocalOnly) {
      if (!canMoveChats) return
      if (!(await handleConvertChatToCloud(favorite.id))) return
    }
    await thread.update(favorite.id, { pinned: true }).catch(thread.report)
  }
  const handleOpenFavorite = (chat: { id: string }) => handleChatSelect(chat.id)
  // A chat kept on this device moves to the cloud before it joins a project;
  // when the move into the project fails, it returns to the device as it was.
  const handleMoveChatToProject = async (chatId: string, projectId: string) => {
    if (!isPremium) {
      setIsSubscribePromptOpen(true)
      return
    }
    const moving = chats.find((chat) => chat.id === chatId)
    let original: Awaited<ReturnType<typeof thread.moveToCloud>> | undefined
    try {
      if (moving?.isLocalOnly) {
        if (!canMoveChats) throw new Error('Chats cannot move to the cloud')
        original = await thread.moveToCloud(chatId)
      }
      await thread.update(chatId, { projectId })
      await reloadChats()
      if (currentChat.id === chatId) createNewChat(false, true)
      toast({
        title: 'Chat moved to project',
        description: 'The chat has been moved successfully.',
      })
    } catch (error) {
      if (original) {
        try {
          await thread.moveToDevice(chatId, original)
        } catch (rollbackError) {
          logError(
            'Failed to restore local chat after project move',
            rollbackError,
            {
              component: 'ChatInterface',
              action: 'handleMoveChatToProject.rollback',
              metadata: { chatId, projectId },
            },
          )
        }
      }
      if (isAbort(error)) return
      logError('Failed to move chat to project', error, {
        component: 'ChatInterface',
        action: 'handleMoveChatToProject',
        metadata: { chatId, projectId },
      })
      await reloadChats().catch(thread.report)
      toast({
        title: 'Failed to move chat',
        description: 'Please try again.',
        variant: 'destructive',
      })
    }
  }
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
  // Leaving a project while one of its chats is dragged keeps the open chat
  // and the page, so the drag can end on the Cloud or Local tab.
  const handleExitProjectWhileDragging = () => {
    setPendingProjectUpload(null)
    setShowAddToProjectModal(false)
    exitProjectMode()
  }
  const canToggleTemporaryChat = (chat: Chat) =>
    !chat.id && !processedDocuments.length && !isStreaming
  const handleToggleTemporaryMode = () => {
    if (canToggleTemporaryChat(currentChat))
      thread.setTemporary(!thread.temporary)
  }
  const handleWebSearchToggle = () => {
    thread.setWebSearch(!effectiveWebSearchEnabled)
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
    setIsVerifierSidebarOpen((value) => !value)
  }
  const handleSetVerifierSidebarOpen = setIsVerifierSidebarOpen
  const handleOpenSettingsModal = () => {
    setHasMountedSettingsModal(true)
    setIsSettingsModalOpen(true)
  }
  const handleOpenSafeguardsSettings = () => {
    setSettingsInitialTab('safeguards')
    handleOpenSettingsModal()
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
  const handleOpenSearchModal = useCallback(() => {
    setIsSettingsModalOpen(false)
    setIsShareModalOpen(false)
    setIsPromptLibraryModalOpen(false)
    setIsReportBugModalOpen(false)
    setHasMountedSearchModal(true)
    setIsSearchModalOpen(true)
  }, [])
  const handleOpenReportBugModal = () => {
    setHasMountedReportBugModal(true)
    setIsReportBugModalOpen(true)
  }
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
  const sidebarChat = useSidebarChat({ context: thread.askContext, options })
  // A flag stops the chat: its reply in progress, its queued turns, and an
  // ask about it.
  const runningRef = useRef(isStreaming)
  runningRef.current = isStreaming
  const queueRef = useRef(thread.state.snapshot.queue)
  queueRef.current = thread.state.snapshot.queue
  useEffect(() => {
    if (!currentChatIsFlagged) return
    for (const item of queueRef.current)
      void thread.removeQueued(item.queueId).catch(thread.report)
    if (runningRef.current) void thread.cancel().catch(thread.report)
    setIsAskSidebarOpen(false)
    sidebarChat.reset()
    // Only a newly flagged chat is stopped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatIsFlagged, currentChat.id])
  useEffect(() => {
    if (waitingForSafeguards || !submitAfterSafeguards.current) return
    submitAfterSafeguards.current = false
    if (!currentChatIsFlagged) submitComposer()
    // The send the user made while the flags loaded goes out once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForSafeguards])
  async function processFileForChat(file: File) {
    const localId = crypto.randomUUID()
    setProcessedDocuments((previous) => [
      ...previous,
      { id: localId, name: file.name, time: new Date(), isUploading: true },
    ])
    try {
      const attachment = await thread.upload(file)
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
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      toast({
        title: 'Processing failed',
        description: uploadErrorMessage(cause),
        variant: 'destructive',
        position: 'top-right',
      })
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
      if (!addToProject) {
        await processFileForChat(file)
        continue
      }
      try {
        await uploadDocument(file, '')
      } catch (cause) {
        toast({
          title: 'Upload failed',
          description: uploadErrorMessage(
            cause,
            'Failed to add document to project context.',
          ),
          variant: 'destructive',
          position: 'top-right',
        })
      }
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
  useEffect(() => {
    if (suppressIntroModals) return
    // Passkey recovery opens because remote chats need unlocking, and a
    // first passkey setup starts here so the cloud sync intro shows first.
    // Without cloud sync every chat stays on this device.
    if (passkeyRecoveryNeeded || passkeyFirstTimePromptAvailable)
      setShowCloudSyncSetupModal(true)
  }, [
    passkeyFirstTimePromptAvailable,
    passkeyRecoveryNeeded,
    suppressIntroModals,
  ])
  // A chat the harness stores cannot stay open once cloud sync is off.
  const previousCloudSync = useRef(cloudSyncEnabled)
  useEffect(() => {
    if (previousCloudSync.current === cloudSyncEnabled) return
    previousCloudSync.current = cloudSyncEnabled
    if (!cloudSyncEnabled && currentChat.id && !currentChat.isLocalOnly)
      createNewChat(true)
    // Only a change of the storage mode moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudSyncEnabled])
  useEffect(() => {
    if (!router.isReady || router.query.upgrade !== 'projects') return
    setIsSubscribePromptOpen(true)
    void router.replace('/chat', undefined, { shallow: true })
  }, [router])

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

  const hasCurrentMessages = currentChat.messages.length > 0
  const createNewChatRef = useRef(createNewChat)
  createNewChatRef.current = createNewChat
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+. (or Ctrl+.) to toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        setIsSidebarOpen((prev) => !prev)
        return
      }

      // Cmd+K (or Ctrl+K) to search chats and projects
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'k'
      ) {
        e.preventDefault()
        if (isSearchModalOpen) setIsSearchModalOpen(false)
        else handleOpenSearchModal()
        return
      }

      // Shift+Cmd+O (or Shift+Ctrl+O) for new chat
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'o'
      ) {
        e.preventDefault()
        if (hasCurrentMessages) {
          createNewChatRef.current()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    setIsSidebarOpen,
    hasCurrentMessages,
    isSearchModalOpen,
    handleOpenSearchModal,
  ])

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
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    // Move keyboard/screen-reader focus to the latest message so it is read
    // out and becomes the navigation anchor. preventScroll avoids fighting the
    // smooth scroll above.
    const messageEls = el.querySelectorAll('[data-message-role]')
    const lastMessage = messageEls[messageEls.length - 1] as HTMLElement | null
    lastMessage?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!showScrollButton) {
      const el = scrollContainerRef.current
      el?.scrollTo({ top: el.scrollHeight })
    }
  }, [currentChat.messages.length, isStreaming, showScrollButton])
  const showEmptyChatGrid =
    currentChat.messages.length === 0 && !isWaitingForResponse

  if (!session && sessionError) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <TfTinSad
              className="h-24 w-24 !text-content-secondary"
              aria-hidden="true"
            />
          </div>
          <h2 className="mb-3 text-xl font-semibold text-content-primary">
            Something went wrong
          </h2>
          <p role="alert" className="mb-6 text-content-secondary">
            {sessionError}
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

  if (!session || !logoAnimDone) {
    return (
      <LogoLoading isLoading={!session} onFinished={handleLogoAnimFinished} />
    )
  }

  if (isLocalChatUrl && thread.notFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-chat-background px-4 font-aeonik">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="rounded-full bg-surface-chat p-4">
              <TfChat2
                className="h-8 w-8 !text-content-secondary"
                aria-hidden="true"
              />
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

  const showChatHeader = currentChat.messages.length > 0 && !isChatHydrating

  const hideTopControlsOnMobile =
    windowWidth < CONSTANTS.MOBILE_BREAKPOINT &&
    (isSidebarOpen ||
      isVerifierSidebarOpen ||
      isSettingsModalOpen ||
      isAskSidebarOpen ||
      isArtifactSidebarOpen)

  // Below the mobile breakpoint the open sidebar covers the chat, so the chat
  // must be unreachable by keyboard and screen readers until it closes.
  const isSidebarCoveringChat =
    isSidebarOpen && windowWidth < CONSTANTS.MOBILE_BREAKPOINT

  const hasVisibleChatHeader = showChatHeader && !hideTopControlsOnMobile
  const sidebarToggle = windowWidth < CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT &&
    !isSidebarOpen &&
    !(
      isVerifierSidebarOpen ||
      isSettingsModalOpen ||
      isAskSidebarOpen ||
      isArtifactSidebarOpen
    ) && (
      <div className="group relative">
        <button
          type="button"
          className={cn(
            'flex items-center justify-center gap-2 rounded-lg border border-transparent bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary',
            !hasVisibleChatHeader && 'fixed left-4 top-4 z-50',
          )}
          onClick={() => {
            setIsSidebarOpen(true)
            setIsVerifierSidebarOpen(false)
            setIsSettingsModalOpen(false)
          }}
          aria-label="Open sidebar"
          aria-expanded={isSidebarOpen}
          aria-controls={SIDEBAR_PANEL_ID}
          data-sidebar-toggle
        >
          <TfSidebarOpen className="h-5 w-5 -scale-x-100" aria-hidden="true" />
        </button>
        <span
          className={cn(
            'pointer-events-none z-50 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100',
            hasVisibleChatHeader
              ? 'absolute left-0 top-full mt-1'
              : 'fixed left-4 top-16',
          )}
        >
          Open sidebar{' '}
          <span className="ml-1.5 text-content-muted">{modKey}.</span>
        </span>
      </div>
    )

  const topControls = (
    <>
      {/* New chat button - only show in compact conversations with messages */}
      {currentChat.messages.length > 0 && (
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
          className="flex items-center justify-center rounded-lg border border-transparent bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary @3xl/conversation:hidden"
          aria-label="New chat"
        >
          <TfWriting2 className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}

      {!!isSignedIn &&
        canToggleTemporaryChat(currentChat) &&
        (() => {
          const hasMessages = currentChat.messages.length > 0
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
                    : 'border-transparent bg-surface-chat-background text-content-secondary hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary',
                )}
              >
                <TfGhost2 className="h-4 w-4" aria-hidden="true" />
              </button>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
              >
                {label}
              </span>
            </div>
          )
        })()}

      {/* Share button - a signed-in user shares a chat the harness stores,
          or one kept on this device when the harness seals local shares */}
      {canShare && (
        <button
          type="button"
          onClick={handleOpenShareModal}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary @3xl/conversation:px-3 @3xl/conversation:py-2"
          aria-label="Share"
        >
          <TfShare className="h-4 w-4" aria-hidden="true" />
          <span className="hidden text-sm @3xl/conversation:inline">Share</span>
        </button>
      )}

      {/* Verifier toggle button */}
      <div className="group relative">
        <button
          id="verification-status"
          className={cn(
            'relative flex items-center justify-center gap-2 rounded-lg border p-2.5 transition-all duration-200',
            'bg-surface-chat-background text-content-secondary hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary',
            isVerifierSidebarOpen
              ? 'cursor-default border-border-subtle bg-surface-chat text-content-muted hover:text-content-muted'
              : 'border-transparent',
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
              <span
                className={cn(
                  'text-sm leading-none',
                  hasVisibleChatHeader &&
                    'sr-only @3xl/conversation:not-sr-only',
                )}
              >
                Verifying...
              </span>
            </>
          ) : verificationStatus === 'verified' ? (
            <>
              <TfLockLocked
                className="h-4 w-4 !text-brand-accent-dark dark:!text-brand-accent-light"
                aria-hidden="true"
              />
              <span
                className={cn(
                  'text-sm leading-none text-brand-accent-dark dark:text-brand-accent-light',
                  hasVisibleChatHeader &&
                    'sr-only @3xl/conversation:not-sr-only',
                )}
              >
                Verified
              </span>
            </>
          ) : (
            <>
              <TfLockOpened
                className="h-4 w-4 !text-red-500"
                aria-hidden="true"
              />
              <span
                className={cn(
                  'text-sm leading-none text-red-500',
                  hasVisibleChatHeader &&
                    'sr-only @3xl/conversation:not-sr-only',
                )}
              >
                Error
              </span>
            </>
          )}
        </button>
        <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
          {isVerifierSidebarOpen ? 'Close verification' : 'View details'}
        </span>
      </div>
    </>
  )

  const projectSidebarChats = (projectId: string | undefined) =>
    chats
      .filter((c) => c.projectId === projectId)
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
        activeRun: c.activeRun,
      }))

  return (
    <div
      className="app-shell flex overflow-hidden bg-surface-chat-background"
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
            <TfDocumentPlus
              className="h-20 w-20 text-white"
              aria-hidden="true"
            />
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
          canChat &&
          !isChatHydrating &&
          hasValidatedModel &&
          !generationBlocked
        }
        onSubmit={({ text }) => {
          handleQuery(text)
        }}
      />

      {/* URL Hash Settings Handler */}
      <UrlHashSettingsHandler
        isReady={
          !isLoadingConfig && isClient && profileReady && hasValidatedModel
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
      {!hasVisibleChatHeader && sidebarToggle}

      {/* Temporary chat indicator (top-left, fills inner corner). Once a
          chat has messages the header's metadata line marks it instead. */}
      {(isTemporaryMode || currentChat.isTemporary) && !showChatHeader && (
        <div
          inert={isSidebarCoveringChat}
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
          <TfGhost2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Temporary chat</span>
        </div>
      )}

      {/* Right side toggle buttons - float over the welcome screen; once a
          chat has messages they move into the chat header. */}
      {!showChatHeader && !hideTopControlsOnMobile && (
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
          {topControls}
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
                  currentChatId={currentChat.id}
                  isClient={isClient}
                  chats={projectSidebarChats(activeProject.id)}
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
                  onReportBugClick={handleOpenReportBugModal}
                  favoriteChats={favoriteChats}
                  pinnedChatIds={pinnedChatIds}
                  onToggleFavorite={handleToggleFavorite}
                  onRemoveFavorite={unpinChat}
                  onOpenFavorite={handleOpenFavorite}
                  cloudSyncEnabled={cloudSyncEnabled}
                  windowWidth={windowWidth}
                  isPremium={isPremium}
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
                  currentChatId={currentChat.id}
                  isClient={isClient}
                  chats={projectSidebarChats(loadingProject?.id)}
                  deleteChat={deleteChat}
                  updateChatTitle={updateChatTitle}
                  onSettingsClick={handleOpenSettingsModal}
                  onReportBugClick={handleOpenReportBugModal}
                  favoriteChats={favoriteChats}
                  pinnedChatIds={pinnedChatIds}
                  onToggleFavorite={handleToggleFavorite}
                  onRemoveFavorite={unpinChat}
                  onOpenFavorite={handleOpenFavorite}
                  cloudSyncEnabled={cloudSyncEnabled}
                  windowWidth={windowWidth}
                  isPremium={isPremium}
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
                onConvertChatToCloud={
                  canMoveChats ? handleConvertChatToCloud : undefined
                }
                onConvertChatToLocal={
                  canMoveChats ? handleConvertChatToLocal : undefined
                }
                onSettingsClick={handleOpenSettingsModal}
                onReportBugClick={handleOpenReportBugModal}
                onSearchClick={handleOpenSearchModal}
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
      {isClient && (
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

      {hasMountedSearchModal && (
        <ChatSearchModalLazy
          isOpen={isSearchModalOpen}
          onClose={() => setIsSearchModalOpen(false)}
          chats={chats}
          projects={projects}
          searchEnabled={cloudSyncEnabled && keyReady}
          isPremium={isPremium}
          onOpenChat={handleOpenFavorite}
          onOpenProject={(project) =>
            openProjectChat({
              projectId: project.id,
              projectName: project.name,
              createNewChat,
              enterProjectMode,
            })
          }
        />
      )}

      {hasMountedReportBugModal && (
        <ReportBugModalLazy
          isOpen={isReportBugModalOpen}
          onClose={() => setIsReportBugModalOpen(false)}
          isDarkMode={isDarkMode}
          selectedModel={selectedModel}
        />
      )}

      {/* Share Modal */}
      {hasMountedShareModal && (
        <ShareModalLazy
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          messages={currentChat.messages}
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
          chatTitle={currentChat.title}
          chatCreatedAt={currentChat.createdAt}
          chatId={currentChat.id}
          share={thread.share}
          loadDocumentText={thread.documentText}
          // Every harness that seals local shares also reports and revokes
          // shares; no other feature flag marks those routes.
          canRevoke={!!session?.features.localShare}
        />
      )}

      {/* Prompt Library Modal. Also mounted (closed) alongside Settings so its
          lazy chunk is already loaded when Settings hands off to it; otherwise
          the overlay drops for a frame while the chunk resolves. */}
      {(hasMountedPromptLibrary || hasMountedSettingsModal) && (
        <PromptLibraryModalLazy
          isOpen={isPromptLibraryModalOpen}
          onClose={handleClosePromptLibrary}
          activePresetId={activePresetId}
          onSelectPreset={handleSetActivePreset}
          models={models}
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
          onDeleteAllChats={thread.removeAll}
          onAllChatsDeleted={() => createNewChat()}
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

      {/* Outside the main area so it keeps announcing while the mobile
          sidebar makes that area inert. */}
      <ChatAnnouncer
        messages={currentChat.messages}
        isStreaming={isStreaming}
        isWaitingForResponse={isWaitingForResponse}
      />

      {/* Main Chat Area - Modified for sliding effect */}
      <div
        inert={isSidebarCoveringChat}
        className={cn(
          'absolute overflow-hidden @container/conversation',
          CONSTANTS.SIDEBAR_LAYOUT_TRANSITION_CLASS_NAME,
        )}
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
                : windowWidth >= CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT
                  ? `${CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX}px`
                  : '0'
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
            {!hasVisibleChatHeader && shouldShowRateLimitBanner(rateLimit) && (
              <RateLimitBanner
                rateLimit={rateLimit}
                onCheckAgain={checkQuota}
                isDarkMode={isDarkMode}
                className="hidden md:flex"
              />
            )}

            {hasVisibleChatHeader && (
              <ChatHeader
                chat={currentChat}
                isStreaming={isStreaming}
                actions={topControls}
                leadingAction={sidebarToggle}
                notice={
                  shouldShowRateLimitBanner(rateLimit) ? (
                    <RateLimitBanner
                      rateLimit={rateLimit}
                      onCheckAgain={checkQuota}
                      isDarkMode={isDarkMode}
                      className="w-auto px-0"
                    />
                  ) : undefined
                }
                className="relative z-30"
              />
            )}

            {/* Messages Area */}
            <QuoteSelectionPopover
              enabled={
                showChatHeader && !isSettingsModalOpen && !currentChatIsFlagged
              }
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
                // The chat service reads the current conversation as context
                // for the highlighted snippet; only the quote and assistant
                // reply are shown in the sidebar UI.
                sidebarChat.askQuote(text)
              }}
            />
            <div className="relative flex min-h-0 flex-1">
              <AnimatePresence>{isForking && <ForkOverlay />}</AnimatePresence>
              {thread.hasOlder && (
                <button
                  className="absolute top-16 z-10 rounded-full border border-border-subtle px-4 py-2 text-content-secondary"
                  onClick={() => void thread.older().catch(thread.report)}
                >
                  Load earlier messages
                </button>
              )}
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
                      messages={currentChat.messages}
                      isDarkMode={isDarkMode}
                      chatId={currentChat.id}
                      isWaitingForResponse={isWaitingForResponse}
                      isStreamingResponse={isStreaming}
                      activeArtifactToolCallId={
                        isArtifactSidebarOpen ? activeArtifactToolCallId : null
                      }
                      readOnly={currentChatIsFlagged}
                      isPremium={showPremiumComposerControls}
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
                        canChangeMessages && currentChat.messages.length > 1
                          ? deleteMessage
                          : undefined
                      }
                      onEditAssistantMessage={
                        canChangeMessages ? editAssistantMessage : undefined
                      }
                      onContinueAssistantMessage={
                        features.continue ? continueAssistantMessage : undefined
                      }
                      onForkMessage={
                        canFork && !isStreaming && !isForking
                          ? handleForkMessage
                          : undefined
                      }
                      onRetryToolCall={retryToolCall}
                      loadImage={thread.loadImage}
                      loadDocumentText={thread.documentText}
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
                currentChat.messages.length > 0) && (
                <div
                  ref={inputAreaRef}
                  data-chat-input-area
                  aria-busy={isForking || undefined}
                  className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 isolate z-20 px-4 pb-4',
                    // The fork overlay only covers the transcript; the
                    // composer lives in this sibling layer, so it goes
                    // inert here or a send could race the fork.
                    isForking &&
                      '[&_.pointer-events-auto]:pointer-events-none [&_.pointer-events-auto]:opacity-50',
                  )}
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
                  {/* Scroll button - absolutely positioned above the input, and
                      placed before it so focus order matches what is on screen. */}
                  {showScrollButton && currentChat.messages.length > 0 && (
                    <div className="pointer-events-auto absolute -top-[50px] left-1/2 z-10 -translate-x-1/2">
                      <button
                        onClick={() => scrollToLastMessage()}
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-border-subtle bg-surface-sidebar-button shadow-md transition-colors hover:bg-surface-sidebar-button-hover"
                        aria-label="Scroll to latest message"
                      >
                        <ArrowDownIcon
                          className="h-4 w-4 text-content-secondary"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                  )}
                  <div className="pointer-events-auto relative z-10 mx-auto max-w-3xl px-1 @3xl/conversation:px-8">
                    <SafeguardFlagBanner
                      chatId={currentChat.id}
                      isDarkMode={isDarkMode}
                      onOpenSettings={
                        isSignedIn ? handleOpenSafeguardsSettings : undefined
                      }
                    />
                  </div>
                  {currentChatIsFlagged ? null : selectPendingInputToolCallFromChat(
                      currentChat,
                    ) ? (
                    <div className="pointer-events-auto relative z-10 mx-auto max-w-3xl rounded-xl border border-border-subtle bg-surface-card p-3 px-1 @3xl/conversation:px-8">
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
                      className="pointer-events-auto relative z-10 mx-auto max-w-3xl px-1 @3xl/conversation:px-8"
                    >
                      {shouldShowRateLimitBanner(rateLimit) && (
                        <RateLimitBanner
                          rateLimit={rateLimit}
                          onCheckAgain={checkQuota}
                          isDarkMode={isDarkMode}
                          className="mb-2 flex @3xl/conversation:hidden"
                          pillClassName="rounded-full border"
                        />
                      )}
                      {streamError && (
                        <StreamErrorBanner
                          key={streamError.timestamp}
                          error={streamError}
                          onDismiss={dismissStreamError}
                          onRetry={retryLastMessage}
                          isDarkMode={isDarkMode}
                        />
                      )}
                      <MessageQueue
                        queue={queuedMessages}
                        onRemove={removeQueuedMessage}
                        onSend={(queueId) => {
                          void thread.sendQueued(queueId).catch(thread.report)
                        }}
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
                        isPremium={showPremiumComposerControls}
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
                          !currentChat.messages.length && !activePreset ? (
                            <div className="mb-3 md:hidden">
                              <PromptPresetSuggestions
                                activePreset={activePreset}
                                onSetActive={handleSetActivePreset}
                                onOpenLibrary={handleOpenPromptLibrary}
                              />
                            </div>
                          ) : undefined
                        }
                        hasMessages={currentChat.messages.length > 0}
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
            if (!encryptionService.getKey() && isCloudSyncEnabled()) {
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
          <OnboardingView
            key={user?.id}
            onComplete={() => {
              dismissOnboarding()
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
