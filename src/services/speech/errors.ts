import { APIError } from 'openai'

export type SpeechErrorCode =
  'empty' | 'too-long' | 'unsupported' | 'invalid-audio' | 'interrupted'

export class SpeechError extends Error {
  constructor(public readonly code: SpeechErrorCode) {
    super(code)
    this.name = 'SpeechError'
  }
}

export function speechErrorMessage(error: unknown): string {
  if (error instanceof APIError && error.status === 429) {
    return 'Speech usage limit reached. Please try again later.'
  }
  if (error instanceof SpeechError) {
    switch (error.code) {
      case 'empty':
        return 'There is no readable text in this response.'
      case 'too-long':
        return 'This response is too long to read aloud.'
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
