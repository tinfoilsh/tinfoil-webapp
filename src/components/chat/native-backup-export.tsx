import { AuthTokenUnavailableError } from '@/services/auth'
import { exportArchive } from '@/services/harness/archives'
import { describeArchiveError } from '@/services/harness/import-failure-copy'
import { ERROR_CODES } from '@/services/harness/protocol'
import { HarnessError } from '@/services/harness/sse'
import { formatFileSize } from '@/utils/format-file-size'
import { TfDownload } from '@tinfoilsh/tinfoil-icons'
import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from './components/confirm-dialog'

const PAYLOAD_TOO_LARGE_STATUS = 413
const UNAUTHORIZED_STATUS = 401

function nativeBackupExportError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Backup canceled. No backup file was saved.'
  const refusal = describeArchiveError(error)
  if (refusal) return refusal
  if (
    error instanceof HarnessError &&
    error.status === PAYLOAD_TOO_LARGE_STATUS
  )
    return 'This backup is too large to create. Remove some large images or documents, then try again.'
  if (error instanceof HarnessError && error.code === ERROR_CODES.keyRequired)
    return 'Unlock your cloud encryption key on this device, then try again.'
  if (
    error instanceof AuthTokenUnavailableError ||
    (error instanceof HarnessError && error.status === UNAUTHORIZED_STATUS)
  )
    return 'Your account session is unavailable. Sign in again, then retry the backup.'
  // The chat service describes its other refusals.
  if (error instanceof HarnessError) return error.message
  return 'The backup could not be created. Check your connection and try again.'
}

export function NativeBackupExport({ available }: { available: boolean }) {
  const [showWarning, setShowWarning] = useState(false)
  // The bytes of the backup received so far, while a backup is created.
  const [received, setReceived] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const availableRef = useRef(available)
  availableRef.current = available

  useEffect(() => {
    if (!available) {
      controller.current = null
      setShowWarning(false)
      setReceived(null)
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
    setReceived(0)
    try {
      await exportArchive('native', {
        cloud: true,
        signal: current.signal,
        onProgress: (bytes) => {
          if (isCurrent()) setReceived(bytes)
        },
      })
      if (!isCurrent() || !availableRef.current) return
      setMessage('Backup saved successfully.')
    } catch (error) {
      if (!isCurrent()) return
      setFailed(true)
      setMessage(nativeBackupExportError(error))
    } finally {
      if (isCurrent()) {
        controller.current = null
        setReceived(null)
      }
    }
  }

  if (!available) return null

  return (
    <div>
      <div className="rounded-lg border border-border-subtle bg-surface-sidebar p-4">
        <p className="font-aeonik-fono text-xs text-content-muted">
          Export your cloud and local data as a portable ZIP archive.
        </p>
        <button
          type="button"
          onClick={() => setShowWarning(true)}
          disabled={received !== null}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2.5 text-sm font-medium transition-colors hover:bg-surface-chat disabled:cursor-not-allowed disabled:opacity-60"
        >
          <TfDownload className="h-4 w-4" />
          Create Tinfoil Backup
        </button>
        {received !== null && (
          <div
            className="mt-3 flex items-center justify-between gap-3 text-xs text-content-muted"
            role="status"
          >
            <span>
              {received > 0
                ? `Saving archive... ${formatFileSize(received)}`
                : 'Preparing backup...'}
            </span>
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
