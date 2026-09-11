import type { ImportFailureReason } from '@/services/sync-enclave/sync-api'

/** Which user flow drove the enclave import job; picks matching wording. */
export type ImportSurface = 'chat_import' | 'backup_restore'

const IMPORT_FAILURE_COPY: Record<
  ImportSurface,
  Record<ImportFailureReason, string>
> = {
  chat_import: {
    timeout:
      'The import ran out of time before finishing. Chats already imported were kept; run the import again to continue with the rest.',
    invalid_archive:
      'The file could not be read as a supported chat export. Export your chats again and upload the new file.',
    limit_exceeded:
      'The export is larger than the import limits allow. Try splitting it into smaller exports.',
    key_mismatch:
      'The encryption key used for the import no longer matches the key on your account. Nothing was written; try the import again.',
    internal:
      'Something went wrong on our side while processing the import. Please try again.',
  },
  backup_restore: {
    timeout:
      'The restore ran out of time before finishing. Cloud items already restored were kept; reselect the archive to continue with the rest.',
    invalid_archive:
      'The archive could not be read as a Tinfoil backup. Export a new backup and try again.',
    limit_exceeded:
      'The backup is larger than the restore limits allow. Try restoring from a smaller backup.',
    key_mismatch:
      'The encryption key used for the restore no longer matches the key on your account. Nothing was written; try the restore again.',
    internal:
      'Something went wrong on our side while restoring the backup. Please try again.',
  },
}

/**
 * User-facing explanation for a failed import job. Falls back to the
 * generic message for reasons this build does not know about so a
 * newer enclave never produces an empty explanation.
 */
export function describeImportFailure(
  reason: string | undefined,
  surface: ImportSurface = 'chat_import',
): string {
  const copy = IMPORT_FAILURE_COPY[surface]
  if (reason && Object.hasOwn(copy, reason))
    return copy[reason as ImportFailureReason]
  return copy.internal
}
