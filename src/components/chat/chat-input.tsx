import { FiArrowUp } from '@/components/icons/lazy-icons'
import { useProject } from '@/components/project'
import { cn } from '@/components/ui/utils'
import { getProjectColor } from '@/constants/project-colors'
import { useToast } from '@/hooks/use-toast'
import { getTinfoilClient } from '@/services/inference/tinfoil-client'
import { logError } from '@/utils/error-handling'
import {
  FolderIcon,
  MicrophoneIcon,
  Squares2X2Icon,
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
import {
  PiGlobe,
  PiGlobeX,
  PiPaperclipLight,
  PiPlusLight,
  PiQuotes,
  PiSpinner,
  PiTerminalWindow,
} from 'react-icons/pi'
import {
  ContextUsageIndicator,
  type ContextUsage,
} from './components/context-usage-indicator'
import { FilePreview, imageDataUrl } from './components/file-preview'
import { CONSTANTS } from './constants'
import { useEnterToNewline } from './hooks/use-enter-to-newline'
import { isImeComposition } from './keyboard-utils'
import type { PromptPreset } from './prompts/types'
import { RecordingWaveform } from './recording-waveform'
import type { ProcessedDocument } from './renderers/types'
import type { LoadingState } from './types'

function MenuCheckmark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  )
}

// Tracks every mounted textarea per shared external ref so an unmounting
// instance can hand the shared ref over to a surviving instance.
const sharedTextareaRegistries = new WeakMap<object, Set<HTMLTextAreaElement>>()

function getSharedTextareaRegistry(ref: object): Set<HTMLTextAreaElement> {
  let registry = sharedTextareaRegistries.get(ref)
  if (!registry) {
    registry = new Set()
    sharedTextareaRegistries.set(ref, registry)
  }
  return registry
}

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
  contextUsage?: ContextUsage
  mobileHeader?: React.ReactNode
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
  contextUsage,
  mobileHeader,
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const documentsScrollRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  const { isProjectMode, activeProject } = useProject()
  const enterToNewline = useEnterToNewline()
  const [textareaResetNonce, setTextareaResetNonce] = useState(0)
  const prevInputValueRef = useRef(input)
  const shouldRemountOnClearRef = useRef(false)
  const hasInitiallyFocusedRef = useRef(false)
  const refocusAfterResetRef = useRef(false)

  // Several ChatInput instances can be mounted at once (e.g. the centered
  // welcome-screen input and the bottom input) while sharing one external
  // `inputRef`, so the shared ref may point at another instance's textarea.
  // Keep a private ref to this instance's own element and use it for all
  // local reads and writes (resize, focus, blur).
  const ownTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const attachTextareaRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      const registered = getSharedTextareaRegistry(inputRef)
      if (el) {
        ownTextareaRef.current = el
        registered.add(el)
        ;(
          inputRef as React.MutableRefObject<HTMLTextAreaElement | null>
        ).current = el
      } else {
        if (ownTextareaRef.current) {
          registered.delete(ownTextareaRef.current)
        }
        if (inputRef.current === ownTextareaRef.current) {
          // Hand the shared ref back to another still-mounted instance (e.g.
          // the welcome-screen input after the bottom input unmounts) so
          // focus actions keep working.
          const remaining = [...registered].pop() ?? null
          ;(
            inputRef as React.MutableRefObject<HTMLTextAreaElement | null>
          ).current = remaining
        }
        ownTextareaRef.current = null
      }
    },
    [inputRef],
  )

  const useIsomorphicLayoutEffect =
    typeof window !== 'undefined' ? useLayoutEffect : useEffect

  const resizeTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return

      const min = Number.parseInt(inputMinHeight, 10) || 0
      // Cap the textarea to the visual viewport (which shrinks when the
      // on-screen keyboard opens) so the toolbar row with the send button
      // always stays visible below it. Measure everything else rendered in
      // the input area (toolbar, paddings, suggestion chips, banners,
      // attachment previews) so the cap adapts to what is actually shown,
      // e.g. the extra suggestions row on the initial query screen.
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const inputArea = el.closest('[data-chat-input-area]')
      const chromeHeight = inputArea
        ? inputArea.getBoundingClientRect().height -
          el.getBoundingClientRect().height
        : CONSTANTS.INPUT_VIEWPORT_RESERVED_PX
      const available = Math.min(
        CONSTANTS.INPUT_MAX_HEIGHT_PX,
        viewportHeight - chromeHeight - CONSTANTS.INPUT_VIEWPORT_TOP_GAP_PX,
      )
      // Snap the cap to a whole number of text lines so scrolled-out content
      // is clipped flush at a line boundary instead of mid-line.
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight)
      const max =
        Number.isFinite(lineHeight) && lineHeight > 0
          ? Math.max(Math.floor(available / lineHeight), 1) * lineHeight
          : available

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

  // Coalesce resize requests to at most one layout read/write per frame.
  // Typing fires several resize triggers per keystroke (input event, value
  // change, viewport changes); collapsing them into a single rAF avoids the
  // repeated forced reflows that dominated the typing CPU profile.
  const resizeRafRef = useRef<number | null>(null)
  const pendingResizeElRef = useRef<HTMLTextAreaElement | null>(null)
  const scheduleResize = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return
      pendingResizeElRef.current = el
      if (resizeRafRef.current !== null) return
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null
        resizeTextarea(pendingResizeElRef.current)
      })
    },
    [resizeTextarea],
  )

  useEffect(() => {
    return () => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current)
        // Clear the id so a later remount (e.g. React Strict Mode's
        // simulated unmount/remount) can schedule again instead of seeing a
        // stale, already-cancelled frame and short-circuiting forever.
        resizeRafRef.current = null
      }
    }
  }, [])

  // If the input transitions from non-empty -> empty (send/clear), remount the
  // textarea to guarantee any stuck inline height is dropped on mobile Safari.
  useEffect(() => {
    const prev = prevInputValueRef.current
    if (prev !== '' && input === '' && shouldRemountOnClearRef.current) {
      refocusAfterResetRef.current =
        typeof document !== 'undefined' &&
        ownTextareaRef.current !== null &&
        document.activeElement === ownTextareaRef.current
      setTextareaResetNonce((n) => n + 1)
    }
    prevInputValueRef.current = input
    if (input === '') {
      shouldRemountOnClearRef.current = false
    }
  }, [input])

  useEffect(() => {
    if (refocusAfterResetRef.current && ownTextareaRef.current) {
      ownTextareaRef.current.focus()
      refocusAfterResetRef.current = false
    }
  }, [textareaResetNonce])

  // --- Speech-to-text state ---
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  // Mirrors mediaStreamRef in state so the live waveform re-renders with the
  // active stream while recording.
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(
    null,
  )
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recordingSessionRef = useRef(0)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const recordingSession = recordingSessionRef
    return () => {
      recordingSession.current++
      if (recordingTimeoutRef.current) {
        clearTimeout(recordingTimeoutRef.current)
        recordingTimeoutRef.current = null
      }
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onstop = null
        if (recorder.state !== 'inactive') recorder.stop()
        mediaRecorderRef.current = null
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
      audioChunksRef.current = []
    }
  }, [])

  // --- Input options menu state (the "+" button) ---
  const [isInputMenuOpen, setIsInputMenuOpen] = useState(false)
  const inputMenuRef = useRef<HTMLDivElement>(null)
  const inputMenuTriggerRef = useRef<HTMLButtonElement>(null)

  const getInputMenuItems = (): HTMLElement[] =>
    Array.from(
      inputMenuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ) ?? [],
    )

  // ARIA menu keyboard contract: focus moves into the menu on open,
  // Escape dismisses and restores focus to the trigger, and arrow keys
  // move between items (wrapping). Tab closes rather than tabbing through.
  useEffect(() => {
    if (isInputMenuOpen) {
      getInputMenuItems()[0]?.focus()
    }
  }, [isInputMenuOpen])

  const closeInputMenu = (restoreFocus: boolean) => {
    setIsInputMenuOpen(false)
    if (restoreFocus) {
      inputMenuTriggerRef.current?.focus()
    }
  }

  const handleInputMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeInputMenu(true)
      return
    }
    if (e.key === 'Tab') {
      closeInputMenu(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = getInputMenuItems()
      if (items.length === 0) return
      const currentIndex = items.indexOf(document.activeElement as HTMLElement)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const nextIndex =
        currentIndex === -1
          ? delta === 1
            ? 0
            : items.length - 1
          : (currentIndex + delta + items.length) % items.length
      items[nextIndex]?.focus()
    }
  }

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
    // Synchronous pass before paint avoids a visible height jump.
    resizeTextarea(ownTextareaRef.current)

    // iOS Safari can report the previous scrollHeight on the same tick; re-check
    // on the next frame (coalesced with any other pending resize) to ensure
    // growth kicks in.
    scheduleResize(ownTextareaRef.current)
    // Include `textareaResetNonce` so a remount recalculates height immediately.
    // Include `isRecording` because the textarea is hidden while recording and
    // measures as zero height, so it must be re-measured once it reappears.
  }, [input, resizeTextarea, scheduleResize, textareaResetNonce, isRecording])

  // Recompute the height cap when the visual viewport changes (e.g. the
  // on-screen keyboard opens or closes) so long text never pushes the send
  // button out of view.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const onViewportResize = () => scheduleResize(ownTextareaRef.current)
    vv.addEventListener('resize', onViewportResize)
    return () => vv.removeEventListener('resize', onViewportResize)
  }, [scheduleResize])

  // Focus textarea on initial mount only (not on remounts after sending)
  useEffect(() => {
    if (!hasInitiallyFocusedRef.current && ownTextareaRef.current) {
      ownTextareaRef.current.focus()
      hasInitiallyFocusedRef.current = true
    }
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0 && handleDocumentUpload) {
        const files = Array.from(e.target.files)
        for (const file of files) {
          handleDocumentUpload(file)
        }
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      }
    },
    [handleDocumentUpload],
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
    setRecordingStream(null)
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
          ownTextareaRef.current?.focus()
          requestAnimationFrame(() => {
            resizeTextarea(ownTextareaRef.current)
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
          position: 'top-right',
        })
      } finally {
        setIsTranscribing(false)
      }
    },
    [setInput, toast, input, audioModel, resizeTextarea],
  )

  const isWebMAudioSupported = () => {
    return (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('audio/webm')
    )
  }

  const startRecording = useCallback(async () => {
    const recordingSession = ++recordingSessionRef.current
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      if (recordingSession !== recordingSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      mediaStreamRef.current = stream

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
        // The recorder can stop on its own (e.g. the microphone track ends),
        // so recording state is cleared here rather than only in stopRecording.
        setIsRecording(false)
        setRecordingStream(null)
        try {
          // Stop all tracks
          stream?.getTracks().forEach((track) => track.stop())
          if (mediaStreamRef.current === stream) mediaStreamRef.current = null

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
            position: 'top-right',
          })
          setIsTranscribing(false)
        }
      }

      mediaRecorder.start(1000)
      setIsRecording(true)
      setRecordingStream(stream)

      // Auto-stop after configured timeout
      recordingTimeoutRef.current = setTimeout(() => {
        stopRecording()
      }, CONSTANTS.RECORDING_TIMEOUT_MS)
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop())
      if (mediaStreamRef.current === stream) mediaStreamRef.current = null
      if (recordingSession !== recordingSessionRef.current) return
      toast({
        title: 'Recording Error',
        description:
          err instanceof Error
            ? err.message
            : 'Could not start recording. Please make sure you have granted microphone permissions.',
        variant: 'destructive',
        position: 'top-right',
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
    [handleDocumentUpload],
  )

  // Once a conversation is underway the composer collapses into a single row
  // with the controls flanking the textarea; the welcome screen keeps the
  // taller two-row layout.
  const isCompact = Boolean(hasMessages)

  return (
    <div className="flex flex-col gap-2">
      {hasMessages && modelSelectorButton && (
        <div className="flex items-center self-end px-3 md:hidden">
          {modelSelectorButton}
        </div>
      )}
      <div className="relative">
        {mobileHeader}
        <div
          className={cn(
            // relative anchors the folder-style tabs below to the card itself.
            'relative rounded-3xl border bg-white px-3 py-3 shadow-md transition-colors dark:bg-surface-chat md:rounded-4xl md:px-6 md:py-4',
            isCompact && 'md:px-4 md:py-3',
            isTemporaryMode
              ? 'border-dashed border-content-muted'
              : 'border-border-subtle',
          )}
        >
          {/* Project tab - manila folder style, absolutely positioned */}
          {isProjectMode &&
            activeProject &&
            (() => {
              const projectColor = getProjectColor(activeProject.color)
              const colorStyle = projectColor
                ? {
                    borderColor: projectColor.hex,
                    backgroundColor: projectColor.hex,
                  }
                : undefined
              return (
                <div className="pointer-events-none absolute right-8 top-px z-10 hidden -translate-y-full md:block">
                  <div
                    className={cn(
                      'pointer-events-auto inline-flex items-center gap-1.5 rounded-t-site-tab border border-b-0 px-2.5 py-1',
                      projectColor
                        ? 'text-gray-900'
                        : 'border-border-subtle bg-surface-chat text-content-secondary',
                    )}
                    style={colorStyle}
                  >
                    <FolderIcon className="h-3 w-3" />
                    <span className="text-xs font-medium">
                      {activeProject.name}
                    </span>
                  </div>
                </div>
              )
            })()}
          {/* Prompt preset tab - shows the active prompt for this chat */}
          {activePromptPreset &&
            (() => {
              const ActivePresetIcon = activePromptPreset.Icon
              return (
                <div className="pointer-events-none absolute left-8 top-px z-10 -translate-y-full">
                  <div className="pointer-events-auto inline-flex items-center gap-1 rounded-t-3xl border border-b-0 border-border-subtle bg-surface-chat px-2.5 py-1 text-content-secondary">
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
          {/* No accept filter: unknown extensions are sniffed for text
              content and rejected gracefully after selection instead of
              being blocked by the picker. */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            multiple
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
              className="mb-3 flex gap-2 overflow-x-auto pt-2"
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
                      type="button"
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
                    <FilePreview
                      filename={doc.name}
                      imageSrc={
                        doc.attachment?.type === 'image' || doc.imageData
                          ? imageDataUrl(
                              doc.attachment?.thumbnailBase64 ??
                                doc.attachment?.base64 ??
                                doc.imageData?.base64,
                              doc.attachment?.mimeType ??
                                doc.imageData?.mimeType,
                            )
                          : null
                      }
                      textContent={doc.attachment?.textContent ?? doc.content}
                      isBusy={Boolean(
                        doc.isUploading || doc.isGeneratingDescription,
                      )}
                    />
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

          {/* In compact mode the toolbar below uses display: contents so its
              button groups become flex siblings of the textarea and can be
              ordered around it. */}
          <div className={cn(isCompact && 'flex items-end gap-2')}>
            {/* The button groups are sized to the send button so a one-line
                textarea centers against them; when it grows they stay pinned
                to the bottom via items-end. */}
            {/* While recording, the textarea stays mounted (so its ref, height
                and focus handling survive) but is hidden behind the live
                waveform, which occupies the same slot. */}
            {isRecording && recordingStream && (
              <RecordingWaveform
                stream={recordingStream}
                className={cn(
                  'w-full',
                  isCompact && 'min-w-0 flex-1 self-center',
                )}
                style={{ minHeight: inputMinHeight }}
              />
            )}
            <textarea
              id="chat-input"
              aria-label="Message"
              ref={attachTextareaRef}
              key={textareaResetNonce}
              value={input}
              onFocus={handleInputFocus}
              onChange={(e) => {
                // Resize is driven by the layout effect on the resulting value
                // change; avoid an extra synchronous reflow here.
                setInput(e.target.value)
              }}
              onInput={(e) => {
                // Some mobile Safari builds update `scrollHeight` more reliably on
                // `input`; schedule a coalesced resize rather than reflowing now.
                scheduleResize(e.currentTarget as HTMLTextAreaElement)
              }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                // Enter during IME composition only confirms the conversion;
                // it must not send the message or edit the list structure.
                if (e.key === 'Enter' && isImeComposition(e)) {
                  return
                }
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
                } else if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  (!enterToNewline || e.metaKey || e.ctrlKey)
                ) {
                  // On mobile, Enter should insert a newline, not submit
                  const isMobile = /iPhone|iPad|iPod|Android/i.test(
                    navigator.userAgent,
                  )
                  if (isMobile && !e.metaKey && !e.ctrlKey) {
                    return
                  }
                  e.preventDefault()
                  const hasDocuments =
                    processedDocuments &&
                    processedDocuments.some((doc) => isDocumentSubmittable(doc))
                  const hasInput = input.trim().length > 0
                  const hasQuote = Boolean(quote)
                  if (
                    !isTranscribing &&
                    (hasInput || hasDocuments || hasQuote)
                  ) {
                    shouldRemountOnClearRef.current = true
                    handleSubmit(e)
                  }
                } else if (e.key === 'Enter') {
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
                      resizeTextarea(textarea)
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
                        cursorPosition +
                        1 +
                        indent.length +
                        newMarker.length +
                        1

                      setTimeout(() => {
                        resizeTextarea(textarea)
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
                  ? CONSTANTS.REPLY_PLACEHOLDER
                  : CONSTANTS.INPUT_PLACEHOLDER
              }
              rows={1}
              className={cn(
                'w-full resize-none bg-transparent font-chat text-lg leading-relaxed text-content-primary placeholder:text-content-muted focus:outline-none',
                isCompact && 'min-w-0 flex-1 self-center',
                isRecording && recordingStream && 'hidden',
              )}
              style={{
                minHeight: inputMinHeight,
                maxHeight: `${CONSTANTS.INPUT_MAX_HEIGHT_PX}px`,
              }}
            />

            <div
              className={cn(
                isCompact
                  ? 'contents'
                  : 'mt-3 flex items-center justify-between',
              )}
            >
              <span className="sr-only" role="status" aria-live="polite">
                {audioStatus}
              </span>
              <div
                className={cn(
                  'flex items-center gap-1',
                  isCompact && 'order-first h-10 md:h-8',
                )}
              >
                {/* Unified + button opening the input options menu */}
                <div className="relative">
                  <button
                    id="input-options-button"
                    ref={inputMenuTriggerRef}
                    type="button"
                    onClick={() => setIsInputMenuOpen(!isInputMenuOpen)}
                    aria-label="Input options"
                    aria-expanded={isInputMenuOpen}
                    aria-haspopup="menu"
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
                  >
                    <PiPlusLight className="h-5 w-5" />
                  </button>
                  {isInputMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => closeInputMenu(false)}
                      />
                      <div
                        ref={inputMenuRef}
                        role="menu"
                        aria-label="Input options"
                        onKeyDown={handleInputMenuKeyDown}
                        className="absolute bottom-full left-0 z-20 mb-2 min-w-[220px] rounded-xl border border-border-subtle bg-surface-chat py-1.5 shadow-lg"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            triggerFileInput()
                            closeInputMenu(true)
                          }}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                        >
                          <PiPaperclipLight className="h-5 w-5 text-content-secondary" />
                          Add files or photos
                        </button>
                        {onOpenPromptLibrary && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onOpenPromptLibrary()
                              closeInputMenu(true)
                            }}
                            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                          >
                            <Squares2X2Icon className="h-5 w-5 text-content-secondary" />
                            Change system prompt
                          </button>
                        )}
                        {(onWebSearchToggle || onCodeExecutionToggle) && (
                          <div className="my-1.5 border-t border-border-subtle" />
                        )}
                        {onWebSearchToggle && (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={webSearchEnabled}
                            onClick={() => {
                              onWebSearchToggle()
                              closeInputMenu(true)
                            }}
                            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                          >
                            {webSearchEnabled ? (
                              <PiGlobe className="h-5 w-5 text-content-secondary" />
                            ) : (
                              <PiGlobeX className="h-5 w-5 text-content-secondary" />
                            )}
                            <span className="flex-1">Web search</span>
                            {webSearchEnabled && (
                              <MenuCheckmark className="h-4 w-4 text-brand-accent-light" />
                            )}
                          </button>
                        )}
                        {onCodeExecutionToggle && (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={codeExecutionEnabled}
                            onClick={() => {
                              onCodeExecutionToggle()
                              closeInputMenu(true)
                            }}
                            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                          >
                            <PiTerminalWindow className="h-5 w-5 text-content-secondary" />
                            <span className="flex-1">Code execution</span>
                            {codeExecutionEnabled && (
                              <MenuCheckmark className="h-4 w-4 text-brand-accent-light" />
                            )}
                          </button>
                        )}
                        {contextUsage && (
                          <div className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary md:hidden">
                            <span className="flex-1">Context</span>
                            <ContextUsageIndicator usage={contextUsage} />
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div
                className={cn(
                  'flex items-center gap-2',
                  isCompact && 'h-10 md:h-8',
                )}
              >
                {/* Once a conversation is underway these move to the footer
                  below the card so the card itself stays focused on composing. */}
                {!hasMessages && contextUsage && (
                  <ContextUsageIndicator
                    usage={contextUsage}
                    className="hidden md:flex"
                  />
                )}
                {!hasMessages && modelSelectorButton && (
                  <div>{modelSelectorButton}</div>
                )}
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
                  const isBusy = loadingState !== 'idle'
                  const hasCompletedDocuments = Boolean(
                    processedDocuments &&
                    processedDocuments.some((doc) =>
                      isDocumentSubmittable(doc),
                    ),
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
                            /iPhone|iPad|iPod|Android/i.test(
                              navigator.userAgent,
                            )
                          if (!isMobile) {
                            ownTextareaRef.current?.blur()
                          }
                        }
                      }}
                      className={cn(
                        'group flex h-10 w-10 items-center justify-center rounded-site-control bg-tinfoil-accent-blue text-white transition-colors hover:bg-tinfoil-accent-blue-hover disabled:opacity-50 md:h-8 md:w-8',
                        !isCompact && 'ml-2',
                      )}
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                      disabled={
                        showStopAction
                          ? false
                          : isTranscribing || !hasSubmittableContent
                      }
                      aria-label={showStopAction ? 'Stop generation' : 'Send'}
                    >
                      {showStopAction ? (
                        <div className="h-3.5 w-3.5 bg-white/80 transition-colors md:h-3 md:w-3" />
                      ) : (
                        <FiArrowUp className="h-6 w-6 text-current transition-colors md:h-5 md:w-5" />
                      )}
                    </button>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>

      {hasMessages && (
        <div className="flex items-center justify-between gap-4 px-3 md:px-6">
          <p className="text-xs text-content-muted">
            AI can make mistakes. Verify important information.
          </p>
          <div className="hidden items-center gap-2 md:flex">
            {contextUsage && (
              <ContextUsageIndicator
                usage={contextUsage}
                className="hidden md:flex"
              />
            )}
            {modelSelectorButton}
          </div>
        </div>
      )}
    </div>
  )
}
