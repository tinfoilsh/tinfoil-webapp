/**
 * Right-side slide-over that renders an artifact in full size.
 *
 * State ownership sits in `chat-interface.tsx`. This component is pure UI:
 * it receives the artifact payload, current width, and callbacks. The width
 * is clamped between `ARTIFACT_SIDEBAR_MIN_WIDTH_PX` and
 * `ARTIFACT_SIDEBAR_MAX_WIDTH_PX` and can be dragged via a pointer-captured
 * resize handle on the left edge, or stepped via keyboard arrows.
 */
import {
  ArtifactPreviewPanel,
  type ArtifactPreviewSidebarDetail,
} from '@/components/chat/genui/widgets/ArtifactPreview'
import { cn } from '@/components/ui/utils'
import { EyeIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { CONSTANTS } from './constants'

type ArtifactSidebarProps = {
  isOpen: boolean
  onClose: () => void
  artifact: ArtifactPreviewSidebarDetail | null
  isDarkMode: boolean
  width: number
  onWidthChange: (width: number) => void
  isResizable: boolean
}

export function ArtifactSidebar({
  isOpen,
  onClose,
  artifact,
  isDarkMode,
  width,
  onWidthChange,
  isResizable,
}: ArtifactSidebarProps) {
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const [isResizing, setIsResizing] = useState(false)

  const clampWidth = useCallback((nextWidth: number) => {
    return Math.min(
      CONSTANTS.ARTIFACT_SIDEBAR_MAX_WIDTH_PX,
      Math.max(CONSTANTS.ARTIFACT_SIDEBAR_MIN_WIDTH_PX, nextWidth),
    )
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const delta = startXRef.current - event.clientX
      onWidthChange(clampWidth(startWidthRef.current + delta))
    }

    const handlePointerUp = () => {
      setIsResizing(false)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [clampWidth, isResizing, onWidthChange])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizable || event.button !== 0) return
    startXRef.current = event.clientX
    startWidthRef.current = width
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsResizing(true)
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isResizable) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onWidthChange(
        clampWidth(width + CONSTANTS.ARTIFACT_SIDEBAR_RESIZE_STEP_PX),
      )
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onWidthChange(
        clampWidth(width - CONSTANTS.ARTIFACT_SIDEBAR_RESIZE_STEP_PX),
      )
    }
  }

  return (
    <>
      <div
        className={cn(
          'fixed right-0 top-0 z-40 flex h-full w-[85vw] flex-col border-l border-border-subtle bg-surface-chat-background font-aeonik transition-transform duration-200 ease-in-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
        style={
          isResizable
            ? { width: `${width}px` }
            : { maxWidth: `${CONSTANTS.ARTIFACT_SIDEBAR_WIDTH_PX}px` }
        }
        aria-hidden={!isOpen}
      >
        {isResizable && isOpen && (
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize artifact sidebar"
            aria-orientation="vertical"
            aria-valuemin={CONSTANTS.ARTIFACT_SIDEBAR_MIN_WIDTH_PX}
            aria-valuemax={CONSTANTS.ARTIFACT_SIDEBAR_MAX_WIDTH_PX}
            aria-valuenow={width}
            onPointerDown={handleResizeStart}
            onKeyDown={handleResizeKeyDown}
            className="absolute left-0 top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 cursor-col-resize outline-none md:block"
          >
            <div
              className={cn(
                'flex h-14 w-6 items-center justify-center rounded-full border border-border-subtle bg-surface-chat shadow-sm transition-colors',
                isResizing
                  ? 'bg-surface-chat-background'
                  : 'hover:bg-surface-chat-background',
              )}
            >
              <div className="h-8 w-1 rounded-full bg-content-muted" />
            </div>
          </div>
        )}

        <div className="flex flex-shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-2 text-content-primary">
            <EyeIcon className="h-5 w-5" />
            <span className="text-sm font-medium">Preview</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-surface-chat text-content-secondary transition-colors hover:bg-surface-chat-background"
            aria-label="Close artifact sidebar"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {artifact ? (
            <ArtifactPreviewPanel
              title={artifact.title}
              description={artifact.description}
              source={artifact.source}
              footer={artifact.footer}
              isDarkMode={isDarkMode}
              className="w-full"
              layout="sidebar"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <p className="text-sm text-content-secondary">
                Open an artifact preview from the chat to inspect it here.
              </p>
            </div>
          )}
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}
    </>
  )
}
