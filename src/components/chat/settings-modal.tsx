import { TextureGrid } from '@/components/texture-grid'
import { cn } from '@/components/ui/utils'
import { UserAvatar } from '@/components/user-avatar'
import { API_BASE_URL } from '@/config'
import {
  DASHBOARD_URL,
  PRIVACY_POLICY_URL,
  TERMS_URL,
} from '@/constants/external-links'
import type { SettingsTab } from '@/constants/settings-tabs'
import { useProjects } from '@/hooks/use-projects'
import { useToast } from '@/hooks/use-toast'
import { authTokenManager } from '@/services/auth'
import {
  buildChatExport,
  type AttachmentBytesFetcher,
} from '@/services/chat-export/export-archive'
import { collectChatExport } from '@/services/chat-export/export-chats'
import { isZipFile, readExportFiles } from '@/services/chat-import/export-files'
import { describeImportFailure } from '@/services/chat-import/import-failure-copy'
import {
  parseLocalTinfoilExportForAccess,
  PremiumProjectImportRequiredError,
} from '@/services/chat-import/local-tinfoil-import'
import {
  exportArchive,
  ImportSequenceError,
  importStatus,
  runImports,
  type ImportSequenceResult,
  type ImportStatusResponse,
} from '@/services/harness/archives'
import {
  importedLocalThread,
  localThreadStore,
} from '@/services/harness/local-threads'
import { useHarness } from '@/services/harness/provider'
import { reportHarnessError } from '@/services/harness/runtime'
import {
  useCloudSyncSetting,
  useLocalChatsSetting,
} from '@/services/harness/storage-mode'
import { validateCurrentPrimaryKey } from '@/services/keys/cloud-key-preflight'
import {
  deletePasskeyCredential,
  getLocalPasskeyCredentialId,
  loadPasskeyCredentials,
  PrfNotSupportedError,
  type PasskeyCredentialEntry,
} from '@/services/passkey'
import { TINFOIL_COLORS } from '@/theme/colors'
import {
  clearExplicitSignoutIntent,
  requestExplicitSignout,
} from '@/utils/auth-signout-intent'
import {
  parseChatGPTConversations,
  parseClaudeConversations,
  type ChatGPTConversation,
  type ClaudeConversation,
} from '@/utils/chat-import-parsers'
import {
  recordCloudSyncPreference,
  setLocalOnlyModeEnabled,
} from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { formatFileSize } from '@/utils/format-file-size'
import { clearPersonalizationDetails } from '@/utils/personalization-settings'
import {
  RESPONSE_LANGUAGES,
  SYSTEM_RESPONSE_LANGUAGE,
} from '@/utils/response-language'
import { generateReverseId } from '@/utils/reverse-id'
import {
  hideSignoutProgress,
  showSignoutProgress,
} from '@/utils/signout-progress'
import { useAuth, useUser } from '@clerk/react'
import { Dialog } from '@headlessui/react'
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import {
  TfAdjustmentToggle,
  TfBoxCheckmark,
  TfBoxX,
  TfCard,
  TfChat2,
  TfChevronDown,
  TfChevronRight,
  TfCloudSync,
  TfComputer,
  TfDownload,
  TfExternalLink,
  TfEye,
  TfEyeSlash,
  TfKey,
  TfLightbulb,
  TfMoon,
  TfNumber1,
  TfNumber2,
  TfNumber3,
  TfNumber4,
  TfPerson,
  TfPersonKey,
  TfPlus,
  TfShieldCheck,
  TfShieldWithExclamation,
  TfSignIn,
  TfStack,
  TfSunLightMode,
  TfTools,
  TfTrash,
} from '@tinfoilsh/tinfoil-icons'
import { AnimatePresence, motion } from 'framer-motion'
import Link from 'next/link'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { BsQrCode } from 'react-icons/bs'
import { PiSpinner } from 'react-icons/pi'
import QRCode from 'react-qr-code'
import { CONSTANTS } from './constants'
import { normalizeChatFont, type ChatFont } from './hooks/use-chat-font'
import { usePromptLibrary } from './hooks/use-prompt-library'
import { ImportFileList } from './import-file-list'
import { MfaSettingsCard } from './mfa-settings-card'
import { NativeBackupExport } from './native-backup-export'
import { NativeBackupRestore } from './native-backup-restore'
import { SafeguardsSettings } from './safeguards-settings'
import {
  canDeleteAllProjects,
  canTransferProjectData,
  countExcludedProjectChats,
  filterExportableChats,
} from './settings-project-policy'
import type { Chat } from './types'

const CHARS = '0123456789ABCDEF!@#$%^&*()_+<>?/'

const DELETE_ALL_CHATS_CONFIRM_PHRASE = 'delete all chats'
const DELETE_ALL_PROJECTS_CONFIRM_PHRASE = 'delete all projects'

interface ImportResult {
  jobId?: string
  success: boolean
  chatsImported: number
  projectsImported: number
  errors: string[]
  pending?: boolean
  /** The enclave job ended without completing (distinct from per-chat errors). */
  failed?: boolean
  message?: string
}

/**
 * Turns the enclave's kickoff snapshot into the panel state and toast
 * copy. The job normally reports staging/running here and finishes off
 * device, but a job that has already failed must not be announced as
 * started.
 */
export function describeOffDeviceImportKickoff(
  status: ImportStatusResponse,
  sourceLabel: string,
): ImportResult {
  const pending = status.status === 'staging' || status.status === 'running'
  const failed = status.status === 'failed'
  return {
    jobId: status.jobId,
    success: !failed,
    chatsImported: status.imported,
    projectsImported: 0,
    errors: status.errors ?? [],
    pending,
    failed,
    message: failed
      ? describeImportFailure(
          status.failureReason ?? status.failure_reason,
          'chat_import',
          status.failureDetail ?? status.failure_detail,
        )
      : pending
        ? `Your ${sourceLabel} export is being imported securely. We'll email you when it's done.`
        : undefined,
  }
}

/**
 * Turns the outcome of an import, possibly split across several files,
 * into the panel state. Chats from files that already completed are
 * counted, and a failure names its file and how many files were never
 * started.
 */
export function describeOffDeviceImportOutcome(
  outcome: ImportSequenceResult,
  fileNames: readonly string[],
  sourceLabel: string,
): ImportResult {
  const kickoff = describeOffDeviceImportKickoff(outcome.status, sourceLabel)
  const chatsImported = outcome.importedBefore + kickoff.chatsImported
  if (!outcome.interrupted && !kickoff.failed) {
    return { ...kickoff, chatsImported }
  }
  const explanation = outcome.interrupted
    ? 'The import stopped before it finished. Chats already imported were kept; select this file again to continue.'
    : kickoff.message
  return {
    success: false,
    failed: true,
    pending: false,
    chatsImported,
    projectsImported: 0,
    errors: fileFailureErrors(fileNames, outcome.fileIndex, explanation),
  }
}

/**
 * Panel state for an import that threw. When a later file of a split
 * export fails, the chats earlier files imported are still counted and
 * the failing file is named.
 */
export function describeOffDeviceImportError(
  err: unknown,
  fileNames: readonly string[],
): ImportResult {
  const message = err instanceof Error ? err.message : 'Failed to start import'
  if (!(err instanceof ImportSequenceError) || fileNames.length < 2) {
    return {
      success: false,
      chatsImported: 0,
      projectsImported: 0,
      errors: [message],
    }
  }
  return {
    success: false,
    chatsImported: err.importedBefore,
    projectsImported: 0,
    errors: fileFailureErrors(fileNames, err.fileIndex, message),
  }
}

function fileFailureErrors(
  fileNames: readonly string[],
  fileIndex: number,
  explanation: string | undefined,
): string[] {
  const errors = [`${fileNames[fileIndex]}: ${explanation}`]
  const notStarted = fileNames.length - fileIndex - 1
  if (notStarted > 0) {
    errors.push(
      `${notStarted} remaining file${notStarted === 1 ? ' was' : 's were'} not imported.`,
    )
  }
  return errors
}

// The chat service receives each file of an export in one request, so an
// upload advances a file at a time. An import on this device counts the
// chats it stores.
export type ImportProgress =
  | { type: 'chats'; current: number; total: number }
  | {
      type: 'upload'
      file: number
      files: number
      uploadedBytes: number
      totalBytes: number
    }
  | {
      type: 'processing'
      file: number
      files: number
      imported: number
      total: number
    }

export function describeImportProgress(progress: ImportProgress): {
  title: string
  detail: string
  percent: number
} {
  if (progress.type === 'processing') {
    const { file, files, imported, total } = progress
    return {
      title: `Importing file ${file} of ${files}...`,
      detail: `${total > 0 ? `${imported} of ${total} chats` : 'Reading export'}. Keep this page open until every file has started.`,
      percent: total > 0 ? (imported / total) * 100 : 0,
    }
  }
  if (progress.type === 'chats') {
    return {
      title: `Importing ${progress.type}...`,
      detail: `${progress.current} of ${progress.total}`,
      percent:
        progress.total > 0 ? (progress.current / progress.total) * 100 : 0,
    }
  }
  const { file, files, uploadedBytes, totalBytes } = progress
  return {
    title:
      files > 1
        ? `Uploading file ${file} of ${files}...`
        : 'Uploading export...',
    detail:
      files > 1
        ? `${formatFileSize(uploadedBytes)} of ${formatFileSize(totalBytes)} uploaded`
        : formatFileSize(totalBytes),
    percent: totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0,
  }
}

export function importResultTitle(result: ImportResult): string {
  if (result.pending) return 'Import in progress'
  if (result.success) return 'Import complete'
  if (result.failed) return 'Import failed'
  return 'Import completed with errors'
}

export function getDeleteAllChatsSuccessTitle(
  isSignedIn: boolean,
  cloudDeletionCompleted: boolean,
): string {
  return isSignedIn && !cloudDeletionCompleted
    ? 'Chats deleted from this device'
    : 'All chats deleted'
}

export function getDeleteAllChatsSuccessDescription(
  isSignedIn: boolean,
  cloudDeletionCompleted: boolean,
): string {
  if (cloudDeletionCompleted) {
    return 'Removed all chats from this device and encrypted cloud storage.'
  }
  return isSignedIn
    ? 'Removed all chats from this device. Encrypted cloud storage was not cleared.'
    : 'Removed all chats from this browser session.'
}

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

const STEP_ICONS = {
  1: TfNumber1,
  2: TfNumber2,
  3: TfNumber3,
  4: TfNumber4,
} as const

function StepNumber({ step }: { step: keyof typeof STEP_ICONS }) {
  const Icon = STEP_ICONS[step]

  return (
    <>
      <Icon
        className="mt-1 h-3 w-3 shrink-0 text-content-secondary"
        aria-hidden="true"
      />
      <span className="sr-only">Step {step}:</span>
    </>
  )
}

type ImportSection = 'chatgpt' | 'claude' | 'tinfoil'
type StagedImportKind = 'chatgpt' | 'claude-conversations' | 'claude-projects'
type ImportSourceKey = 'chatgpt' | 'claude'

function ImportAccordionHeader({
  title,
  panelId,
  expanded,
  onToggle,
}: {
  title: string
  panelId: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <h3>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center justify-between p-4 text-left"
      >
        <span className="font-aeonik text-sm font-medium text-content-primary">
          {title}
        </span>
        <TfChevronDown
          aria-hidden="true"
          className={cn(
            'h-4 w-4 text-content-muted transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
    </h3>
  )
}

function ImportStep({
  step,
  children,
}: {
  step: keyof typeof STEP_ICONS
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <StepNumber step={step} />
      <div className="font-aeonik-fono text-sm text-content-muted">
        {children}
      </div>
    </div>
  )
}

export type { SettingsTab } from '@/constants/settings-tabs'

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
                  <TfPersonKey
                    className="h-4 w-4 shrink-0 text-content-secondary"
                    aria-hidden="true"
                  />
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
  onOpenPromptLibrary: () => void
  onCloudSyncSetupClick?: () => void
  onChatsUpdated?: () => void | Promise<void>
  // Deletes the chats on this device, and with cloud sync the harness's.
  onDeleteAllChats: () => Promise<{ cloudDeletionCompleted: boolean }>
  onAllChatsDeleted?: () => void
  onAllProjectsDeleted?: () => void
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
  // The listed chats, so a flagged chat links to its local or project route.
  chats?: readonly Pick<Chat, 'id' | 'isLocalOnly' | 'projectId'>[]
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
  onOpenPromptLibrary,
  onCloudSyncSetupClick,
  onChatsUpdated,
  onDeleteAllChats,
  onAllChatsDeleted,
  onAllProjectsDeleted,
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
  chats,
}: SettingsModalProps) {
  const { getToken, signOut } = useAuth()
  const { user } = useUser()
  // The prompt new chats start with replaces the custom default prompt where
  // the harness keeps one, as on main.
  const {
    builtInPresets,
    userPresets,
    defaultPreset,
    setDefaultPreset,
    canSetDefaultPreset,
  } = usePromptLibrary()
  const { toast } = useToast()
  const { api, profile, keyReady } = useHarness()

  const { refresh: refreshProjects } = useProjects({ autoLoad: false })
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
  const [showClearPersonalizationConfirm, setShowClearPersonalizationConfirm] =
    useState(false)

  // Language setting (separate from personalization)
  const [language, setLanguage] = useState<string>(SYSTEM_RESPONSE_LANGUAGE)

  // Custom system prompt settings
  const [isUsingCustomPrompt, setIsUsingCustomPrompt] = useState<boolean>(false)
  const [customSystemPrompt, setCustomSystemPrompt] = useState<string>('')

  // Without cloud sync every chat and setting stays on this device.
  const cloudSyncSetting = useCloudSyncSetting()
  const cloudSyncEnabled = !!isSignedIn && cloudSyncSetting
  const localChatsEnabled = useLocalChatsSetting()

  // Web Search PII check setting (defaults to on)
  const [piiCheckEnabled, setPiiCheckEnabled] = useState<boolean>(true)

  // Enter inserts newline instead of sending (defaults to off)
  const [enterToNewlineEnabled, setEnterToNewlineEnabled] =
    useState<boolean>(false)

  const [pixelateSidebarChatTitles, setPixelateSidebarChatTitles] =
    useState<boolean>(false)
  const [browserTabChatTitle, setBrowserTabChatTitle] = useState<boolean>(true)

  const [webSearchAvailable, setWebSearchAvailable] = useState<boolean>(true)

  // Generative UI setting (defaults to on)
  const [genUIEnabled, setGenUIEnabled] = useState<boolean>(true)

  // Chat font setting
  const [chatFont, setChatFont] = useState<ChatFont>('system')

  const [isHowItWorksOpen, setIsHowItWorksOpen] = useState(false)
  const importSectionId = useId()
  const [openImportSection, setOpenImportSection] =
    useState<ImportSection | null>(null)
  const toggleImportSection = (section: ImportSection) =>
    setOpenImportSection((current) => (current === section ? null : section))

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

  // Signed-in-only tabs disappear from the nav on sign-out; fall back to a
  // tab that still exists so the modal is not left with blank content. This
  // runs after the initial-tab effect so a requested hidden tab cannot win.
  const signedInOnlyTab =
    activeTab === 'cloud-sync' || activeTab === 'safeguards'
  useEffect(() => {
    if (!isSignedIn && signedInOnlyTab) {
      setActiveTab('account')
    }
  }, [isSignedIn, signedInOnlyTab])

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

  // Upgrade state
  const [upgradeLoading, setUpgradeLoading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)

  // Import state
  const [importSource, setImportSource] = useState<ImportSection | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(
    null,
  )
  // Files picked for an import, shown for review before it starts.
  const [stagedImports, setStagedImports] = useState<
    Partial<Record<ImportSourceKey, { kind: StagedImportKind; files: File[] }>>
  >({})
  const chatGptFileInputRef = useRef<HTMLInputElement>(null)
  const claudeConversationsFileInputRef = useRef<HTMLInputElement>(null)
  const claudeProjectsFileInputRef = useRef<HTMLInputElement>(null)
  const tinfoilFileInputRef = useRef<HTMLInputElement>(null)
  const localTinfoilImportAbortControllerRef = useRef<AbortController | null>(
    null,
  )

  // Export state
  const [isExporting, setIsExporting] = useState(false)
  const [isPreparingExport, setIsPreparingExport] = useState(false)
  const [exportType, setExportType] = useState<'chats' | 'projects' | null>(
    null,
  )
  const [projectExportResult, setProjectExportResult] = useState<{
    error: string
  } | null>(null)

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

  // Settings live in the encrypted profile held by the chat service.
  useEffect(() => {
    if (!isOpen) return
    setNickname(profile.nickname ?? '')
    setProfession(profile.profession ?? '')
    setSelectedTraits(profile.traits ?? [])
    setAdditionalContext(profile.additionalContext ?? '')
    setSavedPersonalization({
      nickname: profile.nickname ?? '',
      profession: profile.profession ?? '',
      traits: profile.traits ?? [],
      additionalContext: profile.additionalContext ?? '',
    })
    setIsUsingPersonalization(profile.isUsingPersonalization ?? true)
    setLanguage(profile.language ?? SYSTEM_RESPONSE_LANGUAGE)
    setIsUsingCustomPrompt(profile.isUsingCustomPrompt ?? false)
    setCustomSystemPrompt(profile.customSystemPrompt ?? '')
    setPiiCheckEnabled(profile.piiCheckEnabled ?? true)
    setEnterToNewlineEnabled(profile.enterToNewlineEnabled ?? false)
    setPixelateSidebarChatTitles(
      profile.pixelateSidebarChatTitlesEnabled ?? false,
    )
    setBrowserTabChatTitle(profile.browserTabChatTitleEnabled ?? true)
    setWebSearchAvailable(profile.webSearchEnabled ?? true)
    setGenUIEnabled(profile.genUIEnabled ?? true)
    setChatFont(normalizeChatFont(profile.chatFont))
  }, [isOpen, profile])

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

  // Save personalization settings to the profile
  const savePersonalizationSettings = (values?: {
    nickname?: string
    profession?: string
    traits?: string[]
    additionalContext?: string
    isEnabled?: boolean
  }) => {
    void api
      .updateProfile({
        nickname: values?.nickname ?? nickname,
        profession: values?.profession ?? profession,
        traits: values?.traits ?? selectedTraits,
        additionalContext: values?.additionalContext ?? additionalContext,
        isUsingPersonalization: values?.isEnabled ?? isUsingPersonalization,
      })
      .catch(reportHarnessError)
  }

  // Save language setting separately
  const saveLanguageSetting = (newLanguage: string) => {
    void api.updateProfile({ language: newLanguage }).catch(reportHarnessError)
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

  const handleClearPersonalization = () => {
    const cleared = clearPersonalizationDetails({
      nickname,
      profession,
      traits: selectedTraits,
      additionalContext,
      language,
      isEnabled: isUsingPersonalization,
    })
    setNickname(cleared.nickname)
    setProfession(cleared.profession)
    setSelectedTraits(cleared.traits)
    setAdditionalContext(cleared.additionalContext)
    setSavedPersonalization({
      nickname: cleared.nickname,
      profession: cleared.profession,
      traits: cleared.traits,
      additionalContext: cleared.additionalContext,
    })
    setShowClearPersonalizationConfirm(false)

    if (isClient) {
      savePersonalizationSettings({
        nickname: cleared.nickname,
        profession: cleared.profession,
        traits: cleared.traits,
        additionalContext: cleared.additionalContext,
        isEnabled: cleared.isEnabled,
      })
    }
  }

  const handleChatFontChange = (font: ChatFont) => {
    setChatFont(font)
    void api.updateProfile({ chatFont: font }).catch(reportHarnessError)
  }

  const handleToggleCustomPrompt = (enabled: boolean) => {
    setIsUsingCustomPrompt(enabled)
    void api
      .updateProfile({ isUsingCustomPrompt: enabled })
      .catch(reportHarnessError)
  }

  const handleCustomPromptBlur = () => {
    void api.updateProfile({ customSystemPrompt }).catch(reportHarnessError)
  }

  const handleRestoreDefaultPrompt = () => {
    setCustomSystemPrompt('')
    setIsUsingCustomPrompt(false)
    void api
      .updateProfile({ customSystemPrompt: '', isUsingCustomPrompt: false })
      .catch(reportHarnessError)
  }

  // Turning cloud sync on needs the encryption key, which a passkey can
  // create; turning it off keeps the harness's chats for when it returns.
  const handleCloudSyncToggle = async (enabled: boolean) => {
    if (!enabled || encryptionKey) {
      recordCloudSyncPreference(enabled)
      return
    }
    setIsOpen(false)
    if (passkeySetupAvailable && onSetupPasskey) {
      try {
        if (await onSetupPasskey()) return
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
    }
    onCloudSyncSetupClick?.()
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
    requestExplicitSignout()
    try {
      await signOut()
    } catch (error) {
      clearExplicitSignoutIntent()
      logError('Sign out failed', error, {
        component: 'SettingsModal',
        action: 'handleSignOut',
      })
      hideSignoutProgress()
    } finally {
      setIsSigningOut(false)
    }
  }, [signOut])

  // Imports upload the original export to the chat service, which converts
  // and stores it off device and emails the user when a long job finishes.
  // An export split across files runs as a sequence of jobs, each finishing
  // before the next file is uploaded.
  const importFiles = async (
    source: ImportSection,
    files: readonly File[],
    sourceLabel: string,
  ) => {
    if (files.length === 0) return
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    const bytesBefore = files.map((_, index) =>
      files.slice(0, index).reduce((sum, file) => sum + file.size, 0),
    )
    const fileNames = files.map((file) => file.name)
    setIsImporting(true)
    setImportSource(source)
    setImportResult(null)
    localTinfoilImportAbortControllerRef.current?.abort()
    const controller = new AbortController()
    localTinfoilImportAbortControllerRef.current = controller
    try {
      const outcome = await runImports(source, files, {
        signal: controller.signal,
        onUpload: (fileIndex) =>
          setImportProgress({
            type: 'upload',
            file: fileIndex + 1,
            files: files.length,
            uploadedBytes: bytesBefore[fileIndex],
            totalBytes,
          }),
        onProcessing: (fileIndex, status) =>
          setImportProgress({
            type: 'processing',
            file: fileIndex + 1,
            files: files.length,
            imported: status.imported,
            total: status.total,
          }),
      })
      const result = describeOffDeviceImportOutcome(
        outcome,
        fileNames,
        sourceLabel,
      )
      setImportResult(result)
      if (result.failed) {
        toast({
          title: 'Import failed',
          description: result.errors[0] ?? result.message,
          variant: 'destructive',
        })
      } else if (result.pending) {
        toast({ title: 'Import started', description: result.message })
      }
      if (!result.pending || result.chatsImported > 0) {
        await onChatsUpdated?.()
        await refreshProjects()
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      const result = describeOffDeviceImportError(cause, fileNames)
      setImportResult(result)
      toast({
        title: 'Import failed',
        description: `Could not start the ${sourceLabel} import`,
        variant: 'destructive',
      })
      if (result.chatsImported > 0) await onChatsUpdated?.()
    } finally {
      if (localTinfoilImportAbortControllerRef.current === controller) {
        localTinfoilImportAbortControllerRef.current = null
        setIsImporting(false)
        setImportProgress(null)
      }
    }
  }

  const checkImportProgress = async (jobId: string) => {
    try {
      const status = await importStatus(jobId)
      setImportResult(describeOffDeviceImportKickoff(status, 'archive'))
      if (status.status === 'completed' || status.status === 'partial') {
        await onChatsUpdated?.()
        await refreshProjects()
      }
    } catch (cause) {
      reportHarnessError(cause)
    }
  }

  // Chats kept on this device are imported in the browser, as on main: an
  // export is parsed here and its chats are stored on this device (in this
  // tab when signed out). With cloud sync the chat service imports it.
  const importsOnDevice = !cloudSyncEnabled

  const generateChatId = (createdAt?: Date) => {
    const timestampMs = createdAt?.getTime() || Date.now()
    return generateReverseId(timestampMs).id
  }

  const getParseOptions = () => ({
    generateChatId,
    isCloudSyncEnabled: false,
  })

  // An import on this device ends with the modal or the account.
  const startDeviceImport = (source: ImportSection) => {
    setImportSource(source)
    setIsImporting(true)
    setImportResult(null)
    localTinfoilImportAbortControllerRef.current?.abort()
    const controller = new AbortController()
    localTinfoilImportAbortControllerRef.current = controller
    return {
      controller,
      signal: AbortSignal.any([controller.signal, api.lifetime.signal]),
    }
  }

  const finishDeviceImport = (controller: AbortController) => {
    if (localTinfoilImportAbortControllerRef.current !== controller) return
    localTinfoilImportAbortControllerRef.current = null
    setIsImporting(false)
    setImportProgress(null)
  }

  const saveImportedChats = async (
    chats: Chat[],
    signal: AbortSignal,
  ): Promise<{ imported: number; errors: string[] }> => {
    setImportProgress({ current: 0, total: chats.length, type: 'chats' })
    const store = localThreadStore(api.userId ? 'device' : 'tab')

    let imported = 0
    const errors: string[] = []

    for (let i = 0; i < chats.length; i++) {
      signal.throwIfAborted()
      try {
        const chat = chats[i]
        if (!(await store.update(chat.id, () => importedLocalThread(chat))))
          throw new Error('The chat was not saved')
        imported++
      } catch {
        signal.throwIfAborted()
        errors.push(`Failed to save "${chats[i].title}" locally`)
      }
      setImportProgress({
        current: i + 1,
        total: chats.length,
        type: 'chats',
      })
    }

    return { imported, errors }
  }

  const importChatGPT = async (files: File[]) => {
    if (!importsOnDevice) {
      await importFiles('chatgpt', files, 'ChatGPT')
      return
    }
    const { controller, signal } = startDeviceImport('chatgpt')

    try {
      const data = await readExportFiles<ChatGPTConversation>(
        files,
        'ChatGPT conversations',
      )

      const chats = parseChatGPTConversations(data, getParseOptions())
      const { imported, errors } = await saveImportedChats(chats, signal)

      setImportResult({
        success: errors.length === 0,
        chatsImported: imported,
        projectsImported: 0,
        errors,
      })

      void onChatsUpdated?.()

      toast({
        title: 'Import complete',
        description: `Imported ${imported} chat${imported !== 1 ? 's' : ''} from ChatGPT`,
      })
    } catch (err) {
      if (signal.aborted) return
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
      finishDeviceImport(controller)
    }
  }

  const importClaudeConversations = async (files: File[]) => {
    if (!importsOnDevice) {
      await importFiles('claude', files, 'Claude')
      return
    }
    const { controller, signal } = startDeviceImport('claude')

    try {
      const data = await readExportFiles<ClaudeConversation>(
        files,
        'Claude conversations',
      )

      const chats = parseClaudeConversations(data, getParseOptions())
      const { imported, errors } = await saveImportedChats(chats, signal)

      setImportResult({
        success: errors.length === 0,
        chatsImported: imported,
        projectsImported: 0,
        errors,
      })

      void onChatsUpdated?.()

      toast({
        title: 'Import complete',
        description: `Imported ${imported} chat${imported !== 1 ? 's' : ''} from Claude`,
      })
    } catch (err) {
      if (signal.aborted) return
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
      finishDeviceImport(controller)
    }
  }

  const handleImportTinfoil = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!importsOnDevice) {
      await importFiles('tinfoil', [file], 'Tinfoil')
      return
    }
    const { controller, signal } = startDeviceImport('tinfoil')

    try {
      const { chats, skippedProjectChats } =
        await parseLocalTinfoilExportForAccess(
          file,
          {
            ...getParseOptions(),
            signal,
          },
          Boolean(isPremium),
        )
      const { imported, errors } = await saveImportedChats(chats, signal)
      const projectErrors =
        skippedProjectChats > 0
          ? [
              `Skipped ${skippedProjectChats} project chat${skippedProjectChats === 1 ? '' : 's'}. Premium is required to import project chats.`,
            ]
          : []
      const importErrors = [...errors, ...projectErrors]

      setImportResult({
        success: importErrors.length === 0,
        chatsImported: imported,
        projectsImported: 0,
        errors: importErrors,
      })

      void onChatsUpdated?.()

      toast({
        title:
          skippedProjectChats > 0
            ? 'Chats imported; project chats skipped'
            : 'Import complete',
        description:
          skippedProjectChats > 0
            ? `Imported ${imported} chat${imported !== 1 ? 's' : ''}. Premium is required to import the ${skippedProjectChats} project chat${skippedProjectChats === 1 ? '' : 's'}.`
            : `Imported ${imported} chat${imported !== 1 ? 's' : ''} from Tinfoil`,
      })
    } catch (err) {
      if (signal.aborted) return
      const projectOnly = err instanceof PremiumProjectImportRequiredError
      setImportResult({
        success: false,
        chatsImported: 0,
        projectsImported: 0,
        errors: [err instanceof Error ? err.message : 'Failed to parse file'],
      })
      toast({
        title: projectOnly ? 'Premium required' : 'Import failed',
        description: projectOnly
          ? err.message
          : 'Could not parse the Tinfoil export file',
        variant: 'destructive',
      })
    } finally {
      finishDeviceImport(controller)
    }
  }

  // File pickers only stage the selection; the import runs once the user
  // confirms the set from the staged file list.
  const stageImportFiles = (
    kind: StagedImportKind,
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (selected.length === 0) return
    if (
      kind === 'claude-conversations' &&
      !isPremium &&
      selected.some((file) => isZipFile(file))
    ) {
      toast({
        title: 'Premium required',
        description: 'Claude archives containing projects require Premium',
        variant: 'destructive',
      })
      return
    }
    setImportResult(null)
    const source = stagedImportSource(kind)
    setStagedImports((previous) => {
      const current = previous[source]
      const existing = current?.kind === kind ? current.files : []
      const isDuplicate = (file: File) =>
        existing.some(
          (other) =>
            other.name === file.name &&
            other.size === file.size &&
            other.lastModified === file.lastModified,
        )
      return {
        ...previous,
        [source]: {
          kind,
          files: [
            ...existing,
            ...selected.filter((file) => !isDuplicate(file)),
          ],
        },
      }
    })
  }

  const clearStagedImport = (source: ImportSourceKey) => {
    setStagedImports((previous) => {
      const { [source]: _removed, ...rest } = previous
      return rest
    })
  }

  const removeStagedFile = (source: ImportSourceKey, index: number) => {
    setStagedImports((previous) => {
      const current = previous[source]
      if (!current) return previous
      const files = current.files.filter((_, i) => i !== index)
      if (files.length === 0) {
        const { [source]: _removed, ...rest } = previous
        return rest
      }
      return { ...previous, [source]: { ...current, files } }
    })
  }

  // Claude's project files are always imported by the chat service, which
  // keeps projects; it reads them as a Claude export.
  const runStagedImport = async (source: ImportSourceKey) => {
    const staged = stagedImports[source]
    if (!staged) return
    const { kind, files } = staged
    clearStagedImport(source)
    switch (kind) {
      case 'chatgpt':
        await importChatGPT(files)
        break
      case 'claude-projects':
        await importFiles('claude', files, 'Claude')
        break
      case 'claude-conversations':
        await importClaudeConversations(files)
        break
    }
  }

  const stagedImportSource = (kind: StagedImportKind): ImportSourceKey =>
    kind === 'chatgpt' ? 'chatgpt' : 'claude'

  const stagedImportInputRef = (kind: StagedImportKind) => {
    switch (kind) {
      case 'chatgpt':
        return chatGptFileInputRef
      case 'claude-projects':
        return claudeProjectsFileInputRef
      case 'claude-conversations':
        return claudeConversationsFileInputRef
    }
  }

  const stagedImportLabel = (kind: StagedImportKind) =>
    kind === 'claude-projects' ? 'Import projects' : 'Import conversations'

  const renderStagedImport = (source: ImportSourceKey) => {
    const staged = stagedImports[source]
    if (!staged) return null
    return (
      <ImportFileList
        files={staged.files}
        isDarkMode={isDarkMode}
        onRemove={(index) => removeStagedFile(source, index)}
        onAddMore={() => stagedImportInputRef(staged.kind).current?.click()}
        onImport={() => void runStagedImport(source)}
        onCancel={() => clearStagedImport(source)}
        importLabel={stagedImportLabel(staged.kind)}
        importDisabled={isImporting}
      />
    )
  }

  // Rendered in place of a source's upload button so progress and the
  // outcome appear inside the box the user is importing from.
  const renderImportStatus = (source: ImportSection) => {
    if (importSource !== source) return null
    // An import on this device shows its progress once it stores chats.
    if (isImporting && !importProgress && importsOnDevice) return null
    if (isImporting) {
      const { title, detail, percent } = describeImportProgress(
        importProgress ?? {
          type: 'upload',
          file: 1,
          files: 1,
          uploadedBytes: 0,
          totalBytes: 0,
        },
      )
      return (
        <div
          role="status"
          className={cn(
            'rounded-lg border border-border-subtle p-4',
            isDarkMode ? 'bg-surface-chat' : 'bg-surface-sidebar',
          )}
        >
          <div className="flex items-center gap-3">
            <PiSpinner
              className="h-5 w-5 animate-spin text-brand-accent-light"
              aria-hidden="true"
            />
            <div className="flex-1">
              <div className="font-aeonik text-sm font-medium text-content-primary">
                {title}
              </div>
              {detail && (
                <div className="font-aeonik-fono text-xs text-content-muted">
                  {detail}
                </div>
              )}
            </div>
          </div>
          <div
            className={cn(
              'mt-3 h-2 overflow-hidden rounded-full',
              isDarkMode ? 'bg-surface-sidebar' : 'bg-surface-chat',
            )}
          >
            <div
              className="h-full bg-brand-accent-light transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )
    }
    if (importResult && !isImporting) {
      return (
        <div
          role="status"
          className={cn(
            'rounded-lg border p-4',
            importResult.success
              ? 'border-brand-accent-dark/30 bg-brand-accent-dark/10 dark:border-brand-accent-light/30 dark:bg-brand-accent-light/10'
              : 'border-red-500/30 bg-red-500/10',
          )}
        >
          <div className="flex items-start gap-3">
            {importResult.success ? (
              <TfBoxCheckmark
                className="h-5 w-5 shrink-0 text-brand-accent-dark dark:text-brand-accent-light"
                aria-hidden="true"
              />
            ) : (
              <TfBoxX
                className="h-5 w-5 shrink-0 text-red-500"
                aria-hidden="true"
              />
            )}
            <div className="flex-1">
              <div
                className={cn(
                  'font-aeonik text-sm font-medium',
                  importResult.success
                    ? 'text-brand-accent-dark dark:text-brand-accent-light'
                    : 'text-red-500',
                )}
              >
                {importResultTitle(importResult)}
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
              {importResult.pending && importResult.jobId && (
                <button
                  type="button"
                  className="mt-2 font-aeonik-fono text-xs text-content-primary hover:underline"
                  onClick={() => void checkImportProgress(importResult.jobId!)}
                >
                  Check import progress
                </button>
              )}
              {importResult.errors.length > 0 && (
                <div className="mt-2 text-xs text-red-400">
                  {importResult.errors.slice(0, 3).map((err, i) => (
                    <div key={i}>{err}</div>
                  ))}
                  {importResult.errors.length > 3 && (
                    <div>+{importResult.errors.length - 3} more errors</div>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setImportResult(null)
                setImportSource(null)
              }}
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 text-content-muted transition-colors hover:text-content-primary"
            >
              <TfBoxX className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )
    }
    return null
  }

  // Export chats as conversations.json, or a ZIP holding their images
  const downloadChats = async (
    chatsToExport: Chat[],
    fetchAttachmentBytes: AttachmentBytesFetcher,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted()
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
      // One binary attachment is fetched at a time so the browser never
      // holds every attachment's bytes in memory at once.
      const archive = await buildChatExport(chatsToExport, fetchAttachmentBytes)
      signal.throwIfAborted()
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
      try {
        signal.throwIfAborted()
        a.click()
      } finally {
        document.body.removeChild(a)
        window.URL.revokeObjectURL(url)
      }

      signal.throwIfAborted()
      toast({
        title: 'Export complete',
        description: `Exported ${chatsToExport.length} conversation${chatsToExport.length !== 1 ? 's' : ''} successfully.`,
      })
    } catch (error) {
      if (signal.aborted) return
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

  // Exports the chats kept on this device and, with cloud sync, the stored
  // chats. An account change ends the export without a download.
  const handleExportAllChats = async () => {
    const signal = api.lifetime.signal
    setIsPreparingExport(true)
    setExportType('chats')

    try {
      const source = await collectChatExport(api, {
        cloud: cloudSyncEnabled,
        signal,
      })
      const hasPremiumProjectAccess = Boolean(isPremium)
      const exportableChats = filterExportableChats(
        source.chats,
        hasPremiumProjectAccess,
      )
      const excludedProjectChats = countExcludedProjectChats(
        source.chats,
        hasPremiumProjectAccess,
      )

      setIsPreparingExport(false)
      if (excludedProjectChats > 0) {
        toast({
          title: 'Project chats not included',
          description: `${excludedProjectChats} project chat${excludedProjectChats === 1 ? '' : 's'} could not be exported. Premium is required to export project chats.`,
        })
      }
      await downloadChats(exportableChats, source.fetchAttachmentBytes, signal)
    } catch (error) {
      if (signal.aborted) {
        setIsPreparingExport(false)
        setExportType(null)
        return
      }
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

  const handleDeleteAllChats = async () => {
    if (
      deleteAllChatsConfirmText.trim().toLowerCase() !==
      DELETE_ALL_CHATS_CONFIRM_PHRASE
    )
      return
    setIsDeletingAllChats(true)
    try {
      const { cloudDeletionCompleted } = await onDeleteAllChats()
      onAllChatsDeleted?.()
      await onChatsUpdated?.()
      setShowDeleteAllChatsConfirm(false)
      setDeleteAllChatsConfirmText('')
      toast(
        cloudSyncEnabled || !isSignedIn
          ? {
              title: getDeleteAllChatsSuccessTitle(
                Boolean(isSignedIn),
                cloudDeletionCompleted,
              ),
              description: getDeleteAllChatsSuccessDescription(
                Boolean(isSignedIn),
                cloudDeletionCompleted,
              ),
            }
          : {
              title: 'All chats deleted',
              description: 'Removed all chats from this device.',
            },
      )
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description:
          cause instanceof Error ? cause.message : 'Unable to delete chats.',
        variant: 'destructive',
      })
    } finally {
      setIsDeletingAllChats(false)
    }
  }

  const handleDeleteAllProjects = async () => {
    if (
      deleteAllProjectsConfirmText.trim().toLowerCase() !==
      DELETE_ALL_PROJECTS_CONFIRM_PHRASE
    )
      return
    setIsDeletingAllProjects(true)
    try {
      await api.post('/v1/projects/delete-all')
      onAllProjectsDeleted?.()
      await refreshProjects()
      await onChatsUpdated?.()
      setShowDeleteAllProjectsConfirm(false)
      setDeleteAllProjectsConfirmText('')
      toast({ title: 'All projects deleted' })
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description:
          cause instanceof Error ? cause.message : 'Unable to delete projects.',
        variant: 'destructive',
      })
    } finally {
      setIsDeletingAllProjects(false)
    }
  }

  const downloadProjectsForClaude = async () => {
    setIsExporting(true)
    setExportType('projects')
    setProjectExportResult(null)
    try {
      await exportArchive('claude-projects')
    } catch (cause) {
      setProjectExportResult({
        error:
          cause instanceof Error ? cause.message : 'Unable to export projects.',
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

  useEffect(() => {
    return () => {
      const abortController = localTinfoilImportAbortControllerRef.current
      localTinfoilImportAbortControllerRef.current = null
      abortController?.abort()
    }
  }, [])

  // Reset transient state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsQRCodeExpanded(false)
      setShowDeleteAllChatsConfirm(false)
      setDeleteAllChatsConfirmText('')
      setShowDeleteAllProjectsConfirm(false)
      setDeleteAllProjectsConfirmText('')
      setProjectExportResult(null)
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
    { id: 'account' as const, label: 'Account', icon: TfPerson },
    {
      id: 'general' as const,
      label: 'General',
      icon: TfAdjustmentToggle,
    },
    {
      id: 'chat' as const,
      label: 'Chat Settings',
      icon: TfChat2,
    },
    {
      id: 'personalization' as const,
      label: 'Personalization',
      icon: TfPerson,
    },
    {
      id: 'prompts' as const,
      label: 'Prompts',
      icon: TfTools,
    },
    ...(isSignedIn
      ? [
          {
            id: 'cloud-sync' as const,
            label: 'Cloud Sync',
            icon: TfCloudSync,
          },
          {
            id: 'safeguards' as const,
            label: 'Safeguards',
            icon: TfShieldWithExclamation,
          },
        ]
      : []),
    { id: 'data' as const, label: 'Data', icon: TfStack },
  ]

  return (
    <Dialog
      open={isOpen}
      onClose={setIsOpen}
      autoFocus
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      {/* Modal overlay */}
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />

      {/* Settings modal */}
      <Dialog.Panel
        data-settings-panel
        className={cn(
          'relative z-10 flex h-[80vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-site-lg border font-aeonik shadow-xl md:flex-row',
          'border-border-subtle bg-surface-sidebar text-content-primary',
        )}
      >
        <Dialog.Title className="sr-only">Settings</Dialog.Title>
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
                    type="button"
                    onClick={handleSavePersonalization}
                    className="rounded-lg bg-brand-accent-dark px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
                  >
                    Save
                  </button>
                )}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close settings"
                className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
              >
                <TfBoxX className="h-5 w-5" aria-hidden="true" />
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
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                )}
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Left sidebar navigation (desktop only) */}
        <div className="hidden w-56 flex-none flex-col border-r border-border-subtle md:flex">
          {/* Spacer matching the content header so tabs start below it */}
          <div className="h-14 flex-none" />

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
                  <item.icon className="h-5 w-5" aria-hidden="true" />
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
            <div className="flex items-center gap-2">
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
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close settings"
                className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
              >
                <TfBoxX className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
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
                            icon: TfSunLightMode,
                          },
                          {
                            id: 'dark' as const,
                            label: 'Dark',
                            icon: TfMoon,
                          },
                          {
                            id: 'system' as const,
                            label: 'System',
                            icon: TfComputer,
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
                            <theme.icon
                              className="h-5 w-5 text-content-primary"
                              aria-hidden="true"
                            />
                            <span className="text-xs text-content-secondary">
                              {theme.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="mr-3 flex-1">
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Redact sidebar chat titles
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            Cover inactive chat titles until you hover over
                            them.
                          </div>
                        </div>
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            aria-label="Redact sidebar chat titles"
                            checked={pixelateSidebarChatTitles}
                            onChange={(e) => {
                              const newValue = e.target.checked
                              setPixelateSidebarChatTitles(newValue)
                              void api
                                .updateProfile({
                                  pixelateSidebarChatTitlesEnabled: newValue,
                                })
                                .catch(reportHarnessError)
                            }}
                            className="peer sr-only"
                          />
                          <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-border-strong" />
                        </label>
                      </div>
                    </div>
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="mr-3 flex-1">
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Show chat title in browser tab
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            When off, the tab shows only &ldquo;
                            {CONSTANTS.BASE_DOCUMENT_TITLE}&rdquo;.
                          </div>
                        </div>
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            aria-label="Show chat title in browser tab"
                            checked={browserTabChatTitle}
                            onChange={(e) => {
                              const newValue = e.target.checked
                              setBrowserTabChatTitle(newValue)
                              void api
                                .updateProfile({
                                  browserTabChatTitleEnabled: newValue,
                                })
                                .catch(reportHarnessError)
                            }}
                            className="peer sr-only"
                          />
                          <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-border-strong" />
                        </label>
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
                            'w-full rounded-md border py-2 pl-3 pr-8 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong',
                            isDarkMode
                              ? 'border-border-strong bg-surface-chat text-content-secondary'
                              : 'border-border-subtle bg-surface-sidebar text-content-primary',
                          )}
                        >
                          {!RESPONSE_LANGUAGES.some(
                            (option) => option === language,
                          ) && <option value={language}>{language}</option>}
                          {RESPONSE_LANGUAGES.map((lang) => (
                            <option key={lang} value={lang}>
                              {lang}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {/* Enter inserts newline */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="mr-3 flex-1">
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Press Enter for new line
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            Enter inserts a new line instead of sending your
                            message. Send with Cmd/Ctrl+Enter or the send
                            button.
                          </div>
                        </div>
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            aria-label="Press Enter for new line"
                            checked={enterToNewlineEnabled}
                            onChange={(e) => {
                              const newValue = e.target.checked
                              setEnterToNewlineEnabled(newValue)
                              void api
                                .updateProfile({
                                  enterToNewlineEnabled: newValue,
                                })
                                .catch(reportHarnessError)
                            }}
                            className="peer sr-only"
                          />
                          <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-border-strong" />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Advanced Settings */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Advanced Settings
                    </h3>
                    <div className="space-y-4">
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="mr-3 flex-1">
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Web Search
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              Show web search controls and allow chats to search
                              the web.
                            </div>
                          </div>
                          <label className="relative inline-flex cursor-pointer items-center">
                            <input
                              type="checkbox"
                              checked={webSearchAvailable}
                              onChange={(e) => {
                                const newValue = e.target.checked
                                setWebSearchAvailable(newValue)
                                void api
                                  .updateProfile({ webSearchEnabled: newValue })
                                  .catch(reportHarnessError)
                              }}
                              className="peer sr-only"
                            />
                            <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                          </label>
                        </div>

                        {/* Web Search PII Detection - only meaningful while web search is on */}
                        {webSearchAvailable && (
                          <div className="mt-4 flex items-start justify-between border-t border-border-subtle pt-4">
                            <div className="mr-3 flex-1">
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                Automatic PII Blocking
                              </div>
                              <div className="font-aeonik-fono text-xs text-content-muted">
                                Block web search queries that contain personal
                                information.
                              </div>
                            </div>
                            <label className="relative inline-flex cursor-pointer items-center">
                              <input
                                type="checkbox"
                                checked={piiCheckEnabled}
                                onChange={(e) => {
                                  const newValue = e.target.checked
                                  setPiiCheckEnabled(newValue)
                                  void api
                                    .updateProfile({
                                      piiCheckEnabled: newValue,
                                    })
                                    .catch(reportHarnessError)
                                }}
                                className="peer sr-only"
                              />
                              <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                            </label>
                          </div>
                        )}
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
                              Let Al render interactive widgets like charts and
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
                                void api
                                  .updateProfile({ genUIEnabled: newValue })
                                  .catch(reportHarnessError)
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
                          Tailor Al&apos;s replies using the details below. When
                          off, none of these are sent to the model.
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
                              How should Al call you?
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
                              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong',
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
                          <input
                            type="text"
                            value={profession}
                            onChange={(e) =>
                              handleProfessionChange(e.target.value)
                            }
                            placeholder="Your occupation"
                            className={cn(
                              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong',
                              isDarkMode
                                ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                            )}
                          />
                        </div>
                      </div>

                      {/* Traits */}
                      <div
                        className={cn(
                          'rounded-site-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div>
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Conversational Traits
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              What traits should Al have?
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {availableTraits.map((trait) => (
                              <button
                                key={trait}
                                onClick={() => handleTraitToggle(trait)}
                                aria-pressed={selectedTraits.includes(trait)}
                                className={cn(
                                  'rounded-site-control px-3 py-1.5 text-sm transition-colors',
                                  selectedTraits.includes(trait)
                                    ? 'bg-brand-accent-light text-brand-accent-dark'
                                    : isDarkMode
                                      ? 'bg-surface-chat text-content-secondary hover:bg-surface-chat'
                                      : 'border border-border-subtle bg-surface-sidebar text-content-secondary hover:bg-surface-chat',
                                )}
                              >
                                {selectedTraits.includes(trait) ? (
                                  <TfBoxCheckmark
                                    className="inline-block h-3 w-3"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <TfPlus
                                    className="inline-block h-3 w-3"
                                    aria-hidden="true"
                                  />
                                )}{' '}
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
                              Anything else Al should know about you?
                            </div>
                          </div>
                          <textarea
                            value={additionalContext}
                            onChange={(e) =>
                              handleContextChange(e.target.value)
                            }
                            placeholder="Interests and other preferences you'd like Al to know about you."
                            rows={3}
                            className={cn(
                              'w-full resize-none rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong',
                              isDarkMode
                                ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                                : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                            )}
                          />
                        </div>
                      </div>

                      {!showClearPersonalizationConfirm ? (
                        <button
                          onClick={() =>
                            setShowClearPersonalizationConfirm(true)
                          }
                          className={cn(
                            'w-full rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                            isDarkMode
                              ? 'border-red-500/30 bg-red-950/20 text-red-400 hover:bg-red-950/40'
                              : 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100',
                          )}
                        >
                          Clear details
                        </button>
                      ) : (
                        <div className="space-y-2 rounded-lg border border-border-subtle p-3">
                          <p className="font-aeonik-fono text-xs text-content-muted">
                            Clear your name, occupation, traits, and additional
                            context? Your personalization setting and response
                            language will not change.
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={handleClearPersonalization}
                              className={cn(
                                'flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-white',
                                isDarkMode
                                  ? 'bg-red-600 hover:bg-red-500'
                                  : 'bg-red-600 hover:bg-red-700',
                              )}
                            >
                              Clear details
                            </button>
                            <button
                              onClick={() =>
                                setShowClearPersonalizationConfirm(false)
                              }
                              className="flex-1 rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-content-secondary"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {/* Prompts Tab */}
              {activeTab === 'prompts' && (
                <>
                  {canSetDefaultPreset ? (
                    <div className="space-y-3">
                      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                        Default Prompt
                      </h3>
                      <div
                        className={cn(
                          'rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="space-y-3">
                          <div>
                            <div className="font-aeonik text-sm font-medium text-content-primary">
                              Default prompt for new chats
                            </div>
                            <div className="font-aeonik-fono text-xs text-content-muted">
                              New chats start with this prompt from your
                              library. You can still switch prompts in any chat.
                            </div>
                          </div>
                          <select
                            value={defaultPreset?.id ?? ''}
                            onChange={(e) =>
                              setDefaultPreset(e.target.value || null)
                            }
                            aria-label="Default prompt for new chats"
                            className={cn(
                              'w-full rounded-md border py-2 pl-3 pr-8 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong',
                              isDarkMode
                                ? 'border-border-strong bg-surface-chat text-content-secondary'
                                : 'border-border-subtle bg-surface-sidebar text-content-primary',
                            )}
                          >
                            <option value="">Tinfoil default</option>
                            {userPresets.length > 0 && (
                              <optgroup label="Your prompts">
                                {userPresets.map((preset) => (
                                  <option key={preset.id} value={preset.id}>
                                    {preset.name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <optgroup label="Built-in">
                              {builtInPresets.map((preset) => (
                                <option key={preset.id} value={preset.id}>
                                  {preset.name}
                                </option>
                              ))}
                            </optgroup>
                          </select>
                        </div>
                      </div>
                    </div>
                  ) : (
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
                                aria-label="Custom default prompt"
                                checked={isUsingCustomPrompt}
                                onChange={(e) =>
                                  handleToggleCustomPrompt(e.target.checked)
                                }
                                className="peer sr-only"
                              />
                              <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-border-strong" />
                            </label>
                          </div>
                          {isUsingCustomPrompt && (
                            <>
                              <textarea
                                aria-label="Custom system prompt"
                                value={customSystemPrompt}
                                onChange={(e) =>
                                  setCustomSystemPrompt(e.target.value)
                                }
                                onBlur={handleCustomPromptBlur}
                                placeholder="Enter your custom system prompt..."
                                rows={6}
                                className={cn(
                                  'w-full resize-none rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong',
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
                                        ? 'text-brand-accent-light'
                                        : 'text-brand-accent-dark',
                                    )}
                                  >
                                    Tip:
                                  </span>{' '}
                                  Use placeholders like {'{USER_PREFERENCES}'},{' '}
                                  {'{LANGUAGE}'}, and {'{TIMEZONE}'} to tell the
                                  model about your preferences and timezone. The
                                  current time and date are always provided to
                                  the model automatically.
                                </div>
                              </div>
                              <div className="flex justify-center">
                                <button
                                  type="button"
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
                  )}

                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Prompt Library
                    </h3>
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false)
                        onOpenPromptLibrary()
                      }}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border border-border-subtle p-4 text-left transition-colors hover:bg-surface-chat',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-surface-chat text-content-secondary">
                        <TfTools className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-aeonik text-sm font-medium text-content-primary">
                          Open prompt library
                        </span>
                        <span className="mt-0.5 block font-aeonik-fono text-xs text-content-muted">
                          Browse built-in prompts and create or manage your own.
                        </span>
                      </span>
                      <TfChevronRight
                        className="h-4 w-4 flex-none text-content-muted"
                        aria-hidden="true"
                      />
                    </button>
                  </div>
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
                        <TfLightbulb
                          className="h-4 w-4 text-content-muted"
                          aria-hidden="true"
                        />
                        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                          How It Works
                        </h3>
                      </div>
                      <TfChevronDown
                        className={cn(
                          'h-4 w-4 text-content-muted transition-transform',
                          isHowItWorksOpen && 'rotate-180',
                        )}
                        aria-hidden="true"
                      />
                    </button>
                    {isHowItWorksOpen && (
                      <div className="space-y-3 border-t border-border-subtle p-4">
                        <div className="flex items-start gap-3">
                          <StepNumber step={1} />
                          <div className="font-aeonik-fono text-sm text-content-muted">
                            Your chats are encrypted with a key that only you
                            possess and stored encrypted in the cloud. Nobody
                            but you can access your backed up chats.
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <StepNumber step={2} />
                          <div className="font-aeonik-fono text-sm text-content-muted">
                            Only you have the encryption key. Tinfoil cannot
                            read your messages.
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <StepNumber step={3} />
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
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-aeonik text-sm font-medium text-content-primary">
                            Encrypted Cloud Sync
                          </div>
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            {!cloudSyncEnabled
                              ? 'Turn on Cloud Sync to back up and access your data across devices.'
                              : keyReady
                                ? 'End-to-end encrypted. Only you can access your chats and data.'
                                : 'Unlock your encryption key to access your saved chats.'}
                          </div>
                        </div>
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            aria-label="Encrypted Cloud Sync"
                            checked={cloudSyncEnabled}
                            onChange={(e) =>
                              void handleCloudSyncToggle(e.target.checked)
                            }
                            className="peer sr-only"
                          />
                          <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                        </label>
                      </div>
                      {cloudSyncEnabled && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsOpen(false)
                            onCloudSyncSetupClick?.()
                          }}
                          className="mt-3 rounded-site-control border border-border-subtle px-3 py-1.5 text-sm text-content-primary transition-colors hover:bg-surface-chat"
                        >
                          {keyReady ? 'Manage key' : 'Unlock'}
                        </button>
                      )}
                    </div>
                    <NativeBackupExport
                      available={Boolean(
                        cloudSyncEnabled &&
                        canTransferProjectData(Boolean(isPremium)) &&
                        encryptionKey,
                      )}
                    />
                    <NativeBackupRestore
                      available={Boolean(
                        cloudSyncEnabled &&
                        canTransferProjectData(Boolean(isPremium)) &&
                        user?.id &&
                        encryptionKey,
                      )}
                      ownerId={user?.id}
                      onChatsUpdated={onChatsUpdated}
                      onProjectsUpdated={refreshProjects}
                    />
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
                          <TfKey
                            className="h-4 w-4 text-content-muted"
                            aria-hidden="true"
                          />
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
                                      <TfEyeSlash
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <TfEye
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                      />
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
                                  <BsQrCode
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
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
                                  <TfDownload
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
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
                              <TfPersonKey
                                className="mt-0.5 h-4 w-4 shrink-0 text-tinfoil-accent-blue dark:text-blue-400"
                                aria-hidden="true"
                              />
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
                              <TfShieldCheck
                                className="h-3.5 w-3.5 text-tinfoil-accent-blue dark:text-blue-400"
                                aria-hidden="true"
                              />
                              <span className="text-xs font-medium text-tinfoil-accent-blue dark:text-blue-400">
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
                                    title: 'Passkey recovery removed',
                                    description:
                                      'That platform can no longer recover your cloud encryption key with this bundle.',
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
                                <TfPersonKey
                                  className="mt-[3px] h-4 w-4 shrink-0 text-content-secondary"
                                  aria-hidden="true"
                                />
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
                                <TfPersonKey
                                  className="mt-[3px] h-4 w-4 shrink-0 text-content-secondary"
                                  aria-hidden="true"
                                />
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
                                aria-label="Enable local chats"
                                checked={localChatsEnabled}
                                onChange={(e) =>
                                  setLocalOnlyModeEnabled(e.target.checked)
                                }
                                className="peer sr-only"
                              />
                              <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-light peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none" />
                            </label>
                          </div>
                          {localChatsEnabled && (
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

              {/* Data Tab */}
              {activeTab === 'data' && (
                <>
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Delete
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
                                {!isSignedIn
                                  ? 'Permanently delete every chat from this browser. This cannot be undone.'
                                  : cloudSyncEnabled
                                    ? 'Permanently delete every chat from this device and your encrypted cloud backup. This cannot be undone.'
                                    : 'Permanently delete every chat from this device. This cannot be undone.'}
                              </div>
                            </div>
                            {!showDeleteAllChatsConfirm && (
                              <button
                                onClick={() =>
                                  setShowDeleteAllChatsConfirm(true)
                                }
                                className={cn(
                                  'flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium transition-colors sm:w-52',
                                  isDarkMode
                                    ? 'border-red-500/40 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                                    : 'border-red-300 bg-white text-red-600 hover:bg-red-100',
                                )}
                              >
                                <TfTrash
                                  className="h-4 w-4 shrink-0"
                                  aria-hidden="true"
                                />
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

                      {/* Delete all projects remains available for account data control. */}
                      {cloudSyncEnabled &&
                        canDeleteAllProjects(Boolean(isSignedIn)) && (
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
                                      'flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium transition-colors sm:w-52',
                                      isDarkMode
                                        ? 'border-red-500/40 bg-red-950/30 text-red-400 hover:bg-red-950/50'
                                        : 'border-red-300 bg-white text-red-600 hover:bg-red-100',
                                    )}
                                  >
                                    <TfTrash
                                      className="h-4 w-4 shrink-0"
                                      aria-hidden="true"
                                    />
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

                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Import
                    </h3>
                    {/* ChatGPT Import */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <ImportAccordionHeader
                        title="Import from ChatGPT"
                        panelId={`${importSectionId}-chatgpt`}
                        expanded={openImportSection === 'chatgpt'}
                        onToggle={() => toggleImportSection('chatgpt')}
                      />
                      {openImportSection === 'chatgpt' && (
                        <div
                          id={`${importSectionId}-chatgpt`}
                          className="space-y-3 border-t border-border-subtle p-4"
                        >
                          <ImportStep step={1}>
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
                          </ImportStep>
                          <ImportStep step={2}>
                            Click on &quot;Export data&quot; and confirm the
                            export.
                          </ImportStep>
                          <ImportStep step={3}>
                            {importsOnDevice
                              ? 'Download and unzip the file you receive by email.'
                              : 'Download the ZIP file you receive by email.'}
                          </ImportStep>
                          <ImportStep step={4}>
                            {importsOnDevice ? (
                              <>
                                Select the{' '}
                                <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                  conversations*.json
                                </code>{' '}
                                files from the unzipped folder. Large exports
                                are split into several files; select them all.
                              </>
                            ) : (
                              <>
                                Select the ZIP export to include attachments, or
                                the{' '}
                                <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                  conversations*.json
                                </code>{' '}
                                files for chat text only. Large exports are
                                split into several files; select them all.
                              </>
                            )}
                          </ImportStep>
                          <input
                            ref={chatGptFileInputRef}
                            type="file"
                            accept={importsOnDevice ? '.json' : '.json,.zip'}
                            onChange={(e) => stageImportFiles('chatgpt', e)}
                            className="hidden"
                            disabled={isImporting}
                            multiple
                          />
                          {renderImportStatus('chatgpt') ??
                            renderStagedImport('chatgpt') ?? (
                              <button
                                onClick={() =>
                                  chatGptFileInputRef.current?.click()
                                }
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
                                <ArrowUpTrayIcon
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                Select File
                              </button>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Claude Import */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <ImportAccordionHeader
                        title="Import from Claude"
                        panelId={`${importSectionId}-claude`}
                        expanded={openImportSection === 'claude'}
                        onToggle={() => toggleImportSection('claude')}
                      />
                      {openImportSection === 'claude' && (
                        <div
                          id={`${importSectionId}-claude`}
                          className="space-y-3 border-t border-border-subtle p-4"
                        >
                          <ImportStep step={1}>
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
                          </ImportStep>
                          <ImportStep step={2}>
                            Click on &quot;Export data&quot; and confirm the
                            export.
                          </ImportStep>
                          <ImportStep step={3}>
                            {isPremium && !importsOnDevice
                              ? 'Download the ZIP file you receive by email.'
                              : 'Download and unzip the file you receive by email.'}
                          </ImportStep>
                          <ImportStep step={4}>
                            {isPremium && !importsOnDevice ? (
                              <>
                                Select the ZIP export with the Conversations
                                button to include attachments. For projects,
                                select every file in the unzipped{' '}
                                <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                  projects
                                </code>{' '}
                                folder. Claude exports do not record which
                                project a chat belonged to, so project chats
                                import as regular chats.
                              </>
                            ) : isPremium ? (
                              <>
                                Select the{' '}
                                <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                  conversations*.json
                                </code>{' '}
                                files from the unzipped folder, or every file in
                                its{' '}
                                <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                  projects
                                </code>{' '}
                                folder. Large exports are split into several
                                files; select them all. Claude exports do not
                                record which project a chat belonged to, so
                                project chats import as regular chats.
                              </>
                            ) : (
                              <>
                                Select the{' '}
                                <code className="rounded bg-surface-chat px-1.5 py-0.5 font-mono text-xs">
                                  conversations*.json
                                </code>{' '}
                                files from the unzipped folder. Large exports
                                are split into several files; select them all.
                              </>
                            )}
                          </ImportStep>
                          <input
                            ref={claudeConversationsFileInputRef}
                            type="file"
                            accept={
                              isPremium && !importsOnDevice
                                ? '.json,.zip'
                                : '.json'
                            }
                            onChange={(e) =>
                              stageImportFiles('claude-conversations', e)
                            }
                            className="hidden"
                            disabled={isImporting}
                            multiple
                          />
                          {isPremium && (
                            <input
                              ref={claudeProjectsFileInputRef}
                              type="file"
                              accept=".json"
                              onChange={(e) =>
                                stageImportFiles('claude-projects', e)
                              }
                              className="hidden"
                              disabled={isImporting}
                              multiple
                            />
                          )}
                          {renderImportStatus('claude') ??
                            renderStagedImport('claude') ?? (
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
                                  <ArrowUpTrayIcon
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  Conversations
                                </button>
                                {isPremium && (
                                  <button
                                    onClick={() =>
                                      claudeProjectsFileInputRef.current?.click()
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
                                    <ArrowUpTrayIcon
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    Projects
                                  </button>
                                )}
                              </div>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Tinfoil Import */}
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <ImportAccordionHeader
                        title="Import from Tinfoil"
                        panelId={`${importSectionId}-tinfoil`}
                        expanded={openImportSection === 'tinfoil'}
                        onToggle={() => toggleImportSection('tinfoil')}
                      />
                      {openImportSection === 'tinfoil' && (
                        <div
                          id={`${importSectionId}-tinfoil`}
                          className="space-y-3 border-t border-border-subtle p-4"
                        >
                          <div className="font-aeonik-fono text-xs text-content-muted">
                            {importsOnDevice
                              ? 'Re-import a Tinfoil conversations export. When cloud sync is off, chats and attachments stay in this browser.'
                              : 'Re-import a Tinfoil conversations export or backup archive into your encrypted account.'}
                          </div>
                          <input
                            ref={tinfoilFileInputRef}
                            type="file"
                            accept=".json,.zip"
                            onChange={(event) =>
                              void handleImportTinfoil(event)
                            }
                            className="hidden"
                            disabled={isImporting}
                          />
                          {renderImportStatus('tinfoil') ?? (
                            <button
                              onClick={() =>
                                tinfoilFileInputRef.current?.click()
                              }
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
                              <ArrowUpTrayIcon
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              Select Tinfoil Export
                            </button>
                          )}
                        </div>
                      )}
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
                          <PiSpinner
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <TfDownload className="h-4 w-4" aria-hidden="true" />
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
                  {cloudSyncEnabled && isPremium && (
                    <div className="space-y-3">
                      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                        Export Projects for Claude
                      </h3>
                      <div
                        className={cn(
                          'space-y-3 rounded-lg border border-border-subtle p-4',
                          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                        )}
                      >
                        <div className="font-aeonik-fono text-xs text-content-muted">
                          Creates a lossy, Claude-compatible projects.json with
                          project names, descriptions, instructions, and
                          extracted document text and metadata. Memory, colors,
                          chats, images, and original document bytes are not
                          included.
                        </div>
                        <button
                          onClick={downloadProjectsForClaude}
                          disabled={isExporting}
                          className={cn(
                            'flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors',
                            isExporting
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-surface-chat',
                            isDarkMode
                              ? 'bg-surface-chat text-content-primary'
                              : 'bg-surface-sidebar text-content-primary',
                          )}
                        >
                          {isExporting && exportType === 'projects' ? (
                            <PiSpinner
                              className="h-4 w-4 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <TfDownload
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          )}
                          {isExporting && exportType === 'projects'
                            ? 'Exporting...'
                            : 'Export Projects for Claude'}
                        </button>
                        {projectExportResult && (
                          <div
                            className="space-y-1 font-aeonik-fono text-xs text-content-muted"
                            role="status"
                          >
                            <div>{projectExportResult.error}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {activeTab === 'safeguards' && isSignedIn && (
                <SafeguardsSettings
                  isDarkMode={isDarkMode}
                  onNavigateToChat={() => setIsOpen(false)}
                  chats={chats}
                />
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
                            onClick={() => void handleSignOut()}
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
                              <PiSpinner
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                              />
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
                                  ? 'bg-brand-accent-dark/20 text-brand-accent-dark dark:bg-brand-accent-light/20 dark:text-brand-accent-light'
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
                                <TfCard
                                  className="h-5 w-5 text-content-muted"
                                  aria-hidden="true"
                                />
                                <div className="font-aeonik text-sm font-medium text-content-primary">
                                  Manage Billing
                                </div>
                              </div>
                              <div className="mt-1 font-aeonik-fono text-xs text-content-muted">
                                Update payment method, view invoices
                              </div>
                            </div>
                            <div className="text-sm text-content-muted">
                              {billingLoading ? (
                                '...'
                              ) : (
                                <TfExternalLink
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              )}
                            </div>
                          </button>
                        )}

                        {upgradeError && (
                          <p className="text-xs text-destructive">
                            {upgradeError}
                          </p>
                        )}
                      </div>

                      <MfaSettingsCard isDarkMode={isDarkMode} />

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
                              <TfPerson
                                className="h-5 w-5 text-content-muted"
                                aria-hidden="true"
                              />
                              <div className="font-aeonik text-sm font-medium text-content-primary">
                                Dashboard
                              </div>
                            </div>
                            <div className="mt-1 font-aeonik-fono text-xs text-content-muted">
                              Manage your account at dash.tinfoil.sh
                            </div>
                          </div>
                          <TfExternalLink
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
                        <TfPerson
                          className="mx-auto h-12 w-12 text-content-muted"
                          aria-hidden="true"
                        />
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
                          <TfSignIn className="h-4 w-4" aria-hidden="true" />
                          Sign in or sign up
                        </Link>
                      </div>
                    </div>
                  )}

                  {/* Legal */}
                  <div className="space-y-3">
                    <h3 className="font-aeonik text-sm font-medium text-content-secondary">
                      Legal
                    </h3>
                    <div
                      className={cn(
                        'rounded-lg border border-border-subtle p-4',
                        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
                      )}
                    >
                      <p className="text-sm leading-relaxed text-content-secondary">
                        By using this service, you agree to Tinfoil&apos;s{' '}
                        <a
                          href={TERMS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-content-primary underline underline-offset-2 transition-colors hover:text-content-secondary"
                        >
                          Terms of Service
                        </a>{' '}
                        and{' '}
                        <a
                          href={PRIVACY_POLICY_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-content-primary underline underline-offset-2 transition-colors hover:text-content-secondary"
                        >
                          Privacy Policy
                        </a>
                        .
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </Dialog.Panel>
    </Dialog>
  )
}
