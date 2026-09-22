import {
  findSelectableModel,
  getAutoModel,
  getSelectableChatModels,
  type BaseModel,
} from '@/config/models'
import type { PromptPresetSettings } from './types'

// Sentinel value for the "leave the chat as is" option in the editor's
// select controls. Chosen so it can never collide with a real model id.
export const PRESET_SETTING_UNSET = ''

export const PRESET_WEB_SEARCH_ON = 'on'
export const PRESET_WEB_SEARCH_OFF = 'off'

export type PresetWebSearchOption =
  | typeof PRESET_SETTING_UNSET
  | typeof PRESET_WEB_SEARCH_ON
  | typeof PRESET_WEB_SEARCH_OFF

export const webSearchToOption = (
  value: boolean | undefined,
): PresetWebSearchOption => {
  if (value === undefined) return PRESET_SETTING_UNSET
  return value ? PRESET_WEB_SEARCH_ON : PRESET_WEB_SEARCH_OFF
}

export const optionToWebSearch = (
  option: PresetWebSearchOption,
): boolean | undefined => {
  if (option === PRESET_SETTING_UNSET) return undefined
  return option === PRESET_WEB_SEARCH_ON
}

/**
 * Models offered in the preset editor: Auto followed by the same chat models
 * the picker shows for the value being edited.
 */
export const getPresetModelOptions = (
  models: BaseModel[],
  currentModel: string | undefined,
): BaseModel[] => {
  const chatModels = getSelectableChatModels(models, currentModel)
  const auto = getAutoModel(models)
  return auto ? [auto, ...chatModels] : chatModels
}

export const getPresetModelLabel = (
  modelName: string,
  models: BaseModel[],
): string => findSelectableModel(modelName, models)?.name ?? modelName

/**
 * Short human-readable summary of a preset's settings for the detail pane,
 * or null when the preset carries none.
 */
export const describePresetSettings = (
  settings: PromptPresetSettings,
  models: BaseModel[],
): string | null => {
  const parts: string[] = []
  if (settings.model !== undefined) {
    parts.push(`Model: ${getPresetModelLabel(settings.model, models)}`)
  }
  if (settings.webSearchEnabled !== undefined) {
    parts.push(`Web search: ${settings.webSearchEnabled ? 'on' : 'off'}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
