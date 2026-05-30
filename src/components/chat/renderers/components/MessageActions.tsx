import { CONSTANTS } from '@/components/chat/constants'
import { logWarning } from '@/utils/error-handling'
import { convertLatexForCopy } from '@/utils/latex-processing'
import { memo, useEffect, useRef, useState } from 'react'
import { BsCheckLg } from 'react-icons/bs'
import { RxCopy } from 'react-icons/rx'

interface MessageActionsProps {
  content: string
  isDarkMode: boolean
}

export const MessageActions = memo(function MessageActions({
  content,
  isDarkMode,
}: MessageActionsProps) {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleCopy = () => {
    const textToCopy = convertLatexForCopy(content)

    // Check if clipboard API is available
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return // Silently fail if clipboard API is not available
    }

    navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        setIsCopied(true)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        timeoutRef.current = setTimeout(() => {
          setIsCopied(false)
          timeoutRef.current = null
        }, CONSTANTS.COPY_TIMEOUT_MS)
      })
      .catch((error) => {
        logWarning('Failed to copy message to clipboard', {
          component: 'MessageActions',
          action: 'copyMessage',
          metadata: {
            errorMessage: error?.message || 'Unknown error',
          },
        })
      })
  }

  return (
    <div className="group/copy relative">
      <button
        type="button"
        onClick={handleCopy}
        className={`flex items-center gap-1.5 rounded px-2 py-2 text-xs font-medium transition-all ${
          isCopied
            ? 'bg-green-500/10 text-green-600 dark:bg-green-500/20 dark:text-green-400'
            : 'text-content-secondary hover:bg-surface-chat-background hover:text-content-primary'
        }`}
        aria-label="Copy message"
      >
        {isCopied ? (
          <>
            <BsCheckLg className="h-3.5 w-3.5" />
            <span aria-live="polite">Copied!</span>
          </>
        ) : (
          <RxCopy className="h-3.5 w-3.5" />
        )}
      </button>
      {!isCopied && (
        <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover/copy:opacity-100">
          Copy
        </span>
      )}
    </div>
  )
})
