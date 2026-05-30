'use client'

import { useEffect, useState } from 'react'

interface TypingAnimationProps {
  fromText: string
  toText: string
  onComplete: () => void
}

/**
 * Animates text changes with a typewriter effect.
 * First deletes the old text character by character, then types the new text.
 */
export function TypingAnimation({
  fromText,
  toText,
  onComplete,
}: TypingAnimationProps) {
  const [currentText, setCurrentText] = useState(fromText)
  const [showCursor, setShowCursor] = useState(true)
  const [phase, setPhase] = useState<'deleting' | 'typing'>('deleting')
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    if (isComplete) return

    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev)
    }, 424)

    return () => clearInterval(cursorInterval)
  }, [isComplete])

  useEffect(() => {
    if (isComplete) return

    let timeoutId: NodeJS.Timeout

    if (phase === 'deleting') {
      if (currentText.length > 0) {
        timeoutId = setTimeout(
          () => {
            setCurrentText((prev) => prev.slice(0, -1))
          },
          20 + Math.random() * 12,
        )
      } else {
        setPhase('typing')
      }
    } else if (phase === 'typing') {
      if (currentText.length < toText.length) {
        timeoutId = setTimeout(
          () => {
            setCurrentText(toText.slice(0, currentText.length + 1))
          },
          28 + Math.random() * 16,
        )
      } else {
        setIsComplete(true)
      }
    }

    return () => {
      clearTimeout(timeoutId)
    }
  }, [currentText, phase, toText, isComplete])

  useEffect(() => {
    if (!isComplete) return

    const timeoutId = setTimeout(() => {
      onComplete()
    }, 200)

    return () => clearTimeout(timeoutId)
  }, [isComplete, onComplete])

  return (
    <span className="inline-flex items-baseline">
      <span>{currentText}</span>
      <span
        aria-hidden="true"
        className={`ml-0.5 inline-block w-0.5 bg-content-primary ${showCursor ? 'opacity-100' : 'opacity-0'}`}
        style={{ height: '1.1em', transform: 'translateY(0.05em)' }}
      />
    </span>
  )
}
