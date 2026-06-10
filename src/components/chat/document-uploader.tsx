import { getAIModels } from '@/config/models'
import {
  getSecureFetch,
  getSessionToken,
  getTinfoilClient,
} from '@/services/inference/tinfoil-client'
import { logError } from '@/utils/error-handling'
import {
  getFileIconType as getFileIcon,
  isPlainTextFile,
  isProbablyTextFile,
  isSupportedFile,
} from '@/utils/file-types'
import {
  generateThumbnailBase64,
  isAudioFile,
  isImageFile,
  scaleAndEncodeImage,
} from '@/utils/preprocessing'
import { useState } from 'react'
import { CONSTANTS } from './constants'
import type { DocumentPage, DocumentProcessingResult } from './types'

/**
 * Re-export getFileIconType for backward compatibility
 */
export const getFileIconType = getFileIcon

/**
 * Handles the document upload and processing logic
 */
export const useDocumentUploader = (isCurrentModelMultimodal?: boolean) => {
  const [uploadingDocuments, setUploadingDocuments] = useState<
    Record<string, boolean>
  >({})

  // Get a unique ID for the document
  const getDocumentId = () => crypto.randomUUID()

  // Get docling model from config
  const getDocUploadModel = async (): Promise<{
    endpoint: string
    modelName: string
  }> => {
    try {
      const models = await getAIModels()
      const doclingModel = models.find(
        (model) => model.modelName === 'docling' || model.type === 'document',
      )

      if (doclingModel?.endpoint) {
        return {
          endpoint: doclingModel.endpoint,
          modelName: doclingModel.modelName,
        }
      }

      // If not found, throw error - no fallbacks
      throw new Error('Document processing model not found in configuration')
    } catch (error) {
      logError('Failed to fetch docling model configuration', error, {
        component: 'DocumentUploader',
        action: 'getDocUploadModel',
      })
      throw error
    }
  }

  // Handle text files directly in the browser
  const handleTextFile = async (file: File): Promise<string> => {
    // Use FileReader to read the file contents
    const reader = new FileReader()

    // Create a promise to handle the async FileReader
    const fileContents = await new Promise<string>((resolve, reject) => {
      reader.onload = (e) => {
        if (e.target?.result) {
          resolve(e.target.result as string)
        } else {
          reject(new Error('Failed to read file contents'))
        }
      }
      reader.onerror = () => reject(new Error('Error reading file'))
      reader.readAsText(file)
    })

    return fileContents
  }

  // Describe image using multimodal model
  const describeImageWithMultimodal = async (
    base64: string,
    mimeType: string,
  ): Promise<string> => {
    const models = await getAIModels()
    const multimodalModel = models.find(
      (m) => m.multimodal && m.chat && m.type === 'chat',
    )
    if (!multimodalModel) {
      throw new Error('No multimodal model available')
    }

    const client = await getTinfoilClient()
    const response = await client.chat.completions.create({
      model: multimodalModel.modelName,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Describe this image in detail. Include:
- What is happening in the image
- Colors (provide hex codes where relevant)
- Any text visible in the image
- Layout and composition
- Other notable details`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
          ],
        },
      ],
      stream: false,
    })

    return (
      (response.choices[0]?.message?.content as string) ||
      'Unable to describe image'
    )
  }

  // Main upload function
  const handleDocumentUpload = async (
    file: File,
    onSuccess: (
      content: string,
      documentId: string,
      imageData?: {
        base64: string
        mimeType: string
        thumbnailBase64?: string
      },
      hasDescription?: boolean,
      pages?: DocumentPage[],
    ) => void,
    onError: (error: Error, documentId: string) => void,
    onGeneratingDescription?: (
      documentId: string,
      imageData?: {
        base64: string
        mimeType: string
        thumbnailBase64?: string
      },
    ) => void,
  ) => {
    const documentId = getDocumentId()

    try {
      setUploadingDocuments((prev) => ({
        ...prev,
        [documentId]: true,
      }))

      // Handle plain text and code files directly in the browser. Files with
      // unknown extensions that sniff as text are read the same way.
      // Text files are not subject to the byte-size limit; the caller
      // validates their token estimate against the model's context window.
      if (
        isPlainTextFile(file.name) ||
        (!isSupportedFile(file.name) && (await isProbablyTextFile(file)))
      ) {
        if (file.size > CONSTANTS.MAX_TEXT_DOCUMENT_SIZE_BYTES) {
          onError(
            new Error(
              `Text file exceeds the limit of ${CONSTANTS.MAX_TEXT_DOCUMENT_SIZE_MB}MB.`,
            ),
            documentId,
          )
          return
        }
        const formattedContent = await handleTextFile(file)
        onSuccess(formattedContent, documentId)
        return
      }

      if (file.size > CONSTANTS.MAX_DOCUMENT_SIZE_BYTES) {
        onError(
          new Error(
            `File size exceeds the limit of ${CONSTANTS.MAX_DOCUMENT_SIZE_MB}MB.`,
          ),
          documentId,
        )
        return
      }

      // For image files, get description from multimodal model
      if (isImageFile(file)) {
        try {
          const scaled = await scaleAndEncodeImage(file, {
            maxWidth: 768,
            maxHeight: 768,
            quality: 0.85,
          })

          let thumbnailBase64: string | undefined
          try {
            thumbnailBase64 = await generateThumbnailBase64(
              scaled.base64,
              scaled.mimeType,
            )
          } catch {
            // Non-fatal — proceed without thumbnail
          }

          const imageData = { ...scaled, thumbnailBase64 }

          // If current model is multimodal, skip description generation
          // The image will be sent directly to the model
          if (isCurrentModelMultimodal) {
            onSuccess('', documentId, imageData, false)
            return
          }

          // Notify that we're generating the description
          onGeneratingDescription?.(documentId, imageData)

          // For non-multimodal models, generate a text description
          const description = await describeImageWithMultimodal(
            imageData.base64,
            imageData.mimeType,
          )
          onSuccess(description, documentId, imageData, true)
          return
        } catch (error) {
          logError('Image description failed', error, {
            component: 'DocumentUploader',
            metadata: { fileName: file.name },
          })
          const message =
            error instanceof Error ? error.message : 'Unknown error'
          onError(new Error(`Failed to process image: ${message}`), documentId)
          return
        }
      }

      // For audio files, transcribe via audio model
      if (isAudioFile(file)) {
        const models = await getAIModels()
        const audioModel = (
          models.find((m) => m.modelName === CONSTANTS.DEFAULT_AUDIO_MODEL) ||
          models.find((m) => m.type === 'audio')
        )?.modelName

        if (!audioModel) {
          onError(
            new Error('No audio model available for transcription'),
            documentId,
          )
          return
        }

        const client = await getTinfoilClient()
        const transcription = await client.audio.transcriptions.create({
          file,
          model: audioModel,
          response_format: 'text',
        })

        const text =
          typeof transcription === 'string'
            ? transcription
            : (transcription as any).text

        if (!text) {
          onError(new Error('No transcription text received'), documentId)
          return
        }

        onSuccess(text.trim(), documentId)
        return
      }

      // For non-txt files, proceed with API processing
      // Create a FormData object for the file
      const formData = new FormData()

      formData.append('files', file)

      const { endpoint } = await getDocUploadModel()
      // Decided at upload time based on the current model: vision-capable
      // models get per-page images, text-only models skip the bandwidth.
      // If the user later switches to a vision model they'll need to
      // re-upload to get image rendering for an existing attachment.
      const fetchEndpoint = isCurrentModelMultimodal
        ? `${endpoint}?mode=images`
        : endpoint

      const apiKey = await getSessionToken()
      const secureFetch = await getSecureFetch()
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        CONSTANTS.DOCUMENT_PROCESSING_TIMEOUT_MS,
      )

      const response = await secureFetch(fetchEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId))

      // Handle 204 No Content response
      if (response.status === 204) {
        onSuccess('', documentId)
        return
      }

      // Check if submission successful
      if (!response.ok) {
        const errorText = await response.text()
        logError(
          `Document upload failed with status: ${response.status}`,
          undefined,
          {
            component: 'DocumentUploader',
            action: 'uploadDocument',
            metadata: { status: response.status, errorText },
          },
        )

        throw new Error(
          `Document upload failed with status: ${response.status}. ${errorText}`,
        )
      }

      // Process the direct response
      const processingResult =
        (await response.json()) as DocumentProcessingResult

      const doc = processingResult.document
      if (doc?.md_content || doc?.pages?.length) {
        onSuccess(
          doc.md_content ?? '',
          documentId,
          undefined,
          undefined,
          doc.pages,
        )
      } else {
        onSuccess('', documentId)
      }
    } catch (error) {
      logError('Document processing failed', error, {
        component: 'DocumentUploader',
        action: 'uploadDocument',
        metadata: { documentId, fileName: file.name },
      })
      onError(
        error instanceof Error
          ? error
          : new Error('Unknown error during document processing'),
        documentId,
      )
    } finally {
      // Remove this document from uploading state
      setUploadingDocuments((prev) => {
        const newState = { ...prev }
        delete newState[documentId]
        return newState
      })
    }
  }

  return {
    handleDocumentUpload,
    uploadingDocuments,
    isDocumentUploading: Object.keys(uploadingDocuments).length > 0,
    describeImageWithMultimodal,
  }
}
