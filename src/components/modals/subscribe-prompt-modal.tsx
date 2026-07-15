import { useUpgradeToPro } from '@/hooks/use-upgrade-to-pro'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { Fragment } from 'react'

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

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50" />
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
              <Dialog.Panel className="relative w-full max-w-md transform overflow-hidden rounded-2xl border border-border-subtle bg-surface-card p-6 text-left align-middle shadow-xl transition-all">
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="absolute right-3 top-3 rounded-full p-1.5 text-content-muted transition-colors hover:bg-surface-chat-background hover:text-content-primary"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>

                <Dialog.Title
                  as="h2"
                  className="mt-2 text-balance px-8 text-center font-aeonik text-xl font-bold text-content-primary"
                >
                  You&apos;ve used your free requests
                </Dialog.Title>

                <Dialog.Description className="mt-2 text-balance px-2 text-center text-sm text-content-secondary">
                  Subscribe to keep chatting without daily request limits.
                </Dialog.Description>

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
                        {upgradeLoading
                          ? 'Redirecting…'
                          : 'Subscribe to Premium'}
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
                        href="/signin"
                        onClick={onClose}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
                      >
                        Subscribe to Premium
                      </Link>
                      <p className="text-center text-xs text-content-secondary">
                        Already subscribed?{' '}
                        <Link
                          href="/signin"
                          onClick={onClose}
                          className="cursor-pointer underline hover:text-content-primary"
                        >
                          Log in
                        </Link>
                      </p>
                    </>
                  )}
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
