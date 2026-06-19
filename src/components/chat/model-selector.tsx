import { type BaseModel } from '@/config/models'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { useLayoutEffect, useRef, useState } from 'react'
import type { AIModel } from './types'

type ModelSelectorProps = {
  selectedModel: AIModel
  onSelect: (model: AIModel) => void
  isDarkMode: boolean
  models: BaseModel[]
  preferredPosition?: 'above' | 'below'
}

export function ModelSelector({
  selectedModel,
  onSelect,
  isDarkMode,
  models,
  preferredPosition = 'above',
}: ModelSelectorProps) {
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({})
  const menuRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const [showOtherModels, setShowOtherModels] = useState(false)

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

      const isMobile = window.innerWidth < 768
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

  const displayModels = models.filter(
    (model) =>
      (model.type === 'chat' || model.type === 'code') && model.chat === true,
  )

  const TOP_MODEL_COUNT = 3
  const topModels = displayModels.slice(0, TOP_MODEL_COUNT)
  const otherModels = displayModels.slice(TOP_MODEL_COUNT)

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
      document.querySelector<HTMLElement>('[data-model-selector]')?.focus()
    })
  }

  const renderModelItem = (model: BaseModel) => {
    const isSelected = model.modelName === selectedModel
    return (
      <button
        type="button"
        key={model.modelName}
        role="menuitemradio"
        aria-checked={isSelected}
        className={`relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${isSelected ? 'text-content-primary' : 'cursor-pointer text-content-secondary hover:bg-surface-card/70'}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onSelect(model.modelName as AIModel)
          focusTrigger()
        }}
        onTouchEnd={(e) => {
          e.stopPropagation()
          if (isScrollingRef.current) return
          e.preventDefault()
          onSelect(model.modelName as AIModel)
          focusTrigger()
        }}
      >
        <div className="relative flex h-5 w-5 flex-none items-center justify-center">
          {!loadedImages[model.modelName] && !failedImages[model.modelName] && (
            <div className="absolute h-5 w-5 rounded-full bg-gray-300 dark:bg-gray-600" />
          )}
          <img
            src={getModelIcon(model)}
            alt=""
            className={`h-5 w-5 transition-opacity duration-200 ${!loadedImages[model.modelName] && !failedImages[model.modelName] ? 'opacity-0' : ''}`}
            onLoad={() => handleImageLoad(model.modelName)}
            onError={() => handleImageError(model.modelName)}
          />
        </div>
        <div className="flex flex-1 flex-col">
          <span className="font-medium">{model.name}</span>
          <span className="text-xs text-content-muted">
            {model.description}
          </span>
        </div>
        {isSelected && (
          <CheckIcon
            className="h-4 w-4 flex-none text-brand-accent-dark dark:text-brand-accent-light"
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
      className={`absolute z-50 w-[280px] overflow-y-auto rounded-lg border border-border-subtle bg-surface-chat p-2 font-aeonik-fono text-content-secondary shadow-lg ${dynamicStyles.bottom ? 'mb-2' : 'mt-2'}`}
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
      {topModels.map((model) => renderModelItem(model))}

      {otherModels.length > 0 && (
        <>
          <div className="mx-3 my-1 border-t border-border-subtle" />
          <button
            type="button"
            aria-expanded={showOtherModels}
            className="flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm font-medium text-content-secondary transition-colors hover:bg-surface-card/70"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setShowOtherModels(!showOtherModels)
            }}
            onMouseDown={(e) => e.stopPropagation()}
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
  )
}
