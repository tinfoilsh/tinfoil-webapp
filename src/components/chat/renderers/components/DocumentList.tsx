import { XMarkIcon } from '@heroicons/react/24/outline'
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BsFile,
  BsFiletypeCss,
  BsFiletypeCsv,
  BsFiletypeDoc,
  BsFiletypeDocx,
  BsFiletypeGif,
  BsFiletypeHtml,
  BsFiletypeJpg,
  BsFiletypeJs,
  BsFiletypeJson,
  BsFiletypeJsx,
  BsFiletypeMd,
  BsFiletypeMov,
  BsFiletypeMp3,
  BsFiletypeMp4,
  BsFiletypePdf,
  BsFiletypePng,
  BsFiletypePpt,
  BsFiletypePptx,
  BsFiletypeTsx,
  BsFiletypeTxt,
  BsFiletypeWav,
  BsFiletypeXls,
  BsFiletypeXlsx,
  BsFiletypeXml,
} from 'react-icons/bs'

import { cn } from '@/components/ui/utils'

import { getMessageAttachments } from '../../attachment-helpers'
import {
  attachmentToImageSrc,
  ImageLightbox,
  useImageGallery,
  type GalleryImage,
} from '../../image-gallery-context'
import type { Attachment } from '../../types'

// Number of thumbnails shown in the pile before collapsing the rest behind a
// "+N" overlay on the last visible tile.
const MAX_PILE_THUMBNAILS = 5

interface DocumentListProps {
  attachments?: Attachment[]
  // Index of the owning message within the conversation, used to key images
  // into the shared gallery so the lightbox can span the whole conversation.
  messageIndex?: number
  // Legacy props — used when attachments is not present
  documents?: Array<{ name: string }>
  documentContent?: string
  imageData?: Array<{ base64: string; mimeType: string }>
}

function getFileIcon(filename: string, size: number = 20) {
  const extension = filename.toLowerCase().split('.').pop() || ''
  const iconClass = 'text-content-secondary'

  switch (extension) {
    case 'pdf':
      return <BsFiletypePdf size={size} className={iconClass} />
    case 'doc':
      return <BsFiletypeDoc size={size} className={iconClass} />
    case 'docx':
      return <BsFiletypeDocx size={size} className={iconClass} />
    case 'xls':
      return <BsFiletypeXls size={size} className={iconClass} />
    case 'xlsx':
      return <BsFiletypeXlsx size={size} className={iconClass} />
    case 'csv':
      return <BsFiletypeCsv size={size} className={iconClass} />
    case 'ppt':
      return <BsFiletypePpt size={size} className={iconClass} />
    case 'pptx':
      return <BsFiletypePptx size={size} className={iconClass} />
    case 'html':
    case 'htm':
      return <BsFiletypeHtml size={size} className={iconClass} />
    case 'css':
      return <BsFiletypeCss size={size} className={iconClass} />
    case 'js':
      return <BsFiletypeJs size={size} className={iconClass} />
    case 'jsx':
      return <BsFiletypeJsx size={size} className={iconClass} />
    case 'ts':
    case 'tsx':
      return <BsFiletypeTsx size={size} className={iconClass} />
    case 'json':
      return <BsFiletypeJson size={size} className={iconClass} />
    case 'md':
      return <BsFiletypeMd size={size} className={iconClass} />
    case 'xml':
      return <BsFiletypeXml size={size} className={iconClass} />
    case 'txt':
      return <BsFiletypeTxt size={size} className={iconClass} />
    case 'png':
      return <BsFiletypePng size={size} className={iconClass} />
    case 'jpg':
    case 'jpeg':
      return <BsFiletypeJpg size={size} className={iconClass} />
    case 'gif':
      return <BsFiletypeGif size={size} className={iconClass} />
    case 'mp3':
      return <BsFiletypeMp3 size={size} className={iconClass} />
    case 'wav':
      return <BsFiletypeWav size={size} className={iconClass} />
    case 'mp4':
      return <BsFiletypeMp4 size={size} className={iconClass} />
    case 'mov':
      return <BsFiletypeMov size={size} className={iconClass} />
    default:
      return <BsFile size={size} className={iconClass} />
  }
}

function getPreviewForDocument(
  documentContent: string | undefined,
  docName: string,
): string | null {
  if (!documentContent) return null

  const docHeader = `Document title: ${docName}`
  const headerIndex = documentContent.indexOf(docHeader)

  if (headerIndex === -1) return null

  const contentsMarker = 'Document contents:\n'
  const contentsStart = documentContent.indexOf(contentsMarker, headerIndex)
  if (contentsStart === -1) return null

  const startIndex = contentsStart + contentsMarker.length
  const nextDocIndex = documentContent.indexOf('\nDocument title: ', startIndex)
  const docSection =
    nextDocIndex === -1
      ? documentContent.slice(startIndex)
      : documentContent.slice(startIndex, nextDocIndex)

  const lines = docSection.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (trimmed.startsWith('# ')) return false
    return true
  })

  return lines.slice(0, 2).join('\n') || null
}

export const DocumentList = memo(function DocumentList({
  attachments,
  messageIndex,
  documents,
  documentContent,
  imageData,
}: DocumentListProps) {
  const gallery = useImageGallery()
  const [modalOpen, setModalOpen] = useState(false)
  const [modalContent, setModalContent] = useState<{
    name: string
    content: string
  } | null>(null)
  // Local fallback lightbox for render contexts without a gallery provider
  // (e.g. shared/printable views); scoped to this message's images.
  const [localLightboxOpen, setLocalLightboxOpen] = useState(false)
  const [localLightboxIndex, setLocalLightboxIndex] = useState(0)

  useEffect(() => {
    if (!modalOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModalOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [modalOpen])

  // Resolve attachments from new format or legacy fields
  const resolvedAttachments: Attachment[] = (() => {
    if (attachments && attachments.length > 0) return attachments
    // Build a synthetic Message to use the helpers
    const syntheticMsg = {
      role: 'user' as const,
      content: '',
      timestamp: new Date(),
      documents,
      documentContent,
      imageData,
    }
    return getMessageAttachments(syntheticMsg)
  })()

  if (resolvedAttachments.length === 0) {
    return null
  }

  const imageAttachments = resolvedAttachments.filter((a) => a.type === 'image')
  const docAttachments = resolvedAttachments.filter(
    (a) => a.type === 'document',
  )

  const openModal = (attachment: Attachment) => {
    if (!attachment.textContent) return
    setModalContent({
      name: attachment.fileName,
      content: attachment.textContent.trim(),
    })
    setModalOpen(true)
  }

  const localImages: GalleryImage[] = imageAttachments
    .map((attachment, i) => {
      const src = attachmentToImageSrc(attachment)
      return src
        ? { key: String(i), src, alt: attachment.fileName || 'Image' }
        : null
    })
    .filter((image): image is GalleryImage => image !== null)

  const openImage = (imageIndex: number) => {
    if (gallery && messageIndex !== undefined) {
      gallery.openByKey(`${messageIndex}:${imageIndex}`)
      return
    }
    setLocalLightboxIndex(imageIndex)
    setLocalLightboxOpen(true)
  }

  const visibleImages = imageAttachments.slice(0, MAX_PILE_THUMBNAILS)
  const hiddenImageCount = imageAttachments.length - visibleImages.length

  return (
    <>
      {imageAttachments.length > 0 && (
        <div className="group/pile mb-2 flex justify-end px-4">
          <div className="flex items-center">
            {visibleImages.map((attachment, i) => {
              const thumb = attachment.thumbnailBase64 || attachment.base64
              const isLastVisible = i === visibleImages.length - 1
              const overflowBadge =
                isLastVisible && hiddenImageCount > 0 ? hiddenImageCount : 0
              return (
                <button
                  key={attachment.id}
                  type="button"
                  onClick={() => openImage(i)}
                  aria-label={`View image ${attachment.fileName}`}
                  style={{ zIndex: visibleImages.length - i }}
                  className={cn(
                    'bg-surface-secondary relative h-24 w-24 flex-none overflow-hidden rounded-lg border-2 border-surface-chat shadow-md transition-all duration-200 ease-out hover:z-10 hover:-translate-y-1',
                    i > 0 && '-ml-14 group-hover/pile:ml-1',
                  )}
                >
                  {thumb ? (
                    <img
                      src={`data:${attachment.mimeType || 'image/jpeg'};base64,${thumb}`}
                      alt={attachment.fileName}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <div className="border-content-tertiary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
                    </div>
                  )}
                  {overflowBadge > 0 && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-semibold text-white">
                      +{overflowBadge}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {docAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-2 px-4">
          {docAttachments.map((attachment) => {
            const preview = attachment.textContent
              ? attachment.textContent
                  .split('\n')
                  .filter((l) => l.trim() && !l.trim().startsWith('# '))
                  .slice(0, 2)
                  .join('\n') || null
              : getPreviewForDocument(documentContent, attachment.fileName)

            return (
              <div
                key={attachment.id}
                role="button"
                tabIndex={0}
                onClick={() => openModal(attachment)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openModal(attachment)
                  }
                }}
                className="flex min-w-[200px] max-w-[300px] cursor-pointer flex-col rounded-lg bg-surface-message-user/90 p-3 shadow-sm backdrop-blur-sm transition-colors hover:bg-surface-message-user"
              >
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center p-1">
                    {getFileIcon(attachment.fileName, 20)}
                  </div>
                  <span className="truncate text-sm font-medium text-content-primary">
                    {attachment.fileName}
                  </span>
                </div>

                {preview && (
                  <div className="mt-2 line-clamp-2 text-xs text-content-muted">
                    {preview}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!gallery && (
        <ImageLightbox
          images={localImages}
          index={localLightboxIndex}
          open={localLightboxOpen}
          onClose={() => setLocalLightboxOpen(false)}
          onIndexChange={setLocalLightboxIndex}
        />
      )}

      {modalOpen &&
        modalContent &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            onClick={() => setModalOpen(false)}
          >
            <div className="fixed inset-0 bg-black/50" />

            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="document-modal-title"
              className="relative z-10 flex h-[80vh] w-[90vw] max-w-4xl flex-col rounded-xl border border-border-subtle bg-surface-card shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
                <div className="flex items-center gap-3">
                  {getFileIcon(modalContent.name, 24)}
                  <h2
                    id="document-modal-title"
                    className="text-lg font-semibold text-content-primary"
                  >
                    {modalContent.name}
                  </h2>
                </div>
                <button
                  onClick={() => setModalOpen(false)}
                  aria-label="Close"
                  className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="flex-1 overflow-auto p-6">
                <pre className="whitespace-pre-wrap font-mono text-sm text-content-primary">
                  {modalContent.content}
                </pre>
              </div>

              <div className="flex items-center justify-end border-t border-border-subtle px-6 py-4">
                <button
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-border-subtle bg-surface-chat px-4 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat/80"
                >
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
})
