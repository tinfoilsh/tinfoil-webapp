import { memo, useEffect, useRef, useState } from 'react'

interface StreamingContentWrapperProps {
  children: React.ReactNode
  isStreaming: boolean
}

/**
 * Wrapper component that prevents content from shrinking during streaming.
 * It maintains the maximum height reached to prevent jarring scroll jumps
 * when content temporarily expands (e.g., raw LaTeX) then contracts when rendered.
 */
export const StreamingContentWrapper = memo(function StreamingContentWrapper({
  children,
  isStreaming,
}: StreamingContentWrapperProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined)
  const maxHeightRef = useRef<number>(0)

  useEffect(() => {
    if (!isStreaming) {
      setMinHeight(undefined)
      maxHeightRef.current = 0
      return
    }
    if (!contentRef.current || typeof ResizeObserver === 'undefined') {
      return
    }

    const node = contentRef.current
    const measureHeight = () => {
      const currentHeight = node.scrollHeight
      if (currentHeight > maxHeightRef.current) {
        maxHeightRef.current = currentHeight
        setMinHeight(currentHeight)
      }
    }

    measureHeight()

    const resizeObserver = new ResizeObserver(() => {
      measureHeight()
    })
    resizeObserver.observe(node)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isStreaming])

  return (
    <div
      ref={contentRef}
      style={{
        overflowAnchor: isStreaming ? 'none' : undefined,
        minHeight: isStreaming && minHeight ? `${minHeight}px` : undefined,
      }}
    >
      {children}
    </div>
  )
})
