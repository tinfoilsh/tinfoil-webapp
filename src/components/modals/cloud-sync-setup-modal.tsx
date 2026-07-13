import {
  describeCloudKeySetupFailure,
  determineGeneratedKeySetupMode,
  type CloudKeySetupMode,
  type CloudKeySetupResult,
} from '@/components/modals/cloud-sync-setup-mode'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PaperGrainTexture } from '@/components/ui/paper-grain-texture'
import { SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL } from '@/constants/storage-keys'
import { useToast } from '@/hooks/use-toast'
import { encryptionService } from '@/services/encryption/encryption-service'
import { PrfNotSupportedError } from '@/services/passkey'
import { setCloudSyncEnabled as persistCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { Dialog, Transition } from '@headlessui/react'
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  DocumentDuplicateIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  TfCloud,
  TfFingerprint,
  TfKey,
  TfLock,
  TfRefresh,
  TfShieldCheck,
  TfTinSad,
} from '@tinfoilsh/tinfoil-icons'
import { AnimatePresence, motion } from 'framer-motion'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import { PiSpinner } from 'react-icons/pi'

const STEP_TRANSITION_DURATION_S = 0.2
const STEP_TRANSITION_OFFSET_PX = 16
const BUTTON_COLUMN_CLASS_NAME =
  'mx-auto grid w-full max-w-full grid-cols-1 gap-6 sm:grid-cols-2'
const BUTTON_STACK_CLASS_NAME =
  'mx-auto grid w-full max-w-full grid-cols-1 gap-2'
const BUTTON_ROW_CLASS_NAME =
  'mx-auto grid w-fit max-w-full grid-flow-col auto-cols-fr gap-2'

const ILLUSTRATION_ICON_CLASS_NAME =
  'mx-auto h-20 w-20 text-content-secondary opacity-70'

interface CloudSyncSetupModalBaseProps {
  isOpen: boolean
  onClose: () => void
  onSetupComplete: (
    encryptionKey: string,
    mode: CloudKeySetupMode,
  ) => Promise<CloudKeySetupResult>
  isDarkMode: boolean
  prfSupported?: boolean
  manualRecoveryNeeded?: boolean
  passkeyRecoveryFailure?: 'auth_failed' | 'stale_backup' | null
  /**
   * Called when the user clicks "Skip for Now" on the passkey-recovery step.
   * Lets the caller persist a "don't auto-reopen" flag. When omitted, the
   * button falls back to plain {@link onClose}.
   */
  onSkipRecovery?: () => void
  onSetupWithPasskey?: () => Promise<boolean>
  isContinuePending?: boolean
  isPasskeySetupBusy?: boolean
}
type CloudSyncSetupModalProps = CloudSyncSetupModalBaseProps &
  (
    | {
        passkeyRecoveryNeeded: true
        onRecoverWithPasskey: () => Promise<boolean>
        onSetupNewKey?: () => Promise<string | null>
      }
    | {
        passkeyRecoveryNeeded?: false
        onRecoverWithPasskey?: () => Promise<boolean>
        onSetupNewKey?: () => Promise<string | null>
      }
  )

type SetupStep =
  | 'intro'
  | 'generate-or-restore'
  | 'key-display'
  | 'restore-key'
  | 'restore-success'
  | 'passkey-recovery'
  | 'confirm-start-fresh'
  | 'setup-failed'

export function CloudSyncSetupModal({
  isOpen,
  onClose,
  onSetupComplete,
  isDarkMode,
  passkeyRecoveryNeeded = false,
  prfSupported = false,
  manualRecoveryNeeded = false,
  passkeyRecoveryFailure = null,
  onSkipRecovery,
  onSetupWithPasskey,
  isContinuePending = false,
  isPasskeySetupBusy = false,
  onRecoverWithPasskey,
  onSetupNewKey,
}: CloudSyncSetupModalProps) {
  const initialStep: SetupStep = passkeyRecoveryNeeded
    ? 'passkey-recovery'
    : manualRecoveryNeeded
      ? 'generate-or-restore'
      : 'intro'
  const [currentStep, setCurrentStep] = useState<SetupStep>(initialStep)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generatedKeyMode, setGeneratedKeyMode] =
    useState<CloudKeySetupMode>('recoverExisting')
  const [inputKey, setInputKey] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isStartingFresh, setIsStartingFresh] = useState(false)
  const [keyAlreadyActivated, setKeyAlreadyActivated] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [startFreshOrigin, setStartFreshOrigin] = useState<
    'passkey-recovery' | 'generate-or-restore'
  >('passkey-recovery')
  const { toast } = useToast()
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [])

  const handleMaybeLater = () => {
    persistCloudSyncEnabled(false)
    localStorage.setItem(SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL, 'true')
    onClose()
  }

  const handleContinue = async () => {
    if (onSetupWithPasskey) {
      try {
        const success = await onSetupWithPasskey()
        if (success) {
          setCurrentStep('restore-success')
        } else {
          setSetupError(
            'Could not create passkey backup. You can try again later.',
          )
          setCurrentStep('setup-failed')
        }
      } catch (error) {
        logError('Could not start passkey setup', error, {
          component: 'CloudSyncSetupModal',
          action: 'handleContinue',
        })
        setSetupError(
          'Could not create passkey backup. You can try again later.',
        )
        setCurrentStep('setup-failed')
      }
      return
    }
    setCurrentStep(
      passkeyRecoveryNeeded ? 'passkey-recovery' : 'generate-or-restore',
    )
  }

  const handleGenerateKey = async () => {
    setIsProcessing(true)
    try {
      const newKey = await encryptionService.generateKey()
      const keySetupMode = await determineGeneratedKeySetupMode({
        manualRecoveryNeeded,
      })
      setGeneratedKey(newKey)
      setGeneratedKeyMode(keySetupMode)

      logInfo('Generated new encryption key for cloud sync', {
        component: 'CloudSyncSetupModal',
        action: 'handleGenerateKey',
      })

      // Activating a generated key over existing cloud data wipes that
      // data (start_fresh), so it must never happen on a single click —
      // route through the explicit confirmation step first.
      if (keySetupMode === 'explicitStartFresh') {
        setStartFreshOrigin('generate-or-restore')
        setCurrentStep('confirm-start-fresh')
        return
      }

      await proceedWithGeneratedKey(newKey, keySetupMode)
    } catch (error) {
      logError('Failed to generate encryption key', error, {
        component: 'CloudSyncSetupModal',
        action: 'handleGenerateKey',
      })
      setSetupError('Failed to generate encryption key')
      setCurrentStep('setup-failed')
    } finally {
      setIsProcessing(false)
    }
  }

  // When the user has a PRF-capable passkey, the passkey wraps the
  // encryption key for them — they don't need to manually save a recovery
  // copy. Skip the "Save this key securely" step and complete the flow
  // immediately. They can reveal the backup key from Settings later if
  // they want a paper copy.
  const proceedWithGeneratedKey = async (
    newKey: string,
    keySetupMode: CloudKeySetupMode,
  ) => {
    if (prfSupported && !manualRecoveryNeeded) {
      const result = await onSetupComplete(newKey, keySetupMode)
      if (result.ok) {
        persistCloudSyncEnabled(true)
        setKeyAlreadyActivated(true)
        setCurrentStep('key-display')
        return
      }
      // Fall through to the manual key-display step so the user can
      // save the key and retry via Done, but tell them why the
      // automatic activation did not complete.
      const { description } = describeCloudKeySetupFailure(result.reason)
      setSetupError(description)
      setCurrentStep('setup-failed')
      return
    }

    setCurrentStep('key-display')
  }

  const handleRestoreKey = async () => {
    if (!inputKey.trim()) return

    setIsProcessing(true)
    try {
      const result = await onSetupComplete(inputKey, 'recoverExisting')

      if (!result.ok) {
        const { description } = describeCloudKeySetupFailure(result.reason)
        setSetupError(description)
        setCurrentStep('setup-failed')
        return
      }

      persistCloudSyncEnabled(true)
      localStorage.setItem(SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL, 'true')

      logInfo('Restored encryption key for cloud sync', {
        component: 'CloudSyncSetupModal',
        action: 'handleRestoreKey',
      })

      setCurrentStep('restore-success')
    } catch (error) {
      logError('Failed to restore encryption key', error, {
        component: 'CloudSyncSetupModal',
        action: 'handleRestoreKey',
      })
      setSetupError('The encryption key you entered is invalid')
      setCurrentStep('setup-failed')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleCopyKey = async () => {
    if (!generatedKey) return

    try {
      await navigator.clipboard.writeText(generatedKey)
      setIsCopied(true)

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }

      copyTimeoutRef.current = setTimeout(() => {
        setIsCopied(false)
        copyTimeoutRef.current = null
      }, 2000)
    } catch (error) {
      toast({
        title: 'Failed to copy',
        description: 'Could not copy encryption key to clipboard',
        variant: 'destructive',
      })
    }
  }

  const downloadKeyAsPEM = () => {
    if (!generatedKey) return

    const pemContent = `-----BEGIN TINFOIL CHAT ENCRYPTION KEY-----
${generatedKey.replace('key_', '')}
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
      } catch (error) {
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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      await handleFileImport(file)
      e.target.value = ''
    }
  }

  const handleComplete = () => {
    if (!generatedKey) return

    if (keyAlreadyActivated) {
      localStorage.setItem(SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL, 'true')
      persistCloudSyncEnabled(true)
      onClose()
      return
    }

    setIsProcessing(true)
    void onSetupComplete(generatedKey, generatedKeyMode)
      .then((result) => {
        if (!result.ok) {
          const { description } = describeCloudKeySetupFailure(result.reason)
          setSetupError(description)
          setCurrentStep('setup-failed')
          return
        }

        localStorage.setItem(SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL, 'true')
        persistCloudSyncEnabled(true)
        onClose()
      })
      .catch((error) => {
        setSetupError(
          error instanceof Error
            ? error.message
            : 'Failed to finish cloud sync setup',
        )
        setCurrentStep('setup-failed')
      })
      .finally(() => {
        setIsProcessing(false)
      })
  }

  const renderIntroStep = () => (
    <div className="flex h-full flex-col gap-6">
      <TfCloud className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">
          Encrypted Backups &amp; Sync
        </h2>
        <p className="text-balance text-center text-sm text-content-secondary">
          Tinfoil offers seamless end-to-end encrypted backups and sync across
          devices.
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div className="grid w-full max-w-xs grid-cols-1 gap-8">
          <Card dashedLines texture className="relative z-10 space-y-1 p-4">
            <TfLock className="mx-auto h-5 w-5 text-content-secondary" />
            <p className="text-balance text-center text-sm font-medium text-content-primary">
              End-to-End Encrypted
            </p>
            <p className="text-balance text-center text-xs text-content-muted">
              All chats are encrypted with a key that lives on your device.
            </p>
          </Card>

          <Card dashedLines texture className="relative z-10 space-y-1 p-4">
            <TfKey className="mx-auto h-5 w-5 text-content-secondary" />
            <p className="text-balance text-center text-sm font-medium text-content-primary">
              You Control Your Key
            </p>
            <p className="text-balance text-center text-xs text-content-muted">
              Only you have access to your encryption key.
            </p>
          </Card>
        </div>
      </div>

      <div
        className={`mx-auto mt-auto grid w-fit grid-cols-1 gap-2 sm:grid-cols-2`}
      >
        <Button
          variant="landingOutline"
          size="landing"
          chevron
          onClick={handleMaybeLater}
          disabled={isContinuePending || isPasskeySetupBusy}
          className="w-full min-w-[7rem]"
        >
          Maybe later
        </Button>
        <Button
          variant="solid"
          size="landing"
          chevron
          onClick={handleContinue}
          disabled={isContinuePending || isPasskeySetupBusy}
          className="w-full min-w-[7rem]"
        >
          {isPasskeySetupBusy ? 'Setting up...' : 'Continue'}
        </Button>
      </div>
    </div>
  )

  const renderGenerateOrRestoreStep = () => (
    <div className="flex h-full flex-col gap-5">
      <TfKey className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-2">
        <h2 className="text-balance text-center text-xl font-bold">
          Encryption Key
        </h2>
        <p className="text-balance text-center text-sm leading-relaxed text-content-secondary">
          {manualRecoveryNeeded
            ? 'Restore your existing encryption key to unlock cloud data, or explicitly start fresh with a new key.'
            : 'This device does not have a passkey. You can generate a new personal encryption key or restore an existing one from another device. Your chats will be encrypted and synced with this personal key.'}
        </p>
      </div>

      <div className={`mt-auto pt-4 ${BUTTON_COLUMN_CLASS_NAME}`}>
        <div className="w-full space-y-3">
          <p className="text-center text-sm font-medium text-content-primary">
            Have an existing key?
          </p>
          <Button
            variant="solid"
            size="landing"
            chevron
            onClick={() => setCurrentStep('restore-key')}
            disabled={isProcessing}
            className="w-full"
          >
            Restore Encryption Key
          </Button>
        </div>
        <div className="w-full space-y-3">
          <p className="text-center text-sm font-medium text-content-primary">
            {manualRecoveryNeeded ? 'Need a new key?' : 'First time set up?'}
          </p>
          <Button
            variant="landingOutline"
            size="landing"
            chevron
            onClick={handleGenerateKey}
            disabled={isProcessing}
            className="w-full"
          >
            {isProcessing && (
              <PiSpinner
                data-testid="generate-key-spinner"
                aria-hidden
                className="h-4 w-4 animate-spin"
              />
            )}
            {isProcessing
              ? 'Generating...'
              : manualRecoveryNeeded
                ? 'Start Fresh'
                : 'Generate Encryption Key'}
          </Button>
        </div>
      </div>
    </div>
  )

  const renderKeyDisplayStep = () => (
    <div className="flex h-full flex-col gap-8">
      <TfShieldCheck className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">Success!</h2>

        <p className="text-balance text-center text-sm text-content-secondary">
          {generatedKeyMode === 'explicitStartFresh'
            ? 'Save this key securely. Using it will start a new encrypted cloud history on this device.'
            : "Save this key securely. You'll need it to access your chats and projects on other devices."}
        </p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        {generatedKey && (
          <Card dashedLines texture className="w-full max-w-xs p-3">
            <div className="max-h-24 overflow-y-auto">
              <code className="break-all font-mono text-sm text-blue-400 drop-shadow-[0_0_6px_rgba(96,165,250,0.5)]">
                {generatedKey}
              </code>
            </div>
          </Card>
        )}

        {generatedKey && (
          <div className="grid w-fit grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              variant="landingOutline"
              size="landingSm"
              chevron
              onClick={downloadKeyAsPEM}
              className="w-full min-w-[5rem]"
              title="Download as PEM file"
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              Download
            </Button>
            <Button
              variant="landingOutline"
              size="landingSm"
              chevron
              onClick={handleCopyKey}
              className={`w-full min-w-[5rem] ${
                isCopied
                  ? 'border-emerald-500 bg-emerald-500 text-white hover:border-emerald-600 hover:bg-emerald-600'
                  : ''
              }`}
              title="Copy to clipboard"
            >
              {isCopied ? (
                <>
                  <CheckIcon className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <DocumentDuplicateIcon className="h-4 w-4" />
                  Copy
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      <Button
        variant="solid"
        size="landing"
        chevron
        onClick={handleComplete}
        className="mx-auto mt-auto"
      >
        Let&apos;s go!
      </Button>
    </div>
  )

  const renderRestoreKeyStep = () => (
    <div className="flex h-full flex-col gap-8">
      <TfRefresh className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">
          Restore Encryption Key
        </h2>

        <p className="text-balance text-center text-sm text-content-secondary">
          Enter or upload your personal encryption key.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!isProcessing && inputKey.trim()) {
            handleRestoreKey()
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="flex flex-1 flex-col items-center justify-center gap-2"
        id="encryption-key-form"
      >
        <div className="flex w-full max-w-xs gap-2">
          <input
            type="text"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            placeholder="Enter encryption key"
            autoComplete="off"
            className="flex-1 rounded-lg border border-blue-500 bg-surface-input px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".pem"
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            variant="landingOutline"
            size="icon"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0"
            title="Upload PEM file"
          >
            <ArrowUpTrayIcon className="h-5 w-5" />
          </Button>
        </div>
        {isDragging && (
          <p className="text-center text-sm text-blue-500">
            Drop your PEM file here
          </p>
        )}
      </form>

      <div className="mx-auto mt-auto grid w-fit grid-cols-1 gap-2 pt-4 sm:grid-cols-2">
        <Button
          variant="landingOutline"
          size="landing"
          chevron
          back
          type="button"
          onClick={() =>
            setCurrentStep(
              passkeyRecoveryNeeded
                ? 'passkey-recovery'
                : 'generate-or-restore',
            )
          }
          className="w-full min-w-[6rem]"
        >
          Back
        </Button>
        <Button
          variant="solid"
          size="landing"
          chevron
          type="submit"
          disabled={isProcessing || !inputKey.trim()}
          className="w-full min-w-[6rem]"
          form="encryption-key-form"
        >
          {isProcessing ? 'Restoring...' : 'Restore Key'}
        </Button>
      </div>
    </div>
  )

  const renderRestoreSuccessStep = () => (
    <div className="flex h-full flex-col gap-8">
      <TfShieldCheck className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">Success!</h2>

        <p className="text-balance text-center text-sm text-content-secondary">
          Your encryption key was restored successfully. Your encrypted chats
          are now synced to this device.
        </p>
      </div>

      <Button
        variant="solid"
        size="landing"
        chevron
        onClick={onClose}
        className="mx-auto mt-auto"
      >
        Let&apos;s go!
      </Button>
    </div>
  )

  const renderSetupFailedStep = () => (
    <div className="flex h-full flex-col gap-8">
      <TfTinSad className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">
          Setup Failed
        </h2>

        <p className="text-balance text-center text-sm text-content-secondary">
          {setupError}
        </p>
      </div>

      <div className="mx-auto mt-auto grid w-fit grid-cols-1 gap-2 pt-4 sm:grid-cols-2">
        <Button
          variant="landingOutline"
          size="landing"
          chevron
          back
          onClick={() => setCurrentStep('generate-or-restore')}
          className="w-full min-w-[6rem]"
        >
          Go Back
        </Button>
        <Button
          variant="solid"
          size="landing"
          chevron
          onClick={onClose}
          className="w-full min-w-[6rem]"
        >
          Close
        </Button>
      </div>
    </div>
  )

  const handlePasskeyRecovery = async () => {
    if (!onRecoverWithPasskey) return
    setIsRecovering(true)
    setRecoveryFailed(false)
    try {
      const success = await onRecoverWithPasskey()
      if (success) {
        setCurrentStep('restore-success')
      } else {
        setRecoveryFailed(true)
      }
    } catch (error) {
      logError('Passkey recovery failed', error, {
        component: 'CloudSyncSetupModal',
        action: 'handlePasskeyRecovery',
      })
      setRecoveryFailed(true)
    } finally {
      setIsRecovering(false)
    }
  }

  const handleStartFresh = async () => {
    if (!onSetupNewKey) return
    setIsStartingFresh(true)
    try {
      const key = await onSetupNewKey()
      if (key) {
        setGeneratedKey(key)
        setGeneratedKeyMode('explicitStartFresh')
        setKeyAlreadyActivated(true)
        setCurrentStep('key-display')
      } else {
        setSetupError(
          'Could not create a new encryption key. Please try again.',
        )
        setCurrentStep('setup-failed')
      }
    } catch (error) {
      if (error instanceof PrfNotSupportedError) {
        setSetupError(error.message)
        setCurrentStep('setup-failed')
      } else {
        logError('Start fresh failed', error, {
          component: 'CloudSyncSetupModal',
          action: 'handleStartFresh',
        })
        setSetupError(
          'Could not create a new encryption key. Please try again.',
        )
        setCurrentStep('setup-failed')
      }
    } finally {
      setIsStartingFresh(false)
    }
  }

  const renderPasskeyRecoveryStep = () => (
    <div className="flex h-full flex-col gap-8">
      <TfLock className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">
          Unlock Your Chats
        </h2>

        <p className="text-balance text-center text-sm text-content-secondary">
          Your encrypted chats are stored in the cloud. Authenticate with your
          passkey to recover your encryption key on this device.
        </p>

        {recoveryFailed && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-balance text-center text-xs text-amber-700 dark:text-amber-400">
              {passkeyRecoveryFailure === 'stale_backup'
                ? "This passkey is valid, but its backup key doesn't match your existing cloud data. Enter your backup key manually, or start fresh if you no longer need the old data."
                : 'Passkey authentication failed. You can try again or enter your encryption key manually.'}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <Button
          variant="solid"
          size="landing"
          chevron
          onClick={handlePasskeyRecovery}
          disabled={isRecovering}
          className="min-w-[11rem]"
        >
          <TfFingerprint className="h-4 w-4" />
          {isRecovering ? 'Authenticating...' : 'Unlock with Passkey'}
        </Button>

        <div className="relative my-2 w-full">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border-subtle" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-surface-card px-2 text-content-muted">or</span>
          </div>
        </div>

        <div className="grid w-fit grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="landingOutline"
            size="landing"
            chevron
            onClick={() => setCurrentStep('restore-key')}
            disabled={isRecovering || isStartingFresh}
            className="w-full"
          >
            <TfKey className="h-4 w-4" />
            Enter Key Manually
          </Button>

          {onSetupNewKey && (
            <Button
              variant="landingOutline"
              size="landing"
              chevron
              onClick={() => {
                setStartFreshOrigin('passkey-recovery')
                setCurrentStep('confirm-start-fresh')
              }}
              disabled={isRecovering || isStartingFresh}
              className="w-full"
            >
              <TfRefresh className="h-4 w-4" />
              Start Fresh
            </Button>
          )}
        </div>
      </div>

      <Button
        variant="ghost"
        size="landingSm"
        onClick={onSkipRecovery ?? onClose}
        disabled={isRecovering || isStartingFresh}
        className="self-center text-content-muted hover:bg-transparent hover:text-content-secondary"
      >
        Skip for Now
      </Button>
    </div>
  )

  const handleConfirmStartFresh = async () => {
    if (startFreshOrigin === 'generate-or-restore') {
      if (!generatedKey) return
      setIsStartingFresh(true)
      try {
        await proceedWithGeneratedKey(generatedKey, 'explicitStartFresh')
      } catch (error) {
        logError('Start fresh with generated key failed', error, {
          component: 'CloudSyncSetupModal',
          action: 'handleConfirmStartFresh',
        })
        setSetupError(
          'Could not activate the new encryption key. Please try again.',
        )
        setCurrentStep('setup-failed')
      } finally {
        setIsStartingFresh(false)
      }
      return
    }
    await handleStartFresh()
  }

  const renderConfirmStartFreshStep = () => (
    <div className="flex h-full flex-col gap-8">
      <TfTinSad className={ILLUSTRATION_ICON_CLASS_NAME} />

      <div className="space-y-3">
        <h2 className="text-balance text-center text-xl font-bold">
          You will lose your conversations
        </h2>

        <p className="text-balance text-center text-sm text-content-secondary">
          Starting fresh will generate a new encryption key that is not
          compatible with your existing one.
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-sm rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-balance text-center text-sm font-semibold text-red-700 dark:text-red-400">
            Your existing encrypted cloud data will be deleted. All your
            conversations and settings encrypted with the old key will be lost.
          </p>
        </div>
      </div>

      <div className="mx-auto mt-auto grid w-fit grid-cols-1 gap-2 pt-4 sm:grid-cols-2">
        <Button
          variant="landingOutline"
          size="landing"
          chevron
          back
          onClick={() => setCurrentStep(startFreshOrigin)}
          disabled={isStartingFresh}
          className="w-full min-w-[7rem]"
        >
          Go Back
        </Button>

        <Button
          variant="solid"
          size="landing"
          chevron
          onClick={handleConfirmStartFresh}
          disabled={isStartingFresh}
          className="w-full min-w-[7rem] border-red-600 bg-red-600 hover:border-red-700 hover:bg-red-700"
        >
          {isStartingFresh ? 'Creating...' : 'Yes, start fresh'}
        </Button>
      </div>
    </div>
  )

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 'intro':
        return renderIntroStep()
      case 'generate-or-restore':
        return renderGenerateOrRestoreStep()
      case 'key-display':
        return renderKeyDisplayStep()
      case 'restore-key':
        return renderRestoreKeyStep()
      case 'restore-success':
        return renderRestoreSuccessStep()
      case 'setup-failed':
        return renderSetupFailedStep()
      case 'passkey-recovery':
        return renderPasskeyRecoveryStep()
      case 'confirm-start-fresh':
        return renderConfirmStartFreshStep()
    }
  }

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={() => {}}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/30 backdrop-blur-md" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel
                className={`relative h-[calc(100dvh-2rem)] max-h-[40rem] w-full max-w-xl transform overflow-hidden rounded-site-lg border p-4 pt-8 text-left align-middle shadow-xl transition-all sm:p-10 sm:pt-16 ${
                  isDarkMode
                    ? 'border-border-subtle bg-surface-card'
                    : 'border-black/10 bg-[#F9F8F6]'
                }`}
              >
                {!isDarkMode && <PaperGrainTexture />}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  aria-label="Close"
                  className="absolute right-4 top-4 z-30 h-7 w-7 text-content-secondary hover:bg-surface-chat hover:text-content-secondary"
                >
                  <XMarkIcon className="h-5 w-5" />
                </Button>

                <div className="relative z-10 h-full">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={currentStep}
                      className="h-full overflow-y-auto"
                      initial={{
                        opacity: 0,
                        x: STEP_TRANSITION_OFFSET_PX,
                      }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{
                        opacity: 0,
                        x: -STEP_TRANSITION_OFFSET_PX,
                      }}
                      transition={{
                        duration: STEP_TRANSITION_DURATION_S,
                        ease: 'easeOut',
                      }}
                    >
                      {renderCurrentStep()}
                    </motion.div>
                  </AnimatePresence>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
