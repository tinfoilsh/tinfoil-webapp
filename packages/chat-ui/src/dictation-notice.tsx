import { TfWarning } from '@tinfoilsh/tinfoil-icons'
import { PiSpinner } from 'react-icons/pi'
import { cn } from './utils'

// Dictation still on its way to the composer: recordings being transcribed
// again, or ones that could not be and wait for the user.
export function DictationNotice({
  retrying,
  failed,
  onRetry,
  onDiscard,
  className,
}: {
  retrying: number
  failed: number
  onRetry: () => void
  onDiscard: () => void
  className?: string
}) {
  if (!failed && !retrying) return null
  return (
    <div
      role="status"
      className={cn(
        'flex w-fit flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-content-secondary',
        className,
      )}
    >
      {failed ? (
        <>
          <TfWarning
            className="h-3.5 w-3.5 flex-shrink-0 !text-amber-500"
            aria-hidden="true"
          />
          Couldn&apos;t transcribe part of your dictation. The recording is kept
          so you can try again.
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-content-primary underline-offset-2 hover:underline"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="font-medium text-content-primary underline-offset-2 hover:underline"
          >
            Discard
          </button>
        </>
      ) : (
        <>
          <PiSpinner
            className="h-3.5 w-3.5 flex-shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Part of your dictation is taking longer to transcribe. It will be
          added here when it&apos;s ready.
        </>
      )}
    </div>
  )
}
