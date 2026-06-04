import { CONSTANTS } from './constants'
import type { Attachment, DocumentPage, Message } from './types'

/**
 * Extract image attachments from a message, handling both new and legacy formats.
 */
export function getMessageImages(msg: Message): Attachment[] {
  if (msg.attachments && msg.attachments.length > 0) {
    return msg.attachments.filter((a) => a.type === 'image')
  }

  // Legacy format: reconstruct from documents + imageData
  if (msg.imageData) {
    return msg.imageData.map((img, i) => {
      const fileName = msg.documents?.[i]?.name ?? 'Image'
      return {
        id: `legacy-img-${i}`,
        type: 'image' as const,
        fileName,
        mimeType: img.mimeType,
        base64: img.base64,
        description: extractImageDescription(fileName, msg.multimodalText),
      }
    })
  }

  return []
}

/**
 * Extract document attachments from a message, handling both new and legacy formats.
 */
export function getMessageDocuments(msg: Message): Attachment[] {
  if (msg.attachments && msg.attachments.length > 0) {
    return msg.attachments.filter((a) => a.type === 'document')
  }

  // Legacy format: documents without imageData entries are text documents
  if (msg.documents) {
    const imageCount = msg.imageData?.length ?? 0
    return msg.documents.slice(imageCount).map((doc, i) => ({
      id: `legacy-doc-${i}`,
      type: 'document' as const,
      fileName: doc.name,
      textContent: extractDocumentContent(doc.name, msg.documentContent),
    }))
  }

  return []
}

/**
 * Get all attachments from a message, handling both new and legacy formats.
 */
export function getMessageAttachments(msg: Message): Attachment[] {
  if (msg.attachments && msg.attachments.length > 0) {
    return msg.attachments
  }

  return [...getMessageImages(msg), ...getMessageDocuments(msg)]
}

/**
 * Check if a message has any attachments (new or legacy format).
 */
export function hasMessageAttachments(msg: Message): boolean {
  if (msg.attachments && msg.attachments.length > 0) return true
  if (msg.documents && msg.documents.length > 0) return true
  if (msg.imageData && msg.imageData.length > 0) return true
  return false
}

/**
 * Extract a single image description from the legacy combined multimodalText string.
 * Format: "Image: {name}\nDescription:\n{description}\n\nImage: {name2}\n..."
 */
function extractImageDescription(
  name: string,
  multimodalText?: string,
): string | undefined {
  if (!multimodalText) return undefined
  const marker = `Image: ${name}\nDescription:\n`
  const idx = multimodalText.indexOf(marker)
  if (idx === -1) return undefined
  const rest = multimodalText.slice(idx + marker.length)
  const nextImg = rest.indexOf('\n\nImage: ')
  return (nextImg === -1 ? rest : rest.slice(0, nextImg)).trim() || undefined
}

// Rough chars-per-token ratio used by the rest of the chat surface
// (see estimateTokenCount in chat-interface.tsx). Inlined here so this
// helper stays a pure leaf module.
const CHARS_PER_TOKEN = 4

export interface TruncateForCodeExecResult {
  content: string
  pages?: DocumentPage[]
  truncated: boolean
}

/**
 * Cap a docling result so a single attachment can't dominate the
 * model's context window. Only invoked when the eager bucket upload
 * succeeded — the truncation footer points the model at the full file
 * in `/user-uploads/<fileName>`.
 *
 * Text-only docs: slice `content` to a token cap and append a footer.
 * Multimodal docs (pages present): cap the pages array to a page count;
 * the per-attachment `/user-uploads` hint emitted by chat-query-builder
 * carries the "rest of the file lives in the sandbox" signal there, so
 * no per-page footer is needed.
 */
export function truncateForCodeExec(opts: {
  content: string
  pages?: DocumentPage[]
  fileName: string
}): TruncateForCodeExecResult {
  const { content, pages, fileName } = opts
  const charCap = CONSTANTS.CODE_EXEC_TEXT_TOKEN_CAP_PER_FILE * CHARS_PER_TOKEN
  const contentOver = content.length > charCap
  const pagesOver =
    !!pages && pages.length > CONSTANTS.CODE_EXEC_MAX_PAGES_PER_FILE

  if (!contentOver && !pagesOver) {
    return { content, pages, truncated: false }
  }

  const footer = `\n\n[...truncated. Full file at /user-uploads/${fileName} — read it with bash/python in the code execution environment.]`
  return {
    content: contentOver ? content.slice(0, charCap) + footer : content,
    pages: pagesOver
      ? pages!.slice(0, CONSTANTS.CODE_EXEC_MAX_PAGES_PER_FILE)
      : pages,
    truncated: true,
  }
}

/**
 * Extract a single document's text content from the legacy combined documentContent string.
 */
function extractDocumentContent(
  name: string,
  documentContent?: string,
): string | undefined {
  if (!documentContent) return undefined
  const marker = `Document title: ${name}\nDocument contents:\n`
  const idx = documentContent.indexOf(marker)
  if (idx === -1) return undefined
  const rest = documentContent.slice(idx + marker.length)
  const nextDoc = rest.indexOf('\nDocument title: ')
  return (nextDoc === -1 ? rest : rest.slice(0, nextDoc)).trim() || undefined
}
