import { FiArrowUp } from '@/components/icons/lazy-icons'
import { useProject } from '@/components/project'
import { cn } from '@/components/ui/utils'
import { useToast } from '@/hooks/use-toast'
import { getTinfoilClient } from '@/services/inference/tinfoil-client'
import { logError } from '@/utils/error-handling'
import { isImageFile } from '@/utils/preprocessing'
import {
  FolderIcon,
  MicrophoneIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import type { FormEvent, RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  PiGlobe,
  PiGlobeX,
  PiPaperclipLight,
  PiPlusLight,
  PiQuotes,
  PiSpinner,
  PiTerminalWindow,
} from 'react-icons/pi'
import { MacFileIcon } from './components/mac-file-icon'
import { CONSTANTS } from './constants'
import { CHAT_FONT_CLASSES, useChatFont } from './hooks/use-chat-font'
import type { PromptPreset } from './prompts/types'
import type { ProcessedDocument } from './renderers/types'
import type { LoadingState } from './types'

type ChatInputProps = {
  input: string
  setInput: (value: string) => void
  handleSubmit: (e: FormEvent) => void
  loadingState: LoadingState
  cancelGeneration: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  handleInputFocus: () => void
  inputMinHeight: string
  isDarkMode: boolean
  handleDocumentUpload?: (file: File) => Promise<void>
  processedDocuments?: ProcessedDocument[]
  removeDocument?: (id: string) => void
  isPremium?: boolean
  hasMessages?: boolean
  audioModel?: string
  modelSelectorButton?: React.ReactNode
  reasoningSelectorButton?: React.ReactNode
  webSearchEnabled?: boolean
  onWebSearchToggle?: () => void
  codeExecutionEnabled?: boolean
  onCodeExecutionToggle?: () => void
  quote?: string | null
  onClearQuote?: () => void
  isTemporaryMode?: boolean
  activePromptPreset?: PromptPreset | null
  onOpenPromptLibrary?: () => void
  onClearPromptPreset?: () => void
}

// Maximum number of characters displayed in the collapsed quote preview.
const QUOTE_PREVIEW_MAX_LENGTH = 240

const isDocumentSubmittable = (doc: ProcessedDocument) =>
  !doc.isUploading && !doc.isGeneratingDescription && !doc.isUnsupported

export function ChatInput({
  input,
  setInput,
  handleSubmit,
  loadingState,
  cancelGeneration,
  inputRef,
  handleInputFocus,
  inputMinHeight,
  isDarkMode,
  handleDocumentUpload,
  processedDocuments,
  removeDocument,
  isPremium,
  hasMessages,
  audioModel,
  modelSelectorButton,
  reasoningSelectorButton,
  webSearchEnabled,
  onWebSearchToggle,
  codeExecutionEnabled,
  onCodeExecutionToggle,
  quote,
  onClearQuote,
  isTemporaryMode,
  activePromptPreset,
  onOpenPromptLibrary,
  onClearPromptPreset,
}: ChatInputProps) {
  const { t } = useTranslation('chat')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const documentsScrollRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  const chatFont = useChatFont()
  const { isProjectMode, activeProject } = useProject()
  const [textareaResetNonce, setTextareaResetNonce] = useState(0)
  const prevInputValueRef = useRef(input)
  const shouldRemountOnClearRef = useRef(false)
  const hasInitiallyFocusedRef = useRef(false)
  const refocusAfterResetRef = useRef(false)

  const useIsomorphicLayoutEffect =
    typeof window !== 'undefined' ? useLayoutEffect : useEffect

  const resizeTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return

      const min = Number.parseInt(inputMinHeight, 10) || 0
      const max = 240

      // Reset to 0 so the browser recomputes content height.
      // Using '0' instead of 'auto' forces scrollHeight to reflect the
      // full content height on mobile Safari, even when the textarea is
      // unfocused (e.g. after programmatic value changes like transcription).
      el.style.height = '0'

      const raw = el.scrollHeight
      const next = Math.max(min, Math.min(raw, max))
      el.style.height = `${next}px`
      el.style.overflowY = raw > max ? 'auto' : 'hidden'
    },
    [inputMinHeight],
  )

  // If the input transitions from non-empty -> empty (send/clear), remount the
  // textarea to guarantee any stuck inline height is dropped on mobile Safari.
  useEffect(() => {
    const prev = prevInputValueRef.current
    if (prev !== '' && input === '' && shouldRemountOnClearRef.current) {
      refocusAfterResetRef.current =
        typeof document !== 'undefined' &&
        inputRef.current !== null &&
        document.activeElement === inputRef.current
      setTextareaResetNonce((n) => n + 1)
    }
    prevInputValueRef.current = input
    if (input === '') {
      shouldRemountOnClearRef.current = false
    }
  }, [input, inputRef])

  useEffect(() => {
    if (refocusAfterResetRef.current && inputRef.current) {
      inputRef.current.focus()
      refocusAfterResetRef.current = false
    }
  }, [textareaResetNonce, inputRef])

  // --- Speech-to-text state ---
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- Mobile attachment menu state ---
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  // Random placeholder - use first one initially to avoid SSR hydration mismatch,
  // then randomize after mount. We track the key (not the resolved string) so
  // the placeholder follows the active UI language.
  const [placeholderKey, setPlaceholderKey] = useState<string>(
    CONSTANTS.INPUT_PLACEHOLDER_KEYS[0],
  )

  useEffect(() => {
    setPlaceholderKey(
      CONSTANTS.INPUT_PLACEHOLDER_KEYS[
        Math.floor(Math.random() * CONSTANTS.INPUT_PLACEHOLDER_KEYS.length)
      ],
    )
  }, [])

  // Scroll to the end when new documents are added
  useEffect(() => {
    if (documentsScrollRef.current && processedDocuments?.length) {
      documentsScrollRef.current.scrollLeft =
        documentsScrollRef.current.scrollWidth
    }
  }, [processedDocuments?.length])

  // Announce attachment processing progress to screen readers without
  // re-rendering: write directly into an off-screen live region.
  const uploadStatusRef = useRef<HTMLSpanElement>(null)
  const wasProcessingAttachmentsRef = useRef(false)
  const processingAttachmentCount = (processedDocuments ?? []).filter(
    (doc) => doc.isUploading || doc.isGeneratingDescription,
  ).length
  const unsupportedAttachmentNames = (processedDocuments ?? [])
    .filter((doc) => doc.isUnsupported)
    .map((doc) => doc.name)
  const unsupportedAttachmentStatus = unsupportedAttachmentNames.join(', ')
  const recordingButtonLabel = isTranscribing
    ? 'Transcribing audio'
    : isRecording
      ? 'Stop recording'
      : 'Start recording'
  const audioStatus = isTranscribing
    ? 'Transcribing audio'
    : isRecording
      ? 'Recording audio'
      : ''
  useEffect(() => {
    const region = uploadStatusRef.current
    if (!region) return
    if (processingAttachmentCount > 0) {
      region.textContent =
        processingAttachmentCount === 1
          ? 'Processing attachment'
          : `Processing ${processingAttachmentCount} attachments`
      wasProcessingAttachmentsRef.current = true
    } else if (unsupportedAttachmentNames.length > 0) {
      region.textContent =
        unsupportedAttachmentNames.length === 1
          ? `Unsupported attachment: ${unsupportedAttachmentStatus}`
          : `Unsupported attachments: ${unsupportedAttachmentStatus}`
      wasProcessingAttachmentsRef.current = false
    } else if (wasProcessingAttachmentsRef.current) {
      region.textContent = 'Attachments ready'
      wasProcessingAttachmentsRef.current = false
    }
  }, [
    processingAttachmentCount,
    unsupportedAttachmentNames.length,
    unsupportedAttachmentStatus,
  ])

  // Auto-resize textarea as content changes (typing, transcription, paste, etc.)
  // Layout effect avoids iOS Safari cases where `scrollHeight` lags a paint.
  useIsomorphicLayoutEffect(() => {
    resizeTextarea(inputRef.current)

    // iOS Safari can report the previous scrollHeight on the same tick; re-check
    // on the next frame to ensure growth kicks in.
    const raf = requestAnimationFrame(() => resizeTextarea(inputRef.current))
    return () => cancelAnimationFrame(raf)
    // Include `textareaResetNonce` so a remount recalculates height immediately.
  }, [input, inputRef, resizeTextarea, textareaResetNonce])

  // Focus textarea on initial mount only (not on remounts after sending)
  useEffect(() => {
    if (!hasInitiallyFocusedRef.current && inputRef.current) {
      inputRef.current.focus()
      hasInitiallyFocusedRef.current = true
    }
  }, [inputRef])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0 && handleDocumentUpload) {
        const files = Array.from(e.target.files)
        for (const file of files) {
          if (!isPremium && isImageFile(file)) {
            continue
          }
          handleDocumentUpload(file)
        }
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      }
    },
    [handleDocumentUpload, isPremium],
  )

  const triggerFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      mediaRecorderRef.current.stop()
    }
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current)
      recordingTimeoutRef.current = null
    }
    setIsRecording(false)
  }, [])

  const sendAudioForTranscription = useCallback(
    async (blob: Blob) => {
      try {
        setIsTranscribing(true)

        if (!audioModel) {
          throw new Error('No audio model available for transcription')
        }

        const client = await getTinfoilClient()
        const file = new File([blob], 'audio.webm', { type: 'audio/webm' })

        const transcription = await client.audio.transcriptions.create({
          file,
          model: audioModel,
          response_format: 'text',
        })

        const text =
          typeof transcription === 'string'
            ? transcription
            : (transcription as any).text

        if (text) {
          const currentInput = input.trim()
          const newText = text.trim()

          if (currentInput) {
            setInput(currentInput + ' ' + newText)
          } else {
            setInput(newText)
          }
          // Focus the textarea so the user can edit or send the transcription,
          // then explicitly resize after React commits the new value to the DOM.
          // The layout effect should handle this, but mobile Safari can report
          // stale scrollHeight for programmatic value changes.
          inputRef.current?.focus()
          requestAnimationFrame(() => {
            resizeTextarea(inputRef.current)
          })
        } else {
          throw new Error('No transcription text received')
        }
      } catch (err) {
        toast({
          title: 'Transcription Error',
          description:
            err instanceof Error ? err.message : 'Failed to transcribe audio',
          variant: 'destructive',
          position: 'top-left',
        })
      } finally {
        setIsTranscribing(false)
      }
    },
    [setInput, toast, input, audioModel, inputRef, resizeTextarea],
  )

  const isWebMAudioSupported = () => {
    return (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('audio/webm')
    )
  }

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      if (!isWebMAudioSupported()) {
        throw new Error('WebM audio recording is not supported in this browser')
      }

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
        audioBitsPerSecond: 128000,
      })
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        try {
          // Stop all tracks
          stream.getTracks().forEach((track) => track.stop())

          // Create WebM blob
          const webmBlob = new Blob(audioChunksRef.current, {
            type: 'audio/webm',
          })
          audioChunksRef.current = []

          if (webmBlob.size === 0) {
            throw new Error('No audio data recorded')
          }

          // Send WebM for transcription
          sendAudioForTranscription(webmBlob)
        } catch (err) {
          toast({
            title: 'Recording Error',
            description:
              err instanceof Error
                ? err.message
                : 'Failed to process audio recording.',
            variant: 'destructive',
            position: 'top-left',
          })
          setIsRecording(false)
          setIsTranscribing(false)
        }
      }

      mediaRecorder.start(1000)
      setIsRecording(true)

      // Auto-stop after configured timeout
      recordingTimeoutRef.current = setTimeout(() => {
        stopRecording()
      }, CONSTANTS.RECORDING_TIMEOUT_MS)
    } catch (err) {
      toast({
        title: 'Recording Error',
        description:
          err instanceof Error
            ? err.message
            : 'Could not start recording. Please make sure you have granted microphone permissions.',
        variant: 'destructive',
        position: 'top-left',
      })
    }
  }, [sendAudioForTranscription, stopRecording, toast])

  // Handle paste event for images and long text detection
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Check for pasted images in clipboard
      if (handleDocumentUpload) {
        const items = Array.from(e.clipboardData.items)
        const imageItem = items.find((item) => item.type.startsWith('image/'))

        if (imageItem) {
          if (!isPremium) {
            toast({
              title: 'Premium Required',
              description: 'Image upload requires a premium subscription.',
              variant: 'destructive',
              position: 'top-left',
            })
            e.preventDefault()
            return
          }

          const file = imageItem.getAsFile()
          if (file) {
            e.preventDefault()
            handleDocumentUpload(file).catch((error) => {
              logError('Failed to upload pasted image', error, {
                component: 'ChatInput',
                action: 'handlePaste',
                metadata: { fileName: file.name },
              })
            })
            return
          }
        }
      }

      const pastedText = e.clipboardData.getData('text')

      // Check if pasted text exceeds threshold
      if (
        pastedText.length > CONSTANTS.LONG_PASTE_THRESHOLD &&
        handleDocumentUpload
      ) {
        e.preventDefault() // Prevent the text from being pasted into the textarea

        // Create a .txt file from the pasted text
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, -5)
        const fileName = `pasted-text-${timestamp}.txt`
        const file = new File([pastedText], fileName, { type: 'text/plain' })

        // Upload the file through the existing document upload system
        handleDocumentUpload(file).catch((error) => {
          logError('Failed to upload pasted text as document', error, {
            component: 'ChatInput',
            action: 'handlePaste',
            metadata: {
              textLength: pastedText.length,
              fileName,
            },
          })
        })
      }
      // If text is short enough, let it paste normally (default behavior)
    },
    [handleDocumentUpload, isPremium, toast],
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        {/* Project tab - manila folder style, absolutely positioned */}
        {isProjectMode && activeProject && (
          <div className="pointer-events-none absolute right-8 top-px z-10 -translate-y-full">
            <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 border-border-subtle bg-surface-chat px-2.5 py-1">
              <FolderIcon className="h-3 w-3 text-content-secondary" />
              <span className="text-xs font-medium text-content-secondary">
                {activeProject.name}
              </span>
            </div>
          </div>
        )}
        {/* Prompt preset tab - shows the active prompt for this chat */}
        {activePromptPreset &&
          (() => {
            const ActivePresetIcon = activePromptPreset.Icon
            return (
              <div className="pointer-events-none absolute left-8 top-px z-10 -translate-y-full">
                <div className="pointer-events-auto inline-flex items-center gap-1 rounded-t-lg border border-b-0 border-border-subtle bg-surface-chat px-2.5 py-1 text-content-secondary">
                  <button
                    type="button"
                    onClick={onOpenPromptLibrary}
                    disabled={!onOpenPromptLibrary}
                    className="flex items-center gap-1.5 transition-colors hover:text-content-primary"
                    aria-label={`Change prompt (currently ${activePromptPreset.name})`}
                  >
                    <ActivePresetIcon className="h-3 w-3" />
                    <span className="text-xs font-medium">
                      {activePromptPreset.name}
                    </span>
                  </button>
                  {onClearPromptPreset && (
                    <button
                      type="button"
                      onClick={onClearPromptPreset}
                      aria-label="Stop using this prompt"
                      className="ml-0.5 rounded-full p-0.5 transition-colors hover:text-content-primary"
                    >
                      <XMarkIcon className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            )
          })()}
        <div
          className={cn(
            'rounded-3xl border bg-surface-chat px-3 py-3 shadow-md transition-colors md:rounded-4xl md:px-6 md:py-4',
            isTemporaryMode
              ? 'border-dashed border-content-muted'
              : 'border-border-subtle',
          )}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            multiple
            accept={
              isPremium
                ? '.pdf,.docx,.xlsx,.pptx,.md,.html,.xhtml,.csv,.png,.jpg,.jpeg,.tiff,.bmp,.webp,.txt,.py,.js,.jsx,.ts,.tsx,.css,.json,.xml,.yaml,.yml,.toml,.sh,.rb,.java,.cpp,.c,.h,.hpp,.go,.rs,.swift,.kt,.r,.sql,.lua,.pl,.php,.env,.ini,.cfg,.conf,.log,.rtf,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm,.wma,.qfx,.qif,.ofx,.ifs,.qbo,.qbx,.bai,.bai2,.mt940,.sta,.tsv,.ics,.vcf'
                : '.pdf,.docx,.xlsx,.pptx,.md,.html,.xhtml,.csv,.txt,.py,.js,.jsx,.ts,.tsx,.css,.json,.xml,.yaml,.yml,.toml,.sh,.rb,.java,.cpp,.c,.h,.hpp,.go,.rs,.swift,.kt,.r,.sql,.lua,.pl,.php,.env,.ini,.cfg,.conf,.log,.rtf,.qfx,.qif,.ofx,.ifs,.qbo,.qbx,.bai,.bai2,.mt940,.sta,.tsv,.ics,.vcf'
            }
          />

          {quote && (
            <div className="mb-3 mt-1 flex items-start gap-2 rounded-2xl border border-border-subtle bg-surface-chat-background px-3 py-2">
              <PiQuotes className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-secondary" />
              <p className="line-clamp-3 flex-1 whitespace-pre-wrap text-sm text-content-secondary">
                {quote.length > QUOTE_PREVIEW_MAX_LENGTH
                  ? `${quote.slice(0, QUOTE_PREVIEW_MAX_LENGTH).trimEnd()}…`
                  : quote}
              </p>
              {onClearQuote && (
                <button
                  type="button"
                  onClick={onClearQuote}
                  aria-label="Remove quote"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-3.5 w-3.5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              )}
            </div>
          )}

          <span
            ref={uploadStatusRef}
            className="sr-only"
            role="status"
            aria-live="polite"
          />

          {processedDocuments && processedDocuments.length > 0 && (
            <div
              ref={documentsScrollRef}
              className="-mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pt-2 md:-mx-6 md:px-6"
            >
              {processedDocuments.map((doc) => (
                <div
                  key={doc.id}
                  className={cn(
                    'group relative flex min-w-[200px] max-w-[300px] flex-shrink-0 flex-col rounded-2xl border p-3 shadow-sm transition-colors',
                    doc.isUnsupported
                      ? 'border-red-400/50 bg-red-950/30'
                      : 'border-border-subtle bg-surface-chat-background',
                  )}
                >
                  {removeDocument && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeDocument(doc.id)
                      }}
                      className={cn(
                        'absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border-[0.5px] border-white',
                        'bg-surface-chat text-content-secondary shadow-sm hover:bg-surface-chat-background hover:text-content-primary',
                      )}
                      aria-label={`Remove ${doc.name}`}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-3 w-3"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  )}
                  <div className="flex items-center gap-2">
                    {doc.attachment?.type === 'image' || doc.imageData ? (
                      <div className="relative h-9 w-9 flex-shrink-0 overflow-hidden rounded-md border border-border-subtle bg-surface-card">
                        <img
                          src={`data:${doc.attachment?.mimeType ?? doc.imageData?.mimeType};base64,${doc.attachment?.thumbnailBase64 ?? doc.attachment?.base64 ?? doc.imageData?.base64}`}
                          alt={doc.name}
                          className="h-full w-full object-cover"
                        />
                        {(doc.isUploading || doc.isGeneratingDescription) && (
                          <div className="absolute inset-0 flex items-center justify-center bg-surface-chat/70">
                            <PiSpinner className="h-3.5 w-3.5 animate-spin text-content-primary" />
                          </div>
                        )}
                      </div>
                    ) : doc.isUploading ? (
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center">
                        <PiSpinner className="h-5 w-5 animate-spin text-content-secondary" />
                      </div>
                    ) : (
                      <MacFileIcon
                        filename={doc.name}
                        size={18}
                        isDarkMode={isDarkMode}
                        compact
                      />
                    )}
                    <div className="flex min-w-0 flex-col">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          doc.isUnsupported
                            ? 'text-red-400'
                            : 'text-content-primary',
                        )}
                      >
                        {doc.name}
                      </span>
                      {doc.isUnsupported ? (
                        <span className="text-xs font-medium text-red-400">
                          Unsupported format
                        </span>
                      ) : (
                        !doc.isUploading && (
                          <span className="text-xs text-content-muted">
                            {doc.isGeneratingDescription
                              ? 'Generating text description...'
                              : doc.attachment?.type === 'image' ||
                                  doc.imageData
                                ? 'Image'
                                : 'Document'}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <textarea
            id="chat-input"
            aria-label={t('input.messageAria')}
            ref={inputRef}
            key={textareaResetNonce}
            value={input}
            onFocus={handleInputFocus}
            onChange={(e) => {
              setInput(e.target.value)
              resizeTextarea(e.currentTarget)
            }}
            onInput={(e) => {
              // Some mobile Safari builds update `scrollHeight` more reliably on `input`.
              resizeTextarea(e.currentTarget as HTMLTextAreaElement)
            }}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                const textarea = e.currentTarget
                const cursorPosition = textarea.selectionStart
                const textBeforeCursor = input.slice(0, cursorPosition)
                const lastLineStart = textBeforeCursor.lastIndexOf('\n') + 1
                const currentLine = textBeforeCursor.slice(lastLineStart)

                // Check if we're on a list line
                const listMatch = currentLine.match(
                  /^(\s*)(\s*\u2022\s+|[-*+]|\s*\d+\.)\s+(?!\[[ x]\])/,
                )

                if (listMatch) {
                  e.preventDefault()
                  const textAfterCursor = input.slice(cursorPosition)

                  if (e.shiftKey) {
                    // Shift+Tab: decrease indent (remove 4 spaces or exit list)
                    const dedentMatch = currentLine.match(/^    /)
                    if (dedentMatch) {
                      // Has 4+ spaces, remove 4 spaces
                      const newText =
                        input.slice(0, lastLineStart) +
                        currentLine.slice(4) +
                        textAfterCursor

                      setInput(newText)

                      setTimeout(() => {
                        textarea.selectionStart = textarea.selectionEnd =
                          Math.max(lastLineStart, cursorPosition - 4)
                      }, 0)
                    } else {
                      // Single indent level - remove the bullet/marker entirely
                      const contentMatch = currentLine.match(
                        /^(\s*)(\s*\u2022\s+|[-*+]|\s*\d+\.)\s+(.*)$/,
                      )
                      if (contentMatch) {
                        const [, , , content] = contentMatch
                        const newText =
                          input.slice(0, lastLineStart) +
                          content +
                          textAfterCursor

                        setInput(newText)

                        setTimeout(() => {
                          textarea.selectionStart = textarea.selectionEnd =
                            lastLineStart + content.length
                        }, 0)
                      }
                    }
                  } else {
                    // Tab: increase indent (add 4 spaces)
                    const newText =
                      input.slice(0, lastLineStart) +
                      '    ' +
                      currentLine +
                      textAfterCursor

                    setInput(newText)

                    setTimeout(() => {
                      textarea.selectionStart = textarea.selectionEnd =
                        cursorPosition + 4
                    }, 0)
                  }
                }
              } else if (e.key === ' ') {
                const textarea = e.currentTarget
                const cursorPosition = textarea.selectionStart
                const textBeforeCursor = input.slice(0, cursorPosition)
                const lastLineStart = textBeforeCursor.lastIndexOf('\n') + 1
                const currentLine = textBeforeCursor.slice(lastLineStart)

                // Check if the line starts with * or - or + (for bullets)
                const bulletMatch = currentLine.match(/^(\s*)([-*+])$/)

                if (bulletMatch) {
                  e.preventDefault()
                  const [, indent] = bulletMatch
                  const textAfterCursor = input.slice(cursorPosition)

                  // Replace the marker with a bullet point and add space with indentation
                  // Extra space after bullet to align with numbered lists
                  const newText =
                    input.slice(0, lastLineStart) +
                    indent +
                    '  \u2022  ' +
                    textAfterCursor

                  setInput(newText)

                  setTimeout(() => {
                    textarea.selectionStart = textarea.selectionEnd =
                      lastLineStart + indent.length + 5
                  }, 0)
                } else {
                  // Check if the line starts with a number (for numbered lists)
                  const numberMatch = currentLine.match(/^(\s*)(\d+\.)$/)

                  if (numberMatch) {
                    e.preventDefault()
                    const [, indent, marker] = numberMatch
                    const textAfterCursor = input.slice(cursorPosition)

                    // Just add a space after the number marker (no extra indentation)
                    const newText =
                      input.slice(0, lastLineStart) +
                      indent +
                      marker +
                      ' ' +
                      textAfterCursor

                    setInput(newText)

                    setTimeout(() => {
                      textarea.selectionStart = textarea.selectionEnd =
                        lastLineStart + indent.length + marker.length + 1
                    }, 0)
                  }
                }
              } else if (e.key === 'Enter' && !e.shiftKey) {
                // On mobile, Enter should insert a newline, not submit
                const isMobile = /iPhone|iPad|iPod|Android/i.test(
                  navigator.userAgent,
                )
                if (isMobile) {
                  return
                }
                e.preventDefault()
                const hasDocuments =
                  processedDocuments &&
                  processedDocuments.some((doc) => isDocumentSubmittable(doc))
                const hasInput = input.trim().length > 0
                const hasQuote = Boolean(quote)
                if (!isTranscribing && (hasInput || hasDocuments || hasQuote)) {
                  shouldRemountOnClearRef.current = true
                  handleSubmit(e)
                }
              } else if (e.key === 'Enter' && e.shiftKey) {
                const textarea = e.currentTarget
                const cursorPosition = textarea.selectionStart
                const textBeforeCursor = input.slice(0, cursorPosition)
                const lastLineStart = textBeforeCursor.lastIndexOf('\n') + 1
                const currentLine = textBeforeCursor.slice(lastLineStart)

                // Match list markers: •, -, *, +, 1.
                const listMarkerMatch = currentLine.match(
                  /^(\s*)(\s*\u2022\s+|[-*+]|\s*\d+\.)\s+/,
                )

                if (!listMarkerMatch) {
                  setTimeout(() => {
                    textarea.style.height = 'auto'
                    const max = 240
                    const raw = textarea.scrollHeight
                    const min = Number.parseInt(inputMinHeight, 10) || 0
                    const next = Math.max(min, Math.min(raw, max))
                    textarea.style.height = `${next}px`
                    textarea.scrollTop = textarea.scrollHeight
                  }, 0)
                } else {
                  e.preventDefault()
                  const [fullMatch, indent, marker] = listMarkerMatch

                  const contentAfterMarker = currentLine
                    .slice(fullMatch.length)
                    .trim()

                  if (!contentAfterMarker) {
                    // Empty list item - exit the list
                    const textAfterCursor = input.slice(cursorPosition)
                    const newText =
                      input.slice(0, lastLineStart) + indent + textAfterCursor

                    setInput(newText)

                    setTimeout(() => {
                      textarea.selectionStart = textarea.selectionEnd =
                        lastLineStart + indent.length
                    }, 0)
                  } else {
                    // Continue the list
                    const textAfterCursor = input.slice(cursorPosition)
                    let newMarker = marker

                    // Increment numbered lists (handle with or without leading spaces)
                    const numberMatch = marker.match(/^(\s*)(\d+\.)$/)
                    if (numberMatch) {
                      const [, markerIndent, number] = numberMatch
                      const currentNumber = parseInt(number)
                      newMarker = `${markerIndent}${currentNumber + 1}.`
                    }

                    const newText =
                      textBeforeCursor +
                      '\n' +
                      indent +
                      newMarker +
                      ' ' +
                      textAfterCursor

                    setInput(newText)

                    const newCursorPos =
                      cursorPosition + 1 + indent.length + newMarker.length + 1

                    setTimeout(() => {
                      textarea.style.height = 'auto'
                      const max = 240
                      const raw = textarea.scrollHeight
                      const min = Number.parseInt(inputMinHeight, 10) || 0
                      const next = Math.max(min, Math.min(raw, max))
                      textarea.style.height = `${next}px`
                      textarea.selectionStart = textarea.selectionEnd =
                        newCursorPos
                      textarea.scrollTop = textarea.scrollHeight
                    }, 0)
                  }
                }
              } else if (e.key === 'Escape' && loadingState === 'loading') {
                e.preventDefault()
                cancelGeneration()
              }
            }}
            placeholder={
              hasMessages
                ? t('input.replyPlaceholder')
                : t(`input.placeholders.${placeholderKey}`)
            }
            rows={1}
            className={cn(
              'w-full resize-none bg-transparent text-lg leading-relaxed text-content-primary placeholder:text-content-muted focus:outline-none',
              CHAT_FONT_CLASSES[chatFont],
            )}
            style={{
              minHeight: inputMinHeight,
              maxHeight: '240px',
            }}
          />

          <div className="mt-3 flex items-center justify-between">
            <span className="sr-only" role="status" aria-live="polite">
              {audioStatus}
            </span>
            <div className="flex items-center gap-1">
              {/* Mobile: + button with dropdown menu */}
              <div className="relative md:hidden">
                <button
                  type="button"
                  onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                  aria-label="Attachment options"
                  aria-expanded={isMobileMenuOpen}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
                >
                  <PiPlusLight className="h-5 w-5" />
                </button>
                {isMobileMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setIsMobileMenuOpen(false)}
                    />
                    <div className="absolute bottom-full left-0 z-20 mb-2 min-w-[180px] rounded-xl border border-border-subtle bg-surface-chat py-1.5 shadow-lg">
                      <button
                        type="button"
                        onClick={() => {
                          triggerFileInput()
                          setIsMobileMenuOpen(false)
                        }}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                      >
                        <PiPaperclipLight className="h-5 w-5 text-content-secondary" />
                        Add files or photos
                      </button>
                      {onWebSearchToggle && (
                        <button
                          type="button"
                          onClick={() => {
                            onWebSearchToggle()
                            setIsMobileMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                        >
                          <PiGlobe className="h-5 w-5 text-content-secondary" />
                          <span className="flex-1">Web search</span>
                          {webSearchEnabled && (
                            <svg
                              className="h-4 w-4 text-brand-accent-light"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          )}
                        </button>
                      )}
                      {onCodeExecutionToggle && (
                        <button
                          type="button"
                          onClick={() => {
                            onCodeExecutionToggle()
                            setIsMobileMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                        >
                          <PiTerminalWindow className="h-5 w-5 text-content-secondary" />
                          <span className="flex-1">Code execution</span>
                          {codeExecutionEnabled && (
                            <svg
                              className="h-4 w-4 text-brand-accent-light"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Desktop: Original buttons */}
              <div className="group relative hidden md:block">
                <button
                  id="upload-button"
                  type="button"
                  onClick={triggerFileInput}
                  aria-label="Upload document"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
                >
                  <PiPaperclipLight className="h-5 w-5" />
                </button>
                <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  Upload document
                </span>
              </div>
              {onWebSearchToggle && (
                <div className="group relative hidden md:block">
                  <button
                    id="web-search-button"
                    type="button"
                    onClick={onWebSearchToggle}
                    aria-label="Web search"
                    aria-pressed={webSearchEnabled}
                    className={cn(
                      'flex h-7 items-center justify-center gap-1.5 rounded-lg transition-colors',
                      webSearchEnabled
                        ? cn(
                            'px-2',
                            isDarkMode
                              ? 'bg-brand-accent-light/20 text-brand-accent-light'
                              : 'bg-brand-accent-dark/20 text-brand-accent-dark',
                          )
                        : 'w-7 text-content-secondary hover:bg-surface-chat-background hover:text-content-primary',
                    )}
                  >
                    {webSearchEnabled ? (
                      <PiGlobe className="h-5 w-5" />
                    ) : (
                      <PiGlobeX className="h-5 w-5" />
                    )}
                    {webSearchEnabled && (
                      <span className="text-xs font-medium leading-none">
                        Web Search
                      </span>
                    )}
                  </button>
                  {!webSearchEnabled && (
                    <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                      Web search
                    </span>
                  )}
                </div>
              )}
              {onCodeExecutionToggle && (
                <div className="group relative hidden md:block">
                  <button
                    type="button"
                    onClick={onCodeExecutionToggle}
                    aria-label="Code execution"
                    aria-pressed={codeExecutionEnabled}
                    className={cn(
                      'flex h-7 items-center justify-center gap-1.5 rounded-lg transition-colors',
                      codeExecutionEnabled
                        ? cn(
                            'px-2',
                            isDarkMode
                              ? 'bg-brand-accent-light/20 text-brand-accent-light'
                              : 'bg-brand-accent-dark/20 text-brand-accent-dark',
                          )
                        : 'w-7 text-content-secondary hover:bg-surface-chat-background hover:text-content-primary',
                    )}
                  >
                    <PiTerminalWindow className="h-5 w-5" />
                    {codeExecutionEnabled && (
                      <span className="text-xs font-medium leading-none">
                        Code
                      </span>
                    )}
                  </button>
                  {!codeExecutionEnabled && (
                    <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                      Code execution
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {modelSelectorButton && <div>{modelSelectorButton}</div>}
              {reasoningSelectorButton && <div>{reasoningSelectorButton}</div>}
              {isPremium && audioModel && (
                <button
                  type="button"
                  onClick={isRecording ? stopRecording : startRecording}
                  className={cn(
                    'disabled:opacity-50',
                    isRecording
                      ? 'flex h-10 w-10 animate-pulse items-center justify-center rounded-full bg-red-500 text-white md:h-8 md:w-8'
                      : 'rounded-lg bg-transparent p-2.5 text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary md:p-1.5',
                  )}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                  title={recordingButtonLabel}
                  aria-label={recordingButtonLabel}
                  disabled={isTranscribing}
                >
                  {isRecording ? (
                    <StopIcon
                      className="h-6 w-6 md:h-5 md:w-5"
                      aria-hidden="true"
                    />
                  ) : isTranscribing ? (
                    <PiSpinner
                      className="h-6 w-6 animate-spin text-current md:h-5 md:w-5"
                      aria-hidden="true"
                    />
                  ) : (
                    <MicrophoneIcon
                      className="h-6 w-6 md:h-5 md:w-5"
                      aria-hidden="true"
                    />
                  )}
                </button>
              )}
              {(() => {
                const isBusy =
                  loadingState === 'loading' || loadingState === 'retrying'
                const hasCompletedDocuments = Boolean(
                  processedDocuments &&
                  processedDocuments.some((doc) => isDocumentSubmittable(doc)),
                )
                const hasSubmittableContent =
                  Boolean(input.trim()) ||
                  Boolean(quote) ||
                  hasCompletedDocuments
                const showStopAction = isBusy && !hasSubmittableContent

                return (
                  <button
                    id="send-button"
                    type="button"
                    onClick={(e) => {
                      if (showStopAction) {
                        e.preventDefault()
                        cancelGeneration()
                      } else {
                        shouldRemountOnClearRef.current = true
                        handleSubmit(e)
                        // On iOS Safari, forcing blur here can lead to a "dead" touch region
                        // after the keyboard dismisses. Keep focus on mobile; desktop can blur.
                        const isMobile =
                          typeof navigator !== 'undefined' &&
                          /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
                        if (!isMobile) {
                          inputRef.current?.blur()
                        }
                      }
                    }}
                    className="group ml-2 flex h-10 w-10 items-center justify-center rounded-full bg-button-send-background text-button-send-foreground transition-colors hover:bg-button-send-background/80 disabled:opacity-50 md:h-8 md:w-8"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                    disabled={
                      showStopAction
                        ? false
                        : isTranscribing || !hasSubmittableContent
                    }
                    aria-label={
                      showStopAction ? t('input.stop') : t('input.send')
                    }
                  >
                    {showStopAction ? (
                      <div className="h-3.5 w-3.5 bg-button-send-foreground/80 transition-colors md:h-3 md:w-3" />
                    ) : (
                      <FiArrowUp className="h-6 w-6 text-button-send-foreground transition-colors md:h-5 md:w-5" />
                    )}
                  </button>
                )
              })()}
            </div>
          </div>
        </div>
      </div>

      {hasMessages && (
        <div className="text-center">
          <p className="text-xs text-content-muted">
            AI can make mistakes. Verify important information.
          </p>
        </div>
      )}
    </div>
  )
}
