import { HarnessError } from '@/services/harness/sse'

export type SpeechErrorCode =
  'unsupported' | 'invalid-audio' | 'interrupted' | 'stalled'

export class SpeechError extends Error {
  constructor(public readonly code: SpeechErrorCode) {
    super(code)
    this.name = 'SpeechError'
  }
}

// Statuses with which the harness refuses the text itself, as one with
// nothing to read aloud or too long, and says why.
const REFUSED_TEXT_STATUSES = new Set([400, 413])

export function speechErrorMessage(error: unknown): string {
  if (error instanceof HarnessError && error.status === 429) {
    return 'Speech usage limit reached. Please try again later.'
  }
  if (
    error instanceof HarnessError &&
    REFUSED_TEXT_STATUSES.has(error.status ?? 0)
  ) {
    return error.message
  }
  if (error instanceof SpeechError) {
    switch (error.code) {
      case 'unsupported':
        return 'Audio playback is not supported in this browser.'
      case 'interrupted':
        return 'Audio playback was interrupted. Please try again.'
      case 'invalid-audio':
        return 'The speech service returned unsupported audio. Please try again.'
      case 'stalled':
        return 'The speech service stopped responding. Please try again.'
    }
  }
  return 'Could not read this response aloud. Please try again.'
}
