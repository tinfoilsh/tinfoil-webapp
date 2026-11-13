import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from 'react'
import { formatElapsed } from './format-duration'
import { StepMarkdown } from './StepMarkdown'
import { cn } from './utils'
import { STEP_BOX_CLASS_NAME, StepHeader } from './WorkStep'

export interface ThoughtProcessProps {
  thoughts: string
  isDarkMode: boolean
  isThinking?: boolean
  shouldDiscard?: boolean
  thinkingDuration?: number
  // When the thinking started, in epoch milliseconds.
  startedAt?: number
  // The chat service's live summary of the thinking while it goes on.
  summary?: string
  // A step of a group shows its thoughts in the group's box.
  inGroup?: boolean
  // What renders the thoughts' Markdown.
  Markdown?: ComponentType<{ content: string; isStreaming?: boolean }>
}

// What a reply thinking shows: the chat service's summary of the thinking,
// shimmering, once it has one.
export function ThinkingLabel({
  summary,
  isDarkMode,
}: {
  summary: string
  isDarkMode: boolean
}) {
  if (!summary) return <span className="font-medium">Thinking</span>
  return (
    <span
      className="block animate-shimmer truncate bg-clip-text font-medium text-transparent motion-reduce:animate-none"
      style={{
        backgroundImage: isDarkMode
          ? 'linear-gradient(90deg, #9ca3af 0%, #e5e7eb 25%, #f9fafb 50%, #e5e7eb 75%, #9ca3af 100%)'
          : 'linear-gradient(90deg, #4b5563 0%, #6b7280 25%, #9ca3af 50%, #6b7280 75%, #4b5563 100%)',
        backgroundSize: '200% 100%',
      }}
    >
      {summary}
    </span>
  )
}

export const ThoughtProcess = memo(function ThoughtProcess({
  thoughts,
  isDarkMode,
  isThinking = false,
  shouldDiscard = false,
  thinkingDuration,
  startedAt,
  summary,
  inGroup = false,
  Markdown = StepMarkdown,
}: ThoughtProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [renderContent, setRenderContent] = useState(false)
  const contentId = useId()

  const contentRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState<number>(0)
  const lastScrollPositionRef = useRef<number>(0)
  const isUserScrollingRef = useRef<boolean>(false)
  const thoughtSummary = summary ?? ''
  // A thought shorter than a second says no duration.
  const thoughtSeconds = Math.floor(thinkingDuration ?? 0)
  const wasExpandedRef = useRef<boolean>(isExpanded)

  const handleToggle = () => {
    setIsExpanded((prev) => !prev)
  }

  useEffect(() => {
    if (isExpanded) {
      setRenderContent(true)
    } else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRenderContent(false)
    }
  }, [isExpanded])

  // Fix main scroll container when thoughts collapse
  useEffect(() => {
    const wasExpanded = wasExpandedRef.current
    wasExpandedRef.current = isExpanded

    // Only run when thoughts actually collapse (expanded -> collapsed),
    // not on initial mount when isExpanded is already false
    if (!isExpanded && wasExpanded && typeof window !== 'undefined') {
      // When thoughts collapse, check if main scroll needs adjustment
      const checkAndFixScroll = () => {
        const mainScrollContainer = document.querySelector(
          '[data-scroll-container="main"]',
        ) as HTMLElement
        if (mainScrollContainer) {
          // Use requestAnimationFrame to ensure DOM has updated
          requestAnimationFrame(() => {
            const { scrollHeight, clientHeight, scrollTop } =
              mainScrollContainer
            const maxScroll = Math.max(0, scrollHeight - clientHeight)

            // If we're scrolled beyond actual content, reset
            if (scrollTop > maxScroll) {
              mainScrollContainer.scrollTop = maxScroll
            }

            // Trigger scroll event to update button
            mainScrollContainer.dispatchEvent(new Event('scroll'))
          })
        }
      }

      // Check immediately and after transition
      checkAndFixScroll()
      const timeoutId = setTimeout(checkAndFixScroll, 350)

      return () => clearTimeout(timeoutId)
    }
  }, [isExpanded])

  // Track user scrolling
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer || !isExpanded) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = () => {
      isUserScrollingRef.current = true
      lastScrollPositionRef.current = scrollContainer.scrollTop

      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrollingRef.current = false
      }, 150)
    }

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [isExpanded])

  // Preserve scroll position during streaming updates
  useEffect(() => {
    if (
      isExpanded &&
      scrollContainerRef.current &&
      isThinking &&
      !isUserScrollingRef.current
    ) {
      // Restore scroll position after content update
      const scrollContainer = scrollContainerRef.current
      if (lastScrollPositionRef.current > 0) {
        scrollContainer.scrollTop = lastScrollPositionRef.current
      }
    }
  }, [thoughts, isExpanded, isThinking])

  // Reset max height when thinking stops
  useEffect(() => {
    const content = contentRef.current
    if (!isThinking && content) {
      setContentHeight(content.offsetHeight)
    }
  }, [isThinking])

  // Measure content height for smooth animation
  // (offsetHeight, unlike scrollHeight, counts the border of the thoughts' box)
  // The observer follows the thoughts as they stream, so the content is
  // measured here only as it shows.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (content) {
      const measuredHeight = content.offsetHeight
      setContentHeight((prevHeight) =>
        // Same never-shrink guard as the ResizeObserver below: shrinking
        // mid-stream causes scroll resets when content temporarily contracts.
        isThinking ? Math.max(prevHeight, measuredHeight) : measuredHeight,
      )
      const resizeObserver = new ResizeObserver(() => {
        const currentContent = contentRef.current
        if (!currentContent) return

        const newHeight = currentContent.offsetHeight
        setContentHeight((prevHeight) => {
          // During streaming (isThinking), only allow height to grow, never shrink
          // This prevents scroll resets when content temporarily contracts
          if (isThinking) {
            return Math.max(prevHeight, newHeight)
          }
          return newHeight
        })
      })
      resizeObserver.observe(content)
      return () => resizeObserver.disconnect()
    }
  }, [isThinking, isExpanded, renderContent])

  if (shouldDiscard || (!thoughts.trim() && !isThinking)) {
    return null
  }

  return (
    <div>
      <StepHeader
        label={
          isThinking ? (
            <ThinkingLabel summary={thoughtSummary} isDarkMode={isDarkMode} />
          ) : (
            <>
              <span className="font-medium">Thought</span>
              {thoughtSeconds > 0 && (
                <span className="font-normal">
                  {' '}
                  for {formatElapsed(thoughtSeconds)}
                </span>
              )}
            </>
          )
        }
        isRunning={isThinking}
        startedAt={startedAt}
        isExpanded={isExpanded}
        onToggle={handleToggle}
        detailsId={contentId}
      />

      <div
        ref={scrollContainerRef}
        id={contentId}
        inert={!isExpanded}
        className="overflow-hidden transition-all duration-300 ease-out motion-reduce:transition-none"
        style={{
          maxHeight: isExpanded ? `${contentHeight}px` : '0px',
        }}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !isExpanded) {
            setRenderContent(false)
          }
        }}
      >
        {renderContent && (
          <div
            ref={contentRef}
            className={cn(
              'text-sm text-content-primary/70',
              inGroup ? 'pb-2' : cn(STEP_BOX_CLASS_NAME, 'px-3 py-2'),
            )}
            translate="no"
          >
            <Markdown content={thoughts} isStreaming={isThinking} />
          </div>
        )}
      </div>
    </div>
  )
})
