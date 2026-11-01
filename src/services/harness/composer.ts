import { formatFileSize } from '@/utils/format-file-size'
import { ERROR_CODES } from './protocol'
import { HarnessError } from './sse'
import type { FileGroup } from './types'

// The extension a file name ends with, as accept lists name it.
function extensionOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

// What a file picker offers: the files of every group.
export const acceptOf = (groups: readonly FileGroup[] | undefined) =>
  groups?.flatMap((group) => group.accept).join(',')

// Refuses a picked file before it uploads: one whose extension no group
// accepts, or one larger than its group takes.
export function checkUpload(file: File, groups: readonly FileGroup[]) {
  const extension = extensionOf(file.name)
  const group =
    extension && groups.find((group) => group.accept.includes(extension))
  if (!group)
    throw new HarnessError(
      {
        code: ERROR_CODES.attachmentUnsupported,
        message: `${file.name} is not a supported file type.`,
      },
      415,
    )
  if (file.size <= group.maxBytes) return
  throw new HarnessError(
    {
      code: ERROR_CODES.attachmentTooLarge,
      message: `${file.name} is larger than the ${formatFileSize(group.maxBytes)} limit.`,
    },
    413,
  )
}
