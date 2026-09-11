import type { ImportFailureReason } from '@/services/sync-enclave/sync-api'

const IMPORT_FAILURE_COPY: Record<ImportFailureReason, string> = {
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
}

/**
 * User-facing explanation for a failed import job. Falls back to the
 * generic message for reasons this build does not know about so a
 * newer enclave never produces an empty explanation.
 */
export function describeImportFailure(reason?: string): string {
  if (reason && Object.hasOwn(IMPORT_FAILURE_COPY, reason))
    return IMPORT_FAILURE_COPY[reason as ImportFailureReason]
  return IMPORT_FAILURE_COPY.internal
}
