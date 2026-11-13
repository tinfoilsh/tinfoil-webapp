import type { DictationSnapshot } from '@tinfoil/chat-client/dictation'
import {
  TfMicrophoneAnimated,
  TfStopAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import { PiSpinner } from 'react-icons/pi'
import { cn } from './utils'

// What dictation is doing, as its button and the composer announce it.
export const dictationButtonLabel = (status: DictationSnapshot['status']) =>
  status === 'transcribing'
    ? 'Transcribing audio'
    : status === 'recording'
      ? 'Stop recording'
      : 'Start recording'

// Opens the microphone to dictate into the composer, and closes it again.
export function DictationButton({
  status,
  onStart,
  onStop,
}: {
  status: DictationSnapshot['status']
  onStart: () => void
  onStop: () => void
}) {
  const isRecording = status === 'recording'
  const label = dictationButtonLabel(status)
  return (
    <button
      type="button"
      onClick={isRecording ? onStop : onStart}
      className={cn(
        'disabled:opacity-50',
        isRecording
          ? 'flex h-10 w-10 animate-pulse items-center justify-center rounded-full bg-red-500 text-white md:h-8 md:w-8'
          : 'rounded-lg bg-transparent p-2.5 text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary md:p-1.5',
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      title={label}
      aria-label={label}
      disabled={status === 'transcribing'}
    >
      {isRecording ? (
        <TfStopAnimated className="h-6 w-6 md:h-5 md:w-5" aria-hidden="true" />
      ) : status === 'transcribing' ? (
        <PiSpinner
          className="h-6 w-6 animate-spin text-current md:h-5 md:w-5"
          aria-hidden="true"
        />
      ) : (
        <TfMicrophoneAnimated
          className="h-6 w-6 md:h-4 md:w-4"
          aria-hidden="true"
        />
      )}
    </button>
  )
}
