import { useCallback, useEffect, useRef, useState } from 'react'
import { PiChatCircleText, PiQuotes } from 'react-icons/pi'

type PopoverPosition = {
  top: number
  left: number
}

type QuoteSelectionPopoverProps = {
  containerRef: React.RefObject<HTMLElement | null>
  onQuote: (text: string) => void
  onAsk?: (text: string) => void
}

// Minimum number of characters required for the popover to appear.
const MIN_SELECTION_LENGTH = 2

// Vertical offset (in pixels) above the selection for the popover.
const POPOVER_VERTICAL_OFFSET = 40

export function QuoteSelectionPopover({
  containerRef,
  onQuote,
  onAsk,
}: QuoteSelectionPopoverProps) {
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const [selectedText, setSelectedText] = useState<string>('')
  const popoverRef = useRef<HTMLDivElement>(null)

  const hidePopover = useCallback(() => {
    setPosition(null)
    setSelectedText('')
  }, [])

  const updateFromSelection = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      hidePopover()
      return
    }

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hidePopover()
      return
    }

    const range = selection.getRangeAt(0)
    const commonAncestor = range.commonAncestorContainer
    const ancestorElement =
      commonAncestor.nodeType === Node.ELEMENT_NODE
        ? (commonAncestor as Element)
        : commonAncestor.parentElement

    if (!ancestorElement || !container.contains(ancestorElement)) {
      hidePopover()
      return
    }

    // Only allow selection inside messages, not the input area itself.
    const isInsideInput = ancestorElement.closest(
      '#chat-input, textarea, input',
    )
    if (isInsideInput) {
      hidePopover()
      return
    }

    const text = selection.toString().trim()
    if (text.length < MIN_SELECTION_LENGTH) {
      hidePopover()
      return
    }

    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      hidePopover()
      return
    }

    setSelectedText(text)
    setPosition({
      top: rect.top - POPOVER_VERTICAL_OFFSET,
      left: rect.left + rect.width / 2,
    })
  }, [containerRef, hidePopover])

  useEffect(() => {
    const handleSelectionChange = () => {
      // Defer to allow the selection to fully settle (important on mobile).
      requestAnimationFrame(updateFromSelection)
    }

    const handleMouseUp = () => {
      requestAnimationFrame(updateFromSelection)
    }

    const handleScrollOrResize = () => {
      hidePopover()
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('scroll', handleScrollOrResize, true)
    window.addEventListener('resize', handleScrollOrResize)

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('scroll', handleScrollOrResize, true)
      window.removeEventListener('resize', handleScrollOrResize)
    }
  }, [updateFromSelection, hidePopover])

  const handleQuoteClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!selectedText) return
      onQuote(selectedText)
      window.getSelection()?.removeAllRanges()
      hidePopover()
    },
    [selectedText, onQuote, hidePopover],
  )

  const handleAskClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!selectedText || !onAsk) return
      onAsk(selectedText)
      window.getSelection()?.removeAllRanges()
      hidePopover()
    },
    [selectedText, onAsk, hidePopover],
  )

  if (!position) return null

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Selection actions"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        // Prevent losing the selection when clicking the popover.
        e.preventDefault()
      }}
      className="flex items-center gap-1 rounded-full border border-border-subtle bg-surface-chat p-0.5 shadow-md"
    >
      <button
        type="button"
        onClick={handleQuoteClick}
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat-background"
      >
        <PiQuotes className="h-4 w-4" />
        <span>Quote</span>
      </button>
      {onAsk && (
        <button
          type="button"
          onClick={handleAskClick}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat-background"
        >
          <PiChatCircleText className="h-4 w-4" />
          <span>Ask</span>
        </button>
      )}
    </div>
  )
}
