import { cn } from '@/components/ui/utils'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { useLayoutEffect, useRef, useState } from 'react'
import { PiLightbulbFilament } from 'react-icons/pi'
import type { ReasoningEffort } from './hooks/use-reasoning-effort'

const EFFORT_OPTIONS: {
  value: ReasoningEffort
  label: string
  description: string
}[] = [
  { value: 'high', label: 'High', description: 'Deep thinking' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { value: 'low', label: 'Low', description: 'Quick responses' },
]

type ReasoningEffortSelectorProps = {
  /** Whether the model exposes graded effort (low/medium/high). */
  supportsEffort: boolean
  /** Whether the model exposes an on/off thinking toggle. */
  supportsToggle: boolean
  reasoningEffort: ReasoningEffort
  onEffortChange: (effort: ReasoningEffort) => void
  thinkingEnabled: boolean
  onThinkingEnabledChange: (enabled: boolean) => void
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
  /** Preferred dropdown direction; flips automatically when space is tight. */
  preferredPosition?: 'above' | 'below'
}

export function ReasoningEffortSelector({
  supportsEffort,
  supportsToggle,
  reasoningEffort,
  onEffortChange,
  thinkingEnabled,
  onThinkingEnabledChange,
  isOpen,
  onToggle,
  onClose,
  preferredPosition = 'above',
}: ReasoningEffortSelectorProps) {
  if (!supportsEffort && !supportsToggle) {
    return null
  }

  // Both effort-supporting and toggle-only models render an icon button that
  // opens a popover. Effort models list the graded options; toggle-only models
  // expose On/Off rows. When a model supports both, the popover includes an
  // additional "Off" option below the effort rows. A chevron next to the
  // lightbulb icon signals the dropdown; the active selection is surfaced via
  // the popover's row highlighting.
  const currentEffort =
    EFFORT_OPTIONS.find((o) => o.value === reasoningEffort) ?? EFFORT_OPTIONS[1]
  const isThinkingActive = !supportsToggle || thinkingEnabled
  const buttonTitle = supportsEffort
    ? isThinkingActive
      ? `Reasoning effort: ${currentEffort.label}`
      : 'Thinking off'
    : isThinkingActive
      ? 'Thinking on'
      : 'Thinking off'

  return (
    <div className="relative">
      <button
        type="button"
        data-reasoning-selector
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggle()
        }}
        className={cn(
          'flex items-center gap-0.5 rounded-md px-3 py-1 transition-colors',
          isThinkingActive
            ? 'text-content-primary'
            : 'text-content-secondary hover:text-content-primary',
        )}
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <ReasoningIcon active={isThinkingActive} />
        <ChevronDownIcon
          className={cn(
            'h-3 w-3 transition-transform',
            isOpen ? 'rotate-180' : '',
          )}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <ReasoningPopover
          supportsEffort={supportsEffort}
          supportsToggle={supportsToggle}
          thinkingEnabled={thinkingEnabled}
          reasoningEffort={reasoningEffort}
          onEffortChange={onEffortChange}
          onThinkingEnabledChange={onThinkingEnabledChange}
          onClose={onClose}
          preferredPosition={preferredPosition}
        />
      )}
    </div>
  )
}

type ReasoningPopoverProps = {
  supportsEffort: boolean
  supportsToggle: boolean
  thinkingEnabled: boolean
  reasoningEffort: ReasoningEffort
  onEffortChange: (effort: ReasoningEffort) => void
  onThinkingEnabledChange: (enabled: boolean) => void
  onClose: () => void
  preferredPosition: 'above' | 'below'
}

function ReasoningPopover({
  supportsEffort,
  supportsToggle,
  thinkingEnabled,
  reasoningEffort,
  onEffortChange,
  onThinkingEnabledChange,
  onClose,
  preferredPosition,
}: ReasoningPopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)

  // Mirrors model-selector positioning: honor the requested direction but
  // flip when there isn't enough vertical space, so the menu stays visible
  // inside the viewport on mobile when the keyboard is up.
  const [dynamicStyles, setDynamicStyles] = useState<{
    maxHeight: string
    bottom?: string
    top?: string
  }>({
    maxHeight: '400px',
    ...(preferredPosition === 'below' ? { top: '100%' } : { bottom: '100%' }),
  })

  useLayoutEffect(() => {
    let animationFrameId: number | null = null

    const calculatePosition = () => {
      const menuElement = menuRef.current
      if (!menuElement) return

      const buttonElement = menuElement.parentElement
      if (!buttonElement) return

      const buttonRect = buttonElement.getBoundingClientRect()

      const spaceAbove = buttonRect.top - 20
      const spaceBelow = window.innerHeight - buttonRect.bottom - 20

      let useAbove = preferredPosition === 'above'

      if (
        preferredPosition === 'above' &&
        spaceAbove < 150 &&
        spaceBelow > 150
      ) {
        useAbove = false
      } else if (
        preferredPosition === 'below' &&
        spaceBelow < 150 &&
        spaceAbove > 150
      ) {
        useAbove = true
      }

      const isMobile = window.innerWidth < 768
      const maxHeightCap = isMobile ? 300 : window.innerHeight * 0.7

      if (useAbove) {
        setDynamicStyles({
          maxHeight: `${Math.min(Math.max(0, spaceAbove), maxHeightCap)}px`,
          bottom: '100%',
          top: undefined,
        })
      } else {
        setDynamicStyles({
          maxHeight: `${Math.min(Math.max(0, spaceBelow), maxHeightCap)}px`,
          top: '100%',
          bottom: undefined,
        })
      }
    }

    const throttledCalculatePosition = () => {
      if (animationFrameId !== null) return
      animationFrameId = requestAnimationFrame(() => {
        calculatePosition()
        animationFrameId = null
      })
    }

    calculatePosition()

    window.addEventListener('resize', throttledCalculatePosition)
    window.addEventListener('scroll', throttledCalculatePosition)

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId)
      window.removeEventListener('resize', throttledCalculatePosition)
      window.removeEventListener('scroll', throttledCalculatePosition)
    }
  }, [preferredPosition])

  const focusTrigger = () => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-reasoning-selector]')?.focus()
    })
  }

  return (
    <div
      ref={menuRef}
      data-reasoning-menu
      role="menu"
      aria-label="Thinking options"
      className={cn(
        'absolute z-50 w-[200px] overflow-y-auto rounded-lg border border-border-subtle bg-surface-chat p-1 font-aeonik-fono text-content-secondary shadow-lg',
        dynamicStyles.bottom ? 'mb-2' : 'mt-2',
      )}
      style={{
        maxHeight: dynamicStyles.maxHeight,
        ...(dynamicStyles.bottom && { bottom: dynamicStyles.bottom }),
        ...(dynamicStyles.top && { top: dynamicStyles.top }),
      }}
      onTouchStart={(e) => {
        e.stopPropagation()
        isScrollingRef.current = false
      }}
      onTouchMove={(e) => {
        e.stopPropagation()
        isScrollingRef.current = true
      }}
      onTouchEnd={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {supportsEffort &&
        EFFORT_OPTIONS.map((option) => {
          const isActive =
            (!supportsToggle || thinkingEnabled) &&
            reasoningEffort === option.value
          const handleSelect = () => {
            if (supportsToggle && !thinkingEnabled) {
              onThinkingEnabledChange(true)
            }
            onEffortChange(option.value)
            onClose()
            focusTrigger()
          }
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={isActive}
              className={cn(
                'flex w-full flex-col rounded-md border px-3 py-2 text-left text-sm transition-colors',
                isActive
                  ? 'border-border-subtle bg-surface-card text-content-primary'
                  : 'border-transparent hover:bg-surface-card/70',
              )}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleSelect()
              }}
              onTouchEnd={(e) => {
                e.stopPropagation()
                if (isScrollingRef.current) return
                e.preventDefault()
                handleSelect()
              }}
            >
              <span className="font-medium">{option.label}</span>
              <span className="text-xs text-content-muted">
                {option.description}
              </span>
            </button>
          )
        })}
      {supportsToggle && !supportsEffort && (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={thinkingEnabled}
          className={cn(
            'flex w-full flex-col rounded-md border px-3 py-2 text-left text-sm transition-colors',
            thinkingEnabled
              ? 'border-border-subtle bg-surface-card text-content-primary'
              : 'border-transparent hover:bg-surface-card/70',
          )}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onThinkingEnabledChange(true)
            onClose()
            focusTrigger()
          }}
          onTouchEnd={(e) => {
            e.stopPropagation()
            if (isScrollingRef.current) return
            e.preventDefault()
            onThinkingEnabledChange(true)
            onClose()
            focusTrigger()
          }}
        >
          <span className="font-medium">On</span>
          <span className="text-xs text-content-muted">
            Enable thinking mode
          </span>
        </button>
      )}
      {supportsToggle && (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={!thinkingEnabled}
          className={cn(
            'flex w-full flex-col rounded-md border px-3 py-2 text-left text-sm transition-colors',
            !thinkingEnabled
              ? 'border-border-subtle bg-surface-card text-content-primary'
              : 'border-transparent hover:bg-surface-card/70',
          )}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onThinkingEnabledChange(false)
            onClose()
            focusTrigger()
          }}
          onTouchEnd={(e) => {
            e.stopPropagation()
            if (isScrollingRef.current) return
            e.preventDefault()
            onThinkingEnabledChange(false)
            onClose()
            focusTrigger()
          }}
        >
          <span className="font-medium">Off</span>
          <span className="text-xs text-content-muted">
            Disable thinking mode
          </span>
        </button>
      )}
    </div>
  )
}

/**
 * Lightbulb glyph used as the trigger for the reasoning selector. When
 * `active` is false (thinking is off), a diagonal stroke is overlaid on
 * top of the icon to indicate the disabled state — the slash is drawn
 * manually as a rotated absolutely-positioned bar that adapts to the
 * current text color in both light and dark themes.
 */
function ReasoningIcon({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center">
      <PiLightbulbFilament className="h-4 w-4" />
      {!active && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-px w-[18px] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current"
        />
      )}
    </span>
  )
}
