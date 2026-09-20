import { speechPlayer } from '@/services/speech/player'
import {
  ArrowPathIcon,
  SpeakerWaveIcon,
  StopIcon,
} from '@heroicons/react/24/outline'
import { useEffect, useState, useSyncExternalStore } from 'react'

export function ReadAloudButton({ content }: { content: string }) {
  const [owner] = useState(() => Symbol('read-aloud'))
  const snapshot = useSyncExternalStore(
    speechPlayer.subscribe,
    speechPlayer.getSnapshot,
    speechPlayer.getServerSnapshot,
  )
  const status = snapshot.owner === owner ? snapshot.status : 'idle'
  const error = snapshot.owner === owner ? snapshot.error : undefined
  const active = status === 'loading' || status === 'playing'
  const label =
    status === 'loading'
      ? 'Cancel read aloud'
      : status === 'playing'
        ? 'Stop reading aloud'
        : 'Read aloud'

  useEffect(() => () => speechPlayer.stop(owner), [owner, content])

  return (
    <div className="group/speech relative">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        title={
          status === 'loading' ? 'Buffering audio — click to cancel' : label
        }
        onClick={() =>
          active ? speechPlayer.stop(owner) : speechPlayer.read(owner, content)
        }
        className="flex items-center rounded px-2 py-2 text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
      >
        {status === 'loading' ? (
          <ArrowPathIcon
            className="h-3.5 w-3.5 animate-spin"
            aria-hidden="true"
          />
        ) : active ? (
          <StopIcon className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <SpeakerWaveIcon className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      {status === 'loading' && (
        <span className="sr-only" role="status">
          Buffering speech
        </span>
      )}
      {error && (
        <span
          role="alert"
          className="absolute bottom-full left-0 z-10 mb-2 w-64 rounded border border-border-subtle bg-surface-chat-background p-2 text-xs text-content-primary shadow-sm"
        >
          {error}
        </span>
      )}
    </div>
  )
}
