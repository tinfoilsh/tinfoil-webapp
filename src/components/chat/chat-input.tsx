import { useProject } from '@/components/project'
import { cn } from '@/components/ui/utils'
import { getProjectColor } from '@/constants/project-colors'
import { useToast } from '@/hooks/use-toast'
import { useHarness } from '@/services/harness/provider'
import { useReloadHold } from '@/services/reload-when-updated'
import { dictation } from '@/services/speech/dictation'
import { logError } from '@/utils/error-handling'
import { Composer, type ComposerHandle } from '@tinfoil/chat-ui/composer'
import { DictationButton } from '@tinfoil/chat-ui/dictation-button'
import { useDictation } from '@tinfoil/chat-ui/use-dictation'
import {
  TfAttachment,
  TfBoxCheckmark,
  TfBoxX,
  TfGlobe,
  TfGlobeX,
  TfQuote,
  TfStack,
  TfWebSearch,
} from '@tinfoilsh/tinfoil-icons'
import {
  TfFolderAnimated,
  TfPlusAnimated,
  TfToolsAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import type { FormEvent, RefObject } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  COMPACTING_LABEL,
  COMPACT_LABEL,
  ContextUsageIndicator,
  type ContextUsage,
} from './components/context-usage-indicator'
import { DictationNotice } from './components/dictation-notice'
import { FilePreview, imageDataUrl } from './components/file-preview'
import { UnsavedImagesNotice } from './components/unsaved-images-notice'
import { useEnterToNewline } from './hooks/use-enter-to-newline'
import { useListEditing } from './hooks/use-list-editing'
import type { PromptPreset } from './prompts/types'
import { RecordingWaveform } from './recording-waveform'
import type { ProcessedDocument } from './renderers/types'
import type { LoadingState } from './types'

type ChatInputProps = {
  // The chat the composer writes in, which dictation started here belongs
  // to; a new chat's is empty.
  chatId: string
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
  modelSelectorButton?: React.ReactNode
  webSearchEnabled?: boolean
  onWebSearchToggle?: () => void
  // Whether the next question is researched in depth, and what toggles it
  // where the session offers deep research.
  researchEnabled?: boolean
  onResearchToggle?: () => void
  quote?: string | null
  onClearQuote?: () => void
  isTemporaryMode?: boolean
  activePromptPreset?: PromptPreset | null
  onOpenPromptLibrary?: () => void
  onClearPromptPreset?: () => void
  contextUsage?: ContextUsage
  // Compacting the open chat on request.
  canCompact?: boolean
  compacting?: boolean
  onCompact?: () => void
  mobileHeader?: React.ReactNode
}

// Maximum number of characters displayed in the collapsed quote preview.
const QUOTE_PREVIEW_MAX_LENGTH = 240

const isDocumentSubmittable = (doc: ProcessedDocument) =>
  !doc.isUploading && !doc.isGeneratingDescription && !doc.isUnsupported

export const ChatInput = memo(function ChatInput({
  chatId,
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
  modelSelectorButton,
  webSearchEnabled,
  onWebSearchToggle,
  researchEnabled = false,
  onResearchToggle,
  quote,
  onClearQuote,
  isTemporaryMode,
  activePromptPreset,
  onOpenPromptLibrary,
  onClearPromptPreset,
  contextUsage,
  canCompact = false,
  compacting = false,
  onCompact,
  mobileHeader,
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const documentsScrollRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  const { isProjectMode, activeProject } = useProject()
  const { api, session } = useHarness()
  const transcriptionAvailable = !!session?.features.transcription
  const compaction =
    onCompact && session?.features.manualCompaction
      ? { canCompact, compacting, onCompact }
      : undefined
  const enterToNewline = useEnterToNewline()
  const handleListKeyDown = useListEditing(input, setInput)
  const composerRef = useRef<ComposerHandle>(null)

  // --- Speech-to-text state ---
  const reportRecordingError = useCallback(
    (err: unknown) => {
      toast({
        title: 'Recording Error',
        description:
          err instanceof Error
            ? err.message
            : 'Could not start recording. Please make sure you have granted microphone permissions.',
        variant: 'destructive',
        position: 'top-right',
      })
    },
    [toast],
  )
  const {
    state: dictationState,
    isRecording,
    isTranscribing,
    announcement: audioStatus,
    start: startRecording,
    stop: stopRecording,
  } = useDictation({
    dictation,
    chatId,
    input,
    setInput,
    composer: composerRef,
    segmentSeconds: session?.composer.dictationSegmentSeconds,
    persist: !isTemporaryMode,
    onError: reportRecordingError,
  })
  // A reload cuts off the recording under way, and the text of one being
  // transcribed has yet to reach the composer.
  useReloadHold(isRecording || isTranscribing)
  const recordingStream = dictationState.stream

  // --- Input options menu state (the "+" button) ---
  const [isInputMenuOpen, setIsInputMenuOpen] = useState(false)
  const inputMenuRef = useRef<HTMLDivElement>(null)
  const inputMenuTriggerRef = useRef<HTMLButtonElement>(null)

  // Items a breakpoint hides take no focus, so arrow keys skip them.
  const getInputMenuItems = (): HTMLElement[] =>
    Array.from(
      inputMenuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ) ?? [],
    ).filter((item) => getComputedStyle(item).display !== 'none')

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
  // A signed-out visitor's chat keeps its images only while the page is open.
  const imagesUnsaved =
    !api.userId &&
    !isTemporaryMode &&
    !!processedDocuments?.some((doc) => doc.attachment?.type === 'image')
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
                metadata: { contentType: file.type, sizeBytes: file.size },
              })
            })
            return
          }
        }
      }

      const pastedText = e.clipboardData.getData('text')

      // Check if pasted text exceeds threshold
      if (
        session &&
        pastedText.length > session.composer.pasteAsFileChars &&
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
    [handleDocumentUpload, session],
  )

  const hasCompletedDocuments = Boolean(
    processedDocuments?.some((doc) => isDocumentSubmittable(doc)),
  )

  return (
    <Composer
      ref={composerRef}
      input={input}
      setInput={setInput}
      onSubmit={handleSubmit}
      busy={loadingState !== 'idle'}
      onCancel={cancelGeneration}
      cancelOnEscape={loadingState === 'loading'}
      inputRef={inputRef}
      onFocus={handleInputFocus}
      inputMinHeight={inputMinHeight}
      hasMessages={hasMessages}
      enterToNewline={enterToNewline}
      onListKeyDown={handleListKeyDown}
      onPaste={handlePaste}
      hasAttachedContent={Boolean(quote) || hasCompletedDocuments}
      locked={isRecording || isTranscribing}
      // While recording an empty draft, the textarea is hidden behind the
      // live waveform. Nonempty drafts stay visible above the waveform.
      textareaHidden={Boolean(isRecording && recordingStream && !input.trim())}
      belowTextarea={
        isRecording &&
        recordingStream && (
          <RecordingWaveform
            stream={recordingStream}
            className="w-full"
            style={{ minHeight: inputMinHeight }}
          />
        )
      }
      dashed={isTemporaryMode}
      modelSelectorButton={modelSelectorButton}
      header={mobileHeader}
      tabs={
        <>
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
                    <TfFolderAnimated className="h-3 w-3" aria-hidden="true" />
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
                      <ActivePresetIcon
                        className="h-3 w-3"
                        aria-hidden="true"
                      />
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
                        <TfBoxX className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })()}
        </>
      }
      attachments={
        <>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            multiple
          />

          {quote && (
            <div className="mb-3 mt-1 flex items-start gap-2 rounded-2xl border border-border-subtle bg-surface-chat-background px-3 py-2">
              <TfQuote
                className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-secondary"
                aria-hidden="true"
              />
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
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
                >
                  <TfBoxX className="h-3.5 w-3.5" aria-hidden="true" />
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
                      className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center text-content-secondary transition-colors hover:text-content-primary"
                      aria-label={`Remove ${doc.name}`}
                    >
                      <TfBoxX className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                  <div
                    className={cn(
                      'flex items-center gap-2',
                      removeDocument && 'pr-4',
                    )}
                  >
                    <FilePreview
                      filename={doc.name}
                      imageSrc={
                        doc.attachment?.type === 'image'
                          ? imageDataUrl(
                              doc.attachment.thumbnailBase64 ??
                                doc.attachment.base64,
                              doc.attachment.mimeType,
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
                              : doc.attachment?.type === 'image'
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

          {imagesUnsaved && <UnsavedImagesNotice className="mb-3" />}
          <DictationNotice
            retrying={dictationState.retrying}
            failed={dictationState.failed}
            onRetry={() => dictation.retry()}
            onDiscard={() => dictation.discard()}
            className="mb-3"
          />
        </>
      }
      status={audioStatus}
      leadingControls={
        <>
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
              <TfPlusAnimated className="h-5 w-5" aria-hidden="true" />
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
                    <TfAttachment
                      className="h-5 w-5 !text-content-secondary"
                      aria-hidden="true"
                    />
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
                      <TfToolsAnimated
                        className="h-5 w-5 text-content-secondary"
                        aria-hidden="true"
                      />
                      Change system prompt
                    </button>
                  )}
                  {onWebSearchToggle && (
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
                        <TfGlobe
                          className="h-5 w-5 !text-content-secondary"
                          aria-hidden="true"
                        />
                      ) : (
                        <TfGlobeX
                          className="h-5 w-5 text-content-secondary"
                          aria-hidden="true"
                        />
                      )}
                      <span className="flex-1">Web search</span>
                      {webSearchEnabled && (
                        <TfBoxCheckmark
                          className="h-4 w-4 text-brand-accent-dark dark:text-brand-accent-light"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )}
                  {onResearchToggle && (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={researchEnabled}
                      onClick={() => {
                        onResearchToggle()
                        closeInputMenu(true)
                      }}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                    >
                      <TfWebSearch
                        className="h-5 w-5 text-content-secondary"
                        aria-hidden="true"
                      />
                      <span className="flex-1">Deep research</span>
                      {researchEnabled && (
                        <TfBoxCheckmark
                          className="h-4 w-4 text-brand-accent-light"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )}
                  {contextUsage && (
                    <div className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary md:hidden">
                      <span className="flex-1">Context</span>
                      <ContextUsageIndicator usage={contextUsage} />
                    </div>
                  )}
                  {contextUsage && compaction && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-disabled={!compaction.canCompact}
                      onClick={() => {
                        if (!compaction.canCompact) return
                        compaction.onCompact()
                        closeInputMenu(true)
                      }}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary md:hidden',
                        compaction.canCompact
                          ? 'hover:bg-surface-chat-background'
                          : 'cursor-default opacity-50',
                      )}
                    >
                      <TfStack
                        className="h-5 w-5 text-content-secondary"
                        aria-hidden="true"
                      />
                      {compaction.compacting ? COMPACTING_LABEL : COMPACT_LABEL}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {researchEnabled && onResearchToggle && (
            <button
              type="button"
              onClick={onResearchToggle}
              aria-label="Turn off deep research"
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-brand-accent-light transition-colors hover:bg-surface-chat-background"
            >
              <TfWebSearch className="h-4 w-4" aria-hidden="true" />
              Deep research
              <TfBoxX className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </>
      }
      trailingControls={
        <>
          {isPremium && transcriptionAvailable && (
            <DictationButton
              status={dictationState.status}
              onStart={startRecording}
              onStop={stopRecording}
            />
          )}
        </>
      }
      cardUsage={
        contextUsage && (
          <ContextUsageIndicator
            usage={contextUsage}
            className="hidden md:flex"
          />
        )
      }
      footerUsage={
        contextUsage && (
          <ContextUsageIndicator
            usage={contextUsage}
            className="hidden md:flex"
            compaction={compaction}
          />
        )
      }
    />
  )
})
