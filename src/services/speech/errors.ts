import { HarnessError } from '@/services/harness/sse'

export type SpeechErrorCode = 'unsupported' | 'invalid-audio' | 'interrupted'

export class SpeechError extends Error {
  constructor(public readonly code: SpeechErrorCode) {
    super(code)
    this.name = 'SpeechError'
  }
}

export function speechErrorMessage(error: unknown): string {
  if (error instanceof HarnessError && error.status === 429) {
    return 'Speech usage limit reached. Please try again later.'
  }
  if (error instanceof SpeechError) {
    switch (error.code) {
      case 'unsupported':
        return 'Audio playback is not supported in this browser.'
      case 'interrupted':
        return 'Audio playback was interrupted. Please try again.'
      case 'invalid-audio':
        return 'The speech service returned unsupported audio. Please try again.'
    }
  }
  return 'Could not read this response aloud. Please try again.'
}
