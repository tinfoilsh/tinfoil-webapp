import { cn } from '@/components/ui/utils'
import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { preprocessMarkdown } from '@/utils/markdown-preprocessing'
import { sanitizeUrl } from '@braintree/sanitize-url'
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import { formatElapsed } from './format-duration'
import { useMathPlugins } from './use-math-plugins'
import { STEP_BOX_CLASS_NAME, StepHeader } from './WorkStep'

interface ThoughtProcessProps {
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
  useLayoutEffect(() => {
    const content = contentRef.current
    if (content) {
      const measuredHeight = content.offsetHeight
      setContentHeight((prevHeight) =>
        // Same never-shrink guard as the ResizeObserver below: this effect
        // re-runs on every streaming chunk, and shrinking mid-stream causes
        // scroll resets when content temporarily contracts.
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
  }, [thoughts, isThinking, isExpanded, renderContent])

  const { remarkPlugins, rehypePlugins } = useMathPlugins()
  const sanitizedThoughts = useMemo(() => {
    if (!renderContent) return ''
    const preprocessed = preprocessMarkdown(thoughts)
    const processedThoughts = processLatexTags(preprocessed)
    return sanitizeUnsupportedMathBlocks(processedThoughts)
  }, [renderContent, thoughts])

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
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={{
                p: ({ children }: { children?: React.ReactNode }) => (
                  <p className="mb-1.5 break-words last:mb-0">{children}</p>
                ),
                pre: ({ children }: { children?: React.ReactNode }) => (
                  <pre className="my-1.5 overflow-x-auto rounded-md border border-border-subtle bg-surface-chat p-2.5 font-mono text-[11px] text-content-primary">
                    {children}
                  </pre>
                ),
                code: ({
                  inline,
                  children,
                }: {
                  inline?: boolean
                  children?: React.ReactNode
                }) =>
                  inline ? (
                    <code className="inline break-words rounded border border-border-subtle bg-surface-chat px-1 py-0.5 align-baseline font-mono text-[11px] text-content-primary">
                      {children}
                    </code>
                  ) : (
                    <code className="block break-all font-mono text-[11px] text-content-primary">
                      {children}
                    </code>
                  ),
                a: ({ children, href }: any) => {
                  if (href?.startsWith('#cite-')) {
                    const tildeIndex = href.indexOf('~')
                    if (tildeIndex !== -1) {
                      const rest = href.slice(tildeIndex + 1)
                      const secondTildeIndex = rest.indexOf('~')
                      if (secondTildeIndex !== -1) {
                        const url = rest.slice(0, secondTildeIndex)
                        let title: string
                        try {
                          title = decodeURIComponent(
                            rest.slice(secondTildeIndex + 1),
                          )
                        } catch {
                          title = rest.slice(secondTildeIndex + 1)
                        }
                        const sanitizedHref = sanitizeUrl(url)
                        return (
                          <a
                            href={sanitizedHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mx-0.5 inline-flex h-[1.5em] items-center gap-1 whitespace-nowrap rounded-full bg-blue-500/10 px-1.5 !align-baseline text-[10px] font-medium text-blue-500 transition-colors hover:bg-blue-500/20"
                            title={title || url}
                          >
                            {children}
                          </a>
                        )
                      }
                      const sanitizedHref = sanitizeUrl(rest)
                      return (
                        <a
                          href={sanitizedHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mx-0.5 inline-flex h-[1.5em] items-center gap-1 whitespace-nowrap rounded-full bg-blue-500/10 px-1.5 !align-baseline text-[10px] font-medium text-blue-500 transition-colors hover:bg-blue-500/20"
                        >
                          {children}
                        </a>
                      )
                    }
                  }
                  if (!href) {
                    return <span>{children}</span>
                  }
                  return (
                    <a
                      href={sanitizeUrl(href)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 underline hover:text-blue-600"
                    >
                      {children}
                    </a>
                  )
                },
              }}
            >
              {sanitizedThoughts}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
})
