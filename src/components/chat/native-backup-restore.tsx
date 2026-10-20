import { restoreBackup, type RestoreResult } from '@/services/harness/archives'
import { describeImportFailure } from '@/services/harness/import-failure-copy'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const INITIAL_RESTORE_PHASE = 'uploading'
// The kinds of cloud data a restore's job counts, as the user reads them.
const RESTORED_KIND_LABELS = new Map([
  ['project', 'projects'],
  ['document', 'project documents'],
  ['chat', 'cloud chats'],
])

function restoreMessage(result: RestoreResult, refreshFailed: boolean) {
  if (refreshFailed)
    return result.state === 'partial'
      ? 'Backup restored with warnings, but chats could not be refreshed. Reload to see restored chats.'
      : 'Backup restored successfully, but chats could not be refreshed. Reload to see restored chats.'
  switch (result.state) {
    case 'pending':
      return "The cloud restore is still running. We'll email you when it finishes."
    case 'interrupted':
      return "The cloud restore was interrupted before we could confirm the result. We'll email you whether it finished or failed."
    case 'failed':
      return `The cloud restore failed. ${describeImportFailure(
        result.status?.failureReason ?? result.status?.failure_reason,
        'backup_restore',
      )}`
    case 'partial':
      return 'Backup restored with warnings.'
    case 'completed':
      return 'Backup restored successfully.'
  }
}

export function NativeBackupRestore({
  available,
  ownerId,
  onChatsUpdated,
  onProjectsUpdated,
}: {
  available?: boolean
  ownerId?: string
  onChatsUpdated?: () => void | Promise<void>
  // A backup can restore projects as well as chats.
  onProjectsUpdated?: () => void | Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const started = useRef(false)
  const dismissed = useRef(false)
  const guard = useRef({ available, ownerId })
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(INITIAL_RESTORE_PHASE)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // prettier-ignore
  useEffect(() => () => { if (!started.current) controller.current?.abort() }, [])
  useLayoutEffect(() => {
    const changed =
      guard.current.available !== available || guard.current.ownerId !== ownerId
    guard.current = { available, ownerId }
    if (changed) {
      controller.current?.abort()
      controller.current = null
      if (input.current) input.current.value = ''
      started.current = false
      dismissed.current = false
      setBusy(false)
      setPhase(INITIAL_RESTORE_PHASE)
      setResult(null)
      setMessage(null)
    }
  }, [available, ownerId])

  const restore = async (file: File) => {
    if (!ownerId) return
    const current = new AbortController()
    controller.current = current
    const isCurrent = () =>
      controller.current === current && !current.signal.aborted
    started.current = false
    dismissed.current = false
    setBusy(true)
    setResult(null)
    setMessage(null)
    try {
      const next = await restoreBackup(file, current.signal, {
        onStarted: (status) => {
          if (!isCurrent()) return
          started.current = true
          setPhase(status.phase ?? 'running')
        },
        // prettier-ignore
        onPhase: (value) => { if (isCurrent() && !dismissed.current && value) setPhase(value) },
      })
      if (!isCurrent()) return
      let refreshFailed = false
      if (next.state === 'completed' || next.state === 'partial') {
        try {
          await onChatsUpdated?.()
          await onProjectsUpdated?.()
        } catch {
          refreshFailed = true
        }
      }
      if (!isCurrent()) return
      if (!dismissed.current || next.state !== 'pending') {
        setResult(next)
        setMessage(restoreMessage(next, refreshFailed))
      }
    } catch (cause) {
      if (isCurrent())
        setMessage(cause instanceof Error ? cause.message : 'Restore failed')
    } finally {
      if (controller.current === current) {
        controller.current = null
        setBusy(false)
        if (input.current) input.current.value = ''
      }
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
          <span>{started.current ? `Enclave restore: ${phase}...` : 'Uploading backup...'}</span>
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
            {Object.entries(result.status?.counts ?? {}).map(
              ([kind, value]) => (
                <li key={kind}>
                  {RESTORED_KIND_LABELS.get(kind) ?? kind}: {value.imported}{' '}
                  imported, {value.skipped} skipped, {value.failed} failed,{' '}
                  {value.blocked} blocked
                </li>
              ),
            )}
            <li>
              chats on this device: {result.stored} imported, {result.skipped}{' '}
              skipped
            </li>
            {[...result.warnings, ...(result.status?.warnings ?? [])].map(
              (warning, index) => (
                <li key={`warning-${index}`}>{warning}</li>
              ),
            )}
            {(result.status?.errors ?? []).map((error, index) => (
              <li key={`error-${index}`}>{error}</li>
            ))}
          </ul>
        )}
    </div>
  )
}
