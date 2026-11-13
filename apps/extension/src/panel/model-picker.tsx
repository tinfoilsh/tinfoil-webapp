import {
  selectedModelLabel,
  type AutoIntelligenceLevel,
  type BaseModel,
  type ReasoningEffort,
} from '@tinfoil/chat-client/models'
import { ModelSelector } from '@tinfoil/chat-ui/model-selector'
import { ModelSelectorTriggerLabel } from '@tinfoil/chat-ui/model-selector-trigger-label'
import { useEffect, useState } from 'react'

const PICKER_SELECTOR = '[data-model-selector], [data-model-menu]'

// The model a chat's next turn runs on, and how hard it works.
export function ModelPicker({
  models,
  autoLevels,
  selectedModel,
  onSelect,
  reasoningEffort,
  onEffortChange,
  autoIntelligence,
  onAutoIntelligenceChange,
  isDarkMode,
}: {
  models: BaseModel[]
  autoLevels: readonly AutoIntelligenceLevel[]
  selectedModel: string
  onSelect: (model: string) => void
  reasoningEffort: ReasoningEffort
  onEffortChange: (effort: ReasoningEffort) => void
  autoIntelligence: string
  onAutoIntelligenceChange: (level: string) => void
  isDarkMode: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    if (!isOpen) return
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(PICKER_SELECTOR)
      )
        setIsOpen(false)
    }
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setIsOpen(false)
    }
    document.addEventListener('mousedown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    document.addEventListener('keydown', dismissWithKeyboard)
    return () => {
      document.removeEventListener('mousedown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
      document.removeEventListener('keydown', dismissWithKeyboard)
    }
  }, [isOpen])

  return (
    <div className="relative">
      <button
        type="button"
        data-model-selector
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`Current model ${selectedModelLabel(selectedModel, models, autoLevels, autoIntelligence) ?? ''}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsOpen((value) => !value)
        }}
        className="flex items-center gap-1 py-1.5 text-content-secondary transition-colors hover:text-content-primary"
      >
        <ModelSelectorTriggerLabel
          selectedModel={selectedModel}
          models={models}
          autoLevels={autoLevels}
          autoIntelligence={autoIntelligence}
          isOpen={isOpen}
        />
      </button>

      {isOpen && (
        <ModelSelector
          selectedModel={selectedModel}
          onSelect={(model) => {
            onSelect(model)
            setIsOpen(false)
          }}
          isDarkMode={isDarkMode}
          models={models}
          autoLevels={autoLevels}
          reasoningEffort={reasoningEffort}
          onEffortChange={onEffortChange}
          autoIntelligence={autoIntelligence}
          onAutoIntelligenceChange={onAutoIntelligenceChange}
        />
      )}
    </div>
  )
}
