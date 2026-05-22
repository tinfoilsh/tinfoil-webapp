import type { IconType } from 'react-icons'

export type PromptPreset = {
  id: string
  name: string
  description: string
  Icon: IconType
  systemPrompt: string
  isBuiltIn: boolean
}

export type UserPromptPreset = {
  id: string
  name: string
  description: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}
