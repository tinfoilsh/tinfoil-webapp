import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Fragment, type ReactNode } from 'react'
import { Button } from './button'
import { cn } from './utils'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  /** Extra classes merged into the panel, e.g. to change max-width or padding */
  className?: string
  /** Extra classes merged into the backdrop overlay */
  overlayClassName?: string
  showCloseButton?: boolean
  /** When false, clicking the overlay or pressing Escape does not close the modal */
  dismissible?: boolean
}

const noop = () => {}

export function Modal({
  isOpen,
  onClose,
  children,
  className,
  overlayClassName,
  showCloseButton = true,
  dismissible = true,
}: ModalProps) {
  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-50"
        onClose={dismissible ? onClose : noop}
      >
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className={cn('fixed inset-0 bg-black/50', overlayClassName)} />
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
                className={cn(
                  'relative w-full max-w-md transform overflow-hidden rounded-site-lg border border-border-subtle bg-surface-card p-6 text-left align-middle shadow-xl transition-all',
                  className,
                )}
              >
                {showCloseButton && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    aria-label="Close"
                    className="absolute right-4 top-4 z-30 h-7 w-7 text-content-secondary hover:bg-surface-chat hover:text-content-secondary"
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </Button>
                )}
                {children}
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}

interface ModalTextProps {
  children: ReactNode
  className?: string
}

export function ModalTitle({ children, className }: ModalTextProps) {
  return (
    <Dialog.Title
      as="h3"
      className={cn(
        'font-aeonik text-lg font-medium leading-6 text-content-primary',
        className,
      )}
    >
      {children}
    </Dialog.Title>
  )
}

export function ModalDescription({ children, className }: ModalTextProps) {
  return (
    <Dialog.Description
      className={cn('text-sm text-content-secondary', className)}
    >
      {children}
    </Dialog.Description>
  )
}
