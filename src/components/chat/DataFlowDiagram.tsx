import { memo, useLayoutEffect, useRef, useState } from 'react'
import { BiSolidLock } from 'react-icons/bi'
import { HiOutlineServer } from 'react-icons/hi'
import { HiOutlineKey, HiShieldCheck } from 'react-icons/hi2'

const ARROW_COLOR = 'hsl(var(--content-muted) / 0.7)'

const DESIGN_W = 591
const DESIGN_H = 410

function Arrow({ d }: { d: string }) {
  return (
    <path
      d={d}
      style={{ stroke: ARROW_COLOR }}
      strokeWidth="1.5"
      strokeDasharray="4 5"
      strokeLinecap="round"
      className="df-animated-arrow"
      markerEnd="url(#df-arrow)"
    />
  )
}

/**
 * Simplified data-flow diagram showing how data flows between the
 * Tinfoil Chat App, Tinfoil Server, and Inference Processing enclave.
 *
 * Four arrows:
 *   1. Enclave top  -> Verification Proof pill (proof sent up)
 *   2. Pill left    -> App top                 (proof delivered to app)
 *   3. App right    -> Enclave left            (encrypted request)
 *   4. Enclave left -> App right               (encrypted response)
 *
 * All coordinates target a fixed 520x340 canvas. The diagram scales
 * down proportionally on smaller screens via ResizeObserver.
 */
export const DataFlowDiagram = memo(function DataFlowDiagram({
  onOpenVerifier,
}: {
  onOpenVerifier?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) {
        setScale(Math.min(width / DESIGN_W, 1))
      }
    }

    measure()

    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // SVG arrow connection points
  const pillLeft = { x: 175, y: 10 }
  const pillRight = { x: 355, y: 10 }

  const appTop = { x: 65, y: 187 }
  const appRightUpper = { x: 195, y: 210 }
  const appRightLower = { x: 195, y: 230 }

  const enclaveTopRight = { x: 536, y: 185 }
  const enclaveLeftUpper = { x: 280, y: 210 }
  const enclaveLeftLower = { x: 280, y: 230 }

  return (
    <div
      ref={containerRef}
      className="relative mt-5 w-full select-none overflow-hidden"
      style={{
        height: scale !== null ? DESIGN_H * scale : 0,
        visibility: scale !== null ? 'visible' : 'hidden',
      }}
    >
      <style>{`
        @keyframes df-dash {
          to { stroke-dashoffset: -18; }
        }
        .df-animated-arrow {
          animation: df-dash 2.4s linear infinite;
        }
      `}</style>

      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: DESIGN_W,
          height: DESIGN_H,
          transform: `scale(${scale ?? 1})`,
          willChange: 'transform',
        }}
      >
        <svg
          viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`}
          fill="none"
          className="absolute inset-0 h-full w-full"
        >
          <defs>
            <marker
              id="df-arrow"
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" style={{ fill: ARROW_COLOR }} />
            </marker>
          </defs>

          {/* Enclave top -> pill right */}
          <Arrow
            d={`M ${enclaveTopRight.x} ${enclaveTopRight.y} L ${enclaveTopRight.x} ${pillRight.y + 14} L ${pillRight.x} ${pillRight.y + 14}`}
          />

          {/* Pill left -> app top */}
          <Arrow
            d={`M ${pillLeft.x} ${pillLeft.y + 14} L ${appTop.x} ${pillLeft.y + 14} L ${appTop.x} ${appTop.y}`}
          />

          {/* App -> enclave (request) */}
          <Arrow
            d={`M ${appRightUpper.x} ${appRightUpper.y} L ${enclaveLeftUpper.x} ${enclaveLeftUpper.y}`}
          />

          {/* Enclave -> app (response) */}
          <Arrow
            d={`M ${enclaveLeftLower.x} ${enclaveLeftLower.y} L ${appRightLower.x} ${appRightLower.y}`}
          />
        </svg>

        {/* Verification Proof pill */}
        <div
          className="absolute top-[8px]"
          style={{ left: 'calc(50% - 30px)', transform: 'translateX(-50%)' }}
        >
          <div className="flex items-center gap-1.5 whitespace-nowrap rounded border border-brand-accent-light/40 bg-brand-accent-light/10 px-3 py-1.5 text-base font-medium text-brand-accent-dark dark:border-brand-accent-light/30 dark:bg-brand-accent-light/10 dark:text-brand-accent-light">
            <HiShieldCheck className="h-4 w-4" />
            <span>Attestation Proof</span>
          </div>
        </div>

        {/* Tinfoil Server container */}
        <div
          className="absolute rounded border border-border-subtle bg-surface-card/50 px-5 pb-5 pt-3 dark:bg-surface-card/30"
          style={{
            left: 236,
            top: 72,
            width: 355,
            height: 260,
          }}
        >
          <div className="flex items-center gap-2 whitespace-nowrap">
            <HiOutlineServer className="h-4 w-4 shrink-0 text-content-muted" />
            <span className="text-base font-medium text-content-primary">
              Tinfoil Server
            </span>
          </div>
          <ul className="mt-1 list-disc pl-4 text-sm text-content-muted">
            <li className="whitespace-nowrap">Cannot access user data</li>
            <li className="whitespace-nowrap">
              Cannot see inside of the enclave
            </li>
          </ul>
        </div>

        {/* Inference Processing (enclave) */}
        <div
          className="absolute rounded border border-brand-accent-light/40 bg-white px-4 py-3 shadow-sm dark:border-brand-accent-light/30 dark:bg-surface-card"
          style={{
            width: 280,
            left: 280,
            top: 185,
          }}
        >
          <div className="flex items-center gap-2 whitespace-nowrap">
            <BiSolidLock className="h-3.5 w-3.5 shrink-0 text-brand-accent-dark dark:text-brand-accent-light" />
            <span className="text-base font-medium text-content-primary">
              Secure Enclave
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-content-muted">
            Requests processed in secure hardware, isolated from the server.
          </p>
        </div>

        {/* Tinfoil Chat App */}
        <div
          className="absolute rounded border border-brand-accent-light/40 bg-white px-4 py-3 shadow-sm dark:border-brand-accent-light/30 dark:bg-surface-card"
          style={{ left: 0, top: 190, width: 195 }}
        >
          <div className="flex items-center gap-2 whitespace-nowrap">
            <HiOutlineKey className="h-4 w-4 shrink-0 text-content-muted" />
            <span className="text-base font-medium text-content-primary">
              Tinfoil Chat App
            </span>
          </div>
          <ul className="mt-1 list-disc pl-4 text-sm text-content-muted">
            <li className="whitespace-nowrap">Verifies attestation</li>
            <li className="whitespace-nowrap">Encrypts requests</li>
          </ul>
        </div>

        {/* Open verification center button */}
        {onOpenVerifier && (
          <button
            type="button"
            onClick={onOpenVerifier}
            className="absolute rounded border border-brand-accent-light/40 bg-brand-accent-light/10 px-4 py-1.5 text-sm font-medium text-brand-accent-dark transition-colors hover:bg-brand-accent-light/20 dark:border-brand-accent-light/30 dark:text-brand-accent-light"
            style={{ left: 0, top: 340, width: 195 }}
          >
            Open verification center
          </button>
        )}
      </div>
    </div>
  )
})
