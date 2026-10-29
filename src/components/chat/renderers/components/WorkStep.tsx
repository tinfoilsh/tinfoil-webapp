import { LoadingDots } from '@/components/loading-dots'
import { cn } from '@/components/ui/utils'
import type { ReactNode } from 'react'

// The box a step's details show in, below its header.
export const STEP_BOX_CLASS_NAME = 'rounded-lg border border-border-subtle'

function Chevron({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-content-primary/40 transition-transform motion-reduce:transition-none',
        isExpanded && 'rotate-90',
      )}
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
  )
}

interface StepHeaderProps {
  label: ReactNode
  // Shown after the label, as the favicons of the pages a step found.
  extra?: ReactNode
  // A running step leads with a progress indicator.
  isRunning: boolean
  isExpanded: boolean
  onToggle: () => void
  // The details the header shows and hides; a step without details has none.
  detailsId?: string
  truncate?: boolean
  labelClassName?: string
}

// The row naming a step: its progress indicator while it runs, what it
// does, and a chevron right after the text when it has details to show.
export function StepHeader({
  label,
  extra,
  isRunning,
  isExpanded,
  onToggle,
  detailsId,
  truncate = false,
  labelClassName = 'text-content-primary/50',
}: StepHeaderProps) {
  const canExpand = detailsId !== undefined
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!canExpand}
      aria-expanded={canExpand ? isExpanded : undefined}
      aria-controls={detailsId}
      className={cn(
        'group -mx-1 flex min-w-0 max-w-full items-start gap-1.5 rounded-md px-1 py-1 text-left text-base transition-colors',
        canExpand
          ? 'hover:bg-surface-secondary/50 cursor-pointer'
          : 'cursor-default',
      )}
    >
      {isRunning && (
        <span className="flex h-6 shrink-0 items-center" aria-hidden="true">
          <LoadingDots size="small" />
        </span>
      )}
      <span className={cn('min-w-0', truncate && 'truncate', labelClassName)}>
        {label}
      </span>
      {extra && <span className="flex h-6 shrink-0 items-center">{extra}</span>}
      {canExpand && (
        <span className="flex h-6 shrink-0 items-center">
          <Chevron isExpanded={isExpanded} />
        </span>
      )}
    </button>
  )
}

interface StepDetailsProps {
  id: string
  isExpanded: boolean
  // A step of a group shows its details in the group's box.
  inGroup?: boolean
  boxClassName?: string
  children: ReactNode
}

export function StepDetails({
  id,
  isExpanded,
  inGroup = false,
  boxClassName = 'px-3 py-2',
  children,
}: StepDetailsProps) {
  return (
    <div
      id={id}
      inert={!isExpanded}
      className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={inGroup ? 'pb-2' : cn(STEP_BOX_CLASS_NAME, boxClassName)}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
