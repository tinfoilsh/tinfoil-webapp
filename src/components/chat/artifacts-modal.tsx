'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { TfBoxX, TfDocumentWithCode } from '@tinfoilsh/tinfoil-icons'
import { ArtifactList } from './artifact-list'

interface ArtifactsModalProps {
  isOpen: boolean
  onClose: () => void
  onOpenChat: (threadId: string) => void
}

// The artifacts of every stored chat, listed each time the dialog opens. It
// closes once an artifact or its chat is opened from it.
export function ArtifactsModal({
  isOpen,
  onClose,
  onOpenChat,
}: ArtifactsModalProps) {
  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="flex max-h-[70dvh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-sidebar shadow-xl focus:outline-none"
          >
            <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
              <TfDocumentWithCode
                className="h-4 w-4 flex-none text-content-muted"
                aria-hidden="true"
              />
              <DialogPrimitive.Title className="min-w-0 flex-1 font-aeonik text-base font-medium text-content-primary">
                Artifacts
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                aria-label="Close artifacts"
                className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-chat hover:text-content-primary"
              >
                <TfBoxX className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-[200px] flex-1 overflow-y-auto px-2 py-2">
              <ArtifactList
                onOpenChat={(threadId) => {
                  onClose()
                  onOpenChat(threadId)
                }}
                onOpenArtifact={onClose}
              />
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
