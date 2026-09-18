export const SETTINGS_TABS = [
  'general',
  'chat',
  'personalization',
  'prompts',
  'cloud-sync',
  'safeguards',
  'data',
  'account',
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]
