import { Dialog, Transition } from '@headlessui/react'
import { CloudArrowUpIcon, KeyIcon } from '@heroicons/react/24/outline'
import { Fragment } from 'react'

interface PasskeySetupPromptModalProps {
  isOpen: boolean
  isBusy?: boolean
  /** User confirmed they want to enable passkey-backed cloud sync. */
  onEnable: () => void
  /** User dismissed the prompt (cloud sync stays off). */
  onDismiss: () => void
}

export function PasskeySetupPromptModal({
  isOpen,
  isBusy = false,
  onEnable,
  onDismiss,
}: PasskeySetupPromptModalProps) {
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
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl border border-border-subtle bg-surface-card p-6 text-left align-middle shadow-xl transition-all">
                <div className="flex items-center justify-center">
                  <div className="rounded-full bg-brand-accent-dark/15 p-3">
                    <CloudArrowUpIcon className="h-8 w-8 text-brand-accent-dark" />
                  </div>
                </div>

                <Dialog.Title
                  as="h2"
                  className="mt-4 text-center font-aeonik text-xl font-bold text-content-primary"
                >
                  Back Up Your Chats
                </Dialog.Title>

                <div className="mt-4 space-y-3 text-sm text-content-secondary">
                  <p>
                    Tinfoil can encrypt and back up your chats with a passkey so
                    you can access them across devices.
                  </p>
                </div>

                <div className="mt-5 space-y-2">
                  <button
                    onClick={onEnable}
                    disabled={isBusy}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <KeyIcon className="h-4 w-4" />
                    {isBusy ? 'Setting up...' : 'Enable with Passkey'}
                  </button>

                  <button
                    onClick={onDismiss}
                    disabled={isBusy}
                    className="w-full rounded-lg border border-border-subtle bg-surface-chat px-4 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat/80 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Not Now
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
