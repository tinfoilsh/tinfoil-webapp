export const SETTINGS_TABS = [
  'general',
  'chat',
  'personalization',
  'prompts',
  'cloud-sync',
  'data',
  'account',
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]
