import { Modal, ModalDescription, ModalTitle } from '@/components/ui/modal'
import { useUpgradeToPro } from '@/hooks/use-upgrade-to-pro'
import Link from 'next/link'
import { useRouter } from 'next/router'

interface SubscribePromptModalProps {
  isOpen: boolean
  onClose: () => void
  isSignedIn: boolean
}

export function SubscribePromptModal({
  isOpen,
  onClose,
  isSignedIn,
}: SubscribePromptModalProps) {
  const { startUpgrade, upgradeLoading, upgradeError } = useUpgradeToPro()
  const router = useRouter()
  // Send users back to where they hit the limit after they authenticate,
  // instead of dropping them on the home screen.
  const signInHref = `/signin?redirect_url=${encodeURIComponent(router.asPath)}`

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalTitle className="mt-2 text-balance px-8 text-center text-xl font-bold">
        You&apos;ve used your free requests
      </ModalTitle>

      <ModalDescription className="mt-2 text-balance px-2 text-center">
        Subscribe to keep chatting without daily request limits.
      </ModalDescription>

      <p className="mt-3 text-center text-sm text-content-secondary">
        <span className="font-aeonik text-base font-semibold text-content-primary">
          $20
        </span>
        <span className="text-content-muted">/month</span>
        <span className="mx-2 text-content-muted">·</span>
        <span>Cancel anytime</span>
      </p>

      <div className="mt-6 space-y-2">
        {isSignedIn ? (
          <>
            <button
              type="button"
              onClick={() => {
                onClose()
                void startUpgrade()
              }}
              disabled={upgradeLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {upgradeLoading ? 'Redirecting…' : 'Subscribe to Premium'}
            </button>
            {upgradeError && (
              <p className="text-center text-xs text-destructive">
                {upgradeError}
              </p>
            )}
          </>
        ) : (
          <>
            <Link
              href={signInHref}
              onClick={onClose}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
            >
              Subscribe to Premium
            </Link>
            <p className="text-center text-xs text-content-secondary">
              Already subscribed?{' '}
              <Link
                href={signInHref}
                onClick={onClose}
                className="cursor-pointer underline hover:text-content-primary"
              >
                Log in
              </Link>
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}
