'use client'

import { CONSTANTS } from '@/components/chat/constants'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { useCallback, useEffect, useRef, useState } from 'react'

const COLLAPSED_MAX_WIDTH_REM = 52

interface ExpandableTableProps {
  children: React.ReactNode
}

export function ExpandableTable({ children }: ExpandableTableProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const checkOverflow = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const collapsedPx =
      COLLAPSED_MAX_WIDTH_REM *
      parseFloat(getComputedStyle(document.documentElement).fontSize)
    setCanExpand(el.scrollWidth > collapsedPx)
  }, [])

  useEffect(() => {
    const checkMobile = () =>
      setIsMobile(window.innerWidth < CONSTANTS.MOBILE_BREAKPOINT)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  useEffect(() => {
    checkOverflow()

    const observer = new ResizeObserver(checkOverflow)
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }
    return () => observer.disconnect()
  }, [checkOverflow])

  const toggle = () => setIsExpanded((prev) => !prev)

  const chevronBase =
    'pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border-subtle bg-white text-content-secondary shadow hover:text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-accent-dark dark:bg-zinc-800 dark:focus:ring-brand-accent-light'

  const collapsed = canExpand && !isExpanded
  const expanded = canExpand && isExpanded

  // On mobile, tables stay within bounds and scroll horizontally inside their container
  const showExpandControls = canExpand && !isMobile

  return (
    <div
      className={`table-breakout group/table relative my-4 ${collapsed && !isMobile ? 'rounded-lg border border-border-subtle' : ''}`}
      style={
        isMobile
          ? undefined
          : {
              maxWidth: isExpanded
                ? 'calc(100cqw - 2rem)'
                : `${COLLAPSED_MAX_WIDTH_REM}rem`,
            }
      }
    >
      <div
        ref={containerRef}
        tabIndex={0}
        role="group"
        aria-label="Table, scroll horizontally to see more"
        className="relative z-0 overflow-x-auto"
      >
        <table
          className="divide-y divide-border-subtle"
          style={isMobile ? undefined : { minWidth: 'max-content' }}
        >
          {children}
        </table>
      </div>

      {showExpandControls && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={isExpanded}
            className={`${chevronBase} absolute left-1.5 top-1/2 -translate-y-1/2 ${expanded ? 'opacity-0 transition-opacity focus:opacity-100 group-focus-within/table:opacity-100 group-hover/table:opacity-100' : ''}`}
            aria-label={collapsed ? 'Expand table' : 'Collapse table'}
          >
            {collapsed ? (
              <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={isExpanded}
            className={`${chevronBase} absolute right-1.5 top-1/2 -translate-y-1/2 ${expanded ? 'opacity-0 transition-opacity focus:opacity-100 group-focus-within/table:opacity-100 group-hover/table:opacity-100' : ''}`}
            aria-label={collapsed ? 'Expand table' : 'Collapse table'}
          >
            {collapsed ? (
              <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      )}
    </div>
  )
}
