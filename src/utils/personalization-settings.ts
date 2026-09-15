export type PersonalizationSettings = {
  nickname: string
  profession: string
  traits: string[]
  additionalContext: string
  language: string
  isEnabled: boolean
}

export function isPersonalizationEnabled(value: string | null): boolean {
  return value !== 'false'
}

export function clearPersonalizationDetails(
  settings: PersonalizationSettings,
): PersonalizationSettings {
  return {
    ...settings,
    nickname: '',
    profession: '',
    traits: [],
    additionalContext: '',
  }
}
