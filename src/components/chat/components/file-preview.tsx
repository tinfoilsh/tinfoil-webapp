import { cn } from '@/components/ui/utils'
import { isPlainTextFile } from '@/utils/file-types'
import { PiSpinner } from 'react-icons/pi'
import { MacFileIcon } from './mac-file-icon'

// Enough text to fill the tile at the smallest font size without
// rendering the entire document into the DOM.
const TEXT_PREVIEW_MAX_CHARS = 600
const TEXT_PREVIEW_MAX_LINES = 24
// Rendered like a sheet of paper: lines of text in a font too small to read,
// so the shape of the document shows through the way it does in a Finder icon.
const TEXT_PREVIEW_FONT_PX = 3.5
const TEXT_PREVIEW_LINE_HEIGHT_PX = 4.5

type FilePreviewSize = 'sm' | 'md' | 'lg'

const SIZE_CLASSES: Record<FilePreviewSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-24 w-24',
}

// Icon size for the fallback glyph, scaled to the tile.
const ICON_SIZES: Record<FilePreviewSize, number> = {
  sm: 16,
  md: 18,
  lg: 32,
}

// Text tiles read as a sheet of paper: the text is tiny, so a few extra
// lines of padding keep it from touching the edges.
const TEXT_TILE_PADDING: Record<FilePreviewSize, string> = {
  sm: 'p-1',
  md: 'p-1',
  lg: 'p-2',
}

export function buildTextPreviewExcerpt(content: string): string {
  // Only the head of the document is ever shown, so bound the work to a
  // prefix instead of splitting a possibly multi-megabyte string into lines.
  const head = content.slice(0, TEXT_PREVIEW_MAX_CHARS * TEXT_PREVIEW_MAX_LINES)
  return head
    .replace(/\r\n?/g, '\n')
    .split('\n', TEXT_PREVIEW_MAX_LINES)
    .join('\n')
    .slice(0, TEXT_PREVIEW_MAX_CHARS)
}

export function hasTextPreview(filename: string, textContent?: string) {
  return Boolean(textContent?.trim()) && isPlainTextFile(filename)
}

interface FilePreviewProps {
  filename: string
  /** Data URL for an image tile; when present it takes precedence. */
  imageSrc?: string | null
  /** Raw text used to render a miniature document tile. */
  textContent?: string
  size?: FilePreviewSize
  /** Draws a spinner over the tile while the file is still processing. */
  isBusy?: boolean
  className?: string
}

/**
 * Thumbnail for a file attachment: a real image thumbnail for images, a
 * miniature rendering of the text for plain-text files (in the style of
 * macOS Finder document icons), and a file-type glyph otherwise.
 */
export function FilePreview({
  filename,
  imageSrc,
  textContent,
  size = 'md',
  isBusy = false,
  className,
}: FilePreviewProps) {
  const showImage = Boolean(imageSrc)
  const showText = !showImage && hasTextPreview(filename, textContent)
  // While a file is still processing and there is nothing to preview yet,
  // show a bare spinner in the same slot so the row keeps its geometry
  // without framing an empty tile.
  const showPendingSpinner = isBusy && !showImage && !showText

  if (showPendingSpinner) {
    return (
      <div
        className={cn(
          'flex flex-shrink-0 items-center justify-center',
          SIZE_CLASSES[size],
          className,
        )}
        data-testid="file-preview"
        data-preview-kind="pending"
      >
        <PiSpinner className="h-4 w-4 animate-spin text-content-secondary" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-surface-card',
        SIZE_CLASSES[size],
        className,
      )}
      data-testid="file-preview"
      data-preview-kind={showImage ? 'image' : showText ? 'text' : 'icon'}
    >
      {showImage ? (
        <img
          src={imageSrc as string}
          alt={filename}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : showText ? (
        <pre
          aria-hidden="true"
          className={cn(
            'h-full w-full select-none overflow-hidden whitespace-pre-wrap break-words bg-white text-left font-mono text-gray-700 dark:bg-gray-100 dark:text-gray-800',
            TEXT_TILE_PADDING[size],
          )}
          style={{
            fontSize: `${TEXT_PREVIEW_FONT_PX}px`,
            lineHeight: `${TEXT_PREVIEW_LINE_HEIGHT_PX}px`,
          }}
        >
          {buildTextPreviewExcerpt(textContent as string)}
        </pre>
      ) : (
        <MacFileIcon filename={filename} size={ICON_SIZES[size]} />
      )}
      {isBusy && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-chat/70">
          <PiSpinner className="h-4 w-4 animate-spin text-content-secondary" />
        </div>
      )}
    </div>
  )
}

export function imageDataUrl(
  base64: string | undefined,
  mimeType: string | undefined,
): string | null {
  if (!base64) return null
  return `data:${mimeType || 'image/jpeg'};base64,${base64}`
}
