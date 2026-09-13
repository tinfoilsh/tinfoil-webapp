import { SteppedSlider } from '@/components/ui/stepped-slider'
import {
  AUTO_INTELLIGENCE_LEVELS,
  getAutoIntelligenceLevel,
  getAutoModel,
  isAutoModelId,
  resolveModelSelection,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@/config/models'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type TouchEvent,
} from 'react'
import { PiShuffleAngularBold } from 'react-icons/pi'
import {
  DEFAULT_EFFORT,
  supportsReasoningEffort,
  supportsThinkingToggle,
  type ReasoningEffort,
} from './hooks/use-reasoning-effort'
import { ModelLifecycleBadges } from './model-lifecycle-badges'
import type { AIModel } from './types'

const EFFORT_OPTIONS: {
  value: ReasoningEffort
  label: string
}[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const EFFORT_EXPLAINER =
  'Higher effort means more thorough responses, but takes longer.'

const INTELLIGENCE_EXPLAINER =
  'Higher intelligence picks a more capable model and thinks longer.'

const MOBILE_BREAKPOINT_PX = 768
const EFFORT_FLYOUT_WIDTH_PX = 240
const EFFORT_FLYOUT_GAP_PX = 8
const VIEWPORT_MARGIN_PX = 10

// The top section grows to fill the available height so tall screens see
// more models before the "Other models" fold. Row heights are estimated from
// the Tailwind classes below (padding plus text line heights) rather than
// measured, so the count is known before the first paint.
const MIN_TOP_MODEL_COUNT = 3
const MENU_PADDING_PX = 16
const MENU_DIVIDER_HEIGHT_PX = 9
const AUTO_MODEL_ROW_HEIGHT_PX = 40
const INTELLIGENCE_SLIDER_HEIGHT_PX = 84
const MODEL_ROW_HEIGHT_PX = 56
const EFFORT_ROW_HEIGHT_PX = 40
const THINKING_ROW_HEIGHT_PX = 56
const OTHER_MODELS_ROW_HEIGHT_PX = 40

type ModelSelectorProps = {
  selectedModel: AIModel
  onSelect: (model: AIModel) => void
  isDarkMode: boolean
  models: BaseModel[]
  preferredPosition?: 'above' | 'below'
  reasoningEffort?: ReasoningEffort
  onEffortChange?: (effort: ReasoningEffort) => void
  thinkingEnabled?: boolean
  onThinkingEnabledChange?: (enabled: boolean) => void
  autoIntelligence?: AutoIntelligenceLevelId
  onAutoIntelligenceChange?: (level: AutoIntelligenceLevelId) => void
}

export function ModelSelector({
  selectedModel,
  onSelect,
  isDarkMode,
  models,
  preferredPosition = 'above',
  reasoningEffort,
  onEffortChange,
  thinkingEnabled,
  onThinkingEnabledChange,
  autoIntelligence,
  onAutoIntelligenceChange,
}: ModelSelectorProps) {
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({})
  const menuRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const [showOtherModels, setShowOtherModels] = useState(false)
  const [showEffortOptions, setShowEffortOptions] = useState(false)
  const effortRowRef = useRef<HTMLButtonElement>(null)
  const effortFlyoutRef = useRef<HTMLDivElement>(null)
  const [isMobileLayout, setIsMobileLayout] = useState(false)
  const [effortFlyout, setEffortFlyout] = useState<{
    top: number
    left: number
  } | null>(null)

  const [dynamicStyles, setDynamicStyles] = useState<{
    maxHeight: string
    bottom?: string
    top?: string
    left?: string
    right?: string
  }>({
    maxHeight: '400px',
    ...(preferredPosition === 'below' ? { top: '100%' } : { bottom: '100%' }),
  })

  const handleImageError = (modelName: string) => {
    setFailedImages((prev) => ({ ...prev, [modelName]: true }))
  }

  const handleImageLoad = (modelName: string) => {
    setLoadedImages((prev) => ({ ...prev, [modelName]: true }))
  }

  useLayoutEffect(() => {
    let animationFrameId: number | null = null

    const calculatePosition = () => {
      const menuElement = menuRef.current
      if (!menuElement) return

      const buttonElement = menuElement.parentElement
      if (!buttonElement) return

      const buttonRect = buttonElement.getBoundingClientRect()

      // On mobile browsers (notably Firefox for Android) window.innerHeight
      // does not account for the dynamic toolbar or on-screen keyboard, which
      // can collapse the computed space and hide below-the-fold models. The
      // visual viewport reflects the actually-visible area, so prefer it.
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight

      const spaceAbove = buttonRect.top - 20
      const spaceBelow = viewportHeight - buttonRect.bottom - 20

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

      const isMobile = window.innerWidth < MOBILE_BREAKPOINT_PX
      const maxHeightCap = isMobile ? 300 : viewportHeight * 0.7

      const menuWidth = 280
      const viewportWidth = window.innerWidth
      const buttonLeft = buttonRect.left
      const buttonRight = buttonRect.right

      let horizontalStyles: { left?: string; right?: string } = {}

      if (isMobile) {
        if (buttonLeft + menuWidth > viewportWidth - 10) {
          const rightOffset = viewportWidth - buttonRight
          const dropdownLeft = viewportWidth - rightOffset - menuWidth
          if (dropdownLeft < 10) {
            horizontalStyles = { left: `${-buttonLeft + 10}px` }
          } else {
            horizontalStyles = { right: '0' }
          }
        }
      }

      if (useAbove) {
        setDynamicStyles({
          maxHeight: `${Math.min(Math.max(0, spaceAbove), maxHeightCap)}px`,
          bottom: '100%',
          top: undefined,
          ...horizontalStyles,
        })
      } else {
        setDynamicStyles({
          maxHeight: `${Math.min(Math.max(0, spaceBelow), maxHeightCap)}px`,
          top: '100%',
          bottom: undefined,
          ...horizontalStyles,
        })
      }
    }

    const throttledCalculatePosition = () => {
      if (animationFrameId !== null) {
        return
      }
      animationFrameId = requestAnimationFrame(() => {
        calculatePosition()
        animationFrameId = null
      })
    }

    calculatePosition()

    window.addEventListener('resize', throttledCalculatePosition)
    window.addEventListener('scroll', throttledCalculatePosition)
    // The visual viewport changes when the mobile toolbar or keyboard shows
    // or hides without firing window resize, so track it to keep the menu
    // height and position in sync (e.g. Firefox for Android).
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', throttledCalculatePosition)
    visualViewport?.addEventListener('scroll', throttledCalculatePosition)

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
      }
      window.removeEventListener('resize', throttledCalculatePosition)
      window.removeEventListener('scroll', throttledCalculatePosition)
      visualViewport?.removeEventListener('resize', throttledCalculatePosition)
      visualViewport?.removeEventListener('scroll', throttledCalculatePosition)
    }
  }, [preferredPosition])

  useLayoutEffect(() => {
    const updateLayout = () =>
      setIsMobileLayout(window.innerWidth < MOBILE_BREAKPOINT_PX)
    updateLayout()
    window.addEventListener('resize', updateLayout)
    return () => window.removeEventListener('resize', updateLayout)
  }, [])

  // Anchors the effort flyout beside the menu at the Effort row's height,
  // preferring the right side, otherwise the roomier side, and clamping into
  // the viewport (overlapping the menu beats rendering off-screen).
  const recalcEffortFlyout = useCallback(() => {
    const menuElement = menuRef.current
    const rowElement = effortRowRef.current
    if (!menuElement || !rowElement) return
    const menuRect = menuElement.getBoundingClientRect()
    const rowRect = rowElement.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    const spaceRight =
      viewportWidth -
      VIEWPORT_MARGIN_PX -
      (menuRect.right + EFFORT_FLYOUT_GAP_PX)
    const spaceLeft = menuRect.left - EFFORT_FLYOUT_GAP_PX - VIEWPORT_MARGIN_PX
    const useRight =
      spaceRight >= EFFORT_FLYOUT_WIDTH_PX || spaceRight >= spaceLeft
    const desiredLeft = useRight
      ? menuRect.right + EFFORT_FLYOUT_GAP_PX
      : menuRect.left - EFFORT_FLYOUT_GAP_PX - EFFORT_FLYOUT_WIDTH_PX
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(
        desiredLeft,
        viewportWidth - VIEWPORT_MARGIN_PX - EFFORT_FLYOUT_WIDTH_PX,
      ),
    )
    const flyoutHeight = effortFlyoutRef.current?.offsetHeight ?? 0
    const maxTop = viewportHeight - VIEWPORT_MARGIN_PX - flyoutHeight
    const top = Math.min(rowRect.top, Math.max(VIEWPORT_MARGIN_PX, maxTop))
    setEffortFlyout({ top: top - menuRect.top, left: left - menuRect.left })
  }, [])

  useLayoutEffect(() => {
    if (!showEffortOptions || isMobileLayout) {
      setEffortFlyout(null)
      return
    }
    recalcEffortFlyout()
    window.addEventListener('resize', recalcEffortFlyout)
    window.addEventListener('scroll', recalcEffortFlyout)
    return () => {
      window.removeEventListener('resize', recalcEffortFlyout)
      window.removeEventListener('scroll', recalcEffortFlyout)
    }
  }, [showEffortOptions, isMobileLayout, recalcEffortFlyout])

  const autoModel = getAutoModel(models)
  const isAutoSelected = isAutoModelId(selectedModel)
  const showIntelligenceSlider =
    isAutoSelected &&
    autoModel !== undefined &&
    autoIntelligence !== undefined &&
    onAutoIntelligenceChange !== undefined

  // Reasoning controls live at the bottom of the menu and reflect the
  // currently selected model. They only render when the parent wires the
  // reasoning props and the model exposes the matching capability. Auto hides
  // them: the router chooses the effort from the intelligence level.
  const resolvedModel = isAutoSelected
    ? undefined
    : resolveModelSelection(selectedModel, models).model
  const showEffort =
    supportsReasoningEffort(resolvedModel) &&
    reasoningEffort !== undefined &&
    onEffortChange !== undefined
  const showThinkingToggle =
    supportsThinkingToggle(resolvedModel) &&
    thinkingEnabled !== undefined &&
    onThinkingEnabledChange !== undefined
  const isThinkingActive = !showThinkingToggle || thinkingEnabled === true
  const currentEffort =
    EFFORT_OPTIONS.find((o) => o.value === reasoningEffort) ?? EFFORT_OPTIONS[1]

  const displayModels = models.filter(
    (model) =>
      (model.type === 'chat' || model.type === 'code') &&
      model.chat === true &&
      model.deprecated !== true,
  )

  const availableHeight = Number.parseInt(dynamicStyles.maxHeight, 10) || 0
  const fixedHeight =
    MENU_PADDING_PX +
    (autoModel ? AUTO_MODEL_ROW_HEIGHT_PX + MENU_DIVIDER_HEIGHT_PX : 0) +
    (showIntelligenceSlider ? INTELLIGENCE_SLIDER_HEIGHT_PX : 0) +
    (showEffort || showThinkingToggle ? MENU_DIVIDER_HEIGHT_PX : 0) +
    (showEffort ? EFFORT_ROW_HEIGHT_PX : 0) +
    (showThinkingToggle ? THINKING_ROW_HEIGHT_PX : 0) +
    MENU_DIVIDER_HEIGHT_PX +
    OTHER_MODELS_ROW_HEIGHT_PX
  const topModelCount = Math.max(
    MIN_TOP_MODEL_COUNT,
    Math.floor((availableHeight - fixedHeight) / MODEL_ROW_HEIGHT_PX),
  )
  const topModels = displayModels.slice(0, topModelCount)
  const otherModels = displayModels.slice(topModelCount)

  const getModelIcon = (model: BaseModel) => {
    if (failedImages[model.modelName]) return '/icon.png'
    if (model.image === 'openai.png')
      return `/model-icons/openai-${isDarkMode ? 'dark' : 'light'}.png`
    if (model.image === 'moonshot.png')
      return `/model-icons/moonshot-${isDarkMode ? 'dark' : 'light'}.png`
    return `/model-icons/${model.image}`
  }

  const focusTrigger = () => {
    requestAnimationFrame(() => {
      menuRef.current?.parentElement
        ?.querySelector<HTMLElement>('[data-model-selector]')
        ?.focus()
    })
  }

  // Shared handlers for every actionable menu row: taps only activate when
  // the touch was not a scroll gesture, and propagation is stopped so the
  // document-level dismiss handler does not close the menu first.
  const menuItemHandlers = (action: () => void) => ({
    onClick: (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      action()
    },
    onTouchEnd: (e: TouchEvent) => {
      e.stopPropagation()
      if (isScrollingRef.current) return
      e.preventDefault()
      action()
    },
    onMouseDown: (e: MouseEvent) => e.stopPropagation(),
  })

  const renderEffortContent = () => (
    <>
      <p className="px-3 py-1 text-xs text-content-muted">{EFFORT_EXPLAINER}</p>
      {EFFORT_OPTIONS.map((option) => {
        const isActive = isThinkingActive && reasoningEffort === option.value
        const handleSelect = () => {
          if (showThinkingToggle && !thinkingEnabled) {
            onThinkingEnabledChange?.(true)
          }
          onEffortChange?.(option.value)
        }
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={isActive}
            className={`relative flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${isActive ? 'text-content-primary' : 'cursor-pointer text-content-secondary hover:bg-surface-card/70'}`}
            {...menuItemHandlers(handleSelect)}
          >
            <span className="font-medium">{option.label}</span>
            {option.value === DEFAULT_EFFORT && (
              <span className="rounded bg-surface-card px-1.5 py-0.5 text-xs text-content-muted">
                Default
              </span>
            )}
            <span className="flex-1" />
            {isActive && (
              <CheckIcon
                className="h-4 w-4 flex-none text-brand-accent-dark dark:text-brand-accent-light"
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}
    </>
  )

  const renderModelItem = (model: BaseModel) => {
    const isSelected = model.isAuto
      ? isAutoSelected
      : model.modelName === selectedModel
    return (
      <button
        type="button"
        key={model.modelName}
        role="menuitemradio"
        aria-checked={isSelected}
        className={`relative flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${isSelected ? 'text-content-primary' : 'cursor-pointer text-content-secondary hover:bg-surface-card/70'}`}
        {...menuItemHandlers(() => {
          onSelect(model.modelName as AIModel)
          focusTrigger()
        })}
      >
        <div className="relative flex h-5 w-5 flex-none items-center justify-center">
          {model.isAuto ? (
            <PiShuffleAngularBold
              className="h-5 w-5 text-brand-accent-dark dark:text-brand-accent-light"
              aria-hidden="true"
            />
          ) : (
            <>
              {!loadedImages[model.modelName] &&
                !failedImages[model.modelName] && (
                  <div className="absolute h-5 w-5 rounded-full bg-gray-300 dark:bg-gray-600" />
                )}
              <img
                src={getModelIcon(model)}
                alt=""
                className={`h-5 w-5 transition-opacity duration-200 ${!loadedImages[model.modelName] && !failedImages[model.modelName] ? 'opacity-0' : ''}`}
                onLoad={() => handleImageLoad(model.modelName)}
                onError={() => handleImageError(model.modelName)}
              />
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{model.name}</span>
          {!model.isAuto && model.chatConfig?.descriptionShort && (
            <span className="text-xs text-content-muted">
              {model.chatConfig.descriptionShort}
            </span>
          )}
          {!model.isAuto && <ModelLifecycleBadges model={model} />}
        </div>
        {isSelected && (
          <CheckIcon
            className="mt-0.5 h-4 w-4 flex-none text-brand-accent-dark dark:text-brand-accent-light"
            aria-hidden="true"
          />
        )}
      </button>
    )
  }

  return (
    <div
      ref={menuRef}
      data-model-menu
      role="menu"
      aria-label="Select a model"
      className={`absolute z-50 flex w-[280px] flex-col rounded-lg border border-border-subtle bg-surface-chat font-aeonik-fono text-content-secondary shadow-lg ${dynamicStyles.bottom ? 'mb-2' : 'mt-2'}`}
      style={{
        maxHeight: dynamicStyles.maxHeight,
        ...(dynamicStyles.bottom && { bottom: dynamicStyles.bottom }),
        ...(dynamicStyles.top && { top: dynamicStyles.top }),
        ...(dynamicStyles.left && { left: dynamicStyles.left }),
        ...(dynamicStyles.right && { right: dynamicStyles.right }),
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
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onScroll={() => {
          if (showEffortOptions && !isMobileLayout) recalcEffortFlyout()
        }}
      >
        {autoModel && renderModelItem(autoModel)}

        {showIntelligenceSlider && (
          <div className="px-3 pb-2 pt-1">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium text-content-secondary">
                Intelligence
              </span>
              <span className="text-content-muted">
                {getAutoIntelligenceLevel(autoIntelligence).label}
              </span>
            </div>
            <SteppedSlider
              steps={AUTO_INTELLIGENCE_LEVELS}
              value={autoIntelligence}
              onValueChange={onAutoIntelligenceChange}
              aria-label="Auto intelligence"
            />
            <p className="mt-2 text-xs text-content-muted">
              {INTELLIGENCE_EXPLAINER}
            </p>
          </div>
        )}

        {autoModel && (
          <div className="mx-3 my-1 border-t border-border-subtle" />
        )}

        {topModels.map((model) => renderModelItem(model))}

        {(showEffort || showThinkingToggle) && (
          <div className="mx-3 my-1 border-t border-border-subtle" />
        )}

        {showEffort && (
          <>
            <button
              ref={effortRowRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={showEffortOptions}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm font-medium transition-colors ${showEffortOptions ? 'bg-surface-card/70 text-content-primary' : 'text-content-secondary hover:bg-surface-card/70'}`}
              {...menuItemHandlers(() => setShowEffortOptions((prev) => !prev))}
            >
              <span>Effort</span>
              <span className="flex items-center gap-1 text-content-muted">
                <span className="text-xs">
                  {isThinkingActive ? currentEffort.label : 'Off'}
                </span>
                <ChevronRightIcon
                  className={`h-4 w-4 transition-transform ${showEffortOptions && isMobileLayout ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                />
              </span>
            </button>

            {showEffortOptions && isMobileLayout && renderEffortContent()}
          </>
        )}

        {showThinkingToggle && (
          <>
            {showEffort && showEffortOptions && isMobileLayout && (
              <div className="mx-3 my-1 border-t border-border-subtle" />
            )}
            <button
              type="button"
              role="switch"
              aria-checked={thinkingEnabled}
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium text-content-secondary transition-colors hover:bg-surface-card/70"
              {...menuItemHandlers(() =>
                onThinkingEnabledChange?.(!thinkingEnabled),
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span>Thinking</span>
                <span className="text-xs font-normal text-content-muted">
                  Can think for more complex tasks
                </span>
              </div>
              <span
                aria-hidden="true"
                className={`relative h-5 w-9 flex-none rounded-full border border-border-subtle transition-colors after:absolute after:left-[1px] after:top-[1px] after:h-4 after:w-4 after:rounded-full after:shadow-sm after:transition-all after:content-[''] ${thinkingEnabled ? 'bg-brand-accent-light after:translate-x-full after:bg-white' : 'bg-content-muted/40 after:bg-content-muted/70'}`}
              />
            </button>
          </>
        )}

        {otherModels.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />
            <button
              type="button"
              aria-expanded={showOtherModels}
              className="flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm font-medium text-content-secondary transition-colors hover:bg-surface-card/70"
              {...menuItemHandlers(() => setShowOtherModels((prev) => !prev))}
            >
              <span>Other models</span>
              <ChevronDownIcon
                className={`h-4 w-4 text-content-muted transition-transform ${showOtherModels ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>

            {showOtherModels &&
              otherModels.map((model) => renderModelItem(model))}
          </>
        )}
      </div>

      {showEffort && showEffortOptions && !isMobileLayout && (
        <div
          ref={effortFlyoutRef}
          role="menu"
          aria-label="Reasoning effort"
          className="absolute rounded-lg border border-border-subtle bg-surface-chat p-2 shadow-lg"
          style={{
            width: `${EFFORT_FLYOUT_WIDTH_PX}px`,
            top: `${effortFlyout?.top ?? 0}px`,
            left: `${effortFlyout?.left ?? 0}px`,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {renderEffortContent()}
        </div>
      )}
    </div>
  )
}
