'use client'

import { useDocumentUploader } from '@/components/chat/document-uploader'
import { cn } from '@/components/ui/utils'
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { useCallback, useRef, useState } from 'react'
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
        async (content, _documentId, _imageData) => {
          try {
            setUploadStatus('Uploading...')
            await uploadDocument(file, content)
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
            ? 'border-border-strong text-content-muted hover:border-emerald-500/40 hover:text-emerald-400'
            : 'border-border-subtle text-content-muted hover:border-emerald-500/40 hover:text-emerald-600',
          isUploading && 'cursor-not-allowed opacity-50',
        )}
      >
        {isUploading ? (
          <>
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span>{uploadStatus || 'Uploading...'}</span>
          </>
        ) : (
          <>
            <ArrowUpTrayIcon className="h-3.5 w-3.5" />
            <span>Upload Document</span>
          </>
        )}
      </button>

      {error && <p className="text-center text-[10px] text-red-500">{error}</p>}

      <p className="text-center font-aeonik-fono text-[10px] text-content-muted">
        PDF, Office, text files up to 10MB
      </p>
    </div>
  )
}
