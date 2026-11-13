import { Modal, ModalTitle } from '@tinfoil/chat-ui/modal'
import { cn } from '@tinfoil/chat-ui/utils'
import { TfTrash } from '@tinfoilsh/tinfoil-icons'
import type { View } from '../messages'

// The chats saved in this extension, to open or delete.
export function ChatsModal({
  isOpen,
  onClose,
  chats,
  currentId,
  onSelect,
  onDelete,
}: {
  isOpen: boolean
  onClose: () => void
  chats: View['tasks']
  currentId?: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      className="flex h-[calc(100dvh-2rem)] flex-col p-0"
    >
      <ModalTitle className="flex-none px-6 pb-3 pr-14 pt-6">
        Recent chats
      </ModalTitle>
      <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {chats.length === 0 && (
          <li className="px-3 py-2 text-sm text-content-muted">
            No saved chats yet.
          </li>
        )}
        {chats.map((chat) => (
          <li key={chat.id} className="group/chat relative">
            <button
              type="button"
              onClick={() => onSelect(chat.id)}
              aria-current={chat.id === currentId ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg py-2.5 pl-3 pr-10 text-left text-sm transition-colors',
                chat.id === currentId
                  ? 'bg-surface-chat text-content-primary'
                  : 'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
              )}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 flex-none rounded-full border border-content-muted"
              />
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(chat.id)}
              aria-label={`Delete ${chat.title}`}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-content-muted opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 group-hover/chat:opacity-100"
            >
              <TfTrash className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
