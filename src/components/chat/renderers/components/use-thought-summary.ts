import { summarize } from '@/services/inference/summary-client'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_CONTENT_WORDS = 20
const TAIL_WORD_COUNT = 200
const MIN_SUMMARY_INTERVAL_MS = 3000

/**
 * Produces a short live summary of an in-progress thinking trace, throttled
 * to one summarizer call every few seconds. Returns '' until a summary is
 * available and clears once thinking stops. Pass `enabled: false` when a
 * parent already owns the summary for the same trace so the model is not
 * asked twice.
 */
export function useThoughtSummary(
  thoughts: string,
  isThinking: boolean,
  enabled = true,
): string {
  const [thoughtSummary, setThoughtSummary] = useState<string>('')
  const summaryGenerationRef = useRef<Promise<void> | null>(null)
  const lastSummaryTimeRef = useRef<number>(0)
  const isMountedRef = useRef<boolean>(true)

  const generateSummary = useCallback(async (thoughtText: string) => {
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
  }, [])

  useEffect(() => {
    if (!isThinking || !enabled) {
      setThoughtSummary('')
      return
    }

    if (!thoughts.trim()) return

    const totalWords = thoughts.split(/\s+/).filter(Boolean).length
    if (totalWords < MIN_CONTENT_WORDS) return

    if (summaryGenerationRef.current) return

    const words = thoughts.split(/\s+/).filter(Boolean)
    const tailText =
      words.length > TAIL_WORD_COUNT
        ? words.slice(-TAIL_WORD_COUNT).join(' ')
        : thoughts

    const timeSinceLastSummary = Date.now() - lastSummaryTimeRef.current
    if (timeSinceLastSummary < MIN_SUMMARY_INTERVAL_MS) {
      const delay = MIN_SUMMARY_INTERVAL_MS - timeSinceLastSummary
      const timeoutId = setTimeout(() => {
        if (!isMountedRef.current || !isThinking) return
        if (summaryGenerationRef.current) return
        lastSummaryTimeRef.current = Date.now()
        summaryGenerationRef.current = generateSummary(tailText).finally(() => {
          summaryGenerationRef.current = null
        })
      }, delay)
      return () => clearTimeout(timeoutId)
    }

    lastSummaryTimeRef.current = Date.now()
    summaryGenerationRef.current = generateSummary(tailText).finally(() => {
      summaryGenerationRef.current = null
    })
  }, [thoughts, isThinking, enabled, generateSummary])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  return thoughtSummary
}
