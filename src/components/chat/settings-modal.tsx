import { TextureGrid } from '@/components/texture-grid'
import { cn } from '@/components/ui/utils'
import { UserAvatar } from '@/components/user-avatar'
import { API_BASE_URL } from '@/config'
import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  SETTINGS_GENUI_ENABLED,
  SETTINGS_PII_CHECK_ENABLED,
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_PROMPT_ENABLED,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_LANGUAGE,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import { useProjects } from '@/hooks/use-projects'
import { useToast } from '@/hooks/use-toast'
import { authTokenManager } from '@/services/auth'
import { buildChatExport } from '@/services/chat-export/export-archive'
import { runOffDeviceImport } from '@/services/chat-import/off-device-import'
import { hasPrimaryKey } from '@/services/cloud/cek-encoding'
import { validateCurrentPrimaryKey } from '@/services/cloud/cloud-key-preflight'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { cloudSync } from '@/services/cloud/cloud-sync'
import { projectStorage } from '@/services/cloud/project-storage'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  deletePasskeyCredential,
  getLocalPasskeyCredentialId,
  loadPasskeyCredentials,
  PrfNotSupportedError,
  type PasskeyCredentialEntry,
} from '@/services/passkey'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { attachmentGet } from '@/services/sync-enclave/sync-api'
import { TINFOIL_COLORS } from '@/theme/colors'
import { base64ToUint8Array } from '@/utils/binary-codec'
import {
  parseChatGPTConversations,
  parseClaudeConversations,
  parseClaudeProjects,
} from '@/utils/chat-import-parsers'
import {
  isCloudSyncEnabled,
  isLocalOnlyModeEnabled,
  setCloudSyncEnabled,
  setLocalOnlyModeEnabled,
} from '@/utils/cloud-sync-settings'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import {
  hideSignoutProgress,
  showSignoutProgress,
} from '@/utils/signout-progress'
import { useAuth, useUser } from '@clerk/nextjs'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpTrayIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ComputerDesktopIcon,
  CreditCardIcon,
  EyeIcon,
  EyeSlashIcon,
  MoonIcon,
  PencilSquareIcon,
  PlusIcon,
  Squares2X2Icon,
  SunIcon,
  TrashIcon,
  UserCircleIcon,
  UserIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AiOutlineCloudSync, AiOutlineExport } from 'react-icons/ai'
import { BsQrCode } from 'react-icons/bs'
import { GoPasskeyFill } from 'react-icons/go'
import { HiOutlineAdjustmentsVertical } from 'react-icons/hi2'
import { IoShieldCheckmark } from 'react-icons/io5'
import { PiSignIn, PiSpinner } from 'react-icons/pi'
import { RiLightbulbFill, RiShieldKeyholeFill } from 'react-icons/ri'
import QRCode from 'react-qr-code'
import { CloudSyncHealthCard } from './cloud-sync-health-card'
import { ConfirmDialog } from './components/confirm-dialog'
import { normalizeChatFont, type ChatFont } from './hooks/use-chat-font'
import { usePromptLibrary } from './hooks/use-prompt-library'
import {
  EMPTY_PRESET_EDITOR_STATE,
  PresetEditor,
  type PresetEditorState,
} from './prompts/preset-editor'
import type { PromptPreset } from './prompts/types'
import type { Attachment, Chat } from './types'

const CHARS = '0123456789ABCDEF!@#$%^&*()_+<>?/'

const DASHBOARD_URL = 'https://dash.tinfoil.sh'

const DELETE_ALL_CHATS_CONFIRM_PHRASE = 'delete all chats'
const DELETE_ALL_PROJECTS_CONFIRM_PHRASE = 'delete all projects'

const ScrambleText = ({
  text,
  className,
  isKeyVisible,
}: {
  text: string | null
  className?: string
  isKeyVisible: boolean
}) => {
  const getTargetText = useCallback(
    (isVisible: boolean) => {
      if (!text) return ''
      return isVisible
        ? text
        : `${text.substring(0, 6)}${'•'.repeat(Math.max(0, text.length - 6))}`
    },
    [text],
  )

  const [displayText, setDisplayText] = useState(() =>
    getTargetText(isKeyVisible),
  )
  const previousText = useRef(getTargetText(isKeyVisible))

  useEffect(() => {
    if (!text) {
      setDisplayText('')
      return
    }

    const targetText = getTargetText(isKeyVisible)

    // If the target hasn't changed, don't re-scramble
    if (previousText.current === targetText) return
    previousText.current = targetText

    let iteration = 0
    const maxIterations = 15 // Fixed number of steps for consistency

    const interval = setInterval(() => {
      setDisplayText(() => {
        const result = targetText
          .split('')
          .map((char, index) => {
            if (index < (iteration / maxIterations) * targetText.length) {
              return targetText[index]
            }
            if (char === '•') return '•'
            return CHARS[Math.floor(Math.random() * CHARS.length)]
          })
          .join('')
        return result
      })

      iteration++

      if (iteration > maxIterations) {
        clearInterval(interval)
        setDisplayText(targetText)
      }
    }, 30)

    return () => clearInterval(interval)
  }, [text, isKeyVisible, getTargetText])

  return (
    <span className={cn('inline-flex items-center', className)}>
      <span className="truncate">{displayText}</span>
    </span>
  )
}

const STEP_CIRCLE_CLASSES = cn(
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
  'bg-content-muted/20 text-content-secondary',
)

export type SettingsTab =
  | 'general'
  | 'chat'
  | 'personalization'
  | 'prompts'
  | 'cloud-sync'
  | 'account'

import type { ThemeMode } from './hooks/use-ui-state'

function PasskeyBundleInventory({
  entries,
  isDarkMode,
  removingId,
  keyStatus,
  onRemove,
}: {
  entries: PasskeyCredentialEntry[]
  isDarkMode: boolean
  removingId: string | null
  keyStatus: 'match' | 'mismatch' | 'unverified'
  onRemove: (credentialId: string) => Promise<void>
}) {
  const canManage = keyStatus === 'match'
  const localCredentialId = getLocalPasskeyCredentialId()
  const sorted = [...entries].sort((a, b) => {
    if (a.id === localCredentialId) return -1
    if (b.id === localCredentialId) return 1
    return (b.created_at ?? '').localeCompare(a.created_at ?? '')
  })

  const formatAddedAt = (iso: string | undefined) => {
    if (!iso) return 'Date unknown'
    const epoch = new Date(0).toISOString()
    if (iso === epoch) return 'Date unknown'
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    } catch {
      return 'Date unknown'
    }
  }

  const formatCredentialId = (id: string) =>
    id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`

  return (
    <div
      className={cn(
        'rounded-lg border border-border-subtle',
        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
      )}
    >
      <div className="border-b border-border-subtle px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-content-muted">
          Registered platforms ({sorted.length})
        </span>
      </div>
      {!canManage && (
        <div className="border-b border-border-subtle bg-surface-chat/50 px-4 py-2.5">
          <p className="text-xs text-content-muted">
            {keyStatus === 'mismatch'
              ? "This device's encryption key doesn't match your current cloud key, so passkeys can't be changed here. Recover or re-enter your current key first."
              : "We couldn't verify your encryption key on this device. Make sure your key is loaded, then reopen this panel."}
          </p>
        </div>
      )}
      <ul className="divide-y divide-border-subtle">
        {sorted.map((entry) => {
          const isCurrentPlatform = entry.id === localCredentialId
          const isLegacy = entry.source === 'legacy'
          const isRemoving = removingId === entry.id
          return (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <GoPasskeyFill className="h-4 w-4 shrink-0 text-content-secondary" />
                  <span className="truncate text-sm font-medium text-content-primary">
                    {isCurrentPlatform ? 'This platform' : 'Other platform'}
                  </span>
                  {isLegacy && (
                    <span className="rounded bg-surface-chat px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content-muted">
                      Legacy
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-content-muted">
                  {formatCredentialId(entry.id)} ·{' '}
                  {formatAddedAt(entry.created_at)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void onRemove(entry.id)
                }}
                disabled={removingId !== null || isLegacy || !canManage}
                title={
                  isLegacy
                    ? 'Legacy credentials cannot be removed from settings yet'
                    : !canManage
                      ? "This device's key must match your current cloud key to remove passkeys"
                      : undefined
                }
                className={cn(
                  'shrink-0 rounded-md border border-border-subtle px-2.5 py-1 text-xs font-medium transition-colors',
                  removingId !== null || isLegacy || !canManage
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-surface-chat/80',
                )}
              >
                {isRemoving ? 'Removing…' : 'Remove'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

type SettingsModalProps = {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  isDarkMode: boolean
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  isClient: boolean
  defaultSystemPrompt?: string
  onCloudSyncSetupClick?: () => void
  onChatsUpdated?: () => void
  isSignedIn?: boolean
  isPremium?: boolean
  encryptionKey: string | null
  passkeyActive?: boolean
  passkeySetupAvailable?: boolean
  passkeyAddDeviceAvailable?: boolean
  onSetupPasskey?: () => Promise<boolean>
  onAddPasskeyToThisDevice?: () => Promise<boolean>
  onRefreshBundleState?: () => Promise<void>
  initialTab?: SettingsTab
  chats?: Chat[]
}

function getAddPasskeyErrorTitle(error: unknown): string {
  if (error instanceof PrfNotSupportedError) {
    return 'Passkey provider not supported'
  }
  return 'Passkey setup failed'
}

function getAddPasskeyErrorDescription(error: unknown): string {
  if (error instanceof PrfNotSupportedError) {
    return error.message
  }
  return 'Could not add passkey for this device. You can try again later.'
}

export function SettingsModal({
  isOpen,
  setIsOpen,
  isDarkMode,
  themeMode,
  setThemeMode,
  isClient,
  defaultSystemPrompt = '',
  onCloudSyncSetupClick,
  onChatsUpdated,
  isSignedIn,
  isPremium,
  encryptionKey,
  passkeyActive,
  passkeySetupAvailable,
  passkeyAddDeviceAvailable,
  onSetupPasskey,
  onAddPasskeyToThisDevice,
  onRefreshBundleState,
  initialTab,
  chats = [],
}: SettingsModalProps) {
  const { getToken, signOut } = useAuth()
  const { user } = useUser()
  const { toast } = useToast()

  // Projects for export functionality
  const {
    projects,
    loading: projectsLoading,
    refresh: refreshProjects,
  } = useProjects({
    autoLoad: isSignedIn && isPremium,
  })
  // Encryption key management state
  const [isCopied, setIsCopied] = useState(false)
  const [isQRCodeExpanded, setIsQRCodeExpanded] = useState(false)
  const [isKeyVisible, setIsKeyVisible] = useState(false)
  const [isSettingUpPasskey, setIsSettingUpPasskey] = useState(false)
  const [passkeyBundles, setPasskeyBundles] = useState<
    PasskeyCredentialEntry[]
  >([])
  const [removingPasskeyId, setRemovingPasskeyId] = useState<string | null>(
    null,
  )
  const [passkeyKeyStatus, setPasskeyKeyStatus] = useState<
    'match' | 'mismatch' | 'unverified'
  >('unverified')
  const passkeyRefreshSeqRef = useRef(0)
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Structured personalization fields
  const [nickname, setNickname] = useState<string>('')
  const [profession, setProfession] = useState<string>('')
  const [selectedTraits, setSelectedTraits] = useState<string[]>([])
  const [additionalContext, setAdditionalContext] = useState<string>('')
  const [isUsingPersonalization, setIsUsingPersonalization] =
    useState<boolean>(true)
  // Last persisted personalization values; edits stay local until the user
  // hits Save, and this baseline is what dirty-checking compares against.
  const [savedPersonalization, setSavedPersonalization] = useState<{
    nickname: string
    profession: string
    traits: string[]
    additionalContext: string
  }>({ nickname: '', profession: '', traits: [], additionalContext: '' })

  // Language setting (separate from personalization)
  const [language, setLanguage] = useState<string>('')

  // Custom system prompt settings
  const [isUsingCustomPrompt, setIsUsingCustomPrompt] = useState<boolean>(false)
  const [customSystemPrompt, setCustomSystemPrompt] = useState<string>('')

  // Cloud sync setting
  const [cloudSyncEnabled, setCloudSyncEnabledState] = useState<boolean>(false)
  const [localOnlyModeEnabledState, setLocalOnlyModeEnabledState] =
    useState<boolean>(false)

  // Web Search PII check setting (defaults to on)
  const [piiCheckEnabled, setPiiCheckEnabled] = useState<boolean>(true)

  // Generative UI setting (defaults to on)
  const [genUIEnabled, setGenUIEnabled] = useState<boolean>(true)

  // Chat font setting
  const [chatFont, setChatFont] = useState<ChatFont>('system')

  const [isHowItWorksOpen, setIsHowItWorksOpen] = useState(false)

  // Prompt library management state
  const {
    builtInPresets,
    userPresets,
    createUserPreset,
    updateUserPreset,
    deleteUserPreset,
    duplicatePreset,
  } = usePromptLibrary()
  const [promptEditor, setPromptEditor] = useState<PresetEditorState | null>(
    null,
  )
  const [presetPendingDelete, setPresetPendingDelete] =
    useState<PromptPreset | null>(null)

  // Active tab state
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    initialTab ?? 'account',
  )

  // Update active tab when initialTab prop changes (e.g., opening to a specific tab)
  useEffect(() => {
    if (initialTab && isOpen) {
      setActiveTab(initialTab)
    }
  }, [initialTab, isOpen])

  // Sync URL fragment with active tab
  useEffect(() => {
    if (isOpen) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#settings/${activeTab}`,
      )
    } else {
      if (window.location.hash.startsWith('#settings/')) {
        window.history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search,
        )
      }
    }
  }, [isOpen, activeTab])

  // Placeholder animation state
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [placeholderVisible, setPlaceholderVisible] = useState(true)

  // Upgrade state
  const [upgradeLoading, setUpgradeLoading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)

  // Import state
  const [importSource, setImportSource] = useState<
    'chatgpt' | 'claude' | 'tinfoil' | null
  >(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{
    current: number
    total: number
    type: 'chats' | 'projects'
  } | null>(null)
  const [importResult, setImportResult] = useState<{
    success: boolean
    chatsImported: number
    projectsImported: number
    errors: string[]
    pending?: boolean
    message?: string
  } | null>(null)
  const chatGptFileInputRef = useRef<HTMLInputElement>(null)
  const claudeConversationsFileInputRef = useRef<HTMLInputElement>(null)
  const claudeProjectsFileInputRef = useRef<HTMLInputElement>(null)
  const tinfoilFileInputRef = useRef<HTMLInputElement>(null)

  // Export state
  const [isExporting, setIsExporting] = useState(false)
  const [isPreparingExport, setIsPreparingExport] = useState(false)
  const [exportType, setExportType] = useState<'chats' | 'projects' | null>(
    null,
  )

  // Danger zone state
  const [showDeleteAllChatsConfirm, setShowDeleteAllChatsConfirm] =
    useState(false)
  const [isDeletingAllChats, setIsDeletingAllChats] = useState(false)
  const [deleteAllChatsConfirmText, setDeleteAllChatsConfirmText] = useState('')
  const [showDeleteAllProjectsConfirm, setShowDeleteAllProjectsConfirm] =
    useState(false)
  const [isDeletingAllProjects, setIsDeletingAllProjects] = useState(false)
  const [deleteAllProjectsConfirmText, setDeleteAllProjectsConfirmText] =
    useState('')

  // Available personality traits
  const availableTraits = [
    'witty',
    'encouraging',
    'formal',
    'casual',
    'analytical',
    'creative',
    'direct',
    'patient',
    'enthusiastic',
    'thoughtful',
    'forward thinking',
    'traditional',
    'skeptical',
    'optimistic',
  ]

  // Cycling profession placeholders
  const professionPlaceholders = [
    'Software engineer',
    'Designer',
    'Product manager',
    'Teacher',
    'Student',
    'Writer',
    'Entrepreneur',
    'Researcher',
    'Marketing specialist',
    'Data scientist',
  ]

  // Cycle through profession placeholders with fade animation
  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderVisible(false)
      setTimeout(() => {
        setPlaceholderIndex(
          (prev) => (prev + 1) % professionPlaceholders.length,
        )
        setPlaceholderVisible(true)
      }, 150)
    }, 2000)
    return () => clearInterval(interval)
  }, [professionPlaceholders.length])

  const getCurrentPlaceholder = () => professionPlaceholders[placeholderIndex]

  // Available languages for dropdown
  const availableLanguages = [
    'English',
    'Spanish',
    'French',
    'German',
    'Italian',
    'Portuguese',
    'Russian',
    'Japanese',
    'Korean',
    'Chinese (Simplified)',
    'Chinese (Traditional)',
    'Arabic',
    'Hindi',
    'Dutch',
    'Swedish',
    'Norwegian',
    'Danish',
    'Finnish',
    'Polish',
    'Turkish',
  ]

  // Shared function to load settings from localStorage
  const loadSettingsFromStorage = useCallback(() => {
    // Load personalization settings
    const savedNickname = localStorage.getItem(USER_PREFS_NICKNAME)
    const savedProfession = localStorage.getItem(USER_PREFS_PROFESSION)
    const savedTraits = localStorage.getItem(USER_PREFS_TRAITS)
    const savedContext = localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT)
    const savedUsingPersonalization = localStorage.getItem(
      USER_PREFS_PERSONALIZATION_ENABLED,
    )

    let parsedTraits: string[] = []
    if (savedTraits) {
      try {
        parsedTraits = JSON.parse(savedTraits)
      } catch {
        parsedTraits = []
      }
    }
    setNickname(savedNickname ?? '')
    setProfession(savedProfession ?? '')
    setSelectedTraits(parsedTraits)
    setAdditionalContext(savedContext ?? '')
    setSavedPersonalization({
      nickname: savedNickname ?? '',
      profession: savedProfession ?? '',
      traits: parsedTraits,
      additionalContext: savedContext ?? '',
    })
    if (savedUsingPersonalization !== null) {
      setIsUsingPersonalization(savedUsingPersonalization === 'true')
    }

    // Load language setting
    const savedLanguage = localStorage.getItem(USER_PREFS_LANGUAGE)
    if (savedLanguage) {
      setLanguage(savedLanguage)
    }

    // Load custom system prompt settings
    const savedUsingCustomPrompt = localStorage.getItem(
      USER_PREFS_CUSTOM_PROMPT_ENABLED,
    )
    const savedCustomPrompt = localStorage.getItem(
      USER_PREFS_CUSTOM_SYSTEM_PROMPT,
    )
    if (savedUsingCustomPrompt !== null) {
      setIsUsingCustomPrompt(savedUsingCustomPrompt === 'true')
    }
    if (savedCustomPrompt !== null) {
      setCustomSystemPrompt(savedCustomPrompt)
    } else if (defaultSystemPrompt) {
      setCustomSystemPrompt(defaultSystemPrompt)
    }

    // Load cloud sync setting
    setCloudSyncEnabledState(isCloudSyncEnabled())
    setLocalOnlyModeEnabledState(isLocalOnlyModeEnabled())

    // Load PII check setting (defaults to true if not set)
    const savedPiiCheck = localStorage.getItem(SETTINGS_PII_CHECK_ENABLED)
    setPiiCheckEnabled(savedPiiCheck === null ? true : savedPiiCheck === 'true')

    // Load Generative UI setting (defaults to true if not set)
    const savedGenUI = localStorage.getItem(SETTINGS_GENUI_ENABLED)
    setGenUIEnabled(savedGenUI === null ? true : savedGenUI === 'true')

    // Load chat font setting
    const savedChatFont = localStorage.getItem(SETTINGS_CHAT_FONT)
    setChatFont(normalizeChatFont(savedChatFont))
  }, [defaultSystemPrompt])

  // Initial load settings from localStorage
  useEffect(() => {
    if (isClient) {
      loadSettingsFromStorage()

      // Set default language if not already set
      const savedLanguage = localStorage.getItem(USER_PREFS_LANGUAGE)
      if (!savedLanguage) {
        setLanguage('English')
        localStorage.setItem(USER_PREFS_LANGUAGE, 'English')
      }
    }
  }, [isClient, loadSettingsFromStorage])

  // Listen for profile sync updates
  useEffect(() => {
    if (!isClient) return

    // Listen for storage events (from other tabs or sync)
    window.addEventListener('storage', loadSettingsFromStorage)

    // Also listen for our custom events that fire after profile sync
    const handleProfileSyncUpdate = () => {
      loadSettingsFromStorage()
    }

    // Listen for cloud sync setting changes (e.g., from modal or other sources)
    const handleCloudSyncUpdate = () => {
      setCloudSyncEnabledState(isCloudSyncEnabled())
    }

    // These events are fired by the profile sync when it updates localStorage
    window.addEventListener('personalizationChanged', handleProfileSyncUpdate)
    window.addEventListener('languageChanged', handleProfileSyncUpdate)
    window.addEventListener(
      'customSystemPromptChanged',
      handleProfileSyncUpdate,
    )
    window.addEventListener('cloudSyncSettingChanged', handleCloudSyncUpdate)

    return () => {
      window.removeEventListener('storage', loadSettingsFromStorage)
      window.removeEventListener(
        'personalizationChanged',
        handleProfileSyncUpdate,
      )
      window.removeEventListener('languageChanged', handleProfileSyncUpdate)
      window.removeEventListener(
        'customSystemPromptChanged',
        handleProfileSyncUpdate,
      )
      window.removeEventListener(
        'cloudSyncSettingChanged',
        handleCloudSyncUpdate,
      )
    }
  }, [isClient, loadSettingsFromStorage])

  const refreshPasskeyBundles = useCallback(async () => {
    // Latest-wins sequencing: overlapping refreshes (panel-open effect
    // racing a post-removal refresh) must not let a stale response
    // overwrite newer inventory or key status.
    const seq = ++passkeyRefreshSeqRef.current
    if (!cloudSyncEnabled) {
      setPasskeyBundles([])
      setPasskeyKeyStatus('unverified')
      return
    }
    try {
      const entries = await loadPasskeyCredentials()
      if (seq !== passkeyRefreshSeqRef.current) return
      setPasskeyBundles(entries)
    } catch (error) {
      logError('Failed to load passkey bundle inventory', error, {
        component: 'SettingsModal',
        action: 'refreshPasskeyBundles',
      })
      if (seq !== passkeyRefreshSeqRef.current) return
      setPasskeyBundles([])
    }
    try {
      const validation = await validateCurrentPrimaryKey()
      if (seq !== passkeyRefreshSeqRef.current) return
      setPasskeyKeyStatus(
        validation.canWrite
          ? 'match'
          : validation.remoteState === 'exists'
            ? 'mismatch'
            : 'unverified',
      )
    } catch {
      if (seq !== passkeyRefreshSeqRef.current) return
      setPasskeyKeyStatus('unverified')
    }
  }, [cloudSyncEnabled])

  // Reload the bundle inventory whenever the Cloud Sync panel
  // becomes visible or the user's passkey state may have changed
  // (active / add-device / setup transitions).
  useEffect(() => {
    if (!isOpen) return
    if (activeTab !== 'cloud-sync') return
    void refreshPasskeyBundles()
  }, [
    isOpen,
    activeTab,
    refreshPasskeyBundles,
    passkeyActive,
    passkeyAddDeviceAvailable,
  ])

  // Save personalization settings and notify components
  const savePersonalizationSettings = (values?: {
    nickname?: string
    profession?: string
    traits?: string[]
    additionalContext?: string
    isEnabled?: boolean
  }) => {
    if (isClient) {
      const currentNickname = values?.nickname ?? nickname
      const currentProfession = values?.profession ?? profession
      const currentTraits = values?.traits ?? selectedTraits
      const currentContext = values?.additionalContext ?? additionalContext
      const currentEnabled = values?.isEnabled ?? isUsingPersonalization

      localStorage.setItem(USER_PREFS_NICKNAME, currentNickname)
      localStorage.setItem(USER_PREFS_PROFESSION, currentProfession)
      localStorage.setItem(USER_PREFS_TRAITS, JSON.stringify(currentTraits))
      localStorage.setItem(USER_PREFS_ADDITIONAL_CONTEXT, currentContext)
      localStorage.setItem(
        USER_PREFS_PERSONALIZATION_ENABLED,
        currentEnabled.toString(),
      )

      // Trigger event to notify other components
      window.dispatchEvent(
        new CustomEvent('personalizationChanged', {
          detail: {
            nickname: currentNickname,
            profession: currentProfession,
            traits: currentTraits,
            additionalContext: currentContext,
            language,
            isEnabled: currentEnabled,
            defaultSystemPrompt,
          },
        }),
      )
    }
  }

  // Save language setting separately
  const saveLanguageSetting = (newLanguage: string) => {
    if (isClient) {
      localStorage.setItem(USER_PREFS_LANGUAGE, newLanguage)

      // Trigger event to notify other components about language change
      window.dispatchEvent(
        new CustomEvent('languageChanged', {
          detail: {
            language: newLanguage,
            defaultSystemPrompt,
          },
        }),
      )
    }
  }

  // Handle individual field changes. Edits are buffered locally and only
  // persisted when the user hits Save.
  const handleNicknameChange = (value: string) => {
    setNickname(value)
  }

  const handleProfessionChange = (value: string) => {
    setProfession(value)
  }

  const handleTraitToggle = (trait: string) => {
    const newTraits = selectedTraits.includes(trait)
      ? selectedTraits.filter((t) => t !== trait)
      : [...selectedTraits, trait]
    setSelectedTraits(newTraits)
  }

  const handleContextChange = (value: string) => {
    setAdditionalContext(value)
  }

  const hasUnsavedPersonalization =
    nickname !== savedPersonalization.nickname ||
    profession !== savedPersonalization.profession ||
    additionalContext !== savedPersonalization.additionalContext ||
    selectedTraits.length !== savedPersonalization.traits.length ||
    selectedTraits.some((t, i) => t !== savedPersonalization.traits[i])

  const handleSavePersonalization = () => {
    if (!isClient) return
    savePersonalizationSettings()
    setSavedPersonalization({
      nickname,
      profession,
      traits: selectedTraits,
      additionalContext,
    })
  }

  const handleLanguageChange = (value: string) => {
    setLanguage(value)
    if (isClient) {
      saveLanguageSetting(value)
    }
  }

  const handleTogglePersonalization = (enabled: boolean) => {
    setIsUsingPersonalization(enabled)
    if (isClient) {
      savePersonalizationSettings({
        ...savedPersonalization,
        isEnabled: enabled,
      })
    }
  }

  const handleResetPersonalization = () => {
    setNickname('')
    setProfession('')
    setSelectedTraits([])
    setAdditionalContext('')
    setLanguage('English')
    setSavedPersonalization({
      nickname: '',
      profession: '',
      traits: [],
      additionalContext: '',
    })

    if (isClient) {
      localStorage.removeItem(USER_PREFS_NICKNAME)
      localStorage.removeItem(USER_PREFS_PROFESSION)
      localStorage.removeItem(USER_PREFS_TRAITS)
      localStorage.removeItem(USER_PREFS_ADDITIONAL_CONTEXT)
      localStorage.setItem(USER_PREFS_LANGUAGE, 'English')
      saveLanguageSetting('English')
      savePersonalizationSettings({
        nickname: '',
        profession: '',
        traits: [],
        additionalContext: '',
        isEnabled: isUsingPersonalization,
      })
    }
  }

  const handleChatFontChange = (font: ChatFont) => {
    setChatFont(font)
    if (isClient) {
      localStorage.setItem(SETTINGS_CHAT_FONT, font)
      window.dispatchEvent(
        new CustomEvent('chatFontChanged', {
          detail: font,
        }),
      )
    }
  }

  // Helper to strip <system> tags for display
  const stripSystemTags = (prompt: string): string => {
    return prompt
      .replace(/^<system>\s*\n?/, '')
      .replace(/\n?<\/system>\s*$/, '')
  }

  // Helper to add <system> tags if not present
  const ensureSystemTags = (prompt: string): string => {
    const trimmed = prompt.trim()
    if (!trimmed) return ''
    if (!trimmed.startsWith('<system>')) {
      return `<system>\n${trimmed}\n</system>`
    }
    return trimmed
  }

  // Handle custom system prompt changes
  const handleToggleCustomPrompt = (enabled: boolean) => {
    setIsUsingCustomPrompt(enabled)
    if (isClient) {
      localStorage.setItem(USER_PREFS_CUSTOM_PROMPT_ENABLED, enabled.toString())
      // Only dispatch event when toggling the feature
      const promptWithTags = ensureSystemTags(customSystemPrompt)
      window.dispatchEvent(
        new CustomEvent('customSystemPromptChanged', {
          detail: {
            isEnabled: enabled,
            customPrompt: promptWithTags,
          },
        }),
      )
    }
  }

  const handleCustomPromptChange = (value: string) => {
    setCustomSystemPrompt(value)
  }

  const handleCustomPromptBlur = () => {
    if (isClient) {
      // Store with system tags
      const promptWithTags = ensureSystemTags(customSystemPrompt)
      localStorage.setItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT, promptWithTags)
      // Only dispatch if currently enabled
      if (isUsingCustomPrompt) {
        window.dispatchEvent(
          new CustomEvent('customSystemPromptChanged', {
            detail: {
              isEnabled: true,
              customPrompt: promptWithTags,
            },
          }),
        )
      }
    }
  }

  const startCreatePreset = () => {
    setPromptEditor({ ...EMPTY_PRESET_EDITOR_STATE })
  }

  const startEditPreset = (preset: PromptPreset) => {
    setPromptEditor({
      mode: 'edit',
      presetId: preset.id,
      name: preset.name,
      description: preset.description,
      systemPrompt: stripSystemTags(preset.systemPrompt),
    })
  }

  const handleDuplicatePreset = (preset: PromptPreset) => {
    const copy = duplicatePreset(preset.id)
    if (!copy) return
    setPromptEditor({
      mode: 'edit',
      presetId: copy.id,
      name: copy.name,
      description: copy.description,
      systemPrompt: stripSystemTags(copy.systemPrompt),
    })
  }

  const handleDeletePreset = (preset: PromptPreset) => {
    if (preset.isBuiltIn) return
    setPresetPendingDelete(preset)
  }

  const handleConfirmDeletePreset = () => {
    const preset = presetPendingDelete
    if (!preset) return
    deleteUserPreset(preset.id)
    setPresetPendingDelete(null)
  }

  const handleSavePromptEditor = () => {
    if (!promptEditor) return
    const name = promptEditor.name.trim()
    if (!name) return
    const trimmed = promptEditor.systemPrompt.trim()
    if (!trimmed) return
    const promptWithTags = ensureSystemTags(trimmed)

    if (promptEditor.mode === 'create') {
      createUserPreset({
        name,
        description: promptEditor.description.trim(),
        systemPrompt: promptWithTags,
      })
    } else if (promptEditor.presetId) {
      updateUserPreset(promptEditor.presetId, {
        name,
        description: promptEditor.description.trim(),
        systemPrompt: promptWithTags,
      })
    }
    setPromptEditor(null)
  }

  // Restore default system prompt and persist immediately
  const handleRestoreDefaultPrompt = () => {
    const restoredWithoutTags = stripSystemTags(defaultSystemPrompt)
    setCustomSystemPrompt(restoredWithoutTags)
    if (isClient) {
      const promptWithTags = ensureSystemTags(restoredWithoutTags)
      localStorage.setItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT, promptWithTags)
      if (isUsingCustomPrompt) {
        window.dispatchEvent(
          new CustomEvent('customSystemPromptChanged', {
            detail: {
              isEnabled: true,
              customPrompt: promptWithTags,
            },
          }),
        )
      }
    }
  }

  const handleCloudSyncToggle = async (enabled: boolean) => {
    if (enabled) {
      // Check if encryption key exists
      if (!encryptionService.getKey()) {
        // Prefer passkey setup when available
        if (passkeySetupAvailable && onSetupPasskey) {
          setIsOpen(false)
          try {
            const success = await onSetupPasskey()
            if (success) return
          } catch (error) {
            toast({
              title:
                error instanceof PrfNotSupportedError
                  ? 'Passkey provider not supported'
                  : 'Passkey setup failed',
              description:
                error instanceof PrfNotSupportedError
                  ? error.message
                  : 'Could not create passkey backup. You can try again later.',
              variant: 'destructive',
            })
          }
          // Passkey setup didn't succeed — fall through to manual key setup
          if (onCloudSyncSetupClick) {
            onCloudSyncSetupClick()
          }
          return
        }

        // Close settings modal and show the cloud sync setup modal
        setIsOpen(false)
        if (onCloudSyncSetupClick) {
          onCloudSyncSetupClick()
        }
        return
      }

      // If key exists, proceed with enabling
      setCloudSyncEnabledState(true)
      setCloudSyncEnabled(true)

      // Clear the explicit disable flag when re-enabling
      localStorage.removeItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED)
    } else {
      // Disabling cloud sync
      setCloudSyncEnabledState(false)
      setCloudSyncEnabled(false)

      // Mark that user explicitly disabled cloud sync (to prevent auto-enable)
      localStorage.setItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED, 'true')

      try {
        const deletedCount = await chatStorage.deleteAllNonLocalChats()
        logInfo(
          `Deleted ${deletedCount} synced chats when disabling cloud sync`,
          {
            component: 'SettingsModal',
            action: 'handleCloudSyncToggle',
          },
        )
        if (deletedCount > 0 && onChatsUpdated) {
          onChatsUpdated()
        }
      } catch (error) {
        logInfo('Failed to delete synced chats', {
          component: 'SettingsModal',
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

  const handleUpgradeToPro = useCallback(async () => {
    setUpgradeError(null)
    setUpgradeLoading(true)
    try {
      const token = await authTokenManager.getValidToken()

      const returnUrl = encodeURIComponent(window.location.origin)
      const response = await fetch(
        `${API_BASE_URL}/api/billing/chat-checkout-link?returnUrl=${returnUrl}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      )

      if (!response.ok) {
        throw new Error('Failed to generate checkout link')
      }

      const data = await response.json()
      if (!data?.url) {
        throw new Error('Checkout link unavailable')
      }

      window.location.href = data.url as string
    } catch {
      setUpgradeError('Failed to start checkout. Please try again later.')
    } finally {
      setUpgradeLoading(false)
    }
  }, [])

  // Billing state
  const [billingLoading, setBillingLoading] = useState(false)

  const handleManageBilling = useCallback(async () => {
    if (!getToken) return

    setBillingLoading(true)
    try {
      const token = await getToken()
      if (!token) throw new Error('No authentication token available')

      const response = await fetch(
        `${API_BASE_URL}/api/billing/subscriptions`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      )

      if (!response.ok) throw new Error('Failed to fetch subscriptions')

      const data = await response.json()
      const chatSubscription = data.subscriptions?.find(
        (sub: { product_name: string; manage_url: string }) =>
          sub.product_name?.toLowerCase().includes('chat'),
      )

      if (chatSubscription?.manage_url) {
        window.location.href = chatSubscription.manage_url
      } else {
        setUpgradeError('No active subscription found')
      }
    } catch {
      setUpgradeError('Failed to load billing. Please try again.')
    } finally {
      setBillingLoading(false)
    }
  }, [getToken])

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true)
    showSignoutProgress()
    try {
      await signOut()
    } catch (error) {
      logError('Sign out failed', error, {
        component: 'SettingsModal',
        action: 'handleSignOut',
      })
      hideSignoutProgress()
    } finally {
      setIsSigningOut(false)
    }
  }, [signOut])

  // Import handlers
  const generateChatId = (createdAt?: Date) => {
    const timestampMs = createdAt?.getTime() || Date.now()
    return generateReverseId(timestampMs).id
  }

  const getParseOptions = () => ({
    generateChatId,
    isCloudSyncEnabled: isCloudSyncEnabled(),
  })

  // Cloud-sync users import off-device: the raw export is uploaded to
  // the enclave, which parses, seals, and stores everything without the
  // plaintext touching app servers, then emails the user on completion.
  const shouldImportOffDevice = () =>
    Boolean(isSignedIn) && isCloudSyncEnabled() && hasPrimaryKey()

  const importOffDevice = async (
    source: 'chatgpt' | 'claude' | 'tinfoil',
    file: File,
    sourceLabel: string,
  ) => {
    setImportSource(source)
    setIsImporting(true)
    setImportResult(null)
    try {
      const { status } = await runOffDeviceImport(source, file)
      const errors = status.errors ?? []
      const pending = status.status === 'staging' || status.status === 'running'
      setImportResult({
        success: status.status !== 'failed',
        chatsImported: status.imported,
        projectsImported: 0,
        errors,
        pending,
        message: pending
          ? `Your ${sourceLabel} export is being imported securely. We'll email you when it's done.`
          : undefined,
      })
      toast({
        title: 'Import started',
        description: `Your ${sourceLabel} export is being imported securely. We'll email you when it's done.`,
      })
      if (!pending && onChatsUpdated) {
        onChatsUpdated()
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start import'
      setImportResult({
        success: false,
        chatsImported: 0,
        projectsImported: 0,
        errors: [message],
      })
      toast({
        title: 'Import failed',
        description: `Could not start the ${sourceLabel} import`,
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      setImportProgress(null)
    }
  }

  const handleImportChatGPT = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (shouldImportOffDevice()) {
      await importOffDevice('chatgpt', file, 'ChatGPT')
      e.target.value = ''
      return
    }

    setImportSource('chatgpt')
    setIsImporting(true)
    setImportResult(null)

    try {
      const content = await file.text()
      const data = JSON.parse(content)

      if (!Array.isArray(data)) {
        throw new Error('Invalid ChatGPT export format')
      }

      const chats = parseChatGPTConversations(data, getParseOptions())
      setImportProgress({ current: 0, total: chats.length, type: 'chats' })

      let imported = 0
      const errors: string[] = []

      // Save all chats to IndexedDB first (skip cloud sync on individual saves)
      for (let i = 0; i < chats.length; i++) {
        try {
          await chatStorage.saveChat(chats[i], true) // skipCloudSync = true
          imported++
        } catch (err) {
          errors.push(`Failed to save "${chats[i].title}" locally`)
        }
        setImportProgress({
          current: i + 1,
          total: chats.length,
          type: 'chats',
        })
      }

      // Bulk upload to cloud if sync is enabled
      if (isCloudSyncEnabled() && (await cloudStorage.isAuthenticated())) {
        const CHUNK_SIZE = 100
        const chatsToUpload = chats.filter((c) => !c.isLocalOnly)
        let cloudUploadFailed = false

        for (let i = 0; i < chatsToUpload.length; i += CHUNK_SIZE) {
          const chunk = chatsToUpload.slice(i, i + CHUNK_SIZE)
          try {
            const result = await cloudStorage.bulkUploadChats(chunk)
            if (result.failed > 0) {
              result.results
                .filter((r) => !r.success)
                .forEach((r) =>
                  errors.push(
                    `Cloud upload failed: ${r.error || r.conversationId}`,
                  ),
                )
            }
          } catch (err) {
            if (!cloudUploadFailed) {
              errors.push(
                `Cloud sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
              )
              cloudUploadFailed = true
            }
          }
        }
      }

      setImportResult({
        success: errors.length === 0,
        chatsImported: imported,
        projectsImported: 0,
        errors,
      })

      if (onChatsUpdated) {
        onChatsUpdated()
      }

      toast({
        title: 'Import complete',
        description: `Imported ${imported} chat${imported !== 1 ? 's' : ''} from ChatGPT`,
      })
    } catch (err) {
      setImportResult({
        success: false,
        chatsImported: 0,
        projectsImported: 0,
        errors: [err instanceof Error ? err.message : 'Failed to parse file'],
      })
      toast({
        title: 'Import failed',
        description: 'Could not parse the ChatGPT export file',
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      setImportProgress(null)
      e.target.value = ''
    }
  }

  const handleImportTinfoil = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (shouldImportOffDevice()) {
      await importOffDevice('tinfoil', file, 'Tinfoil')
      e.target.value = ''
      return
    }

    setImportSource('tinfoil')
    setImportResult({
      success: false,
      chatsImported: 0,
      projectsImported: 0,
      errors: [
        'Tinfoil exports with attachments can be re-imported when cloud sync is enabled.',
      ],
    })
    toast({
      title: 'Cloud sync required',
      description:
        'Turn on cloud sync to re-import Tinfoil exports securely through the enclave.',
      variant: 'destructive',
    })
    e.target.value = ''
  }

  const handleImportClaudeConversations = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (shouldImportOffDevice()) {
      await importOffDevice('claude', file, 'Claude')
      e.target.value = ''
      return
    }

    setImportSource('claude')
    setIsImporting(true)
    setImportResult(null)

    try {
      const content = await file.text()
      const data = JSON.parse(content)

      if (!Array.isArray(data)) {
        throw new Error('Invalid Claude export format')
      }

      const chats = parseClaudeConversations(data, getParseOptions())
      setImportProgress({ current: 0, total: chats.length, type: 'chats' })

      let imported = 0
      const errors: string[] = []

      // Save all chats to IndexedDB first (skip cloud sync on individual saves)
      for (let i = 0; i < chats.length; i++) {
        try {
          await chatStorage.saveChat(chats[i], true) // skipCloudSync = true
          imported++
        } catch (err) {
          errors.push(`Failed to save "${chats[i].title}" locally`)
        }
        setImportProgress({
          current: i + 1,
          total: chats.length,
          type: 'chats',
        })
      }

      // Bulk upload to cloud if sync is enabled
      if (isCloudSyncEnabled() && (await cloudStorage.isAuthenticated())) {
        const CHUNK_SIZE = 100
        const chatsToUpload = chats.filter((c) => !c.isLocalOnly)
        let cloudUploadFailed = false

        for (let i = 0; i < chatsToUpload.length; i += CHUNK_SIZE) {
          const chunk = chatsToUpload.slice(i, i + CHUNK_SIZE)
          try {
            const result = await cloudStorage.bulkUploadChats(chunk)
            if (result.failed > 0) {
              result.results
                .filter((r) => !r.success)
                .forEach((r) =>
                  errors.push(
                    `Cloud upload failed: ${r.error || r.conversationId}`,
                  ),
                )
            }
          } catch (err) {
            if (!cloudUploadFailed) {
              errors.push(
                `Cloud sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
              )
              cloudUploadFailed = true
            }
          }
        }
      }

      setImportResult({
        success: errors.length === 0,
        chatsImported: imported,
        projectsImported: 0,
        errors,
      })

      if (onChatsUpdated) {
        onChatsUpdated()
      }

      toast({
        title: 'Import complete',
        description: `Imported ${imported} chat${imported !== 1 ? 's' : ''} from Claude`,
      })
    } catch (err) {
      setImportResult({
        success: false,
        chatsImported: 0,
        projectsImported: 0,
        errors: [err instanceof Error ? err.message : 'Failed to parse file'],
      })
      toast({
        title: 'Import failed',
        description: 'Could not parse the Claude export file',
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      setImportProgress(null)
      e.target.value = ''
    }
  }

  const handleImportClaudeProjects = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!isPremium) {
      toast({
        title: 'Premium required',
        description: 'Project import is only available for premium users',
        variant: 'destructive',
      })
      e.target.value = ''
      return
    }

    setImportSource('claude')
    setIsImporting(true)
    setImportResult(null)

    try {
      const content = await file.text()
      const data = JSON.parse(content)

      if (!Array.isArray(data)) {
        throw new Error('Invalid Claude projects export format')
      }

      const parsedProjects = parseClaudeProjects(data)
      setImportProgress({
        current: 0,
        total: parsedProjects.length,
        type: 'projects',
      })

      let imported = 0
      const errors: string[] = []

      // Dynamically import project storage to avoid circular dependencies
      const { projectStorage } =
        await import('@/services/cloud/project-storage')

      for (let i = 0; i < parsedProjects.length; i++) {
        const project = parsedProjects[i]
        try {
          const createdProject = await projectStorage.createProject({
            name: project.name,
            description: project.description,
            systemInstructions: project.systemInstructions,
          })

          for (const doc of project.docs) {
            try {
              await projectStorage.uploadDocument(
                createdProject.id,
                doc.filename,
                'text/markdown',
                doc.content,
              )
            } catch {
              errors.push(
                `Failed to import document "${doc.filename}" for project "${project.name}"`,
              )
            }
          }

          imported++
        } catch (err) {
          errors.push(`Failed to import project "${project.name}"`)
        }
        setImportProgress({
          current: i + 1,
          total: parsedProjects.length,
          type: 'projects',
        })
      }

      setImportResult({
        success: errors.length === 0,
        chatsImported: 0,
        projectsImported: imported,
        errors,
      })

      toast({
        title: 'Import complete',
        description: `Imported ${imported} project${imported !== 1 ? 's' : ''} from Claude`,
      })
    } catch (err) {
      setImportResult({
        success: false,
        chatsImported: 0,
        projectsImported: 0,
        errors: [err instanceof Error ? err.message : 'Failed to parse file'],
      })
      toast({
        title: 'Import failed',
        description: 'Could not parse the Claude projects file',
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      setImportProgress(null)
      e.target.value = ''
    }
  }

  // Export chats as conversations.json
  const downloadChats = async (chatsToExport: Chat[]) => {
    if (chatsToExport.length === 0) {
      toast({
        title: 'No chats to export',
        description: 'You have no chats to export yet.',
        variant: 'destructive',
      })
      return
    }

    setIsExporting(true)
    setExportType('chats')

    try {
      // Fetch one binary attachment at a time so the browser never
      // holds every attachment's bytes in memory at once.
      const fetchAttachmentBytes = async (
        att: Attachment,
      ): Promise<Uint8Array | null> => {
        try {
          if (att.base64) {
            return base64ToUint8Array(att.base64)
          }
          if (att.encryptionKey) {
            return await attachmentGet({
              id: att.id,
              attKeyB64: att.encryptionKey,
            })
          }
        } catch {
          logWarning('Failed to fetch attachment for export', {
            component: 'SettingsModal',
            action: 'downloadChats',
            metadata: { attachmentId: att.id },
          })
        }
        return null
      }

      const archive = await buildChatExport(chatsToExport, fetchAttachmentBytes)
      const blob =
        typeof archive.data === 'string'
          ? new Blob([archive.data], { type: archive.mimeType })
          : new Blob([new Uint8Array(archive.data)], {
              type: archive.mimeType,
            })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = archive.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      toast({
        title: 'Export complete',
        description: `Exported ${chatsToExport.length} conversation${chatsToExport.length !== 1 ? 's' : ''} successfully.`,
      })
    } catch (error) {
      logError('Failed to create conversations export', error, {
        component: 'SettingsModal',
        action: 'downloadChats',
      })
      toast({
        title: 'Export failed',
        description: 'Failed to download conversations. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
      setExportType(null)
    }
  }

  // Fetch all chats (including cloud) and export them
  const handleExportAllChats = async () => {
    setIsPreparingExport(true)
    setExportType('chats')

    try {
      const chatsById = new Map<string, Chat>()
      const addChat = (chat: Chat) => {
        if (!chat.id || chatsById.has(chat.id)) return
        chatsById.set(chat.id, chat)
      }

      const indexedDbChats = await chatStorage.getAllChats()
      indexedDbChats.forEach(addChat)
      if (!isSignedIn) {
        sessionChatStorage.getAllChats().forEach(addChat)
      }

      // If cloud sync is enabled, fetch all chats with pagination
      if (isCloudSyncEnabled() && isSignedIn) {
        let hasMore = true
        let continuationToken: string | undefined

        while (hasMore) {
          const result = await cloudSync.loadChatsWithPagination({
            limit: 50,
            continuationToken,
            loadLocal: !continuationToken, // Only load local on first page to avoid duplicates
          })

          // Convert StoredChat to Chat
          for (const storedChat of result.chats) {
            addChat({
              id: storedChat.id,
              title: storedChat.title,
              messages: storedChat.messages,
              createdAt: new Date(storedChat.createdAt),
              updatedAt: storedChat.updatedAt,
              isLocalOnly: storedChat.isLocalOnly,
              isBlankChat: storedChat.isBlankChat,
              syncedAt: storedChat.syncedAt,
              projectId: storedChat.projectId,
            })
          }

          hasMore = result.hasMore
          continuationToken = result.nextToken
        }
      }

      // Filter out blank chats and chats that failed decryption
      const exportableChats = Array.from(chatsById.values()).filter(
        (chat) =>
          !chat.isBlankChat && chat.messages && chat.messages.length > 0,
      )

      setIsPreparingExport(false)
      await downloadChats(exportableChats)
    } catch (error) {
      logError('Failed to prepare chats for export', error, {
        component: 'SettingsModal',
        action: 'handleExportAllChats',
      })
      toast({
        title: 'Export failed',
        description: 'Failed to prepare chats for export. Please try again.',
        variant: 'destructive',
      })
      setIsPreparingExport(false)
      setExportType(null)
    }
  }

  // Delete every chat the user owns (local IndexedDB + cloud + session).
  // Defense in depth: re-check the typed confirmation phrase here in addition
  // to gating the submit button on it, so the destructive action cannot be
  // triggered accidentally even if the UI layer is bypassed.
  const handleDeleteAllChats = async () => {
    if (
      deleteAllChatsConfirmText.trim().toLowerCase() !==
      DELETE_ALL_CHATS_CONFIRM_PHRASE
    ) {
      return
    }

    setIsDeletingAllChats(true)
    try {
      if (isSignedIn) {
        const result = await chatStorage.deleteAllChats()
        toast({
          title: 'All chats deleted',
          description: result.notificationSent
            ? 'We will email you a confirmation.'
            : 'Email confirmation could not be sent.',
        })
      } else {
        sessionChatStorage.clearAll()
        toast({
          title: 'All chats deleted',
          description: 'Removed all chats from this browser session.',
        })
      }

      if (onChatsUpdated) {
        onChatsUpdated()
      }
    } catch (error) {
      logError('Failed to delete all chats', error, {
        component: 'SettingsModal',
        action: 'handleDeleteAllChats',
      })
      toast({
        title: 'Delete failed',
        description: 'Failed to delete all chats. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsDeletingAllChats(false)
      setShowDeleteAllChatsConfirm(false)
      setDeleteAllChatsConfirmText('')
    }
  }

  // Delete every project the user owns. Same defense-in-depth confirmation
  // gate as handleDeleteAllChats.
  const handleDeleteAllProjects = async () => {
    if (
      deleteAllProjectsConfirmText.trim().toLowerCase() !==
      DELETE_ALL_PROJECTS_CONFIRM_PHRASE
    ) {
      return
    }

    setIsDeletingAllProjects(true)
    try {
      const result = await projectStorage.deleteAllProjects()
      toast({
        title: 'All projects deleted',
        description: result.notificationSent
          ? 'We will email you a confirmation.'
          : 'Email confirmation could not be sent.',
      })

      await refreshProjects()

      // Project deletion detaches chats from projects on the server, so the
      // chat list in the sidebar may need to refresh too.
      if (onChatsUpdated) {
        onChatsUpdated()
      }
    } catch (error) {
      logError('Failed to delete all projects', error, {
        component: 'SettingsModal',
        action: 'handleDeleteAllProjects',
      })
      toast({
        title: 'Delete failed',
        description: 'Failed to delete all projects. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsDeletingAllProjects(false)
      setShowDeleteAllProjectsConfirm(false)
      setDeleteAllProjectsConfirmText('')
    }
  }

  // Export projects as projects.json
  const downloadProjects = async (
    projectsToExport: Array<{
      id: string
      name: string
      description: string
      systemInstructions: string
      memory: Array<{ fact: string }>
      createdAt: string
      updatedAt: string
    }>,
  ) => {
    if (projectsToExport.length === 0) {
      toast({
        title: 'No projects to export',
        description: 'You have no projects to export yet.',
        variant: 'destructive',
      })
      return
    }

    setIsExporting(true)
    setExportType('projects')

    try {
      // Fetch documents for each project and convert to Claude-compatible format
      const projectsWithDocs = await Promise.all(
        projectsToExport.map(async (project) => {
          const docs: Array<{
            uuid: string
            filename: string
            content: string
            created_at: string
          }> = []

          // Try to fetch documents for this project
          try {
            const docsResponse = await projectStorage.listDocuments(
              project.id,
              {
                includeContent: true,
              },
            )

            if (docsResponse.documents && docsResponse.documents.length > 0) {
              await Promise.all(
                docsResponse.documents.map(async (doc) => {
                  try {
                    const fullDoc = await projectStorage.getDocument(
                      project.id,
                      doc.id,
                    )
                    if (fullDoc && fullDoc.content) {
                      docs.push({
                        uuid: doc.id,
                        filename: fullDoc.filename,
                        content: fullDoc.content,
                        created_at: new Date().toISOString(),
                      })
                    }
                  } catch {
                    // Skip documents that fail to fetch
                  }
                }),
              )
            }
          } catch {
            // Skip documents if we can't fetch them
          }

          return {
            uuid: project.id,
            name: project.name,
            description: project.description || undefined,
            prompt_template: project.systemInstructions || undefined,
            created_at: new Date(project.createdAt).toISOString(),
            updated_at: new Date(project.updatedAt).toISOString(),
            docs: docs.length > 0 ? docs : undefined,
          }
        }),
      )

      // Create and download JSON file
      const jsonContent = JSON.stringify(projectsWithDocs, null, 2)
      const blob = new Blob([jsonContent], { type: 'application/json' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'projects.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      toast({
        title: 'Export complete',
        description: `Exported ${projectsToExport.length} project${projectsToExport.length !== 1 ? 's' : ''} successfully.`,
      })
    } catch (error) {
      logError('Failed to create projects export', error, {
        component: 'SettingsModal',
        action: 'downloadProjects',
      })
      toast({
        title: 'Export failed',
        description: 'Failed to download projects. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
      setExportType(null)
    }
  }

  // Cleanup copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [])

  // Reset transient state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsQRCodeExpanded(false)
      setShowSignOutConfirm(false)
      setShowDeleteAllChatsConfirm(false)
      setDeleteAllChatsConfirmText('')
      setShowDeleteAllProjectsConfirm(false)
      setDeleteAllProjectsConfirmText('')
    }
  }, [isOpen])

  const handleCopyKey = async () => {
    if (!encryptionKey) return

    try {
      await navigator.clipboard.writeText(encryptionKey)
      setIsCopied(true)

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }

      copyTimeoutRef.current = setTimeout(() => {
        setIsCopied(false)
        copyTimeoutRef.current = null
      }, 2000)
    } catch {
      toast({
        title: 'Failed to copy',
        description: 'Could not copy encryption key to clipboard',
        variant: 'destructive',
      })
    }
  }

  const downloadKeyAsPEM = () => {
    if (!encryptionKey) return

    const pemContent = `-----BEGIN TINFOIL CHAT ENCRYPTION KEY-----
${encryptionKey.replace('key_', '')}
-----END TINFOIL CHAT ENCRYPTION KEY-----`

    const blob = new Blob([pemContent], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tinfoil-chat-key-${new Date().toISOString().split('T')[0]}.pem`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!isOpen) return null

  const navItems = [
    { id: 'account' as const, label: 'Account', icon: UserCircleIcon },
    {
      id: 'general' as const,
      label: 'General',
      icon: HiOutlineAdjustmentsVertical,
    },
    {
      id: 'chat' as const,
      label: 'Chat Settings',
      icon: ChatBubbleLeftRightIcon,
    },
    {
      id: 'personalization' as const,
      label: 'Personalization',
      icon: UserIcon,
    },
    {
      id: 'prompts' as const,
      label: 'Prompts',
      icon: Squares2X2Icon,
    },
    ...(isSignedIn
      ? [
          {
            id: 'cloud-sync' as const,
            label: 'Cloud Sync',
            icon: AiOutlineCloudSync,
          },
        ]
      : []),
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Modal overlay */}
      <div
        className="fixed inset-0 bg-black/50"
        onClick={() => setIsOpen(false)}
      />

      {/* Settings modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
        }}
        className={cn(
          'relative z-10 flex h-[80vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-xl border font-aeonik shadow-xl md:flex-row',
          'border-border-subtle bg-surface-sidebar text-content-primary',
        )}
      >
        {/* Mobile header with close button and horizontal tabs */}
        <div className="flex flex-col border-b border-border-subtle md:hidden">
          {/* Close button row */}
          <div className="flex h-12 items-center justify-between px-4">
            <h2 className="font-aeonik text-base font-semibold text-content-primary">
              {navItems.find((item) => item.id === activeTab)?.label}
            </h2>
            <div className="flex items-center gap-2">
              {activeTab === 'personalization' &&
                isUsingPersonalization &&
                hasUnsavedPersonalization && (
                  <button
                    onClick={handleSavePersonalization}
                    className="rounded-lg bg-brand-accent-dark px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
                  >
                    Save
                  </button>
                )}
              <button
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Horizontal tabs */}
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                  activeTab === item.id
                    ? 'bg-surface-chat text-content-primary'
                    : 'text-content-secondary hover:bg-surface-chat/50',
                )}
              >
                {item.id === 'account' && isSignedIn ? (
                  <UserAvatar size={16} />
                ) : (
                  <item.icon className="h-4 w-4" />
                )}
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Left sidebar navigation (desktop only) */}
        <div className="hidden w-56 flex-none flex-col border-r border-border-subtle md:flex">
          {/* Close button */}
          <div className="flex h-14 items-center px-4">
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation items */}
          <nav className="flex-1 px-3 py-2">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  activeTab === item.id
                    ? 'bg-surface-chat text-content-primary'
                    : 'text-content-secondary hover:bg-surface-chat/50',
                )}
              >
                {item.id === 'account' && isSignedIn ? (
                  <UserAvatar size={20} />
                ) : (
                  <item.icon className="h-5 w-5" />
                )}
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Right content area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Header (desktop only) */}
          <div className="hidden h-14 items-center justify-between border-b border-border-subtle px-6 md:flex">
            <h2 className="font-aeonik text-lg font-semibold text-content-primary">
              {navItems.find((item) => item.id === activeTab)?.label}
            </h2>
            {activeTab === 'personalization' &&
              isUsingPersonalization &&
              hasUnsavedPersonalization && (
                <button
                  onClick={handleSavePersonalization}
                  className="rounded-lg bg-brand-accent-dark px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
                >
                  Save
                </button>
              )}
          </div>

          {/* Content */}
          <div className="relative flex-1 overflow-y-auto p-6">
            <TextureGrid />
            <div className="relative z-10 space-y-6">
              {/* General Tab */}
              {activeTab === 'general' && (
                <>
                  {/* Appearance */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Appearance
                    </h3>
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="mb-3">
                        <div className="font-aeonik text-sm font-medium text-content-primary">
                          Theme
                        </div>
                        <div className="font-aeonik-fono text-xs text-content-muted">
                          Choose your preferred color scheme
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          {
                            id: 'light' as const,
                            label: 'Light',
                            icon: SunIcon,
                          },
                          {
                            id: 'dark' as const,
                            label: 'Dark',
                            icon: MoonIcon,
                          },
                          {
                            id: 'system' as const,
                            label: 'System',
                            icon: ComputerDesktopIcon,
                          },
                        ].map((theme) => (
                          <button
                            key={theme.id}
                            onClick={() => setThemeMode(theme.id)}
                            className={cn(
                              'flex flex-col items-center gap-1 rounded-lg border p-3 transition-all',
                              themeMode === theme.id
                                ? 'border-brand-accent-light bg-brand-accent-light/10'
                                : 'border-border-subtle hover:border-border-strong',
                            )}
                          >
                            <theme.icon className="h-5 w-5 text-content-primary" />
                            <span className="text-xs text-content-secondary">
                              {theme.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Chat Tab */}
              {activeTab === 'chat' && (
                <>
                  {/* Conversation Settings */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Conversation Settings
                    </h3>
                    {/* Chat Font */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="mb-3">
                        <div className="font-aeonik text-sm font-medium text-content-primary">
                          Chat font
                        </div>
                        <div className="font-aeonik-fono text-xs text-content-muted">
                          Choose the font for chat messages
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {(
                          [
                            {
                              id: 'system',
                              label: 'System',
                              fontClass: 'font-system',
                            },
                            {
                              id: 'serif',
                              label: 'Serif',
                              fontClass: 'font-lora',
                            },
                            {
                              id: 'mono',
                              label: 'Mono',
                              fontClass: 'font-aeonik-fono',
                            },
                            {
                              id: 'dyslexic',
                              label: 'Dyslexic friendly',
                              fontClass: 'font-opendyslexic',
                            },
                          ] as const
                        ).map((font) => (
                          <button
                            key={font.id}
                            onClick={() => handleChatFontChange(font.id)}
                            className={cn(
                              'flex flex-col items-center gap-1 rounded-lg border p-2 transition-all',
                              chatFont === font.id
                                ? 'border-brand-accent-light bg-brand-accent-light/10'
                                : 'border-border-subtle hover:border-border-strong',
                            )}
                          >
                            <div
                              className={cn(
                                'flex h-8 w-full items-center justify-center text-lg text-content-primary',
                                font.fontClass,
                              )}
                            >
                              Aa
                            </div>
                            <span className="text-[10px] text-content-secondary">
                              {font.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Response Language */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="space-y-3">
                        <div>
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Response Language
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            Language for AI responses
                          </div>
                        </div>
                        <select
                          value={language}
                          onChange={(e) => handleLanguageChange(e.target.value)}
                          className={cn(
                            'w-full rounded-md border py-2 pl-3 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500',
                            isDarkMode
                              ? 'border-border-strong bg-surface-chat text-content-secondary'
                              : 'border-border-subtle bg-surface-sidebar text-content-primary',
                          )}
                        >
                          {availableLanguages.map((lang) => (
                            <option key={lang} value={lang}>
                              {lang}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Advanced Settings */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Advanced Settings
                    </h3>
                    <div className="space-y-4">
                      {/* Web Search PII Detection */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="mr-3 flex-1">
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Automatic PII Blocking in Web Search
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              When web search is enabled, queries containing
                              personal information will be blocked.
                            </div>
                          </div>
                          <label className="relative inline-flex cursor-pointer items-center">
                            <input
                              type="checkbox"
                              checked={piiCheckEnabled}
                              onChange={(e) => {
                                const newValue = e.target.checked
                                setPiiCheckEnabled(newValue)
                                if (isClient) {
                                  localStorage.setItem(
                                    SETTINGS_PII_CHECK_ENABLED,
                                    newValue.toString(),
                                  )
                                  window.dispatchEvent(
                                    new CustomEvent('piiCheckEnabledChanged', {
                                      detail: { enabled: newValue },
                                    }),
                                  )
                                }
                              }}
                              className="peer sr-only"
                            />
                            <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                          </label>
                        </div>
                      </div>

                      {/* Generative UI */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="mr-3 flex-1">
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Generative UI
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              Let Tin render interactive widgets like charts and
                              timelines. When off, no tool capabilities are sent
                              to the model.
                            </div>
                          </div>
                          <label className="relative inline-flex cursor-pointer items-center">
                            <input
                              type="checkbox"
                              checked={genUIEnabled}
                              onChange={(e) => {
                                const newValue = e.target.checked
                                setGenUIEnabled(newValue)
                                if (isClient) {
                                  localStorage.setItem(
                                    SETTINGS_GENUI_ENABLED,
                                    newValue.toString(),
                                  )
                                  window.dispatchEvent(
                                    new CustomEvent('genUIEnabledChanged', {
                                      detail: { enabled: newValue },
                                    }),
                                  )
                                }
                              }}
                              className="peer sr-only"
                            />
                            <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* General Tab: Data (danger zone) */}
              {activeTab === 'general' && (
                <>
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Data
                    </h3>
                    <>
                      {/* Delete all saved chats */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                            <div>
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                Delete all saved chats
                              </div>
                              <div className="font-aeonik-fono text-xs text-content-muted">
                                {isSignedIn
                                  ? 'Permanently delete every chat from this device and your encrypted cloud backup. This cannot be undone.'
                                  : 'Permanently delete every chat from this browser. This cannot be undone.'}
                              </div>
                            </div>
                            {!showDeleteAllChatsConfirm && (
                              <button
                                onClick={() =>
                                  setShowDeleteAllChatsConfirm(true)
                                }
                                className={cn(
                                  'w-full shrink-0 rounded-md border px-3 py-2 text-sm font-medium transition-colors sm:w-auto',
                                  isDarkMode
                                    ? 'border-red-500/40 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                                    : 'border-red-300 bg-white text-red-600 hover:bg-red-100',
                                )}
                              >
                                Delete all saved chats
                              </button>
                            )}
                          </div>
                          {showDeleteAllChatsConfirm && (
                            <div className="space-y-2">
                              <label className="block">
                                <span className="font-aeonik-fono text-xs text-content-muted">
                                  Type{' '}
                                  <code className="font-mono text-content-primary">
                                    {DELETE_ALL_CHATS_CONFIRM_PHRASE}
                                  </code>{' '}
                                  to confirm.
                                </span>
                                <input
                                  type="text"
                                  autoComplete="off"
                                  autoCorrect="off"
                                  autoCapitalize="off"
                                  spellCheck={false}
                                  value={deleteAllChatsConfirmText}
                                  onChange={(e) =>
                                    setDeleteAllChatsConfirmText(e.target.value)
                                  }
                                  disabled={isDeletingAllChats}
                                  placeholder={DELETE_ALL_CHATS_CONFIRM_PHRASE}
                                  className={cn(
                                    'mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60',
                                    isDarkMode
                                      ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                      : 'border-border-subtle bg-white text-content-primary placeholder:text-content-muted',
                                  )}
                                />
                              </label>
                              <div className="flex flex-col gap-2 sm:flex-row">
                                <button
                                  onClick={handleDeleteAllChats}
                                  disabled={
                                    isDeletingAllChats ||
                                    deleteAllChatsConfirmText
                                      .trim()
                                      .toLowerCase() !==
                                      DELETE_ALL_CHATS_CONFIRM_PHRASE
                                  }
                                  className={cn(
                                    'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                    isDarkMode
                                      ? 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-900 disabled:text-red-300'
                                      : 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:text-white/70',
                                  )}
                                >
                                  {isDeletingAllChats && (
                                    <PiSpinner
                                      className="h-4 w-4 animate-spin"
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span>
                                    {isDeletingAllChats
                                      ? 'Requesting…'
                                      : 'Yes, delete all my chats'}
                                  </span>
                                </button>
                                <button
                                  onClick={() => {
                                    setShowDeleteAllChatsConfirm(false)
                                    setDeleteAllChatsConfirmText('')
                                  }}
                                  disabled={isDeletingAllChats}
                                  className={cn(
                                    'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                                    isDarkMode
                                      ? 'border-border-strong bg-surface-chat text-content-secondary hover:bg-surface-chat/80'
                                      : 'border-border-subtle bg-white text-content-primary hover:bg-surface-chat',
                                  )}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Delete all projects (signed-in premium users only) */}
                      {isSignedIn && isPremium && (
                        <div
                          className={cn(
                            'rounded-lg border border-border-subtle p-4',
                            isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                          )}
                        >
                          <div className="space-y-3">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                              <div>
                                <div className="font-aeonik text-sm font-medium text-content-primary">
                                  Delete all projects
                                </div>
                                <div className="font-aeonik-fono text-xs text-content-muted">
                                  Permanently delete every project and its
                                  documents. Chats inside projects will be
                                  detached but kept. This cannot be undone.
                                </div>
                              </div>
                              {!showDeleteAllProjectsConfirm && (
                                <button
                                  onClick={() =>
                                    setShowDeleteAllProjectsConfirm(true)
                                  }
                                  className={cn(
                                    'w-full shrink-0 rounded-md border px-3 py-2 text-sm font-medium transition-colors sm:w-auto',
                                    isDarkMode
                                      ? 'border-red-500/40 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                                      : 'border-red-300 bg-white text-red-600 hover:bg-red-100',
                                  )}
                                >
                                  Delete all projects
                                </button>
                              )}
                            </div>
                            {showDeleteAllProjectsConfirm && (
                              <div className="space-y-2">
                                <label className="block">
                                  <span className="font-aeonik-fono text-xs text-content-muted">
                                    Type{' '}
                                    <code className="font-mono text-content-primary">
                                      {DELETE_ALL_PROJECTS_CONFIRM_PHRASE}
                                    </code>{' '}
                                    to confirm.
                                  </span>
                                  <input
                                    type="text"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    autoCapitalize="off"
                                    spellCheck={false}
                                    value={deleteAllProjectsConfirmText}
                                    onChange={(e) =>
                                      setDeleteAllProjectsConfirmText(
                                        e.target.value,
                                      )
                                    }
                                    disabled={isDeletingAllProjects}
                                    placeholder={
                                      DELETE_ALL_PROJECTS_CONFIRM_PHRASE
                                    }
                                    className={cn(
                                      'mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60',
                                      isDarkMode
                                        ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                        : 'border-border-subtle bg-white text-content-primary placeholder:text-content-muted',
                                    )}
                                  />
                                </label>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <button
                                    onClick={handleDeleteAllProjects}
                                    disabled={
                                      isDeletingAllProjects ||
                                      deleteAllProjectsConfirmText
                                        .trim()
                                        .toLowerCase() !==
                                        DELETE_ALL_PROJECTS_CONFIRM_PHRASE
                                    }
                                    className={cn(
                                      'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                      isDarkMode
                                        ? 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-900 disabled:text-red-300'
                                        : 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:text-white/70',
                                    )}
                                  >
                                    {isDeletingAllProjects && (
                                      <PiSpinner
                                        className="h-4 w-4 animate-spin"
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span>
                                      {isDeletingAllProjects
                                        ? 'Requesting…'
                                        : 'Yes, delete all my projects'}
                                    </span>
                                  </button>
                                  <button
                                    onClick={() => {
                                      setShowDeleteAllProjectsConfirm(false)
                                      setDeleteAllProjectsConfirmText('')
                                    }}
                                    disabled={isDeletingAllProjects}
                                    className={cn(
                                      'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                                      isDarkMode
                                        ? 'border-border-strong bg-surface-chat text-content-secondary hover:bg-surface-chat/80'
                                        : 'border-border-subtle bg-white text-content-primary hover:bg-surface-chat',
                                    )}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  </div>
                </>
              )}

              {/* Personalization Tab */}
              {activeTab === 'personalization' && (
                <>
                  {/* Enable Personalization */}
                  <div
                    className={cn(
                      'rounded-lg border border-border-subtle p-4',
                      isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div className="mr-3 flex-1">
                        <div className="font-aeonik text-sm font-medium text-content-primary">
                          Personalize responses
                        </div>
                        <div className="font-aeonik-fono text-xs text-content-muted">
                          Tailor Tin&apos;s replies using the details below.
                          When off, none of these are sent to the model.
                        </div>
                      </div>
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={isUsingPersonalization}
                          onChange={(e) =>
                            handleTogglePersonalization(e.target.checked)
                          }
                          className="peer sr-only"
                        />
                        <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                      </label>
                    </div>
                  </div>

                  {isUsingPersonalization && (
                    <>
                      {/* Nickname */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div>
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Name
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              How should Tin call you?
                            </div>
                          </div>
                          <input
                            type="text"
                            value={nickname}
                            onChange={(e) =>
                              handleNicknameChange(e.target.value)
                            }
                            placeholder="Nickname"
                            className={cn(
                              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500',
                              isDarkMode
                                ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                            )}
                          />
                        </div>
                      </div>

                      {/* Profession */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div>
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Occupation
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              What do you do?
                            </div>
                          </div>
                          <div className="relative">
                            <input
                              type="text"
                              value={profession}
                              onChange={(e) =>
                                handleProfessionChange(e.target.value)
                              }
                              className={cn(
                                'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500',
                                isDarkMode
                                  ? 'border-border-strong bg-surface-chat text-content-secondary'
                                  : 'border-border-subtle bg-surface-sidebar text-content-primary',
                              )}
                            />
                            {!profession && (
                              <span
                                className={cn(
                                  'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-content-muted transition-opacity duration-150',
                                  placeholderVisible
                                    ? 'opacity-100'
                                    : 'opacity-0',
                                )}
                              >
                                {getCurrentPlaceholder()}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Traits */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div>
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Conversational Traits
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              What traits should Tin have?
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {availableTraits.map((trait) => (
                              <button
                                key={trait}
                                onClick={() => handleTraitToggle(trait)}
                                className={cn(
                                  'rounded-full px-3 py-1.5 text-sm transition-colors',
                                  selectedTraits.includes(trait)
                                    ? 'bg-brand-accent-light text-brand-accent-dark'
                                    : isDarkMode
                                      ? 'bg-surface-chat text-content-secondary hover:bg-surface-chat'
                                      : 'border border-border-subtle bg-surface-sidebar text-content-secondary hover:bg-surface-chat',
                                )}
                              >
                                {selectedTraits.includes(trait) ? '✓ ' : '+ '}
                                {trait}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Additional Context */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div>
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Additional Context
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              Anything else Tin should know about you?
                            </div>
                          </div>
                          <textarea
                            value={additionalContext}
                            onChange={(e) =>
                              handleContextChange(e.target.value)
                            }
                            placeholder="Interests and other preferences you'd like Tin to know about you."
                            rows={3}
                            className={cn(
                              'w-full resize-none rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500',
                              isDarkMode
                                ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                            )}
                          />
                        </div>
                      </div>

                      {/* Reset Button */}
                      <button
                        onClick={handleResetPersonalization}
                        className={cn(
                          'w-full rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                          isDarkMode
                            ? 'border-red-500/30 bg-red-950/20 text-red-400 hover:bg-red-950/40'
                            : 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100',
                        )}
                      >
                        Reset all fields
                      </button>
                    </>
                  )}
                </>
              )}

              {/* Prompts Tab */}
              {activeTab === 'prompts' && (
                <>
                  {promptEditor ? (
                    <div
                      className={cn(
                        'overflow-hidden rounded-lg border border-border-subtle',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <PresetEditor
                        editor={promptEditor}
                        onChange={setPromptEditor}
                        onCancel={() => setPromptEditor(null)}
                        onSave={handleSavePromptEditor}
                      />
                    </div>
                  ) : (
                    <>
                      {/* Default System Prompt */}
                      <div className="space-y-3">
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          Default System Prompt
                        </h3>
                        <div
                          className={cn(
                            'rounded-lg border border-border-subtle p-4',
                            isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                          )}
                        >
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="mr-3 flex-1">
                                <div className="font-aeonik text-sm font-medium text-content-primary">
                                  Custom default prompt
                                </div>
                                <div className="font-aeonik-fono text-xs text-content-muted">
                                  Override the system prompt for chats that
                                  don&apos;t have a preset selected.
                                </div>
                              </div>
                              <label className="relative inline-flex cursor-pointer items-center">
                                <input
                                  type="checkbox"
                                  checked={isUsingCustomPrompt}
                                  onChange={(e) =>
                                    handleToggleCustomPrompt(e.target.checked)
                                  }
                                  className="peer sr-only"
                                />
                                <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                              </label>
                            </div>
                            {isUsingCustomPrompt && (
                              <>
                                <textarea
                                  value={stripSystemTags(customSystemPrompt)}
                                  onChange={(e) =>
                                    handleCustomPromptChange(e.target.value)
                                  }
                                  onBlur={handleCustomPromptBlur}
                                  placeholder="Enter your custom system prompt..."
                                  rows={6}
                                  className={cn(
                                    'w-full resize-none rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500',
                                    isDarkMode
                                      ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                      : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                                  )}
                                />
                                <div className="rounded-lg border border-border-subtle bg-surface-chat p-3">
                                  <div className="font-aeonik-fono text-xs text-content-muted">
                                    <span
                                      className={cn(
                                        'font-aeonik font-medium',
                                        isDarkMode
                                          ? 'text-emerald-400'
                                          : 'text-emerald-600',
                                      )}
                                    >
                                      Tip:
                                    </span>{' '}
                                    Use placeholders like {'{USER_PREFERENCES}'}
                                    , {'{LANGUAGE}'}, {'{CURRENT_DATETIME}'},
                                    and {'{TIMEZONE}'} to tell the model about
                                    your preferences, timezone, and the current
                                    time and date.
                                  </div>
                                </div>
                                <div className="flex justify-center">
                                  <button
                                    onClick={handleRestoreDefaultPrompt}
                                    className={cn(
                                      'rounded-md px-3 py-1.5 text-xs transition-all hover:underline',
                                      isDarkMode
                                        ? 'text-red-400 hover:text-red-300'
                                        : 'text-red-600 hover:text-red-500',
                                    )}
                                  >
                                    Restore default prompt
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Built-in Prompts */}
                      <div className="space-y-3">
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          Built-in Prompts
                        </h3>
                        <p className="font-aeonik-fono text-xs text-content-muted">
                          Bundled with Tinfoil. Duplicate one to customize it.
                        </p>
                        <div className="space-y-2">
                          {builtInPresets.map((preset) => (
                            <PresetRow
                              key={preset.id}
                              preset={preset}
                              isDarkMode={isDarkMode}
                              onDuplicate={() => handleDuplicatePreset(preset)}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Your Prompts */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                            Your Prompts
                          </h3>
                          <button
                            type="button"
                            onClick={startCreatePreset}
                            className="flex items-center gap-1 rounded-md bg-brand-accent-dark px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
                          >
                            <PlusIcon className="h-3.5 w-3.5" />
                            New
                          </button>
                        </div>
                        {userPresets.length === 0 ? (
                          <div
                            className={cn(
                              'rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-content-muted',
                              isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                            )}
                          >
                            No custom prompts yet. Click &quot;New&quot; above
                            or duplicate a built-in prompt to start.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {userPresets.map((preset) => (
                              <PresetRow
                                key={preset.id}
                                preset={preset}
                                isDarkMode={isDarkMode}
                                onEdit={() => startEditPreset(preset)}
                                onDuplicate={() =>
                                  handleDuplicatePreset(preset)
                                }
                                onDelete={() => handleDeletePreset(preset)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Cloud Sync Tab */}
              {activeTab === 'cloud-sync' && (
                <>
                  {/* How It Works - Collapsible */}
                  <div
                    className={cn(
                      'rounded-lg border border-border-subtle',
                      isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setIsHowItWorksOpen((prev) => !prev)}
                      className="flex w-full items-center justify-between p-4"
                    >
                      <div className="flex items-center gap-2">
                        <RiLightbulbFill className="h-4 w-4 text-content-muted" />
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          How It Works
                        </h3>
                      </div>
                      <ChevronDownIcon
                        className={cn(
                          'h-4 w-4 text-content-muted transition-transform',
                          isHowItWorksOpen && 'rotate-180',
                        )}
                      />
                    </button>
                    {isHowItWorksOpen && (
                      <div className="space-y-3 border-t border-border-subtle p-4">
                        <div className="flex items-start gap-3">
                          <div className={STEP_CIRCLE_CLASSES}>1</div>
                          <div className="font-aeonik-fono text-sm text-content-muted">
                            Your chats are encrypted with a key that only you
                            possess and stored encrypted in the cloud. Nobody
                            but you can access your backed up chats.
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <div className={STEP_CIRCLE_CLASSES}>2</div>
                          <div className="font-aeonik-fono text-sm text-content-muted">
                            Only you have the encryption key. Tinfoil cannot
                            read your messages.
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <div className={STEP_CIRCLE_CLASSES}>3</div>
                          <div className="font-aeonik-fono text-sm text-content-muted">
                            Use a passkey to seamlessly sync your chats across
                            devices, or manually enter your encryption key.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Cloud Sync */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Cloud Sync
                    </h3>
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Encrypted Cloud Sync
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            {cloudSyncEnabled
                              ? 'End-to-end encrypted. Only you can access your chats and data.'
                              : 'Turn on Cloud Sync to back up and access your data across devices.'}
                          </div>
                        </div>
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={cloudSyncEnabled}
                            onChange={(e) =>
                              handleCloudSyncToggle(e.target.checked)
                            }
                            className="peer sr-only"
                          />
                          <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                        </label>
                      </div>
                    </div>
                    {cloudSyncEnabled && (
                      <CloudSyncHealthCard
                        isDarkMode={isDarkMode}
                        onRecoverClick={
                          onCloudSyncSetupClick
                            ? () => {
                                setIsOpen(false)
                                onCloudSyncSetupClick()
                              }
                            : undefined
                        }
                      />
                    )}
                  </div>

                  {/* Your Personal Encryption Key - Collapsible */}
                  {cloudSyncEnabled && (
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex w-full items-center justify-between p-4">
                        <div className="flex items-center gap-2">
                          <RiShieldKeyholeFill className="h-4 w-4 text-content-muted" />
                          <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                            Your Personal Encryption Key
                          </h3>
                        </div>
                      </div>
                      <div className="space-y-3 border-t border-border-subtle p-4">
                        {encryptionKey ? (
                          <div className="flex w-full items-end gap-2">
                            <motion.div
                              layout="size"
                              transition={{
                                type: 'spring',
                                damping: 25,
                                stiffness: 400,
                                mass: 0.5,
                              }}
                              className={cn(
                                'relative min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface-chat transition-colors duration-300 hover:border-blue-500/50',
                                isQRCodeExpanded ? 'p-3' : 'pr-2',
                              )}
                            >
                              {/* Key row (always visible) */}
                              <div className="flex items-center">
                                <div
                                  onClick={handleCopyKey}
                                  className="min-w-0 flex-1 cursor-pointer overflow-hidden px-3 py-2 text-left"
                                >
                                  <code className="block h-5 overflow-hidden whitespace-nowrap font-mono text-sm leading-5 text-blue-500">
                                    <ScrambleText
                                      text={encryptionKey}
                                      isKeyVisible={isKeyVisible}
                                    />
                                  </code>
                                </div>
                                <div className="group relative z-10 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setIsKeyVisible(!isKeyVisible)
                                    }
                                    aria-label={
                                      isKeyVisible ? 'Hide key' : 'Show key'
                                    }
                                    className="flex items-center justify-center rounded-lg p-2 text-content-muted transition-all hover:text-content-primary"
                                  >
                                    {isKeyVisible ? (
                                      <EyeSlashIcon className="h-4 w-4" />
                                    ) : (
                                      <EyeIcon className="h-4 w-4" />
                                    )}
                                  </button>
                                  <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                    {isKeyVisible ? 'Hide key' : 'Show key'}
                                  </span>
                                </div>
                              </div>

                              {/* QR code (below key, pushes container open) */}
                              <motion.div
                                initial={false}
                                animate={isQRCodeExpanded ? 'open' : 'closed'}
                                variants={{
                                  open: {
                                    height: 140,
                                    marginTop: 12,
                                    opacity: 1,
                                  },
                                  closed: {
                                    height: 0,
                                    marginTop: 0,
                                    opacity: 0,
                                  },
                                }}
                                transition={{
                                  type: 'spring',
                                  damping: 25,
                                  stiffness: 400,
                                  mass: 0.5,
                                }}
                                className="overflow-hidden"
                              >
                                <motion.div
                                  initial={false}
                                  animate={
                                    isQRCodeExpanded
                                      ? { scale: 1 }
                                      : { scale: 0.85 }
                                  }
                                  transition={{
                                    type: 'spring',
                                    damping: 25,
                                    stiffness: 400,
                                    mass: 0.5,
                                  }}
                                  style={{ transformOrigin: 'top' }}
                                  className="flex justify-center"
                                >
                                  <QRCode
                                    value={encryptionKey}
                                    size={140}
                                    level="H"
                                    bgColor={
                                      isDarkMode
                                        ? TINFOIL_COLORS.surface.cardDark
                                        : TINFOIL_COLORS.surface.cardLight
                                    }
                                    fgColor="#3b82f6"
                                  />
                                </motion.div>
                              </motion.div>

                              {/* Copied overlay */}
                              <AnimatePresence>
                                {isCopied && (
                                  <motion.span
                                    initial={{
                                      opacity: 0,
                                      filter: 'blur(4px)',
                                      scale: 0.9,
                                    }}
                                    animate={{
                                      opacity: 1,
                                      filter: 'blur(0px)',
                                      scale: 1,
                                    }}
                                    exit={{
                                      opacity: 0,
                                      filter: 'blur(4px)',
                                      scale: 1.1,
                                    }}
                                    className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-blue-500/90 text-sm font-medium text-white backdrop-blur-sm"
                                  >
                                    Copied!
                                  </motion.span>
                                )}
                              </AnimatePresence>
                            </motion.div>
                            <div className="flex shrink-0 items-center gap-1">
                              <div className="group relative">
                                <button
                                  onClick={() =>
                                    setIsQRCodeExpanded(!isQRCodeExpanded)
                                  }
                                  aria-label="Show QR code"
                                  className={cn(
                                    'flex items-center justify-center rounded-lg p-2 transition-all hover:text-content-primary',
                                    isQRCodeExpanded
                                      ? 'text-blue-500'
                                      : 'text-content-muted',
                                  )}
                                >
                                  <BsQrCode className="h-4 w-4" />
                                </button>
                                <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                  QR code
                                </span>
                              </div>
                              <div className="group relative">
                                <button
                                  onClick={downloadKeyAsPEM}
                                  aria-label="Download encryption key as PEM file"
                                  className="flex items-center justify-center rounded-lg p-2 text-content-muted transition-all hover:text-content-primary"
                                >
                                  <ArrowDownTrayIcon className="h-4 w-4" />
                                </button>
                                <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                  Download
                                </span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-content-muted">
                            No encryption key set
                          </p>
                        )}
                        <p className="text-xs text-content-muted">
                          Do not share this key with anyone. Only save it in a
                          secure location.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Passkey Section */}
                  {cloudSyncEnabled &&
                    (passkeyActive ||
                      (passkeySetupAvailable && onSetupPasskey) ||
                      (passkeyAddDeviceAvailable &&
                        onAddPasskeyToThisDevice)) && (
                      <div className="space-y-3">
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          Passkey
                        </h3>

                        {/* Passkey Active Status */}
                        {passkeyActive && (
                          <div
                            className={cn(
                              'rounded-lg border border-border-subtle p-4',
                              isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <GoPasskeyFill className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent-light" />
                              <div>
                                <span className="text-sm font-medium text-content-primary">
                                  Sync and backup using Passkeys
                                </span>
                                <p className="text-xs text-content-muted">
                                  Use Face ID or Touch ID to sync chats across
                                  devices
                                </p>
                              </div>
                            </div>
                            <div className="ml-6 mt-2 flex items-center gap-1.5">
                              <IoShieldCheckmark className="h-3.5 w-3.5 text-brand-accent-light" />
                              <span className="text-xs font-medium text-brand-accent-light">
                                Passkey active
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Per-device passkey inventory */}
                        {passkeyBundles.length > 0 && (
                          <PasskeyBundleInventory
                            entries={passkeyBundles}
                            isDarkMode={isDarkMode}
                            removingId={removingPasskeyId}
                            keyStatus={passkeyKeyStatus}
                            onRemove={async (credentialId) => {
                              // Guard non-pointer activation paths;
                              // one removal at a time.
                              if (removingPasskeyId !== null) return
                              setRemovingPasskeyId(credentialId)
                              try {
                                const ok =
                                  await deletePasskeyCredential(credentialId)
                                if (ok) {
                                  toast({
                                    title: 'Passkey removed',
                                    description:
                                      'That platform can no longer unlock your chats with this passkey.',
                                  })
                                  await refreshPasskeyBundles()
                                  if (onRefreshBundleState) {
                                    await onRefreshBundleState()
                                  }
                                } else {
                                  toast({
                                    title: 'Could not remove passkey',
                                    description:
                                      'Please try again in a moment.',
                                    variant: 'destructive',
                                  })
                                }
                              } catch (error) {
                                logError(
                                  'Failed to remove passkey credential',
                                  error,
                                  {
                                    component: 'SettingsModal',
                                    action: 'onRemovePasskey',
                                  },
                                )
                                toast({
                                  title: 'Could not remove passkey',
                                  description: 'Please try again in a moment.',
                                  variant: 'destructive',
                                })
                              } finally {
                                setRemovingPasskeyId(null)
                              }
                            }}
                          />
                        )}

                        {/* Passkey Setup Prompt */}
                        {!passkeyActive &&
                          passkeySetupAvailable &&
                          onSetupPasskey && (
                            <button
                              onClick={async () => {
                                setIsSettingUpPasskey(true)
                                try {
                                  const success = await onSetupPasskey()
                                  if (success) {
                                    toast({
                                      title: 'Passkey created',
                                      description:
                                        'Your encryption key is now backed up with your passkey',
                                    })
                                  }
                                } catch (error) {
                                  toast({
                                    title:
                                      error instanceof PrfNotSupportedError
                                        ? 'Passkey provider not supported'
                                        : 'Passkey setup failed',
                                    description:
                                      error instanceof PrfNotSupportedError
                                        ? error.message
                                        : 'Could not create passkey backup. You can try again later.',
                                    variant: 'destructive',
                                  })
                                } finally {
                                  setIsSettingUpPasskey(false)
                                }
                              }}
                              disabled={isSettingUpPasskey}
                              className={cn(
                                'w-full rounded-lg border border-border-subtle p-4 text-left transition-colors',
                                isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                                isSettingUpPasskey
                                  ? 'cursor-not-allowed opacity-50'
                                  : 'hover:bg-surface-chat/80',
                              )}
                            >
                              <div className="flex gap-2">
                                <GoPasskeyFill className="mt-[3px] h-4 w-4 shrink-0 text-content-secondary" />
                                <div>
                                  <span className="text-sm font-medium leading-tight text-content-primary">
                                    {isSettingUpPasskey
                                      ? 'Setting up...'
                                      : 'Add Passkey for seamless sync'}
                                  </span>
                                  <p className="text-xs text-content-muted">
                                    Use Face ID or Touch ID to sync chats across
                                    devices
                                  </p>
                                </div>
                              </div>
                            </button>
                          )}

                        {/* Add Passkey on This Device Prompt */}
                        {!passkeyActive &&
                          passkeyAddDeviceAvailable &&
                          onAddPasskeyToThisDevice && (
                            <button
                              onClick={async () => {
                                setIsSettingUpPasskey(true)
                                try {
                                  const success =
                                    await onAddPasskeyToThisDevice()
                                  if (success) {
                                    toast({
                                      title: 'Passkey added for this device',
                                      description:
                                        'You can now unlock your chats on this device with Face ID or Touch ID',
                                    })
                                  }
                                } catch (error) {
                                  toast({
                                    title: getAddPasskeyErrorTitle(error),
                                    description:
                                      getAddPasskeyErrorDescription(error),
                                    variant: 'destructive',
                                  })
                                } finally {
                                  setIsSettingUpPasskey(false)
                                }
                              }}
                              disabled={isSettingUpPasskey}
                              className={cn(
                                'w-full rounded-lg border border-border-subtle p-4 text-left transition-colors',
                                isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                                isSettingUpPasskey
                                  ? 'cursor-not-allowed opacity-50'
                                  : 'hover:bg-surface-chat/80',
                              )}
                            >
                              <div className="flex gap-2">
                                <GoPasskeyFill className="mt-[3px] h-4 w-4 shrink-0 text-content-secondary" />
                                <div>
                                  <span className="text-sm font-medium leading-tight text-content-primary">
                                    {isSettingUpPasskey
                                      ? 'Setting up...'
                                      : 'Set Up Passkey on This Device'}
                                  </span>
                                  <p className="text-xs text-content-muted">
                                    Your other devices use a passkey already.
                                    Add one here for one-tap access.
                                  </p>
                                </div>
                              </div>
                            </button>
                          )}
                      </div>
                    )}

                  {/* Local Chats Section */}
                  {cloudSyncEnabled && (
                    <div className="space-y-3">
                      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                        Local Chats
                      </h3>
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div className="flex items-start justify-between">
                            <div className="mr-3 flex-1">
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                Enable local chats
                              </div>
                              <div className="font-aeonik-fono text-xs text-content-muted">
                                Enable to create chats that stay only on this
                                device and are never synced to the cloud.
                              </div>
                            </div>
                            <label className="relative inline-flex cursor-pointer items-center">
                              <input
                                type="checkbox"
                                checked={localOnlyModeEnabledState}
                                onChange={(e) => {
                                  const newValue = e.target.checked
                                  setLocalOnlyModeEnabledState(newValue)
                                  setLocalOnlyModeEnabled(newValue)
                                }}
                                className="peer sr-only"
                              />
                              <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                            </label>
                          </div>
                          {localOnlyModeEnabledState && (
                            <div className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2">
                              <p className="text-xs font-medium text-orange-500">
                                Local chats will be permanently erased when you
                                sign out. Treat local chats as temporary.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Import Progress */}
                  {isImporting && importProgress && (
                    <div className="space-y-3">
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <ArrowPathIcon className="h-5 w-5 animate-spin text-brand-accent-light" />
                          <div className="flex-1">
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Importing {importProgress.type}...
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              {importProgress.current} of {importProgress.total}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-chat">
                          <div
                            className="h-full bg-brand-accent-light transition-all"
                            style={{
                              width: `${(importProgress.current / importProgress.total) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Import Result */}
                  {importResult && !isImporting && (
                    <div className="space-y-3">
                      <div
                        className={cn(
                          'rounded-lg border p-4',
                          importResult.success
                            ? 'border-emerald-500/30 bg-emerald-500/10'
                            : 'border-red-500/30 bg-red-500/10',
                        )}
                      >
                        <div className="flex items-start gap-3">
                          {importResult.success ? (
                            <CheckCircleIcon className="h-5 w-5 text-emerald-500" />
                          ) : (
                            <XMarkIcon className="h-5 w-5 text-red-500" />
                          )}
                          <div>
                            <div
                              className={cn(
                                'font-aeonik text-sm font-medium',
                                importResult.success
                                  ? 'text-emerald-500'
                                  : 'text-red-500',
                              )}
                            >
                              {importResult.pending
                                ? 'Import in progress'
                                : importResult.success
                                  ? 'Import complete'
                                  : 'Import completed with errors'}
                            </div>
                            {importResult.message && (
                              <div className="font-aeonik-fono text-xs text-content-muted">
                                {importResult.message}
                              </div>
                            )}
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              {importResult.chatsImported > 0 &&
                                `${importResult.chatsImported} chat${importResult.chatsImported !== 1 ? 's' : ''} imported`}
                              {importResult.chatsImported > 0 &&
                                importResult.projectsImported > 0 &&
                                ', '}
                              {importResult.projectsImported > 0 &&
                                `${importResult.projectsImported} project${importResult.projectsImported !== 1 ? 's' : ''} imported`}
                            </div>
                            {importResult.errors.length > 0 && (
                              <div className="mt-2 text-xs text-red-400">
                                {importResult.errors
                                  .slice(0, 3)
                                  .map((err, i) => (
                                    <div key={i}>{err}</div>
                                  ))}
                                {importResult.errors.length > 3 && (
                                  <div>
                                    +{importResult.errors.length - 3} more
                                    errors
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ChatGPT Import */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Import from ChatGPT
                    </h3>
                    <div
                      className={cn(
                        'space-y-3 rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          1
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          Open{' '}
                          <a
                            href="https://chatgpt.com/#settings/DataControls"
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              'hover:underline',
                              isDarkMode
                                ? 'text-brand-accent-light'
                                : 'text-[#004444]',
                            )}
                          >
                            ChatGPT Settings &gt; Data Controls
                          </a>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          2
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          Click on &quot;Export data&quot; and confirm the
                          export.
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          3
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          {shouldImportOffDevice()
                            ? 'Download the ZIP file you receive by email.'
                            : 'Download and unzip the file you receive by email.'}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          4
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          {shouldImportOffDevice() ? (
                            <>
                              Select the ZIP export to include attachments, or{' '}
                              <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                conversations.json
                              </code>{' '}
                              for chat text only.
                            </>
                          ) : (
                            <>
                              Select{' '}
                              <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                conversations.json
                              </code>{' '}
                              from the unzipped folder.
                            </>
                          )}
                        </div>
                      </div>
                      <input
                        ref={chatGptFileInputRef}
                        type="file"
                        accept={
                          shouldImportOffDevice() ? '.json,.zip' : '.json'
                        }
                        onChange={handleImportChatGPT}
                        className="hidden"
                        disabled={isImporting}
                      />
                      <button
                        onClick={() => chatGptFileInputRef.current?.click()}
                        disabled={isImporting}
                        className={cn(
                          'mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                          isImporting
                            ? 'cursor-not-allowed opacity-50'
                            : 'hover:bg-surface-chat',
                          isDarkMode
                            ? 'bg-surface-chat text-content-primary'
                            : 'bg-surface-sidebar text-content-primary',
                        )}
                      >
                        <ArrowUpTrayIcon className="h-4 w-4" />
                        Select File
                      </button>
                    </div>
                  </div>

                  {/* Claude Import */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Import from Claude
                    </h3>
                    <div
                      className={cn(
                        'space-y-3 rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          1
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          Open{' '}
                          <a
                            href="https://claude.ai/settings/data-privacy-controls"
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              'hover:underline',
                              isDarkMode
                                ? 'text-brand-accent-light'
                                : 'text-[#004444]',
                            )}
                          >
                            Claude Settings &gt; Privacy
                          </a>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          2
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          Click on &quot;Export data&quot; and confirm the
                          export.
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          3
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          {shouldImportOffDevice()
                            ? 'Download the ZIP file you receive by email.'
                            : 'Download and unzip the file you receive by email.'}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-aeonik-fono text-xs font-medium leading-none',
                            isDarkMode
                              ? 'bg-content-muted/20 text-content-secondary'
                              : 'bg-content-muted/20 text-content-secondary',
                          )}
                        >
                          4
                        </div>
                        <div className="font-aeonik-fono text-sm text-content-muted">
                          {shouldImportOffDevice() ? (
                            <>
                              Select the ZIP export with the Conversations
                              button to include attachments. Use{' '}
                              <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                projects.json
                              </code>{' '}
                              only for project imports.
                            </>
                          ) : (
                            <>
                              Select{' '}
                              <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                conversations.json
                              </code>{' '}
                              or{' '}
                              <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                projects.json
                              </code>{' '}
                              from the unzipped folder.
                            </>
                          )}
                        </div>
                      </div>
                      <input
                        ref={claudeConversationsFileInputRef}
                        type="file"
                        accept={
                          shouldImportOffDevice() ? '.json,.zip' : '.json'
                        }
                        onChange={handleImportClaudeConversations}
                        className="hidden"
                        disabled={isImporting}
                      />
                      <input
                        ref={claudeProjectsFileInputRef}
                        type="file"
                        accept=".json"
                        onChange={handleImportClaudeProjects}
                        className="hidden"
                        disabled={isImporting || !isPremium}
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() =>
                            claudeConversationsFileInputRef.current?.click()
                          }
                          disabled={isImporting}
                          className={cn(
                            'flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                            isImporting
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-surface-chat',
                            isDarkMode
                              ? 'bg-surface-chat text-content-primary'
                              : 'bg-surface-sidebar text-content-primary',
                          )}
                        >
                          <ArrowUpTrayIcon className="h-4 w-4" />
                          Conversations
                        </button>
                        <button
                          onClick={() =>
                            claudeProjectsFileInputRef.current?.click()
                          }
                          disabled={isImporting || !isPremium}
                          className={cn(
                            'flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                            isImporting || !isPremium
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-surface-chat',
                            isDarkMode
                              ? 'bg-surface-chat text-content-primary'
                              : 'bg-surface-sidebar text-content-primary',
                          )}
                        >
                          <ArrowUpTrayIcon className="h-4 w-4" />
                          Projects
                          {!isPremium && (
                            <span className="ml-1 rounded-full bg-brand-accent-light/20 px-1.5 py-px text-[10px] font-medium text-brand-accent-light">
                              Premium
                            </span>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Tinfoil Import */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Import from Tinfoil
                    </h3>
                    <div
                      className={cn(
                        'space-y-3 rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="font-aeonik-fono text-xs text-content-muted">
                        Re-import a Tinfoil conversations export through the
                        sync enclave. We&apos;ll email you when the import is
                        done.
                      </div>
                      <input
                        ref={tinfoilFileInputRef}
                        type="file"
                        accept=".json,.zip"
                        onChange={handleImportTinfoil}
                        className="hidden"
                        disabled={isImporting}
                      />
                      <button
                        onClick={() => tinfoilFileInputRef.current?.click()}
                        disabled={isImporting}
                        className={cn(
                          'flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                          isImporting
                            ? 'cursor-not-allowed opacity-50'
                            : 'hover:bg-surface-chat',
                          isDarkMode
                            ? 'bg-surface-chat text-content-primary'
                            : 'bg-surface-sidebar text-content-primary',
                        )}
                      >
                        <ArrowUpTrayIcon className="h-4 w-4" />
                        Select Tinfoil Export
                      </button>
                    </div>
                  </div>

                  {/* Export Chats */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Export Chats
                    </h3>
                    <div
                      className={cn(
                        'space-y-3 rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="font-aeonik-fono text-xs text-content-muted">
                        Export all your conversations as a JSON file. This
                        format can be re-imported into Tinfoil Chat.
                      </div>
                      <button
                        onClick={handleExportAllChats}
                        disabled={isExporting || isPreparingExport}
                        className={cn(
                          'flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                          isExporting || isPreparingExport
                            ? 'cursor-not-allowed opacity-50'
                            : 'hover:bg-surface-chat',
                          isDarkMode
                            ? 'bg-surface-chat text-content-primary'
                            : 'bg-surface-sidebar text-content-primary',
                        )}
                      >
                        {(isExporting || isPreparingExport) &&
                        exportType === 'chats' ? (
                          <ArrowPathIcon className="h-4 w-4 animate-spin" />
                        ) : (
                          <AiOutlineExport className="h-4 w-4" />
                        )}
                        {isPreparingExport && exportType === 'chats'
                          ? 'Please wait while we prepare the export...'
                          : isExporting && exportType === 'chats'
                            ? 'Exporting...'
                            : 'Export Chats'}
                      </button>
                    </div>
                  </div>

                  {/* Export Projects (premium only) */}
                  {isPremium && (
                    <div className="space-y-3">
                      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                        Export Projects
                      </h3>
                      <div
                        className={cn(
                          'space-y-3 rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="font-aeonik-fono text-xs text-content-muted">
                          Download all your projects including their settings,
                          system instructions, memory, and documents.
                        </div>
                        <button
                          onClick={() => downloadProjects(projects)}
                          disabled={
                            isExporting ||
                            projects.length === 0 ||
                            projectsLoading
                          }
                          className={cn(
                            'flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                            isExporting ||
                              projects.length === 0 ||
                              projectsLoading
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-surface-chat',
                            isDarkMode
                              ? 'bg-surface-chat text-content-primary'
                              : 'bg-surface-sidebar text-content-primary',
                          )}
                        >
                          {isExporting && exportType === 'projects' ? (
                            <ArrowPathIcon className="h-4 w-4 animate-spin" />
                          ) : projectsLoading ? (
                            <ArrowPathIcon className="h-4 w-4 animate-spin" />
                          ) : (
                            <AiOutlineExport className="h-4 w-4" />
                          )}
                          {isExporting && exportType === 'projects'
                            ? 'Exporting...'
                            : projectsLoading
                              ? 'Loading projects...'
                              : 'Export Projects'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Account Tab */}
              {activeTab === 'account' && (
                <>
                  {isSignedIn ? (
                    <>
                      {/* User Info */}
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
                          <div className="flex items-center gap-4">
                            <UserAvatar size={48} />
                            <div>
                              <div className="font-aeonik text-base font-medium text-content-primary">
                                {user?.firstName
                                  ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
                                  : user?.emailAddresses?.[0]?.emailAddress ||
                                    'User'}
                              </div>
                              <div className="text-sm text-content-muted">
                                {user?.emailAddresses?.[0]?.emailAddress}
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              if (isLocalOnlyModeEnabled()) {
                                setShowSignOutConfirm(true)
                              } else {
                                void handleSignOut()
                              }
                            }}
                            disabled={isSigningOut}
                            className={cn(
                              'flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                              'w-full border md:w-auto md:border-0',
                              'disabled:cursor-not-allowed disabled:opacity-70',
                              isDarkMode
                                ? 'border-red-500/30 bg-red-950/20 text-red-400 hover:bg-red-950/40 md:bg-transparent md:hover:bg-red-500/10'
                                : 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 md:bg-transparent md:text-red-500 md:hover:bg-red-500/10',
                            )}
                          >
                            {isSigningOut && (
                              <ArrowPathIcon className="h-4 w-4 animate-spin" />
                            )}
                            {isSigningOut ? 'Signing out...' : 'Sign out'}
                          </button>
                        </div>
                      </div>

                      {/* Subscription Status */}
                      <div className="space-y-3">
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          Subscription
                        </h3>
                        <div
                          className={cn(
                            'rounded-lg border border-border-subtle p-4',
                            isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                {isPremium ? 'Premium' : 'Free Tier'}
                              </div>
                              <div className="mt-1 font-aeonik-fono text-xs text-content-muted">
                                {isPremium
                                  ? 'You have access to all premium features'
                                  : 'Upgrade to unlock premium features'}
                              </div>
                            </div>
                            <div
                              className={cn(
                                'shrink-0 rounded-full px-3 py-1 text-xs font-medium',
                                isPremium
                                  ? 'bg-emerald-500/20 text-emerald-500'
                                  : 'bg-content-muted/20 text-content-muted',
                              )}
                            >
                              {isPremium ? 'Active' : 'Free'}
                            </div>
                          </div>
                          {!isPremium && (
                            <button
                              type="button"
                              onClick={() => {
                                void handleUpgradeToPro()
                              }}
                              disabled={upgradeLoading}
                              className={cn(
                                'mt-4 w-full rounded-md bg-brand-accent-dark px-4 py-3 text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90',
                                upgradeLoading &&
                                  'cursor-not-allowed opacity-70',
                              )}
                            >
                              {upgradeLoading
                                ? 'Redirecting…'
                                : 'Subscribe to Premium'}
                            </button>
                          )}
                        </div>

                        {isPremium && (
                          <button
                            onClick={() => {
                              void handleManageBilling()
                            }}
                            disabled={billingLoading}
                            className={cn(
                              'flex w-full items-start justify-between rounded-lg border border-border-subtle p-4 transition-colors hover:bg-surface-chat',
                              isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                              billingLoading && 'cursor-not-allowed opacity-70',
                            )}
                          >
                            <div className="text-left">
                              <div className="flex items-center gap-3">
                                <CreditCardIcon className="h-5 w-5 text-content-muted" />
                                <div className="font-aeonik text-sm font-medium text-content-primary">
                                  Manage Billing
                                </div>
                              </div>
                              <div className="mt-1 font-aeonik-fono text-xs text-content-muted">
                                Update payment method, view invoices
                              </div>
                            </div>
                            <div className="text-sm text-content-muted">
                              {billingLoading ? '...' : '→'}
                            </div>
                          </button>
                        )}

                        {upgradeError && (
                          <p className="text-xs text-destructive">
                            {upgradeError}
                          </p>
                        )}
                      </div>

                      {/* Account Management */}
                      <div className="space-y-3">
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          Account Management
                        </h3>
                        <a
                          href={DASHBOARD_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            'flex w-full items-start justify-between rounded-lg border border-border-subtle p-4 transition-colors hover:bg-surface-chat',
                            isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                          )}
                        >
                          <div className="text-left">
                            <div className="flex items-center gap-3">
                              <UserCircleIcon className="h-5 w-5 text-content-muted" />
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                Dashboard
                              </div>
                            </div>
                            <div className="mt-1 font-aeonik-fono text-xs text-content-muted">
                              Manage your account at dash.tinfoil.sh
                            </div>
                          </div>
                          <ArrowTopRightOnSquareIcon
                            className="h-4 w-4 text-content-muted"
                            aria-hidden="true"
                          />
                        </a>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-4">
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-6 text-center',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <UserCircleIcon className="mx-auto h-12 w-12 text-content-muted" />
                        <h3 className="mt-3 font-aeonik text-base font-medium text-content-primary">
                          Sign in to your account
                        </h3>
                        <p className="mt-1 text-sm text-content-muted">
                          Sign in to sync your settings and access premium
                          features
                        </p>
                        <Link
                          href="/signin"
                          className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90"
                        >
                          <PiSignIn className="h-4 w-4" />
                          Sign in or sign up
                        </Link>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Sign-out confirmation when local-only mode is enabled */}
      {showSignOutConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-card p-6 shadow-xl">
            <h3 className="font-aeonik text-lg font-medium text-content-primary">
              Sign Out
            </h3>
            <div className="mt-3 space-y-2 text-sm text-content-secondary">
              <p>
                {passkeyActive
                  ? 'All local data will be cleared. You can recover your cloud chats by signing back in.'
                  : 'All local data will be cleared. You will need your encryption key to recover your cloud chats.'}
              </p>
              <p className="font-medium text-orange-500">
                Your local chats will be deleted forever.
              </p>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setShowSignOutConfirm(false)}
                className={cn(
                  'flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors',
                  isDarkMode
                    ? 'border-border-strong bg-surface-chat text-content-primary hover:bg-surface-chat/80'
                    : 'border-border-subtle bg-white text-content-primary hover:bg-gray-50',
                )}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowSignOutConfirm(false)
                  void handleSignOut()
                }}
                disabled={isSigningOut}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-70',
                  isDarkMode
                    ? 'border-red-500/30 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                    : 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100',
                )}
              >
                {isSigningOut && (
                  <ArrowPathIcon className="h-4 w-4 animate-spin" />
                )}
                {isSigningOut ? 'Signing out...' : 'Sign Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={presetPendingDelete !== null}
        title="Delete prompt?"
        description={
          presetPendingDelete
            ? `"${presetPendingDelete.name}" will be permanently removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleConfirmDeletePreset}
        onCancel={() => setPresetPendingDelete(null)}
      />
    </div>
  )
}

type PresetRowProps = {
  preset: PromptPreset
  isDarkMode: boolean
  onEdit?: () => void
  onDuplicate: () => void
  onDelete?: () => void
}

function PresetRow({
  preset,
  isDarkMode,
  onEdit,
  onDuplicate,
  onDelete,
}: PresetRowProps) {
  const Icon = preset.Icon
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border-subtle p-3',
        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
      )}
    >
      <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-chat text-content-secondary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-content-primary">
          {preset.name}
        </span>
        {preset.description && (
          <span className="mt-0.5 line-clamp-2 text-xs text-content-secondary">
            {preset.description}
          </span>
        )}
      </div>
      <div className="flex flex-none items-center gap-1">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${preset.name}`}
            className="rounded-md p-1.5 text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
          >
            <PencilSquareIcon className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onDuplicate}
          aria-label={`Duplicate ${preset.name}`}
          className="rounded-md p-1.5 text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${preset.name}`}
            className="rounded-md p-1.5 text-red-500 transition-colors hover:bg-red-500/10"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
