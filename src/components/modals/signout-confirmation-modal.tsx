import { Modal, ModalTitle } from '@/components/ui/modal'
import { ArrowDownTrayIcon, CheckIcon } from '@heroicons/react/24/outline'
import { useCallback, useState } from 'react'

interface SignoutConfirmationModalProps {
  isOpen: boolean
  /** Called when the user clicks "Done" — caller should delete the key + reload */
  onDone: () => void
  encryptionKey: string | null
  isDarkMode: boolean
}

export function SignoutConfirmationModal({
  isOpen,
  onDone,
  encryptionKey,
  isDarkMode,
}: SignoutConfirmationModalProps) {
  // Theme now derives from global CSS variables; keep prop for compatibility.
  void isDarkMode
  const [hasDownloadedKey, setHasDownloadedKey] = useState(false)

  const downloadKeyAsPEM = useCallback(() => {
    if (!encryptionKey) return

    // Convert the key to PEM format
    const pemContent = `-----BEGIN TINFOIL CHAT ENCRYPTION KEY-----
${encryptionKey.replace('key_', '')}
-----END TINFOIL CHAT ENCRYPTION KEY-----`

    // Create blob and trigger download
    const blob = new Blob([pemContent], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `tinfoil-chat-key-${new Date().toISOString().split('T')[0]}.pem`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    setHasDownloadedKey(true)
  }, [encryptionKey])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onDone}
      dismissible={false}
      showCloseButton={false}
    >
      <ModalTitle>Save Your Encryption Key</ModalTitle>

      <div className="mt-4 space-y-5">
        {/* Explanation */}
        <div className="rounded-lg border border-border-subtle bg-surface-chat p-4">
          <p className="text-sm text-content-secondary">
            You&apos;ve been signed out. Download your encryption key to keep
            access to your chats on other devices.
          </p>
        </div>

        {/* Download Key */}
        {encryptionKey && (
          <div>
            <button
              onClick={downloadKeyAsPEM}
              disabled={hasDownloadedKey}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                hasDownloadedKey
                  ? 'cursor-not-allowed border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                  : 'border-brand-accent-dark/40 bg-brand-accent-dark text-white hover:bg-brand-accent-dark/90'
              }`}
            >
              {hasDownloadedKey ? (
                <>
                  <CheckIcon className="h-4 w-4" />
                  Key Downloaded
                </>
              ) : (
                <>
                  <ArrowDownTrayIcon className="hidden h-4 w-4 sm:block" />
                  Download Encryption Key
                </>
              )}
            </button>
          </div>
        )}

        {/* Done button — highlighted only after key is downloaded */}
        <button
          onClick={onDone}
          className={`w-full rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
            hasDownloadedKey
              ? 'border-brand-accent-dark/40 bg-brand-accent-dark text-white hover:bg-brand-accent-dark/90'
              : 'border-border-subtle bg-surface-chat text-content-muted hover:bg-surface-chat/80'
          }`}
        >
          Done
        </button>
      </div>
    </Modal>
  )
}
