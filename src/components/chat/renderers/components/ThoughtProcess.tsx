import { LoadingDots } from '@/components/loading-dots'
import { summarize } from '@/services/inference/summary-client'

import { logError } from '@/utils/error-handling'
import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { preprocessMarkdown } from '@/utils/markdown-preprocessing'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useMathPlugins } from './use-math-plugins'

interface ThoughtProcessProps {
  thoughts: string
  isDarkMode: boolean
  isThinking?: boolean
  shouldDiscard?: boolean
  thinkingDuration?: number
}

export const ThoughtProcess = memo(function ThoughtProcess({
  thoughts,
  isDarkMode,
  isThinking = false,
  shouldDiscard = false,
  thinkingDuration,
}: ThoughtProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const contentId = useId()

  const contentRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState<number>(0)
  const lastScrollPositionRef = useRef<number>(0)
  const isUserScrollingRef = useRef<boolean>(false)
  const [thoughtSummary, setThoughtSummary] = useState<string>('')
  const summaryGenerationRef = useRef<Promise<void> | null>(null)
  const lastSummaryTimeRef = useRef<number>(0)
  const isMountedRef = useRef<boolean>(true)
  const wasExpandedRef = useRef<boolean>(isExpanded)

  const handleToggle = () => {
    setIsExpanded((prev) => !prev)
  }

  const generateSummary = useCallback(
    async (
      thoughtText: string,
      isMountedRef: React.MutableRefObject<boolean>,
    ) => {
      if (!thoughtText.trim()) {
        if (isMountedRef.current) {
          setThoughtSummary('')
        }
        return
      }

      try {
        const generatedSummary = await summarize({
          content: thoughtText,
          style: 'thoughts_summary',
        })

        if (isMountedRef.current && generatedSummary.trim()) {
          setThoughtSummary(generatedSummary.trim())
        }
      } catch (error) {
        logError('Failed to generate thought summary', error, {
          component: 'ThoughtProcess',
          action: 'generateSummary',
        })
        if (isMountedRef.current) {
          setThoughtSummary('')
        }
      }
    },
    [],
  )

  useEffect(() => {
    if (!isThinking) {
      setThoughtSummary('')
      return
    }

    if (!thoughts.trim()) return

    const MIN_CONTENT_WORDS = 20
    const totalWords = thoughts.split(/\s+/).filter(Boolean).length
    if (totalWords < MIN_CONTENT_WORDS) return

    if (summaryGenerationRef.current) return

    const TAIL_WORD_COUNT = 200
    const words = thoughts.split(/\s+/).filter(Boolean)
    const tailText =
      words.length > TAIL_WORD_COUNT
        ? words.slice(-TAIL_WORD_COUNT).join(' ')
        : thoughts

    const MIN_SUMMARY_INTERVAL_MS = 3000
    const timeSinceLastSummary = Date.now() - lastSummaryTimeRef.current
    if (timeSinceLastSummary < MIN_SUMMARY_INTERVAL_MS) {
      const delay = MIN_SUMMARY_INTERVAL_MS - timeSinceLastSummary
      const timeoutId = setTimeout(() => {
        if (!isMountedRef.current || !isThinking) return
        if (summaryGenerationRef.current) return
        lastSummaryTimeRef.current = Date.now()
        summaryGenerationRef.current = generateSummary(
          tailText,
          isMountedRef,
        ).finally(() => {
          summaryGenerationRef.current = null
        })
      }, delay)
      return () => clearTimeout(timeoutId)
    }

    lastSummaryTimeRef.current = Date.now()
    summaryGenerationRef.current = generateSummary(
      tailText,
      isMountedRef,
    ).finally(() => {
      summaryGenerationRef.current = null
    })
  }, [thoughts, isThinking, generateSummary])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

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
    if (!isThinking && contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight)
    }
  }, [isThinking])

  // Measure content height for smooth animation
  useEffect(() => {
    if (contentRef.current) {
      const resizeObserver = new ResizeObserver(() => {
        if (contentRef.current) {
          setContentHeight((prevHeight) => {
            const newHeight = contentRef.current!.scrollHeight
            // During streaming (isThinking), only allow height to grow, never shrink
            // This prevents scroll resets when content temporarily contracts
            if (isThinking) {
              return Math.max(prevHeight, newHeight)
            }
            return newHeight
          })
        }
      })
      resizeObserver.observe(contentRef.current)
      return () => resizeObserver.disconnect()
    }
  }, [thoughts, isThinking])

  const { remarkPlugins, rehypePlugins } = useMathPlugins()
  const preprocessed = preprocessMarkdown(thoughts)
  const processedThoughts = processLatexTags(preprocessed)
  const sanitizedThoughts = sanitizeUnsupportedMathBlocks(processedThoughts)

  if (shouldDiscard || (!thoughts.trim() && !isThinking)) {
    return null
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="hover:bg-surface-secondary/50 group -mx-1 flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors"
      >
        <svg
          className={`h-3.5 w-3.5 shrink-0 transform text-content-primary/40 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
        <div className="flex min-w-0 items-center gap-2">
          {isThinking ? (
            <div className="min-w-0">
              {thoughtSummary ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="block animate-shimmer truncate bg-clip-text text-base font-medium text-transparent"
                    style={{
                      backgroundImage: isDarkMode
                        ? 'linear-gradient(90deg, #9ca3af 0%, #e5e7eb 25%, #f9fafb 50%, #e5e7eb 75%, #9ca3af 100%)'
                        : 'linear-gradient(90deg, #4b5563 0%, #6b7280 25%, #9ca3af 50%, #6b7280 75%, #4b5563 100%)',
                      backgroundSize: '200% 100%',
                    }}
                  >
                    {thoughtSummary}
                  </span>
                  <LoadingDots size="small" />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-content-primary/50">
                  <span className="text-base font-medium">Thinking</span>
                  <LoadingDots size="small" />
                </div>
              )}
            </div>
          ) : (
            <span className="text-base text-content-primary/50">
              <span className="font-medium">Thought</span>
              {thinkingDuration && (
                <span className="font-normal">
                  {thinkingDuration < 60
                    ? ` for ${thinkingDuration.toFixed(1)} seconds`
                    : ` for ${(thinkingDuration / 60).toFixed(1)} minutes`}
                </span>
              )}
            </span>
          )}
        </div>
      </button>

      <div
        ref={scrollContainerRef}
        id={contentId}
        inert={!isExpanded}
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{
          maxHeight: isExpanded ? `${contentHeight}px` : '0px',
        }}
      >
        <div
          ref={contentRef}
          className="ml-2 border-l-2 border-border-subtle py-2 pl-3 pr-1 text-sm text-content-primary/70"
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
                return (
                  <a
                    href={href}
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
      </div>
    </div>
  )
})
