import { TextureGrid } from '@/components/texture-grid'
import { cn } from '@/components/ui/utils'
import { UserAvatar } from '@/components/user-avatar'
import { API_BASE_URL } from '@/config'
import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  SETTINGS_MAX_PROMPT_MESSAGES,
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
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { cloudSync } from '@/services/cloud/cloud-sync'
import { projectStorage } from '@/services/cloud/project-storage'
import { encryptionService } from '@/services/encryption/encryption-service'
import { PrfNotSupportedError } from '@/services/passkey'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { TINFOIL_COLORS } from '@/theme/colors'
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
import { logError, logInfo } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { SignInButton, useAuth, useUser } from '@clerk/nextjs'
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
  SparklesIcon,
  SunIcon,
  UserCircleIcon,
  UserIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AiOutlineCloudSync,
  AiOutlineExport,
  AiOutlineImport,
} from 'react-icons/ai'
import { BsQrCode } from 'react-icons/bs'
import { GoPasskeyFill } from 'react-icons/go'
import { HiOutlineAdjustmentsVertical } from 'react-icons/hi2'
import { IoShieldCheckmark } from 'react-icons/io5'
import { PiSignIn } from 'react-icons/pi'
import { RiLightbulbFill, RiShieldKeyholeFill } from 'react-icons/ri'
import QRCode from 'react-qr-code'
import { CONSTANTS } from './constants'
import { normalizeChatFont, type ChatFont } from './hooks/use-chat-font'
import type { Chat } from './types'

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
  | 'cloud-sync'
  | 'import'
  | 'export'
  | 'account'

import type { ThemeMode } from './hooks/use-ui-state'

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
  onKeyChange: (
    key: string,
    options?: { mode?: 'recoverExisting' | 'explicitStartFresh' },
  ) => Promise<void>
  onAddRecoveryKey: (key: string) => Promise<void>
  passkeyActive?: boolean
  passkeySetupAvailable?: boolean
  onSetupPasskey?: () => Promise<boolean>
  initialTab?: SettingsTab
  chats?: Chat[]
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
  onKeyChange,
  onAddRecoveryKey,
  passkeyActive,
  passkeySetupAvailable,
  onSetupPasskey,
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
  const [maxMessages, setMaxMessages] = useState<number>(
    CONSTANTS.MAX_PROMPT_MESSAGES,
  )

  // Encryption key management state
  const [inputKey, setInputKey] = useState('')
  const [isInputKeyVisible, setIsInputKeyVisible] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isQRCodeExpanded, setIsQRCodeExpanded] = useState(false)
  const [isKeyVisible, setIsKeyVisible] = useState(false)
  const [isSettingUpPasskey, setIsSettingUpPasskey] = useState(false)
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [isHowItWorksOpen, setIsHowItWorksOpen] = useState(false)
  const [isEncryptionKeyOpen, setIsEncryptionKeyOpen] = useState(false)
  const [primaryKeyMode, setPrimaryKeyMode] = useState<
    'recoverExisting' | 'explicitStartFresh'
  >('recoverExisting')
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Structured personalization fields
  const [nickname, setNickname] = useState<string>('')
  const [profession, setProfession] = useState<string>('')
  const [selectedTraits, setSelectedTraits] = useState<string[]>([])
  const [additionalContext, setAdditionalContext] = useState<string>('')
  const [isUsingPersonalization, setIsUsingPersonalization] =
    useState<boolean>(true)

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

  // Chat font setting
  const [chatFont, setChatFont] = useState<ChatFont>('system')

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

  // Advanced settings collapsed state
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false)
  const [dangerZoneOpen, setDangerZoneOpen] = useState(false)

  // Placeholder animation state
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [placeholderVisible, setPlaceholderVisible] = useState(true)

  // Upgrade state
  const [upgradeLoading, setUpgradeLoading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)

  // Import state
  const [importSource, setImportSource] = useState<'chatgpt' | 'claude' | null>(
    null,
  )
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
  } | null>(null)
  const chatGptFileInputRef = useRef<HTMLInputElement>(null)
  const claudeConversationsFileInputRef = useRef<HTMLInputElement>(null)
  const claudeProjectsFileInputRef = useRef<HTMLInputElement>(null)

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
    // Load max messages setting
    const savedMaxMessages = localStorage.getItem(SETTINGS_MAX_PROMPT_MESSAGES)
    if (savedMaxMessages) {
      const parsedValue = parseInt(savedMaxMessages, 10)
      if (
        !isNaN(parsedValue) &&
        parsedValue > 0 &&
        parsedValue <= CONSTANTS.MAX_PROMPT_MESSAGES_LIMIT
      ) {
        setMaxMessages(parsedValue)
      }
    }

    // Load personalization settings
    const savedNickname = localStorage.getItem(USER_PREFS_NICKNAME)
    const savedProfession = localStorage.getItem(USER_PREFS_PROFESSION)
    const savedTraits = localStorage.getItem(USER_PREFS_TRAITS)
    const savedContext = localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT)
    const savedUsingPersonalization = localStorage.getItem(
      USER_PREFS_PERSONALIZATION_ENABLED,
    )

    if (savedNickname !== null) setNickname(savedNickname)
    if (savedProfession !== null) setProfession(savedProfession)
    if (savedTraits) {
      try {
        setSelectedTraits(JSON.parse(savedTraits))
      } catch {
        setSelectedTraits([])
      }
    }
    if (savedContext !== null) setAdditionalContext(savedContext)
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
    window.addEventListener('maxPromptMessagesChanged', handleProfileSyncUpdate)
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
        'maxPromptMessagesChanged',
        handleProfileSyncUpdate,
      )
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

  // Save max messages setting to localStorage
  const handleMaxMessagesChange = (value: number) => {
    if (value > 0 && value <= CONSTANTS.MAX_PROMPT_MESSAGES_LIMIT) {
      setMaxMessages(value)
      if (isClient) {
        localStorage.setItem(SETTINGS_MAX_PROMPT_MESSAGES, value.toString())
        // Trigger a custom event to notify other components
        window.dispatchEvent(
          new CustomEvent('maxPromptMessagesChanged', {
            detail: value,
          }),
        )
      }
    }
  }

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

  // Handle individual field changes
  const handleNicknameChange = (value: string) => {
    setNickname(value)
    if (isClient) {
      savePersonalizationSettings({ nickname: value })
    }
  }

  const handleProfessionChange = (value: string) => {
    setProfession(value)
    if (isClient) {
      savePersonalizationSettings({ profession: value })
    }
  }

  const handleTraitToggle = (trait: string) => {
    const newTraits = selectedTraits.includes(trait)
      ? selectedTraits.filter((t) => t !== trait)
      : [...selectedTraits, trait]
    setSelectedTraits(newTraits)
    if (isClient) {
      savePersonalizationSettings({ traits: newTraits })
    }
  }

  const handleContextChange = (value: string) => {
    setAdditionalContext(value)
    if (isClient) {
      savePersonalizationSettings({ additionalContext: value })
    }
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
      savePersonalizationSettings({ isEnabled: enabled })
    }
  }

  const handleResetPersonalization = () => {
    setNickname('')
    setProfession('')
    setSelectedTraits([])
    setAdditionalContext('')
    setLanguage('English')

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
    try {
      await signOut()
    } catch (error) {
      logError('Sign out failed', error, {
        component: 'SettingsModal',
        action: 'handleSignOut',
      })
    } finally {
      // Always reset the flag so the button is re-enabled — on success
      // the component typically unmounts before this matters, and on
      // failure the user can retry instead of being stuck on a
      // permanently-disabled control.
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

  const handleImportChatGPT = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return

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

  const handleImportClaudeConversations = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return

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
      const { projectStorage } = await import(
        '@/services/cloud/project-storage'
      )

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
      // Convert chats to Claude-compatible format
      const conversations = chatsToExport.map((chat) => ({
        uuid: chat.id,
        name: chat.title,
        created_at: new Date(chat.createdAt).toISOString(),
        updated_at: new Date(chat.createdAt).toISOString(),
        chat_messages: chat.messages.map((message, index) => ({
          uuid: `${chat.id}_msg_${index}`,
          text: message.content,
          sender: message.role === 'user' ? 'human' : 'assistant',
          created_at: new Date(message.timestamp).toISOString(),
          ...(message.thoughts
            ? {
                content: [
                  {
                    type: 'thinking',
                    thinking: message.thoughts,
                  },
                ],
              }
            : {}),
        })),
      }))

      // Create and download JSON file
      const jsonContent = JSON.stringify(conversations, null, 2)
      const blob = new Blob([jsonContent], { type: 'application/json' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'conversations.json'
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

      const localChats = isSignedIn
        ? await chatStorage.getAllChats()
        : sessionChatStorage.getAllChats()
      localChats.forEach(addChat)

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
        const total = result.localDeleted + result.cloudDeleted
        toast({
          title: 'All chats deleted',
          description: `Removed ${total} chat${total !== 1 ? 's' : ''} from this device${result.cloudDeleted > 0 ? ' and the cloud' : ''}.`,
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
        description: `Removed ${result.deleted} project${result.deleted !== 1 ? 's' : ''}.`,
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
      setPrimaryKeyMode('recoverExisting')
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

  const handleKeyAction = async (
    action: (key: string) => Promise<void>,
    successTitle: string,
    successDescription: string,
  ) => {
    if (!inputKey.trim()) {
      toast({
        title: 'Invalid key',
        description: 'Please enter a valid encryption key',
        variant: 'destructive',
      })
      return
    }

    setIsUpdating(true)
    try {
      await action(inputKey)
      toast({ title: successTitle, description: successDescription })
      setInputKey('')
    } catch (error) {
      toast({
        title: 'Invalid key',
        description:
          error instanceof Error
            ? error.message
            : 'The encryption key you entered is invalid',
        variant: 'destructive',
      })
    } finally {
      setIsUpdating(false)
    }
  }

  const handleUpdateKey = () =>
    handleKeyAction(
      (key) => onKeyChange(key, { mode: primaryKeyMode }),
      primaryKeyMode === 'recoverExisting'
        ? 'Primary key verified'
        : 'Primary key replaced',
      primaryKeyMode === 'recoverExisting'
        ? 'This device verified the key against your existing cloud data'
        : 'Future cloud writes will use the new primary key on this device',
    )

  const handleAddRecoveryKey = () =>
    handleKeyAction(
      onAddRecoveryKey,
      'Recovery key added',
      'Older encrypted data can now be retried with this key',
    )

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

  const extractKeyFromPEM = (pemContent: string): string | null => {
    const lines = pemContent.split('\n')
    const startIndex = lines.findIndex((line) =>
      line.includes('BEGIN TINFOIL CHAT ENCRYPTION KEY'),
    )
    const endIndex = lines.findIndex((line) =>
      line.includes('END TINFOIL CHAT ENCRYPTION KEY'),
    )

    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
      const keyLines = lines.slice(startIndex + 1, endIndex)
      const keyContent = keyLines.join('').trim()
      return keyContent ? `key_${keyContent}` : null
    }

    return null
  }

  const handleFileImport = useCallback(
    async (file: File) => {
      try {
        const content = await file.text()
        const extractedKey = extractKeyFromPEM(content)

        if (extractedKey) {
          setInputKey(extractedKey)
        } else {
          toast({
            title: 'Invalid file',
            description: 'Could not extract encryption key from the PEM file',
            variant: 'destructive',
          })
        }
      } catch {
        toast({
          title: 'Import failed',
          description: 'Failed to read the PEM file',
          variant: 'destructive',
        })
      }
    },
    [toast],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)

      const files = Array.from(e.dataTransfer.files)
      const pemFile = files.find((file) => file.name.endsWith('.pem'))

      if (pemFile) {
        await handleFileImport(pemFile)
      } else {
        toast({
          title: 'Invalid file',
          description: 'Please drop a .pem file',
          variant: 'destructive',
        })
      }
    },
    [handleFileImport, toast],
  )

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
    ...(isSignedIn
      ? [
          {
            id: 'cloud-sync' as const,
            label: 'Cloud Sync',
            icon: AiOutlineCloudSync,
          },
        ]
      : []),
    {
      id: 'import' as const,
      label: 'Import Chats',
      icon: AiOutlineImport,
    },
    {
      id: 'export' as const,
      label: 'Export Chats',
      icon: AiOutlineExport,
    },
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
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
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
          <div className="hidden h-14 items-center border-b border-border-subtle px-6 md:flex">
            <h2 className="font-aeonik text-lg font-semibold text-content-primary">
              {navItems.find((item) => item.id === activeTab)?.label}
            </h2>
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
                      <div className="grid grid-cols-4 gap-2">
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
                    {/* Messages in Context */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="mr-3 flex-1">
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Messages in Context
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            Maximum number of recent messages sent to the model
                            (1-
                            {CONSTANTS.MAX_PROMPT_MESSAGES_LIMIT}). Longer
                            contexts increase network usage and slow down
                            responses.
                          </div>
                        </div>
                        <input
                          type="number"
                          min="1"
                          max={CONSTANTS.MAX_PROMPT_MESSAGES_LIMIT}
                          value={maxMessages}
                          onChange={(e) => {
                            const value = parseInt(e.target.value, 10)
                            if (!isNaN(value)) {
                              handleMaxMessagesChange(value)
                            }
                          }}
                          className={cn(
                            'w-16 rounded-md border px-2 py-1 text-center text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500',
                            isDarkMode
                              ? 'border-border-strong bg-surface-chat text-content-secondary'
                              : 'border-border-subtle bg-surface-sidebar text-content-primary',
                          )}
                        />
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
                    <button
                      onClick={() =>
                        setAdvancedSettingsOpen(!advancedSettingsOpen)
                      }
                      className="flex w-full items-center justify-between"
                    >
                      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                        Advanced Settings
                      </h3>
                      <ChevronDownIcon
                        className={cn(
                          'h-4 w-4 text-content-muted transition-transform',
                          advancedSettingsOpen && 'rotate-180',
                        )}
                      />
                    </button>

                    {advancedSettingsOpen && (
                      <div className="space-y-4">
                        {/* Custom System Prompt */}
                        <div
                          className={cn(
                            'rounded-lg border border-border-subtle p-4',
                            isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                          )}
                        >
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                Custom System Prompt
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
                                <div className="font-aeonik-fono text-xs text-content-muted">
                                  Override the default system prompt to
                                  customize how Tin behaves.
                                </div>
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
                                      new CustomEvent(
                                        'piiCheckEnabledChanged',
                                        {
                                          detail: { enabled: newValue },
                                        },
                                      ),
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
                    )}
                  </div>

                  {/* Danger Zone */}
                  <div className="space-y-3">
                    <button
                      onClick={() => setDangerZoneOpen(!dangerZoneOpen)}
                      className="flex w-full items-center justify-between"
                    >
                      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                        Danger Zone
                      </h3>
                      <ChevronDownIcon
                        className={cn(
                          'h-4 w-4 text-content-muted transition-transform',
                          dangerZoneOpen && 'rotate-180',
                        )}
                      />
                    </button>

                    {dangerZoneOpen && (
                      <>
                        {/* Delete all saved chats */}
                        <div
                          className={cn(
                            'rounded-lg border p-4',
                            isDarkMode
                              ? 'border-red-500/30 bg-red-950/10'
                              : 'border-red-200 bg-red-50/50',
                          )}
                        >
                          <div className="space-y-3">
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
                            {showDeleteAllChatsConfirm ? (
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
                                      setDeleteAllChatsConfirmText(
                                        e.target.value,
                                      )
                                    }
                                    disabled={isDeletingAllChats}
                                    placeholder={
                                      DELETE_ALL_CHATS_CONFIRM_PHRASE
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
                                    onClick={handleDeleteAllChats}
                                    disabled={
                                      isDeletingAllChats ||
                                      deleteAllChatsConfirmText
                                        .trim()
                                        .toLowerCase() !==
                                        DELETE_ALL_CHATS_CONFIRM_PHRASE
                                    }
                                    className={cn(
                                      'flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                      isDarkMode
                                        ? 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-900 disabled:text-red-300'
                                        : 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:text-white/70',
                                    )}
                                  >
                                    {isDeletingAllChats
                                      ? 'Deleting…'
                                      : 'Yes, delete all my chats'}
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
                            ) : (
                              <button
                                onClick={() =>
                                  setShowDeleteAllChatsConfirm(true)
                                }
                                className={cn(
                                  'w-full rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                                  isDarkMode
                                    ? 'border-red-500/40 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                                    : 'border-red-300 bg-white text-red-600 hover:bg-red-100',
                                )}
                              >
                                Delete all saved chats
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Delete all projects (signed-in premium users only) */}
                        {isSignedIn && isPremium && (
                          <div
                            className={cn(
                              'rounded-lg border p-4',
                              isDarkMode
                                ? 'border-red-500/30 bg-red-950/10'
                                : 'border-red-200 bg-red-50/50',
                            )}
                          >
                            <div className="space-y-3">
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
                              {showDeleteAllProjectsConfirm ? (
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
                                        'flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                        isDarkMode
                                          ? 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-900 disabled:text-red-300'
                                          : 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:text-white/70',
                                      )}
                                    >
                                      {isDeletingAllProjects
                                        ? 'Deleting…'
                                        : 'Yes, delete all my projects'}
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
                              ) : (
                                <button
                                  onClick={() =>
                                    setShowDeleteAllProjectsConfirm(true)
                                  }
                                  className={cn(
                                    'w-full rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                                    isDarkMode
                                      ? 'border-red-500/40 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                                      : 'border-red-300 bg-white text-red-600 hover:bg-red-100',
                                  )}
                                >
                                  Delete all projects
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}

              {/* Personalization Tab */}
              {activeTab === 'personalization' && (
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
                        onChange={(e) => handleNicknameChange(e.target.value)}
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
                              placeholderVisible ? 'opacity-100' : 'opacity-0',
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
                        onChange={(e) => handleContextChange(e.target.value)}
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
                      onClick={() => setIsHowItWorksOpen(!isHowItWorksOpen)}
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
                          'h-4 w-4 text-content-muted transition-transform duration-200',
                          isHowItWorksOpen && 'rotate-180',
                        )}
                      />
                    </button>
                    {isHowItWorksOpen && (
                      <div className="space-y-3 border-t border-border-subtle p-4">
                        <div className="flex items-start gap-3">
                          <div className={STEP_CIRCLE_CLASSES}>1</div>
                          <div className="font-aeonik-fono text-sm text-content-muted">
                            Your chats are encrypted on your device before being
                            sent to the cloud.
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
                  </div>

                  {/* Your Personal Encryption Key - Collapsible */}
                  {cloudSyncEnabled && (
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setIsEncryptionKeyOpen(!isEncryptionKeyOpen)
                        }
                        className="flex w-full items-center justify-between p-4"
                      >
                        <div className="flex items-center gap-2">
                          <RiShieldKeyholeFill className="h-4 w-4 text-content-muted" />
                          <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                            Your Personal Encryption Key
                          </h3>
                        </div>
                        <ChevronDownIcon
                          className={cn(
                            'h-4 w-4 text-content-muted transition-transform duration-200',
                            isEncryptionKeyOpen && 'rotate-180',
                          )}
                        />
                      </button>
                      {isEncryptionKeyOpen && (
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

                          {/* Restore or Update Encryption Key */}
                          <div className="space-y-2 pt-2">
                            <h4 className="font-aeonik text-xs font-medium text-content-secondary">
                              {passkeyActive
                                ? 'Add Decryption Key'
                                : 'Recovery and Primary Keys'}
                            </h4>
                            <p className="text-xs text-content-muted">
                              {passkeyActive
                                ? 'Add an older key to decrypt data from before a key rotation. Your passkey manages the primary key.'
                                : 'Add a recovery key to decrypt older data without changing your current primary key, or replace the primary key used for future cloud writes.'}
                            </p>
                            {!passkeyActive && (
                              <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-chat p-3">
                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setPrimaryKeyMode('recoverExisting')
                                    }
                                    className={cn(
                                      'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                                      primaryKeyMode === 'recoverExisting'
                                        ? 'border border-blue-500 bg-blue-500/10 text-blue-500'
                                        : 'border border-border-subtle bg-surface-input text-content-secondary hover:text-content-primary',
                                    )}
                                  >
                                    Recover Existing
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setPrimaryKeyMode('explicitStartFresh')
                                    }
                                    className={cn(
                                      'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                                      primaryKeyMode === 'explicitStartFresh'
                                        ? 'border border-amber-500 bg-amber-500/10 text-amber-500'
                                        : 'border border-border-subtle bg-surface-input text-content-secondary hover:text-content-primary',
                                    )}
                                  >
                                    Start Fresh
                                  </button>
                                </div>
                                <p className="text-xs text-content-muted">
                                  {primaryKeyMode === 'recoverExisting'
                                    ? 'Verify this key against your existing cloud data before this device resumes writing.'
                                    : 'Use this key for future cloud writes on this device without validating it against older cloud data.'}
                                </p>
                              </div>
                            )}
                            <form
                              onSubmit={(e) => {
                                e.preventDefault()
                                if (!isUpdating && inputKey.trim()) {
                                  if (passkeyActive) {
                                    handleAddRecoveryKey()
                                  } else {
                                    handleUpdateKey()
                                  }
                                }
                              }}
                              onDragOver={handleDragOver}
                              onDragLeave={handleDragLeave}
                              onDrop={handleDrop}
                              className="space-y-2"
                              id="encryption-key-form"
                            >
                              <div className="flex gap-2">
                                <div className="relative flex-1">
                                  <input
                                    type="text"
                                    style={
                                      isInputKeyVisible
                                        ? undefined
                                        : ({
                                            WebkitTextSecurity: 'disc',
                                          } as React.CSSProperties)
                                    }
                                    name="encryption-key"
                                    value={inputKey}
                                    onChange={(e) =>
                                      setInputKey(e.target.value)
                                    }
                                    placeholder={
                                      isDragging
                                        ? ''
                                        : 'Enter key (e.g., key_abc123...)'
                                    }
                                    autoComplete="off"
                                    aria-label="Encryption key input"
                                    className={cn(
                                      'w-full rounded-lg border border-blue-500 bg-surface-input px-3 py-2 pr-9 font-mono text-sm text-blue-500 placeholder:font-sans placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-blue-500',
                                      isDragging && 'ring-2 ring-blue-500',
                                    )}
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setIsInputKeyVisible(!isInputKeyVisible)
                                    }
                                    aria-label={
                                      isInputKeyVisible
                                        ? 'Hide key'
                                        : 'Show key'
                                    }
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-content-muted transition-all hover:text-content-primary"
                                  >
                                    {isInputKeyVisible ? (
                                      <EyeSlashIcon className="h-4 w-4" />
                                    ) : (
                                      <EyeIcon className="h-4 w-4" />
                                    )}
                                  </button>
                                  {isDragging && (
                                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-blue-500/10">
                                      <span className="text-sm text-blue-500">
                                        Drop your PEM file here
                                      </span>
                                    </div>
                                  )}
                                </div>
                                {passkeyActive ? (
                                  <button
                                    type="submit"
                                    disabled={isUpdating || !inputKey.trim()}
                                    aria-label="Add decryption key"
                                    className={cn(
                                      'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                      isUpdating || !inputKey.trim()
                                        ? 'cursor-not-allowed bg-surface-chat text-content-muted'
                                        : 'bg-blue-500 text-white hover:bg-blue-600',
                                    )}
                                  >
                                    {isUpdating ? 'Saving...' : 'Add Key'}
                                  </button>
                                ) : (
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={handleAddRecoveryKey}
                                      disabled={isUpdating || !inputKey.trim()}
                                      aria-label="Add recovery key"
                                      className={cn(
                                        'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                        isUpdating || !inputKey.trim()
                                          ? 'cursor-not-allowed bg-surface-chat text-content-muted'
                                          : 'border border-border-subtle bg-surface-chat text-content-primary hover:bg-surface-chat/80',
                                      )}
                                    >
                                      {isUpdating
                                        ? 'Saving...'
                                        : 'Add Recovery'}
                                    </button>
                                    <button
                                      type="submit"
                                      disabled={isUpdating || !inputKey.trim()}
                                      aria-label="Replace primary encryption key"
                                      className={cn(
                                        'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                        isUpdating || !inputKey.trim()
                                          ? 'cursor-not-allowed bg-surface-chat text-content-muted'
                                          : primaryKeyMode ===
                                              'explicitStartFresh'
                                            ? 'bg-amber-500 text-white hover:bg-amber-600'
                                            : 'bg-blue-500 text-white hover:bg-blue-600',
                                      )}
                                    >
                                      {isUpdating
                                        ? 'Saving...'
                                        : primaryKeyMode === 'recoverExisting'
                                          ? 'Recover Existing'
                                          : 'Start Fresh'}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </form>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Passkey Section */}
                  {cloudSyncEnabled &&
                    (passkeyActive ||
                      (passkeySetupAvailable && onSetupPasskey)) && (
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
                </>
              )}

              {/* Import Tab */}
              {activeTab === 'import' && (
                <>
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
                              {importResult.success
                                ? 'Import complete'
                                : 'Import completed with errors'}
                            </div>
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
                          Download and unzip the file you receive by email.
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
                          Select{' '}
                          <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                            conversations.json
                          </code>{' '}
                          from the unzipped folder.
                        </div>
                      </div>
                      <input
                        ref={chatGptFileInputRef}
                        type="file"
                        accept=".json"
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
                          Download and unzip the file you receive by email.
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
                          Select{' '}
                          <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                            conversations.json
                          </code>{' '}
                          or{' '}
                          <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                            projects.json
                          </code>{' '}
                          from the unzipped folder.
                        </div>
                      </div>
                      <input
                        ref={claudeConversationsFileInputRef}
                        type="file"
                        accept=".json"
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
                              Pro
                            </span>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Export Tab */}
              {activeTab === 'export' && (
                <>
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

                  {/* Export Projects */}
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
                      {!isPremium ? (
                        <div className="flex items-center gap-2 rounded-lg border border-brand-accent-light/30 bg-brand-accent-light/10 px-3 py-2">
                          <span className="text-xs text-content-muted">
                            Projects are a premium feature.
                          </span>
                          <span className="rounded-full bg-brand-accent-light/20 px-1.5 py-px text-[10px] font-medium text-brand-accent-light">
                            Pro
                          </span>
                        </div>
                      ) : (
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
                      )}
                    </div>
                  </div>
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
                              <div className="flex items-center gap-3">
                                <SparklesIcon className="h-5 w-5 text-content-muted" />
                                <div className="font-aeonik text-sm font-medium text-content-primary">
                                  {isPremium ? 'Premium' : 'Free Tier'}
                                </div>
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
                        </div>

                        {isPremium ? (
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
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              void handleUpgradeToPro()
                            }}
                            disabled={upgradeLoading}
                            className={cn(
                              'w-full rounded-md bg-brand-accent-dark px-4 py-3 text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90',
                              upgradeLoading && 'cursor-not-allowed opacity-70',
                            )}
                          >
                            {upgradeLoading
                              ? 'Redirecting…'
                              : 'Subscribe to Premium'}
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
                        <SignInButton mode="modal">
                          <button className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90">
                            <PiSignIn className="h-4 w-4" />
                            Sign in or sign up
                          </button>
                        </SignInButton>
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
    </div>
  )
}
