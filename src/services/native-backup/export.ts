import * as auth from '@/services/auth'
import { SyncEnclaveError } from '@/services/sync-enclave'
import { collectNativeBackupV2, NativeBackupCollectionError } from './collect'
import { formatNativeBackupV2, type NativeBackupWarning } from './format'
import {
  NativeBackupWriterError,
  prepareNativeBackupArchiveDestination,
  writeNativeBackupArchive,
  type NativeBackupArchiveResult,
} from './write'

export type NativeBackupExportProgress = 'collecting' | 'formatting' | 'writing'
export type NativeBackupExportResult = {
  complete: boolean
  omitted: number
  adjustedRelationships: number
  localInventoryUnstable: boolean
  warnings: number
}

export interface NativeBackupExportDependencies {
  prepare?: typeof prepareNativeBackupArchiveDestination
  collect: (signal: AbortSignal) => ReturnType<typeof collectNativeBackupV2>
  format: typeof formatNativeBackupV2
  write: typeof writeNativeBackupArchive
  download: (result: NativeBackupArchiveResult) => void
}

const download = (result: NativeBackupArchiveResult) => {
  if (result.kind !== 'blob') return
  const url = URL.createObjectURL(result.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

const defaults: NativeBackupExportDependencies = {
  prepare: prepareNativeBackupArchiveDestination,
  collect: (signal) => collectNativeBackupV2(undefined, signal),
  format: formatNativeBackupV2,
  write: writeNativeBackupArchive,
  download,
}

export async function runNativeBackupExport(
  signal: AbortSignal,
  onProgress: (progress: NativeBackupExportProgress) => void,
  dependencies: NativeBackupExportDependencies = defaults,
): Promise<NativeBackupExportResult> {
  signal.throwIfAborted()
  const destination = await dependencies.prepare?.()
  signal.throwIfAborted()
  onProgress('collecting')
  const collected = await dependencies.collect(signal)
  signal.throwIfAborted()
  onProgress('formatting')
  const formatted = dependencies.format(collected)
  signal.throwIfAborted()
  onProgress('writing')
  const result = await dependencies.write(formatted, { signal, destination })
  if (result.kind === 'blob') signal.throwIfAborted()
  dependencies.download(result)
  const warningCount = (code: NativeBackupWarning['code']) =>
    collected.warnings.find((warning) => warning.code === code)?.count ?? 0
  const omitted = warningCount('source_items_omitted')
  const adjustedRelationships = warningCount(
    'chats_detached_from_omitted_projects',
  )
  return {
    complete: collected.omissions.length === 0,
    omitted,
    adjustedRelationships,
    localInventoryUnstable: warningCount('local_inventory_unstable') > 0,
    warnings: collected.warnings.length,
  }
}

export function nativeBackupExportError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Backup canceled. No backup file was saved.'
  if (
    error instanceof NativeBackupWriterError &&
    (error.code === 'compressed_limit' || error.code === 'uncompressed_limit')
  )
    return 'This backup is too large to save in your browser. Remove some large images or documents, then try again.'
  if (error instanceof NativeBackupCollectionError) {
    if (error.kind === 'limits')
      return 'This backup is too large to create. Remove some large images or documents, then try again.'
    if (error.kind === 'account')
      return error.recordId === 'active'
        ? 'Your account session is unavailable. Sign in again, then retry the backup.'
        : 'Unlock your cloud encryption key on this device, then try again.'
    return 'Some cloud data changed or went missing during export. Wait for Cloud Sync to finish, then try again.'
  }
  if (
    error instanceof auth.AuthTokenUnavailableError ||
    error instanceof auth.AuthTokenRefreshError ||
    (error instanceof SyncEnclaveError && error.status === 401)
  )
    return 'Your account session is unavailable. Sign in again, then retry the backup.'
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  )
    return 'Tinfoil could not save the backup. Allow file downloads for this site, then try again.'
  return 'The backup could not be created. Check your connection and try again.'
}
