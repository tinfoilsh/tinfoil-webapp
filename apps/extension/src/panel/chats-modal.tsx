import {
  CHAT_ROW_ACTIONS_CLASS_NAME,
  CHAT_ROW_SELECT_CLASS_NAME,
  CHAT_ROW_TITLE_CLASS_NAME,
  chatRowActionClassName,
  chatRowClassName,
} from '@tinfoil/chat-ui/chat-row'
import { DeleteConfirmation } from '@tinfoil/chat-ui/delete-confirmation'
import { Modal, ModalTitle } from '@tinfoil/chat-ui/modal'
import { TfTrash } from '@tinfoilsh/tinfoil-icons'
import { useState } from 'react'
import type { View } from '../messages'

// The chats saved in this extension, to open or delete.
export function ChatsModal({
  isOpen,
  onClose,
  chats,
  currentId,
  runningId,
  onSelect,
  onDelete,
  isDarkMode,
}: {
  isOpen: boolean
  onClose: () => void
  chats: View['tasks']
  currentId?: string
  // The chat whose task is at work.
  runningId?: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  isDarkMode: boolean
}) {
  const [deleting, setDeleting] = useState<string>()
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      className="flex h-[calc(100dvh-2rem)] flex-col p-0"
    >
      <ModalTitle className="flex-none px-5 pb-2 pr-14 pt-6">
        Recent chats
      </ModalTitle>
      {chats.length === 0 && (
        <p className="p-4 text-sm text-content-muted">No saved chats yet.</p>
      )}
      <div role="list" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {chats.map((chat) => (
          <div key={chat.id} role="listitem" className="relative">
            <div
              className={chatRowClassName(chat.id === currentId, isDarkMode)}
            >
              <button
                type="button"
                onClick={() => onSelect(chat.id)}
                aria-current={chat.id === currentId ? 'page' : undefined}
                className={CHAT_ROW_SELECT_CLASS_NAME}
              >
                <span className="flex items-center gap-1.5">
                  <span className={CHAT_ROW_TITLE_CLASS_NAME}>
                    {chat.title}
                  </span>
                  {chat.id === runningId && (
                    <span
                      className="mx-2 flex w-[18px] flex-shrink-0 items-center justify-center"
                      title="Generating response"
                    >
                      <span className="stream-loader" />
                      <span className="sr-only">Generating response</span>
                    </span>
                  )}
                </span>
              </button>
              <div className={CHAT_ROW_ACTIONS_CLASS_NAME}>
                <div className="pointer-events-none flex w-0 items-center overflow-hidden opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:w-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:w-auto group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => setDeleting(chat.id)}
                    aria-label={`Delete ${chat.title}`}
                    title="Delete"
                    className={chatRowActionClassName(isDarkMode)}
                  >
                    <TfTrash className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
            {deleting === chat.id && (
              <DeleteConfirmation
                onConfirm={() => {
                  setDeleting(undefined)
                  onDelete(chat.id)
                }}
                onCancel={() => setDeleting(undefined)}
                isDarkMode={isDarkMode}
              />
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
