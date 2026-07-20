import { cn } from '@/components/ui/utils'
import { getClerkErrorMessage } from '@/utils/clerk-errors'
import { logError, logWarning } from '@/utils/error-handling'
import { useReverification, useUser } from '@clerk/nextjs'
import { isReverificationCancelledError } from '@clerk/nextjs/errors'
import {
  CheckCircleIcon,
  ClipboardDocumentIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { memo, useCallback, useRef, useState, type FormEvent } from 'react'
import { PiSpinner } from 'react-icons/pi'
import QRCode from 'react-qr-code'
import { ConfirmDialog } from './components/confirm-dialog'

const TOTP_CODE_LENGTH = 6
const MFA_ERROR_MESSAGE =
  'Could not update multi-factor authentication. Please try again.'

type MfaSettingsCardProps = {
  isDarkMode: boolean
}

type TotpSetup = {
  uri?: string
  secret?: string
}

const TotpQrCode = memo(function TotpQrCode({ uri }: { uri: string }) {
  return <QRCode value={uri} size={160} level="M" />
})

export function MfaSettingsCard({ isDarkMode }: MfaSettingsCardProps) {
  const { isLoaded, user } = useUser()
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [isStartingSetup, setIsStartingSetup] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [isDisabling, setIsDisabling] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copiedTarget, setCopiedTarget] = useState<
    'setup-key' | 'backup-codes' | null
  >(null)
  const [totpEnabledOverride, setTotpEnabledOverride] = useState<{
    userId: string
    enabled: boolean
  } | null>(null)
  const mfaActionButtonRef = useRef<HTMLButtonElement>(null)

  const createTOTP = useReverification(
    useCallback(async () => {
      if (!user) {
        throw new Error('User is not available')
      }
      return user.createTOTP()
    }, [user]),
  )

  const disableTOTP = useReverification(
    useCallback(async () => {
      if (!user) {
        throw new Error('User is not available')
      }
      return user.disableTOTP()
    }, [user]),
  )

  const totpEnabled =
    user && totpEnabledOverride?.userId === user.id
      ? totpEnabledOverride.enabled
      : (user?.totpEnabled ?? false)

  const refreshUserAfterMfaMutation = async (enabled: boolean) => {
    if (!user) return

    setTotpEnabledOverride({ userId: user.id, enabled })
    try {
      await user.reload()
      setTotpEnabledOverride(null)
    } catch {
      logWarning('Could not refresh user after MFA update', {
        component: 'MfaSettingsCard',
        action: 'refreshUserAfterMfaMutation',
      })
    }
  }

  const handleStartSetup = async () => {
    setIsStartingSetup(true)
    setErrorMessage(null)
    try {
      const resource = await createTOTP()
      setTotpSetup({ uri: resource.uri, secret: resource.secret })
      setVerificationCode('')
      setBackupCodes(null)
      setCopiedTarget(null)
    } catch (error) {
      if (!isReverificationCancelledError(error)) {
        logError('Could not start authenticator app setup', error, {
          component: 'MfaSettingsCard',
          action: 'handleStartSetup',
        })
        setErrorMessage(getClerkErrorMessage(error, MFA_ERROR_MESSAGE))
      }
    } finally {
      setIsStartingSetup(false)
    }
  }

  const handleVerify = async (event: FormEvent) => {
    event.preventDefault()
    if (!user) return

    setIsVerifying(true)
    setErrorMessage(null)
    try {
      const resource = await user.verifyTOTP({ code: verificationCode })
      if (!resource.verified) {
        setErrorMessage('That code could not be verified. Please try again.')
        return
      }

      await refreshUserAfterMfaMutation(true)
      setTotpSetup(null)
      setVerificationCode('')
      setBackupCodes(resource.backupCodes?.length ? resource.backupCodes : [])
      setCopiedTarget(null)
    } catch (error) {
      logError('Could not verify authenticator app setup', error, {
        component: 'MfaSettingsCard',
        action: 'handleVerify',
      })
      setErrorMessage(getClerkErrorMessage(error, MFA_ERROR_MESSAGE))
    } finally {
      setIsVerifying(false)
    }
  }

  const handleCancelSetup = () => {
    setTotpSetup(null)
    setVerificationCode('')
    setErrorMessage(null)
  }

  const handleDisable = async () => {
    setIsDisabling(true)
    setShowDisableConfirm(false)
    setErrorMessage(null)
    try {
      await disableTOTP()
      await refreshUserAfterMfaMutation(false)
      setBackupCodes(null)
    } catch (error) {
      if (!isReverificationCancelledError(error)) {
        logError('Could not disable authenticator app', error, {
          component: 'MfaSettingsCard',
          action: 'handleDisable',
        })
        setErrorMessage(getClerkErrorMessage(error, MFA_ERROR_MESSAGE))
      }
    } finally {
      setIsDisabling(false)
    }
  }

  const handleCopy = async (
    value: string,
    target: 'setup-key' | 'backup-codes',
  ) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedTarget(target)
    } catch (error) {
      logError('Could not copy MFA setup information', error, {
        component: 'MfaSettingsCard',
        action: 'handleCopy',
      })
      setErrorMessage('Could not copy to the clipboard.')
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
        Security
      </h3>
      <div
        className={cn(
          'rounded-lg border border-border-subtle p-4',
          isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
        )}
      >
        <div className="flex items-start gap-3">
          <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-content-muted" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-aeonik text-sm font-medium text-content-primary">
                  Authenticator app
                </div>
                <p className="mt-1 text-xs text-content-muted">
                  Add an extra layer of security with time-based codes.
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
                  totpEnabled
                    ? 'bg-emerald-500/20 text-emerald-500'
                    : 'bg-content-muted/20 text-content-muted',
                )}
              >
                {totpEnabled ? 'On' : 'Off'}
              </span>
            </div>

            {!totpSetup && (
              <button
                ref={mfaActionButtonRef}
                type="button"
                disabled={!isLoaded || !user || isStartingSetup || isDisabling}
                onClick={
                  totpEnabled
                    ? () => setShowDisableConfirm(true)
                    : () => void handleStartSetup()
                }
                className={cn(
                  'mt-4 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  totpEnabled
                    ? 'border-red-500/30 text-red-500 hover:bg-red-500/10'
                    : 'border-border-subtle text-content-primary hover:bg-surface-chat',
                )}
              >
                {(isStartingSetup || isDisabling) && (
                  <PiSpinner className="h-4 w-4 animate-spin" />
                )}
                {isStartingSetup
                  ? 'Starting setup...'
                  : isDisabling
                    ? 'Turning off...'
                    : totpEnabled
                      ? 'Turn off'
                      : 'Set up'}
              </button>
            )}
          </div>
        </div>

        {totpSetup && (
          <form
            onSubmit={handleVerify}
            className="mt-5 border-t border-border-subtle pt-5"
          >
            <p className="text-sm font-medium text-content-primary">
              Scan this code with your authenticator app
            </p>
            <div
              data-testid="totp-qr-code"
              className="mx-auto mt-4 w-fit rounded-lg bg-white p-3"
            >
              {totpSetup.uri && <TotpQrCode uri={totpSetup.uri} />}
            </div>

            {totpSetup.secret && (
              <div className="mt-4">
                <p className="text-xs text-content-muted">
                  Or enter this setup key manually:
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-md bg-surface-chat px-3 py-2">
                  <code className="min-w-0 flex-1 break-all font-aeonik-fono text-xs text-content-primary">
                    {totpSetup.secret}
                  </code>
                  <button
                    type="button"
                    aria-label={
                      copiedTarget === 'setup-key'
                        ? 'Setup key copied'
                        : 'Copy setup key'
                    }
                    onClick={() =>
                      void handleCopy(totpSetup.secret ?? '', 'setup-key')
                    }
                    className="shrink-0 text-content-muted transition-colors hover:text-content-primary"
                  >
                    {copiedTarget === 'setup-key' ? (
                      <CheckCircleIcon className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <ClipboardDocumentIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            )}

            <label
              htmlFor="totp-verification-code"
              className="mt-4 block text-xs font-medium text-content-secondary"
            >
              Enter the 6-digit code
            </label>
            <input
              id="totp-verification-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={TOTP_CODE_LENGTH}
              value={verificationCode}
              onChange={(event) =>
                setVerificationCode(
                  event.target.value
                    .replace(/\D/g, '')
                    .slice(0, TOTP_CODE_LENGTH),
                )
              }
              className="mt-2 h-10 w-full rounded-md border border-border-subtle bg-surface-chat px-3 font-aeonik-fono text-sm tracking-[0.25em] text-content-primary outline-none transition-colors focus:border-border-strong"
            />

            {errorMessage && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {errorMessage}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={isVerifying}
                onClick={handleCancelSetup}
                className="flex-1 rounded-md border border-border-subtle px-3 py-2 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  isVerifying || verificationCode.length !== TOTP_CODE_LENGTH
                }
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-brand-accent-dark px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isVerifying && <PiSpinner className="h-4 w-4 animate-spin" />}
                {isVerifying ? 'Verifying...' : 'Verify and enable'}
              </button>
            </div>
          </form>
        )}

        {!totpSetup && errorMessage && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {errorMessage}
          </p>
        )}
      </div>

      <DialogPrimitive.Root
        open={backupCodes !== null}
        onOpenChange={(open) => {
          if (!open) setBackupCodes(null)
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/60" />
          <DialogPrimitive.Content
            aria-modal="true"
            aria-describedby="mfa-enabled-description"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              mfaActionButtonRef.current?.focus()
            }}
            className={cn(
              'fixed left-1/2 top-1/2 z-[70] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-site-lg border border-border-subtle p-5 shadow-xl focus:outline-none',
              isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
            )}
          >
            <div className="flex items-start gap-3">
              <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
              <div>
                <DialogPrimitive.Title className="font-aeonik text-base font-medium text-content-primary">
                  Authenticator app enabled
                </DialogPrimitive.Title>
                <DialogPrimitive.Description
                  id="mfa-enabled-description"
                  className="mt-1 text-xs text-content-muted"
                >
                  You will use an authenticator code when signing in.
                </DialogPrimitive.Description>
              </div>
            </div>

            {backupCodes && backupCodes.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-content-primary">
                  Save your backup codes
                </p>
                <p className="mt-1 text-xs text-content-muted">
                  Store these somewhere safe. Each code can only be used once.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-surface-chat p-3 font-aeonik-fono text-xs text-content-primary">
                  {backupCodes.map((code) => (
                    <span key={code}>{code}</span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopy(backupCodes.join('\n'), 'backup-codes')
                  }
                  className="mt-3 flex items-center gap-2 text-xs font-medium text-content-secondary transition-colors hover:text-content-primary"
                >
                  <ClipboardDocumentIcon className="h-4 w-4" />
                  {copiedTarget === 'backup-codes' ? 'Copied' : 'Copy'} all
                  codes
                </button>
              </div>
            )}

            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="mt-4 w-full rounded-md bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
              >
                Done
              </button>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <ConfirmDialog
        isOpen={showDisableConfirm}
        title="Turn off authenticator MFA?"
        description="Authenticator codes will no longer protect your account. You may still be asked for an email code."
        confirmLabel="Turn off"
        variant="destructive"
        onConfirm={() => void handleDisable()}
        onCancel={() => setShowDisableConfirm(false)}
      />
    </div>
  )
}
