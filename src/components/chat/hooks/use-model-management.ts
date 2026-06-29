import { isModelNameAvailable, type BaseModel } from '@/config/models'
import { SETTINGS_SELECTED_MODEL } from '@/constants/storage-keys'
import { logWarning } from '@/utils/error-handling'
import { useCallback, useEffect, useState } from 'react'
import type { AIModel, Chat, LabelType } from '../types'

/**
 * Resolves the model a chat should use: the chat's own model when it is
 * still available, otherwise the first available model. No global default
 * is consulted so concurrent chats never override each other's model.
 *
 * Runs during render before the model config has loaded, so `models` may
 * be empty; the empty-string fallback keeps the selector in a neutral
 * placeholder state until the config arrives.
 */
export function resolveChatModel(
  chat: Chat | undefined,
  models: BaseModel[],
): AIModel {
  if (chat?.model && isModelNameAvailable(chat.model, models)) {
    return chat.model
  }
  return models[0]?.modelName ?? ''
}

interface UseModelManagementProps {
  models: BaseModel[]
  isClient: boolean
}

interface UseModelManagementReturn {
  selectedModel: AIModel
  hasValidatedModel: boolean
  expandedLabel: LabelType
  setExpandedLabel: (label: LabelType) => void
  setVerificationComplete: (complete: boolean) => void
  setVerificationSuccess: (success: boolean) => void
  verificationComplete: boolean
  verificationSuccess: boolean
  handleModelSelect: (modelName: AIModel) => void
  handleLabelClick: (
    label: Exclude<LabelType, null>,
    action: () => void,
  ) => void
}

export function useModelManagement({
  models,
  isClient,
}: UseModelManagementProps): UseModelManagementReturn {
  // Model state - initialize with saved model or empty string as placeholder
  const [selectedModel, setSelectedModel] = useState<AIModel>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(SETTINGS_SELECTED_MODEL)
      if (saved) {
        return saved as AIModel
      }
    }
    // Empty string will be replaced with first available model from config
    return ''
  })

  // Track if we've validated against the loaded models
  const [hasValidated, setHasValidated] = useState(false)

  // Add state for expanded label
  const [expandedLabel, setExpandedLabel] = useState<LabelType>(null)

  // Verification state
  const [verificationComplete, setVerificationComplete] = useState(false)
  const [verificationSuccess, setVerificationSuccess] = useState(false)

  const persistSelectedModel = useCallback((modelName: AIModel) => {
    localStorage.setItem(SETTINGS_SELECTED_MODEL, modelName)
    window.dispatchEvent(
      new CustomEvent('selectedModelChanged', {
        detail: modelName,
      }),
    )
  }, [])

  // Effect to validate selected model when models are available
  useEffect(() => {
    if (models.length > 0 && isClient && !hasValidated) {
      setHasValidated(true)

      // If the saved model exists in the models list, keep it
      if (selectedModel && isModelNameAvailable(selectedModel, models)) {
        localStorage.setItem(SETTINGS_SELECTED_MODEL, selectedModel)
        return
      }

      // Otherwise fall back to the first available model
      const targetModel = models[0].modelName as AIModel
      setSelectedModel(targetModel)
      localStorage.setItem(SETTINGS_SELECTED_MODEL, targetModel)

      if (selectedModel) {
        logWarning(
          `Saved model ${selectedModel} not found, switching to ${targetModel}`,
          {
            component: 'useModelManagement',
            action: 'validateModel',
            metadata: {
              previousModel: selectedModel,
              availableModels: models.map((m) => m.modelName),
            },
          },
        )
      }
    }
  }, [models, isClient, hasValidated, selectedModel])

  useEffect(() => {
    const handleSelectedModelChanged = (event: CustomEvent<string>): void => {
      const modelName = event.detail as AIModel
      if (!modelName || !isModelNameAvailable(modelName, models)) return
      setSelectedModel(modelName)
      setExpandedLabel(null)
    }

    window.addEventListener(
      'selectedModelChanged',
      handleSelectedModelChanged as EventListener,
    )
    return () => {
      window.removeEventListener(
        'selectedModelChanged',
        handleSelectedModelChanged as EventListener,
      )
    }
  }, [models])

  // Handle model selection
  const handleModelSelect = useCallback(
    (modelName: AIModel) => {
      // Verify the model exists in the available models
      if (!isModelNameAvailable(modelName, models)) {
        logWarning(`Model ${modelName} is not available`, {
          component: 'useModelManagement',
          action: 'handleModelSelect',
          metadata: { modelName },
        })
        return
      }

      setSelectedModel(modelName)
      setExpandedLabel(null)

      // Save to local storage
      persistSelectedModel(modelName)
    },
    [models, persistSelectedModel],
  )

  // Handle label click
  const handleLabelClick = useCallback(
    (label: Exclude<LabelType, null>, action: () => void) => {
      if (expandedLabel === label) {
        // If already expanded, perform the action
        action()
        setExpandedLabel(null)
      } else {
        // If not expanded or different label is expanded, expand this one
        setExpandedLabel(label)
      }
    },
    [expandedLabel],
  )

  return {
    selectedModel,
    hasValidatedModel: hasValidated,
    expandedLabel,
    setExpandedLabel,
    setVerificationComplete,
    setVerificationSuccess,
    verificationComplete,
    verificationSuccess,
    handleModelSelect,
    handleLabelClick,
  }
}
