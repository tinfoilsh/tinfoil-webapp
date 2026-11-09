'use client'

import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { TfHorizontalEllipsis, TfShare } from '@tinfoilsh/tinfoil-icons'
import {
  TfLockLockedAnimated,
  TfLockOpenedAnimated,
  TfThumbtackAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import { useId } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { cn } from '../ui/utils'
import {
  VERIFIED_LABEL,
  type VerificationStatus,
} from './verification-status-button'

const MENU_GAP_PX = 4
const ITEM_CLASS_NAME =
  'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-content-secondary transition-colors data-[focus]:bg-gray-100 dark:data-[focus]:bg-surface-sidebar'
const VERIFICATION_FAILED_LABEL = 'Verification failed'

function VerificationItemContent({ status }: { status: VerificationStatus }) {
  if (status === 'pending')
    return (
      <>
        <PiSpinner className="h-4 w-4 animate-spin" aria-hidden="true" />
        Verifying...
      </>
    )
  if (status === 'verified')
    return (
      <>
        <TfLockLockedAnimated
          className="h-4 w-4 !text-brand-accent-dark dark:!text-brand-accent-light"
          aria-hidden="true"
        />
        {VERIFIED_LABEL}
      </>
    )
  return (
    <>
      <TfLockOpenedAnimated
        className="h-4 w-4 !text-red-500"
        aria-hidden="true"
      />
      {VERIFICATION_FAILED_LABEL}
    </>
  )
}

// The open chat's occasional actions, and how verifying the chat service
// went, behind one button where the chat header has room only for the
// actions used most. A failed verification marks the button, so it is not
// missed.
export function ChatHeaderMenu({
  verificationStatus,
  onOpenVerification,
  onShare,
  isPinned,
  onTogglePin,
  className,
}: {
  verificationStatus: VerificationStatus
  onOpenVerification: () => void
  onShare?: () => void
  isPinned: boolean
  onTogglePin?: () => void
  className?: string
}) {
  const failureId = useId()
  const failed = verificationStatus === 'failed'
  return (
    <Menu as="div" className={className}>
      <MenuButton
        aria-label="More chat actions"
        aria-describedby={failed ? failureId : undefined}
        className="relative flex items-center justify-center rounded-lg border border-transparent bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary data-[open]:border-border-subtle data-[open]:bg-surface-chat data-[open]:text-content-primary"
      >
        <TfHorizontalEllipsis className="h-4 w-4" aria-hidden="true" />
        {failed && (
          <>
            <span
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500"
              aria-hidden="true"
            />
            <span id={failureId} className="sr-only">
              {VERIFICATION_FAILED_LABEL}
            </span>
          </>
        )}
      </MenuButton>
      <MenuItems
        anchor={{ to: 'bottom end', gap: MENU_GAP_PX }}
        // A modal menu makes the rest of the page inert while open and puts
        // back what it found once it closes, which would leave the panel an
        // item opens inert.
        modal={false}
        className="z-50 min-w-[200px] rounded-lg border border-border-subtle bg-white py-1 shadow-lg focus:outline-none dark:bg-surface-chat"
      >
        <MenuItem>
          <button
            type="button"
            onClick={onOpenVerification}
            className={cn(ITEM_CLASS_NAME, failed && 'text-red-500')}
          >
            <VerificationItemContent status={verificationStatus} />
          </button>
        </MenuItem>
        {onShare && (
          <MenuItem>
            <button type="button" onClick={onShare} className={ITEM_CLASS_NAME}>
              <TfShare className="h-4 w-4" aria-hidden="true" />
              Share
            </button>
          </MenuItem>
        )}
        {onTogglePin && (
          <MenuItem>
            <button
              type="button"
              onClick={onTogglePin}
              className={ITEM_CLASS_NAME}
            >
              <TfThumbtackAnimated className="h-4 w-4" aria-hidden="true" />
              {isPinned ? 'Remove from Favorites' : 'Pin to Favorites'}
            </button>
          </MenuItem>
        )}
      </MenuItems>
    </Menu>
  )
}
