import { summarize } from '@/services/inference/summary-client'
import { logError } from '@/utils/error-handling'
import { useEffect, useRef, useState } from 'react'

const MIN_CONTENT_WORDS = 20
const TAIL_WORD_COUNT = 200
const MIN_SUMMARY_INTERVAL_MS = 3000

/**
 * Produces a short live summary of an in-progress thinking trace, throttled
 * to one summarizer call every few seconds. Returns '' until a summary is
 * available and clears once thinking stops. Pass `enabled: false` when a
 * parent already owns the summary for the same trace so the model is not
 * asked twice. Pass `traceKey` when one hook instance may observe several
 * traces in turn (e.g. a group header) so a change of trace resets it.
 */
export function useThoughtSummary(
  thoughts: string,
  isThinking: boolean,
  enabled = true,
  traceKey?: string,
): string {
  const [thoughtSummary, setThoughtSummary] = useState<string>('')
  const inFlightRef = useRef(false)
  const lastSummaryTimeRef = useRef<number>(0)
  // Bumped whenever thinking stops or the trace changes so a request that
  // was still in flight cannot repopulate the summary for the next trace.
  const epochRef = useRef(0)

  useEffect(() => {
    epochRef.current += 1
    inFlightRef.current = false
    setThoughtSummary('')
  }, [traceKey])

  useEffect(() => {
    if (!isThinking || !enabled) {
      epochRef.current += 1
      inFlightRef.current = false
      setThoughtSummary('')
      return
    }

    const words = thoughts.split(/\s+/).filter(Boolean)
    if (words.length < MIN_CONTENT_WORDS) return
    if (inFlightRef.current) return

    const tailText =
      words.length > TAIL_WORD_COUNT
        ? words.slice(-TAIL_WORD_COUNT).join(' ')
        : thoughts
    const epoch = epochRef.current

    const fire = () => {
      if (inFlightRef.current || epochRef.current !== epoch) return
      inFlightRef.current = true
      lastSummaryTimeRef.current = Date.now()
      summarize({ content: tailText, style: 'thoughts_summary' })
        .then((generated) => {
          if (epochRef.current === epoch && generated.trim()) {
            setThoughtSummary(generated.trim())
          }
        })
        .catch((error) => {
          logError('Failed to generate thought summary', error, {
            component: 'useThoughtSummary',
            action: 'generateSummary',
          })
          if (epochRef.current === epoch) setThoughtSummary('')
        })
        .finally(() => {
          if (epochRef.current === epoch) inFlightRef.current = false
        })
    }

    const delay =
      MIN_SUMMARY_INTERVAL_MS - (Date.now() - lastSummaryTimeRef.current)
    if (delay <= 0) {
      fire()
      return
    }
    const timeoutId = setTimeout(fire, delay)
    return () => clearTimeout(timeoutId)
  }, [thoughts, isThinking, enabled])

  return thoughtSummary
}
