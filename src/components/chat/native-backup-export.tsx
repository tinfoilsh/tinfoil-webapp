import { exportArchive } from '@/services/harness/archives'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from './components/confirm-dialog'
type NativeBackupExportProgress = 'collecting' | 'formatting' | 'writing'

const progressLabel: Record<NativeBackupExportProgress, string> = {
  collecting: 'Collecting cloud data...',
  formatting: 'Formatting backup...',
  writing: 'Saving archive...',
}

export function NativeBackupExport({ available }: { available: boolean }) {
  const [showWarning, setShowWarning] = useState(false)
  const [progress, setProgress] = useState<NativeBackupExportProgress | null>(
    null,
  )
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const availableRef = useRef(available)
  availableRef.current = available

  useEffect(() => {
    if (!available) {
      controller.current = null
      setShowWarning(false)
      setProgress(null)
      setMessage(null)
      setFailed(false)
    }
    return () => controller.current?.abort()
  }, [available])

  const createBackup = async () => {
    setShowWarning(false)
    setMessage(null)
    setFailed(false)
    const current = new AbortController()
    controller.current = current
    const isCurrent = () => controller.current === current
    try {
      setProgress('collecting')
      await exportArchive('tinfoil-backup', current.signal)
      if (isCurrent() && availableRef.current)
        setMessage('Backup saved successfully.')
    } catch (error) {
      if (!isCurrent()) return
      setFailed(true)
      setMessage(
        error instanceof Error ? error.message : 'Unable to export backup.',
      )
    } finally {
      if (isCurrent()) {
        controller.current = null
        setProgress(null)
      }
    }
  }

  if (!available) return null

  return (
    <div>
      <div className="rounded-lg border border-border-subtle bg-surface-sidebar p-4">
        <p className="font-aeonik-fono text-xs text-content-muted">
          Export your chats, projects and settings as a portable ZIP archive.
        </p>
        <button
          type="button"
          onClick={() => setShowWarning(true)}
          disabled={progress !== null}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors hover:bg-surface-chat disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          Create Tinfoil Backup
        </button>
        {progress && (
          <div
            className="mt-3 flex items-center justify-between gap-3 text-xs text-content-muted"
            role="status"
          >
            <span>{progressLabel[progress]}</span>
            <button
              type="button"
              onClick={() => controller.current?.abort()}
              className="font-medium text-content-primary hover:underline"
            >
              Cancel
            </button>
          </div>
        )}
        {message && (
          <p
            role="status"
            className={`mt-3 text-xs ${failed ? 'text-red-500' : 'text-content-primary'}`}
          >
            {message}
          </p>
        )}
      </div>
      <ConfirmDialog
        isOpen={showWarning}
        title="Export readable backup?"
        description="This ZIP is plaintext and readable by anyone who can access it. It contains sensitive chats, documents, and images. Store it securely."
        confirmLabel="I understand, create backup"
        onConfirm={() => void createBackup()}
        onCancel={() => setShowWarning(false)}
      />
    </div>
  )
}
