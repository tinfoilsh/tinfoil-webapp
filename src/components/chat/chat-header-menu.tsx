'use client'

import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { TfHorizontalEllipsis, TfShare } from '@tinfoilsh/tinfoil-icons'
import { TfThumbtackAnimated } from '@tinfoilsh/tinfoil-icons/animated'

const MENU_GAP_PX = 4
const ITEM_CLASS_NAME =
  'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-content-secondary transition-colors data-[focus]:bg-gray-100 dark:data-[focus]:bg-surface-sidebar'

// The open chat's occasional actions, behind one button where the chat
// header has room only for the actions used most.
export function ChatHeaderMenu({
  onShare,
  isPinned,
  onTogglePin,
  className,
}: {
  onShare?: () => void
  isPinned: boolean
  onTogglePin?: () => void
  className?: string
}) {
  return (
    <Menu as="div" className={className}>
      <MenuButton
        aria-label="More chat actions"
        className="flex items-center justify-center rounded-lg border border-transparent bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary data-[open]:border-border-subtle data-[open]:bg-surface-chat data-[open]:text-content-primary"
      >
        <TfHorizontalEllipsis className="h-4 w-4" aria-hidden="true" />
      </MenuButton>
      <MenuItems
        anchor={{ to: 'bottom end', gap: MENU_GAP_PX }}
        className="z-50 min-w-[200px] rounded-lg border border-border-subtle bg-white py-1 shadow-lg focus:outline-none dark:bg-surface-chat"
      >
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
