import { speechSpeed } from '@/services/speech/speed'
import { ROUTES } from './protocol'
import { harnessAPI } from './runtime'

// The audio of plain text read aloud, as one stream: text the user selected,
// or a message of a shared chat. It reads no chat, so it carries no key.
export const speakText = (text: string, signal: AbortSignal) =>
  harnessAPI().stream(
    ROUTES.speech,
    { text, ...speechSpeed() },
    { signal, keyless: true },
  )
