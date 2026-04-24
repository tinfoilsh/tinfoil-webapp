import { useEffect, useRef, useState } from 'react'

interface StreamingTracerDotProps {
  className?: string
  label?: string
  tone?: 'primary' | 'secondary'
}

const SQUARE_SIZE_PX = 5
const GAP_PX = 2.5
const STRIDE_PX = SQUARE_SIZE_PX + GAP_PX
const STEP_DURATION_MS = 90

export function StreamingTracerDot({
  className = '',
  label = 'Streaming response',
  tone = 'primary',
}: StreamingTracerDotProps) {
  const toneClass =
    tone === 'secondary' ? 'text-content-primary/50' : 'text-content-primary'
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const [cells, setCells] = useState(6)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const update = () => {
      const width = el.clientWidth
      const next = Math.max(2, Math.floor((width + GAP_PX) / STRIDE_PX))
      setCells((prev) => (prev === next ? prev : next))
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const durationMs = cells * STEP_DURATION_MS
  const travelPx = cells * STRIDE_PX

  return (
    <>
      <span
        ref={containerRef}
        className={`tracer-loader relative block w-full overflow-hidden ${toneClass} ${className}`}
        role="status"
        aria-label={label}
      >
        <span
          className="tracer-loader__highlight"
          style={{
            animationDuration: `${durationMs}ms`,
            animationTimingFunction: `steps(${cells})`,
            ['--travel' as string]: `${travelPx}px`,
          }}
        />
      </span>
      <style jsx>{`
        .tracer-loader {
          height: ${SQUARE_SIZE_PX}px;
          box-sizing: border-box;
          -webkit-mask: linear-gradient(
              90deg,
              #000 ${SQUARE_SIZE_PX}px,
              #0000 0
            )
            left / ${STRIDE_PX}px 100%;
          mask: linear-gradient(90deg, #000 ${SQUARE_SIZE_PX}px, #0000 0) left /
            ${STRIDE_PX}px 100%;
          background: color-mix(in srgb, currentColor 25%, transparent);
        }

        .tracer-loader__highlight {
          position: absolute;
          top: 0;
          left: 0;
          width: ${SQUARE_SIZE_PX}px;
          height: 100%;
          background: currentColor;
          animation-name: tracer-loader-slide;
          animation-iteration-count: infinite;
        }

        @keyframes tracer-loader-slide {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(var(--travel));
          }
        }
      `}</style>
    </>
  )
}
