import type { Profile } from './runtime'
import type { HarnessErrorBody } from './types'

// The open chat, apart from what its runs show.
export interface OpenChat {
  id: string | null
  temporary: boolean
  // A chat the browser stores: every chat of a signed-out visitor or of an
  // account without cloud sync, and chats from the Local tab.
  local: boolean
  // A new chat until the harness accepts its first turn, or this device
  // first stores it. Its route waits, since opening the route before then
  // would find nothing.
  unsaved: string | null
  loadingId: string | null
  notFound: boolean
  model: string
  // An action that failed. The open chat's run reports how it ended in the
  // run's state.
  failure: { message: string; detail?: HarnessErrorBody } | null
  // Whether the open chat's prompt was chosen, rather than left at the
  // default a new chat starts with.
  presetChosen: boolean
  chosenPresetId: string | null
  // The user chose the open chat's model, over what its prompt chooses.
  modelChosen: boolean
  // The open chat's web search setting, where the toggle set it before the
  // chat stores it.
  webSearch?: boolean
}

// The settings a new chat's saved prompt chooses.
export interface PresetChoice {
  model?: string
  webSearchEnabled?: boolean
}

// The browser holds the chat and sends it with each request: a chat it
// stores, or a temporary chat it keeps in page memory.
export const onDevice = (open: Pick<OpenChat, 'local' | 'temporary'>) =>
  open.local || open.temporary

// The prompt new chats start with, which the harness keeps in the profile.
const defaultPresetIdOf = (profile: Profile): string | null =>
  typeof profile.defaultPromptPresetId === 'string' &&
  profile.defaultPromptPresetId
    ? profile.defaultPromptPresetId
    : null

export const presetIdOf = (open: OpenChat, profile: Profile) =>
  !open.id && !open.presetChosen
    ? defaultPresetIdOf(profile)
    : open.chosenPresetId
