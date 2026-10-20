import { formatFileSize } from '@/utils/format-file-size'
import { ERROR_CODES } from './protocol'
import { HarnessError } from './sse'
import type { Session } from './types'

// Refuses a picked file larger than the harness takes, before it uploads.
export function checkUploadSize(file: File, maxBytes: number) {
  if (file.size <= maxBytes) return
  throw new HarnessError(
    {
      code: ERROR_CODES.attachmentTooLarge,
      message: `${file.name} is larger than the ${formatFileSize(maxBytes)} limit.`,
    },
    413,
  )
}

// The largest file a message may attach. Images are held to the smaller
// limit; any other file to the text limit, as the harness refuses a larger
// document itself.
export const attachmentLimit = (
  { attachments }: Session['composer'],
  file: File,
) =>
  file.type.startsWith('image/')
    ? attachments.maxBytes
    : attachments.maxTextBytes
