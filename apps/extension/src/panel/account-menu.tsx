import { useClerk, useUser } from '@clerk/chrome-extension'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { logError } from '@tinfoil/chat-client/logging'
import { UserAvatar } from '@tinfoil/chat-ui/user-avatar'
import { TfSetting, TfSignOut } from '@tinfoilsh/tinfoil-icons'

const AVATAR_SIZE_PX = 28
const MENU_ITEM_CLASS_NAME =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-content-secondary focus:outline-none data-[focus]:bg-surface-chat data-[focus]:text-content-primary'

// The signed-in account, with the extension's settings and signing out.
export function AccountMenu() {
  const { user } = useUser()
  const clerk = useClerk()
  if (!user) return null
  const email = user.primaryEmailAddress?.emailAddress
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    email?.split('@')[0] ||
    'Account'
  return (
    <Menu as="div" className="relative flex">
      <MenuButton
        aria-label="Account"
        className="flex h-7 w-7 flex-none items-center justify-center overflow-hidden rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-chat-background"
      >
        <UserAvatar user={user} size={AVATAR_SIZE_PX} />
      </MenuButton>
      <MenuItems
        anchor={{ to: 'bottom end', gap: 8 }}
        className="z-50 w-64 rounded-lg border border-border-subtle bg-white p-1.5 font-aeonik-fono shadow-lg focus:outline-none dark:bg-surface-chat-background"
      >
        <div className="px-3 py-2">
          <p className="truncate font-aeonik text-sm font-medium text-content-primary">
            {name}
          </p>
          {email && (
            <p className="truncate text-xs text-content-muted">{email}</p>
          )}
        </div>
        <div className="my-1.5 border-t border-border-subtle" />
        <MenuItem>
          <button
            type="button"
            className={MENU_ITEM_CLASS_NAME}
            onClick={() => {
              chrome.runtime
                .openOptionsPage()
                .catch((cause) => logError('Unable to open settings', cause))
            }}
          >
            <TfSetting className="h-4 w-4" aria-hidden="true" />
            Settings
          </button>
        </MenuItem>
        <MenuItem>
          <button
            type="button"
            className={MENU_ITEM_CLASS_NAME}
            onClick={() => {
              clerk
                .signOut()
                .catch((cause) => logError('Unable to sign out', cause))
            }}
          >
            <TfSignOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  )
}
