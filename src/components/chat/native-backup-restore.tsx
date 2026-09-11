import { describeImportFailure } from '@/services/chat-import/import-failure-copy'
// prettier-ignore
import { NATIVE_RESTORE_KINDS,restoreNativeBackup,type NativeRestoreResult } from '@/services/native-backup/orchestrate'
import { useEffect, useRef, useState } from 'react'

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
  const started = useRef(false)
  const dismissed = useRef(false)
  const guard = useRef({ available, ownerId })
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('uploading')
  const [result, setResult] = useState<NativeRestoreResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // prettier-ignore
  useEffect(() => () => { if (!started.current) controller.current?.abort() }, [])
  useEffect(() => {
    const changed =
      guard.current.available !== available || guard.current.ownerId !== ownerId
    guard.current = { available, ownerId }
    if (changed) controller.current?.abort()
  }, [available, ownerId])

  const restore = async (file: File) => {
    if (!ownerId) return
    const current = new AbortController()
    controller.current = current
    started.current = false
    dismissed.current = false
    setBusy(true)
    setResult(null)
    setMessage(null)
    try {
      const next = await restoreNativeBackup(file, ownerId, current.signal, {
        onStarted: (status) => {
          started.current = true
          setPhase(status.phase ?? 'running')
        },
        // prettier-ignore
        onPhase: (value) => { if (!dismissed.current && value) setPhase(value) },
      })
      let refreshFailed = false
      if (next.state === 'completed' || next.state === 'partial') {
        try {
          await onChatsUpdated?.()
        } catch {
          refreshFailed = true
        }
      }
      if (!dismissed.current || next.state !== 'pending') setResult(next)
      if (!dismissed.current || next.state !== 'pending')
        setMessage(
          refreshFailed
            ? next.state === 'partial'
              ? 'Backup restored with warnings, but chats could not be refreshed. Reload to see restored chats.'
              : 'Backup restored successfully, but chats could not be refreshed. Reload to see restored chats.'
            : next.state === 'pending'
              ? "The cloud restore is still running. We'll email you when it finishes. No local chats were restored; reselect this archive afterward to restore them."
              : next.state === 'interrupted'
                ? "The cloud restore was interrupted before we could confirm the result. We'll email you whether it finished or failed. No local chats were restored; reselect this archive afterward to restore them."
                : next.state === 'failed'
                  ? `The cloud restore failed. ${describeImportFailure(next.failureReason)} No local chats were restored.`
                  : next.state === 'partial'
                    ? 'Backup restored with warnings.'
                    : 'Backup restored successfully.',
        )
    } catch (cause) {
      if (!current.signal.aborted)
        setMessage(cause instanceof Error ? cause.message : 'Restore failed')
    } finally {
      if (controller.current === current) controller.current = null
      setBusy(false)
      if (input.current) input.current.value = ''
    }
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
      {busy && !dismissed.current && (
        <div className="mt-3 flex items-center justify-between text-xs text-content-muted">
          {/* prettier-ignore */}
          <span>{started.current ? `Enclave restore: ${phase}...` : 'Validating and uploading...'}</span>
          <button
            type="button"
            className="font-medium text-content-primary hover:underline"
            onClick={() => {
              if (!started.current) return controller.current?.abort()
              dismissed.current = true
              // prettier-ignore
              setMessage("The enclave restore continues. We'll email you when it finishes.")
            }}
          >
            {started.current ? 'Close' : 'Cancel'}
          </button>
        </div>
      )}
      {message && (
        <p className="mt-3 text-xs text-content-primary" role="status">
          {message}
        </p>
      )}
      {result &&
        result.state !== 'pending' &&
        result.state !== 'interrupted' && (
          <ul className="mt-2 space-y-1 text-xs text-content-muted">
            {NATIVE_RESTORE_KINDS.map((kind) => {
              const value = result.report[kind]
              return (
                <li key={kind}>
                  {kind.replaceAll('_', ' ')}: {value.imported} imported,{' '}
                  {value.skipped} skipped, {value.failed} failed,{' '}
                  {value.blocked} blocked
                  {value.warnings.length > 0 &&
                    `, warnings: ${value.warnings.join('; ')}`}
                  {value.errors.length > 0 &&
                    `, errors: ${value.errors.join('; ')}`}
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}
