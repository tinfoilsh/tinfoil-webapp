import { cn } from '@/components/ui/utils'
import { formatFileSize } from '@/utils/format-file-size'
import { useEffect, useState } from 'react'

// How often a running export's elapsed time is redrawn.
const ELAPSED_TICK_MS = 1000
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60

// A chats export as it runs, and how the last one ended, which stays shown
// until the next one starts.
export type ChatExportState =
  | { status: 'running'; startedAt: number; received: number }
  | { status: 'done'; message: string; warnings: string[] }
  | { status: 'failed'; message: string; canceled: boolean }

// What an export could not include, as its archive's manifest lists it.
export function describeExportWarnings(count: number): string {
  return `${count} item${count === 1 ? '' : 's'} could not be included. The archive's manifest.json lists ${count === 1 ? 'it' : 'them'}.`
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`
}

// The time since an export started, redrawn while it runs.
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return <>{formatElapsed(now - since)}</>
}

export function ChatExportStatus({
  state,
  onCancel,
  onRetry,
}: {
  state: ChatExportState
  onCancel: () => void
  onRetry: () => void
}) {
  // Only how an export ended is announced; its progress changes too often.
  if (state.status === 'running')
    return (
      <div className="flex items-center justify-between gap-3 font-aeonik-fono text-xs text-content-muted">
        <span>
          {state.received > 0
            ? `Downloading archive... ${formatFileSize(state.received)}`
            : 'Preparing your chats...'}{' '}
          <Elapsed since={state.startedAt} />
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="font-medium text-content-primary hover:underline"
        >
          Cancel
        </button>
      </div>
    )
  const failed = state.status === 'failed' && !state.canceled
  return (
    <div
      role="status"
      className={cn(
        'rounded-lg border p-3 font-aeonik-fono text-xs',
        failed ? 'border-red-500/30 bg-red-500/10' : 'border-border-subtle',
      )}
    >
      <div className={failed ? 'text-red-500' : 'text-content-primary'}>
        {state.message}
      </div>
      {state.status === 'done' && state.warnings.length > 0 && (
        <div className="mt-1 text-content-muted">
          {describeExportWarnings(state.warnings.length)}
        </div>
      )}
      {state.status === 'failed' && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 font-medium text-content-primary hover:underline"
        >
          Try again
        </button>
      )}
    </div>
  )
}
