'use client'

import { useEffect, useRef } from 'react'

interface StreamingTracerDotProps {
  className?: string
  label?: string
  tone?: 'primary' | 'secondary'
}

const DOT_SIZE_PX = 10
const STYLE_ELEMENT_ID = 'tracer-dot-styles'

let persistentDot: HTMLDivElement | null = null

function ensureStylesInjected() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ELEMENT_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = `
    .tracer-dot {
      width: ${DOT_SIZE_PX}px;
      height: ${DOT_SIZE_PX}px;
      border-radius: 9999px;
      background: currentColor;
      animation: tracer-dot-pulse 1.6s ease-in-out infinite;
    }

    @keyframes tracer-dot-pulse {
      0%, 100% {
        transform: scale(0.6);
        opacity: 0.5;
      }
      50% {
        transform: scale(1);
        opacity: 1;
      }
    }
  `
  document.head.appendChild(style)
}

function getPersistentDot(): HTMLDivElement {
  if (persistentDot) return persistentDot
  ensureStylesInjected()
  const dot = document.createElement('div')
  dot.className = 'tracer-dot'
  persistentDot = dot
  return persistentDot
}

export function StreamingTracerDot({
  className = '',
  label = 'Streaming response',
  tone = 'primary',
}: StreamingTracerDotProps) {
  const toneClass =
    tone === 'secondary' ? 'text-content-primary/50' : 'text-content-primary'
  const hostRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const dot = getPersistentDot()
    host.appendChild(dot)

    return () => {
      if (dot.parentNode === host) {
        host.removeChild(dot)
      }
    }
  }, [])

  return (
    <span
      ref={hostRef}
      className={`inline-grid shrink-0 place-items-center ${toneClass} ${className}`}
      role="status"
      aria-label={label}
      style={{ width: DOT_SIZE_PX, height: DOT_SIZE_PX }}
    />
  )
}
