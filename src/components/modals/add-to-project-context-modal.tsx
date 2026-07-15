import { cn } from '@/components/ui/utils'
import { FolderIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'

interface AddToProjectContextModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (addToProject: boolean, rememberChoice: boolean) => void
  fileName: string
  projectName: string
  isDarkMode: boolean
}

export function AddToProjectContextModal({
  isOpen,
  onClose,
  onConfirm,
  fileName,
  projectName,
  isDarkMode,
}: AddToProjectContextModalProps) {
  void isDarkMode
  const [isVisible, setIsVisible] = useState(false)
  const [rememberChoice, setRememberChoice] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      setRememberChoice(false)
    } else {
      const timer = setTimeout(() => setIsVisible(false), 300)
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  if (!isVisible) return null

  const handleAddToProject = () => {
    onConfirm(true, rememberChoice)
  }

  const handleAddToChat = () => {
    onConfirm(false, rememberChoice)
  }

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-300',
        isOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black bg-opacity-50"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className={cn(
          'relative z-10 w-full max-w-md transform rounded-lg border border-border-subtle bg-surface-card text-content-primary shadow-xl transition-all duration-300',
          isOpen ? 'scale-100' : 'scale-95',
          'p-4 sm:p-6',
        )}
      >
        <div className="mb-3 flex items-center justify-center sm:mb-4">
          <div className="rounded-full bg-emerald-500/20 p-2 sm:p-3">
            <FolderIcon className="h-6 w-6 text-emerald-500 sm:h-8 sm:w-8" />
          </div>
        </div>

        <h2 className="mb-3 text-center text-lg font-bold sm:mb-4 sm:text-xl">
          Add to project context?
        </h2>

        <div className="mb-4 space-y-3 sm:mb-6">
          <p className="text-center text-xs text-content-secondary sm:text-sm">
            Would you like to add{' '}
            <span className="font-medium text-content-primary">{fileName}</span>{' '}
            to the project context for{' '}
            <span className="font-medium text-content-primary">
              {projectName}
            </span>
            ?
          </p>

          {/* Remember choice checkbox */}
          <label className="flex cursor-pointer items-center justify-center gap-2">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle bg-surface-chat text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
            />
            <span className="text-xs text-content-secondary sm:text-sm">
              Remember my decision for future uploads
            </span>
          </label>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            onClick={handleAddToChat}
            className="flex-1 rounded-lg border border-border-subtle bg-surface-chat px-4 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat-background sm:text-base"
          >
            No, just this chat
          </button>
          <button
            onClick={handleAddToProject}
            className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 sm:text-base"
          >
            Yes, add to project
          </button>
        </div>
      </div>
    </div>
  )
}
