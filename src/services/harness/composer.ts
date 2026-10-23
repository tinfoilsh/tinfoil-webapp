import { BYTES_PER_MB, formatFileSize } from '@/utils/format-file-size'
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

// A file of a type no group names uploads as text, which the harness reads
// when its contents are text.
const TEXT_EXTENSION = '.txt'

// A limit of whole megabytes reads as the app always wrote it, such as 33MB.
const limitLabel = (bytes: number) =>
  bytes % BYTES_PER_MB === 0
    ? `${bytes / BYTES_PER_MB}MB`
    : formatFileSize(bytes)

// Refuses a picked file before it uploads: one larger than its group takes,
// or one of a type no group names when no group takes text.
export function checkUpload(file: File, groups: readonly FileGroup[]) {
  const extension = extensionOf(file.name)
  const group =
    (extension && groups.find((group) => group.accept.includes(extension))) ||
    groups.find((group) => group.accept.includes(TEXT_EXTENSION))
  if (!group)
    throw new HarnessError(
      {
        code: ERROR_CODES.attachmentUnsupported,
        message: `${file.name} is not a supported file type.`,
      },
      415,
    )
  if (file.size <= group.maxBytes) return group
  throw new HarnessError(
    {
      code: ERROR_CODES.attachmentTooLarge,
      message: `File size exceeds the limit of ${limitLabel(group.maxBytes)}.`,
    },
    413,
  )
}

const UPLOAD_IMAGE_QUALITY = 0.85

// Only the upload copy is scaled; text extraction and image descriptions
// belong to the harness.
export async function prepareUpload(
  file: File,
  groups: readonly FileGroup[],
): Promise<File> {
  const group = checkUpload(file, groups)
  if (!group.imageMaxSide) return file
  const source = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = source
    await image.decode()
    const scale = Math.min(
      1,
      group.imageMaxSide / Math.max(image.naturalWidth, image.naturalHeight),
    )
    if (scale === 1) {
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image resizing is unavailable.')
    context.fillStyle = 'white'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error('The image could not be resized.')),
        'image/jpeg',
        UPLOAD_IMAGE_QUALITY,
      ),
    )
    const resized = new File([blob], file.name, {
      type: blob.type,
      lastModified: file.lastModified,
    })
    return resized.size <= group.maxBytes ? resized : file
  } catch {
    // A browser without this image decoder can still upload an image that
    // already fits; the harness has its own decoders.
    return file
  } finally {
    URL.revokeObjectURL(source)
  }
}
