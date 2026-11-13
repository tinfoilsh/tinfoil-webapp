import { cn } from './utils'

// A chat as a list of chats shows it: a row that opens it, with what can be
// done to it at the row's end.
export const chatRowClassName = (isSelected: boolean, isDarkMode: boolean) =>
  cn(
    'group relative flex w-full items-center justify-between rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors hover:border-border-subtle',
    isSelected
      ? isDarkMode
        ? 'bg-surface-chat text-white'
        : 'bg-gray-200 text-content-primary'
      : isDarkMode
        ? 'text-content-secondary hover:bg-surface-chat'
        : 'text-content-secondary hover:bg-surface-sidebar',
  )

// The control that opens the chat, which the whole row stands for.
export const CHAT_ROW_SELECT_CLASS_NAME =
  'min-w-0 flex-1 cursor-pointer rounded-md pr-2 text-left after:absolute after:inset-0 after:rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong'

export const CHAT_ROW_TITLE_CLASS_NAME =
  'truncate font-aeonik-fono text-sm font-medium text-content-primary'

// The actions at the row's end, which stay above the control that covers it.
export const CHAT_ROW_ACTIONS_CLASS_NAME =
  'flex flex-shrink-0 items-center gap-1.5 [&_button]:relative [&_button]:z-10'

export const chatRowActionClassName = (isDarkMode: boolean) =>
  cn(
    'rounded p-1 transition-colors',
    isDarkMode
      ? 'text-content-muted hover:bg-surface-chat hover:text-white'
      : 'text-content-muted hover:bg-surface-sidebar hover:text-content-secondary',
  )
