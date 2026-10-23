import { ERROR_CODES } from '@/services/harness/protocol'
import { HarnessError } from '@/services/harness/sse'

export type SpeechErrorCode =
  'unsupported' | 'invalid-audio' | 'interrupted' | 'stalled'

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
  // The harness refuses a text with nothing to read aloud as a bad request,
  // and one too long to read as too large.
  if (error instanceof HarnessError && error.code === ERROR_CODES.badRequest) {
    return 'There is no readable text in this response.'
  }
  if (
    error instanceof HarnessError &&
    error.code === ERROR_CODES.payloadTooLarge
  ) {
    return 'This response is too long to read aloud.'
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
