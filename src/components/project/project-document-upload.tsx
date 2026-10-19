'use client'

import { getDocumentTextContent } from '@/components/chat/document-content'
import { useDocumentUploader } from '@/components/chat/document-uploader'
import { cn } from '@/components/ui/utils'
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { useCallback, useRef, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { useProject } from './project-context'

interface ProjectDocumentUploadProps {
  isDarkMode: boolean
}

const ACCEPTED_FILE_TYPES = [
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
]

export function ProjectDocumentUpload({
  isDarkMode,
}: ProjectDocumentUploadProps) {
  const { uploadDocument, loading: projectLoading } = useProject()
  const { handleDocumentUpload, isDocumentUploading } = useDocumentUploader()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files || files.length === 0) return

      setError(null)
      setUploadStatus('Processing...')

      const file = files[0]

      handleDocumentUpload(
        file,
        async (content, _documentId, _imageData, _hasDescription, pages) => {
          try {
            const projectContent = getDocumentTextContent(content, pages)
            if (!projectContent) {
              throw new Error('No readable content was found in this document.')
            }
            setUploadStatus('Uploading...')
            await uploadDocument(file, projectContent)
            setUploadStatus(null)
          } catch (err) {
            setError(
              err instanceof Error ? err.message : 'Failed to upload document',
            )
            setUploadStatus(null)
          }
        },
        (err, _documentId) => {
          setError(err.message)
          setUploadStatus(null)
        },
        undefined,
        { requireTextContent: true },
      )

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [handleDocumentUpload, uploadDocument],
  )

  const handleClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const isUploading =
    isDocumentUploading || projectLoading || uploadStatus !== null

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES.join(',')}
        onChange={handleFileSelect}
        className="hidden"
        disabled={isUploading}
      />

      <button
        type="button"
        onClick={handleClick}
        disabled={isUploading}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs transition-colors',
          isDarkMode
            ? 'border-border-strong text-content-muted hover:border-brand-accent-light/40 hover:text-brand-accent-light'
            : 'border-border-subtle text-content-muted hover:border-brand-accent-dark/40 hover:text-brand-accent-dark',
          isUploading && 'cursor-not-allowed opacity-50',
        )}
      >
        {isUploading ? (
          <>
            <PiSpinner
              className="h-3.5 w-3.5 animate-spin"
              aria-hidden="true"
            />
            <span>{uploadStatus || 'Uploading...'}</span>
          </>
        ) : (
          <>
            <ArrowUpTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Upload Document</span>
          </>
        )}
      </button>

      {error && <p className="text-center text-[10px] text-red-500">{error}</p>}

      <p className="text-center font-aeonik-fono text-[10px] text-content-muted">
        PDF, Office, text files up to 32MB
      </p>
    </div>
  )
}
