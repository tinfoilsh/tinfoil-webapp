import { describeImportFailure } from '@/services/chat-import/import-failure-copy'
import {
  importStatus,
  startImport,
  type ImportStatusResponse,
} from '@/services/harness/archives'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const INITIAL_RESTORE_PHASE = 'uploading'

export function NativeBackupRestore({
  available,
  ownerId,
  onChatsUpdated,
}: {
  available?: boolean
  ownerId?: string
  onChatsUpdated?: () => void | Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const guard = useRef({ available, ownerId })
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(INITIAL_RESTORE_PHASE)
  const [result, setResult] = useState<ImportStatusResponse | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => () => controller.current?.abort(), [])
  useLayoutEffect(() => {
    const changed =
      guard.current.available !== available || guard.current.ownerId !== ownerId
    guard.current = { available, ownerId }
    if (changed) {
      controller.current?.abort()
      controller.current = null
      if (input.current) input.current.value = ''
      setPhase(INITIAL_RESTORE_PHASE)
      setResult(null)
      setMessage(null)
      setBusy(false)
    }
  }, [available, ownerId])

  const run = async (
    request: (signal: AbortSignal) => Promise<ImportStatusResponse>,
  ) => {
    if (!ownerId) return
    const current = new AbortController()
    controller.current?.abort()
    controller.current = current
    setBusy(true)
    setMessage(null)
    try {
      const next = await request(current.signal)
      if (current.signal.aborted || controller.current !== current) return
      setPhase(next.phase ?? next.status)
      setResult(next)
      const text =
        next.status === 'failed'
          ? `Backup restore failed. ${describeImportFailure(
              next.failureReason ?? next.failure_reason,
              'backup_restore',
            )}`
          : next.status === 'completed'
            ? 'Backup restored successfully.'
            : next.status === 'partial'
              ? 'Backup restored with warnings.'
              : 'Backup restore is running. You can close this panel.'
      setMessage(text)
      if (next.status === 'completed' || next.status === 'partial') {
        try {
          await onChatsUpdated?.()
        } catch {
          if (!current.signal.aborted)
            setMessage(text + ' Reload to see restored chats.')
        }
      }
    } catch (cause) {
      if (!current.signal.aborted)
        setMessage(cause instanceof Error ? cause.message : 'Restore failed')
    } finally {
      if (controller.current === current) {
        controller.current = null
        setBusy(false)
        if (input.current) input.current.value = ''
      }
    }
  }
  const restore = (file: File) => {
    setResult(null)
    setPhase(INITIAL_RESTORE_PHASE)
    return run((signal) => startImport(file, 'tinfoil', signal))
  }

  if (!available) return null

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-sidebar p-4">
      <p className="font-aeonik-fono text-xs text-amber-600">
        Warning: plaintext backup with sensitive data. Use a trusted archive.
      </p>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void restore(file)
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors hover:bg-surface-chat disabled:cursor-not-allowed disabled:opacity-60"
      >
        Restore Tinfoil Backup
      </button>
      {busy && (
        <div className="mt-3 flex items-center justify-between text-xs text-content-muted">
          <span>
            {phase === 'uploading' ? 'Uploading...' : 'Checking restore...'}
          </span>
          <button
            type="button"
            className="font-medium text-content-primary hover:underline"
            onClick={() => {
              controller.current?.abort()
              controller.current = null
              // The same archive can then be chosen again.
              if (input.current) input.current.value = ''
              setBusy(false)
              setMessage(
                'Stopped waiting. Any accepted restore continues on the server.',
              )
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {!busy &&
        result?.jobId &&
        (result.status === 'running' || result.status === 'staging') && (
          <button
            type="button"
            className="mt-3 text-xs text-content-primary hover:underline"
            onClick={() => {
              void run((signal) => importStatus(result.jobId!, signal))
            }}
          >
            Check restore progress
          </button>
        )}
      {message && (
        <p className="mt-3 text-xs text-content-primary" role="status">
          {message}
        </p>
      )}
      {result?.counts && (
        <ul className="mt-2 space-y-1 text-xs text-content-muted">
          {Object.entries(result.counts).map(([kind, value]) => (
            <li key={kind}>
              {kind.replaceAll('_', ' ')}: {value.imported} imported,{' '}
              {value.skipped} skipped, {value.failed} failed, {value.blocked}{' '}
              blocked
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
