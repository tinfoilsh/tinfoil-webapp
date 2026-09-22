import type { IconType } from 'react-icons'

// Optional per-preset chat settings applied once when the preset is
// selected for a chat. Undefined means "leave the chat as is". Shared with
// the iOS app through the synced profile, so the field names are part of the
// wire format.
export type PromptPresetSettings = {
  // Model picker id (a real model name or the Auto id).
  model?: string
  webSearchEnabled?: boolean
}

export type PromptPreset = PromptPresetSettings & {
  id: string
  name: string
  description: string
  Icon: IconType
  systemPrompt: string
  isBuiltIn: boolean
}

export type UserPromptPreset = PromptPresetSettings & {
  id: string
  name: string
  description: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}
