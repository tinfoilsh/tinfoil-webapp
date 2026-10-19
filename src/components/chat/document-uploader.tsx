import { getAIModels, type BaseModel } from '@/config/models'
import { createActiveAccountGuard } from '@/services/cloud/account-operation'
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

// Every uploader in the tab shares the device's uplink and the document
// service, whose admission queue serves all users, so files convert two at
// a time however many were selected.
const MAX_CONCURRENT_CONVERSIONS = 2
let activeConversions = 0
const waitingConversions: Array<() => void> = []

async function acquireConversionSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
    activeConversions++
  } else {
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        waitingConversions.splice(waitingConversions.indexOf(resume), 1)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      waitingConversions.push(resume)
    })
  }
  return () => {
    const next = waitingConversions.shift()
    if (next) next()
    else activeConversions--
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', abort, { once: true })
  })
}

// The delay a capacity rejection asks for, or null when the response is
// final.
function retryAfterMs(response: Response, errorText: string): number | null {
  if (response.status !== 429 && response.status !== 503) return null
  // The router also sends Retry-After for exhausted quotas. Those require
  // a user decision rather than holding a conversion slot until reset.
  try {
    const error = JSON.parse(errorText)?.error
    if (
      error?.code === 'insufficient_quota' ||
      error?.type === 'insufficient_quota'
    )
      return null
  } catch {
    // The document service itself can return a plain-text capacity error.
  }
  const header = response.headers.get('Retry-After')
  if (!header) return null
  const delay = /^\d+$/.test(header.trim())
    ? Number(header) * 1000
    : Date.parse(header) - Date.now()
  // A zero delay or a date in the past must not create a tight retry loop.
  return Number.isFinite(delay) ? Math.max(1000, delay) : null
}

// Converts a file once a slot is free. A capacity rejection is retried
// after the delay the service asks for while the retry still lands within
// the processing deadline, which starts once the file has a slot.
async function convertDocument(
  endpoint: string,
  file: File,
  account: ReturnType<typeof createActiveAccountGuard>,
): Promise<DocumentProcessingResult> {
  const release = await acquireConversionSlot(account.signal)
  const deadline = Date.now() + CONSTANTS.DOCUMENT_PROCESSING_TIMEOUT_MS
  const controller = new AbortController()
  const abortForAccount = () => controller.abort(account.signal.reason)
  account.signal.addEventListener('abort', abortForAccount, { once: true })
  const timeoutId = setTimeout(
    () => controller.abort(),
    CONSTANTS.DOCUMENT_PROCESSING_TIMEOUT_MS,
  )
  try {
    account.assertCurrent()
    const secureFetch = await getSecureFetch()
    const body = new FormData()
    body.append('files', file)
    for (;;) {
      account.assertCurrent()
      const token = await getSessionToken()
      account.assertCurrent()
      controller.signal.throwIfAborted()
      const response = await secureFetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
        signal: controller.signal,
      })
      if (response.ok) {
        const result: DocumentProcessingResult =
          response.status === 204 ? {} : await response.json()
        account.assertCurrent()
        controller.signal.throwIfAborted()
        return result
      }
      const errorText = await response.text()
      account.assertCurrent()
      controller.signal.throwIfAborted()
      const delayMs = retryAfterMs(response, errorText)
      if (delayMs === null || Date.now() + delayMs >= deadline) {
        throw new Error(
          `Document upload failed with status: ${response.status}. ${errorText}`,
        )
      }
      await waitForRetry(delayMs, controller.signal)
    }
  } finally {
    account.signal.removeEventListener('abort', abortForAccount)
    clearTimeout(timeoutId)
    release()
  }
}

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
      const models = (await getAIModels()) ?? []
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
    const models = (await getAIModels()) ?? []
    const fastTier = 'fast'
    const isMultimodalChat = (m: BaseModel) =>
      Boolean(m.multimodal && m.chat && m.type === 'chat')
    // Prefer a fast multimodal model over larger reasoning-heavy ones
    const multimodalModel =
      models.find(
        (m) =>
          isMultimodalChat(m) && m.chatConfig?.attributes?.includes(fastTier),
      ) ?? models.find(isMultimodalChat)
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
    ) => void | Promise<void>,
    onError: (error: Error, documentId: string) => void,
    onGeneratingDescription?: (
      documentId: string,
      imageData?: {
        base64: string
        mimeType: string
        thumbnailBase64?: string
      },
    ) => void,
    options?: { requireTextContent?: boolean },
  ) => {
    const documentId = getDocumentId()
    const account = createActiveAccountGuard()

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
        await onSuccess(formattedContent, documentId)
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
            maxWidth: CONSTANTS.MAX_IMAGE_DIMENSION_PX,
            maxHeight: CONSTANTS.MAX_IMAGE_DIMENSION_PX,
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

          // Chat attachments can be sent directly to multimodal models, but
          // persistent project documents require reusable text content.
          if (isCurrentModelMultimodal && !options?.requireTextContent) {
            await onSuccess('', documentId, imageData, false)
            return
          }

          // Notify that we're generating the description
          onGeneratingDescription?.(documentId, imageData)

          // For non-multimodal models, generate a text description
          const description = await describeImageWithMultimodal(
            imageData.base64,
            imageData.mimeType,
          )
          await onSuccess(description, documentId, imageData, true)
          return
        } catch (error) {
          logError('Image description failed', error, {
            component: 'DocumentUploader',
            metadata: { contentType: file.type, sizeBytes: file.size },
          })
          const message =
            error instanceof Error ? error.message : 'Unknown error'
          onError(new Error(`Failed to process image: ${message}`), documentId)
          return
        }
      }

      // For audio files, transcribe via audio model
      if (isAudioFile(file)) {
        const models = (await getAIModels()) ?? []
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

        await onSuccess(text.trim(), documentId)
        return
      }

      // For non-txt files, proceed with API processing
      const { endpoint } = await getDocUploadModel()
      // Decided at upload time based on the current model: vision-capable
      // chat attachments get per-page images, while persistent project
      // documents always request reusable text.
      // If the user later switches to a vision model they'll need to
      // re-upload to get image rendering for an existing attachment.
      const fetchEndpoint =
        isCurrentModelMultimodal && !options?.requireTextContent
          ? `${endpoint}?mode=images`
          : endpoint

      const processingResult = await convertDocument(
        fetchEndpoint,
        file,
        account,
      )
      account.assertCurrent()

      const doc = processingResult.document
      if (doc?.md_content || doc?.pages?.length) {
        await onSuccess(
          doc.md_content ?? '',
          documentId,
          undefined,
          undefined,
          doc.pages,
        )
      } else {
        await onSuccess('', documentId)
      }
    } catch (error) {
      logError('Document processing failed', error, {
        component: 'DocumentUploader',
        action: 'uploadDocument',
        metadata: { documentId, contentType: file.type, sizeBytes: file.size },
      })
      onError(
        error instanceof Error
          ? error
          : new Error('Unknown error during document processing'),
        documentId,
      )
    } finally {
      account.dispose()
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
