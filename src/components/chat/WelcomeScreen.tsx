import { Favicon } from '@/components/ui/favicon'
import { type BaseModel } from '@/config/models'
import { USER_PREFS_NICKNAME } from '@/constants/storage-keys'
import { useUser } from '@clerk/nextjs'
import { AnimatePresence, motion } from 'framer-motion'
import React, { memo, useEffect, useRef, useState } from 'react'
import { BiSolidLock } from 'react-icons/bi'
import { ChatInput } from './chat-input'
import { CONSTANTS } from './constants'
import { DataFlowDiagram } from './DataFlowDiagram'
import {
  isReasoningModel,
  supportsReasoningEffort,
  supportsThinkingToggle,
  type ReasoningEffort,
} from './hooks/use-reasoning-effort'
import { ModelSelector } from './model-selector'
import { ReasoningEffortSelector } from './reasoning-effort-selector'
import type { ProcessedDocument } from './renderers/types'
import type { LabelType, LoadingState } from './types'

const LINE_FADE_DURATION_S = 0.5
const LINE_FADE_STAGGER_S = 0.15
const LINE_FADE_INITIAL_DELAY_S = 0.1

type Segment =
  | { type: 'text'; content: string }
  | {
      type: 'link'
      content: string
      href: string
    }
  | {
      type: 'button'
      content: string
      onClick: () => void
    }
  | {
      type: 'citation'
      content: string
      href?: string
      onClick?: () => void
    }

function renderSegment(seg: Segment, key: React.Key) {
  if (seg.type === 'citation') {
    const domain = seg.href
      ? new URL(seg.href).hostname.replace(/^www\./, '')
      : null
    const pillClass =
      'mx-0.5 inline-flex h-[1.5em] items-center gap-1 whitespace-nowrap rounded-full bg-blue-500/10 pl-1 pr-2 !align-baseline text-[10px] font-medium text-blue-500 transition-colors hover:bg-blue-500/20'
    const inner = (
      <>
        {seg.href && (
          <Favicon
            url={seg.href}
            className="h-[1.1em] w-[1.1em] shrink-0 rounded-full bg-white p-[1px]"
          />
        )}
        <span>{domain || seg.content}</span>
      </>
    )
    if (seg.onClick) {
      return (
        <button
          key={key}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            seg.onClick?.()
          }}
          className={pillClass}
        >
          {inner}
        </button>
      )
    }
    return (
      <a
        key={key}
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        className={pillClass}
      >
        {inner}
      </a>
    )
  }

  if (seg.type === 'link') {
    return (
      <a
        key={key}
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-accent-dark transition-opacity hover:opacity-80 dark:text-brand-accent-light"
      >
        {seg.content}
      </a>
    )
  }

  if (seg.type === 'button') {
    return (
      <button
        key={key}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          seg.onClick()
        }}
        className="text-brand-accent-dark transition-opacity hover:opacity-80 dark:text-brand-accent-light"
      >
        {seg.content}
      </button>
    )
  }

  return <span key={key}>{seg.content}</span>
}

/**
 * Splits a flat list of segments into "lines" by breaking text segments on
 * sentence boundaries (". "). Citation/link/button segments stay attached to
 * whichever sentence they follow so inline pills don't orphan on their own line.
 */
function segmentsToLines(segments: Segment[]): Segment[][] {
  const lines: Segment[][] = []
  let current: Segment[] = []

  const pushCurrent = () => {
    if (current.length > 0) {
      lines.push(current)
      current = []
    }
  }

  for (const seg of segments) {
    if (seg.type !== 'text') {
      current.push(seg)
      continue
    }

    const parts = seg.content.split(/(?<=\. )/)
    parts.forEach((part) => {
      if (!part) return
      current.push({ type: 'text', content: part })
      if (/\.\s$/.test(part)) {
        pushCurrent()
      }
    })
  }

  pushCurrent()
  return lines
}

function FadeInLines({ segments }: { segments: Segment[] }) {
  const lines = segmentsToLines(segments)

  return (
    <>
      {lines.map((line, lineIdx) => (
        <motion.span
          key={lineIdx}
          className="inline"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: LINE_FADE_DURATION_S,
            ease: 'easeOut',
            delay: LINE_FADE_INITIAL_DELAY_S + lineIdx * LINE_FADE_STAGGER_S,
          }}
        >
          {line.map((seg, segIdx) => renderSegment(seg, segIdx))}
        </motion.span>
      ))}
    </>
  )
}

interface WelcomeScreenProps {
  isDarkMode: boolean
  isPremium?: boolean
  models?: BaseModel[]
  onSubmit?: (e: React.FormEvent) => void
  input?: string
  setInput?: (value: string) => void
  loadingState?: LoadingState
  cancelGeneration?: () => void
  inputRef?: React.RefObject<HTMLTextAreaElement>
  handleInputFocus?: () => void
  handleDocumentUpload?: (file: File) => Promise<void>
  processedDocuments?: ProcessedDocument[]
  removeDocument?: (id: string) => void
  selectedModel?: string
  handleModelSelect?: (model: string) => void
  expandedLabel?: LabelType
  handleLabelClick?: (
    label: Exclude<LabelType, null>,
    action: () => void,
  ) => void
  webSearchEnabled?: boolean
  onWebSearchToggle?: () => void
  reasoningEffort?: ReasoningEffort
  setReasoningEffort?: (effort: ReasoningEffort) => void
  thinkingEnabled?: boolean
  setThinkingEnabled?: (enabled: boolean) => void
  onOpenVerifier?: () => void
}

export const WelcomeScreen = memo(function WelcomeScreen({
  isDarkMode,
  isPremium,
  models,
  onSubmit,
  input,
  setInput,
  loadingState,
  cancelGeneration,
  inputRef,
  handleInputFocus,
  handleDocumentUpload,
  processedDocuments,
  removeDocument,
  selectedModel,
  handleModelSelect,
  expandedLabel,
  handleLabelClick,
  webSearchEnabled,
  onWebSearchToggle,
  reasoningEffort,
  setReasoningEffort,
  thinkingEnabled,
  setThinkingEnabled,
  onOpenVerifier,
}: WelcomeScreenProps) {
  const { user } = useUser()
  const [nickname, setNickname] = useState<string>('')
  const [privacyExpanded, setPrivacyExpanded] = useState(false)
  const [lockPop, setLockPop] = useState(false)
  const fallbackInputRef = useRef<HTMLTextAreaElement>(null)

  // Load nickname from localStorage and listen for changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Clear nickname when user changes or is not authenticated
      if (!user?.id) {
        setNickname('')
        return
      }

      const savedNickname = localStorage.getItem(USER_PREFS_NICKNAME)
      if (savedNickname) {
        setNickname(savedNickname)
      }

      // Listen for personalization changes
      const handlePersonalizationChange = (event: CustomEvent) => {
        setNickname(event.detail?.nickname ?? '')
      }

      window.addEventListener(
        'personalizationChanged',
        handlePersonalizationChange as EventListener,
      )

      return () => {
        window.removeEventListener(
          'personalizationChanged',
          handlePersonalizationChange as EventListener,
        )
      }
    }
  }, [user?.id])

  // Determine the greeting text based on time of day
  const getGreeting = () => {
    const name = nickname || user?.firstName
    if (!name) {
      return 'Tinfoil Private Chat'
    }

    const hour = new Date().getHours()
    if (hour >= 5 && hour < 12) {
      return `Good morning, ${name}!`
    } else if (hour >= 12 && hour < 17) {
      return `Good afternoon, ${name}!`
    } else if (hour >= 17 && hour < 22) {
      return `Good evening, ${name}!`
    } else {
      return `Up late, ${name}?`
    }
  }

  // Don't show loading skeleton - show the welcome screen immediately
  // Models will populate when they're loaded

  return (
    <motion.div
      className={`flex w-full justify-center ${privacyExpanded ? 'items-start' : 'min-h-[60vh] items-center md:min-h-0 md:items-start'}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.6,
        ease: 'easeOut',
        delay: 0.1,
      }}
    >
      <div className="flex w-full justify-center">
        <div className="w-full max-w-2xl">
          <motion.h1
            className={`flex items-center gap-3 text-2xl font-medium tracking-tight text-content-primary md:justify-start md:text-3xl ${privacyExpanded ? 'justify-start' : 'justify-center'}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.5,
              ease: 'easeOut',
              delay: 0.2,
            }}
          >
            {getGreeting()}
          </motion.h1>

          {/* Privacy explainer */}
          <motion.div
            className="mt-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
              duration: 0.5,
              ease: 'easeOut',
              delay: 0.3,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setPrivacyExpanded((prev) => {
                  if (!prev) setLockPop(true)
                  else setLockPop(false)
                  return !prev
                })
              }}
              className={`group flex w-full items-center gap-2 text-base text-content-secondary transition-colors hover:text-content-primary md:justify-start ${privacyExpanded ? 'justify-start' : 'justify-center'}`}
            >
              <motion.span
                className="inline-flex shrink-0"
                animate={lockPop ? { scale: [1, 1.5, 0.9, 1] } : { scale: 1 }}
                transition={
                  lockPop
                    ? {
                        duration: 0.7,
                        times: [0, 0.3, 0.6, 1],
                        ease: 'easeInOut',
                      }
                    : { duration: 0 }
                }
              >
                <BiSolidLock className="h-4 w-4 text-brand-accent-dark dark:text-brand-accent-light" />
              </motion.span>
              <span>Your chats are private by design</span>
              <svg
                className={`h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-300 ${privacyExpanded ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            <AnimatePresence initial={false}>
              {privacyExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{
                    height: {
                      duration: 0.3,
                      ease: [0.25, 0.1, 0.25, 1],
                    },
                    opacity: {
                      duration: 0.25,
                      delay: 0.1,
                      ease: 'easeOut',
                    },
                  }}
                  className="overflow-hidden"
                >
                  <p className="mt-2 text-left text-base leading-relaxed text-content-secondary">
                    <FadeInLines
                      segments={[
                        {
                          type: 'text',
                          content:
                            'Your messages are encrypted directly to the AI models running inside secure hardware enclaves.',
                        },
                        {
                          type: 'citation',
                          content: 'Technology',
                          href: 'https://tinfoil.sh/technology',
                        },
                        {
                          type: 'text',
                          content:
                            ' These are hardware-isolated environments powered by confidential computing GPUs with verifiable confidentiality and integrity guarantees. Not even Tinfoil can access your data. This applies to all chats, images, documents, and voice input. Our open-source stack lets you verify this yourself by inspecting the hardware attestation.',
                        },
                        {
                          type: 'citation',
                          content: 'Source',
                          href: 'https://github.com/tinfoilsh',
                        },
                      ]}
                    />
                  </p>
                  <DataFlowDiagram onOpenVerifier={onOpenVerifier} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          <div className="mt-8">
            {/* Centered Chat Input - Desktop only */}
            {onSubmit && input !== undefined && setInput && (
              <motion.div
                className="mt-8 hidden md:block"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: 0.5,
                  ease: 'easeOut',
                  delay: 0.4,
                }}
              >
                <ChatInput
                  input={input}
                  setInput={setInput}
                  handleSubmit={onSubmit}
                  loadingState={loadingState ?? 'idle'}
                  cancelGeneration={cancelGeneration ?? (() => {})}
                  inputRef={inputRef ?? fallbackInputRef}
                  handleInputFocus={handleInputFocus ?? (() => {})}
                  inputMinHeight="60px"
                  isDarkMode={isDarkMode}
                  handleDocumentUpload={handleDocumentUpload}
                  processedDocuments={processedDocuments}
                  removeDocument={removeDocument}
                  isPremium={isPremium}
                  hasMessages={false}
                  audioModel={
                    (
                      models?.find(
                        (m) => m.modelName === CONSTANTS.DEFAULT_AUDIO_MODEL,
                      ) || models?.find((m) => m.type === 'audio')
                    )?.modelName
                  }
                  modelSelectorButton={
                    models &&
                    selectedModel &&
                    handleModelSelect &&
                    handleLabelClick ? (
                      <div className="relative">
                        <button
                          type="button"
                          data-model-selector
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            if (handleLabelClick) {
                              handleLabelClick('model', () => {})
                            }
                          }}
                          className="flex items-center gap-1 text-content-secondary transition-colors hover:text-content-primary"
                        >
                          {(() => {
                            const model = models.find(
                              (m) => m.modelName === selectedModel,
                            )
                            if (!model) return null
                            return (
                              <>
                                <span className="text-xs font-medium">
                                  {model.name}
                                </span>
                                <svg
                                  className={`h-3 w-3 transition-transform ${expandedLabel === 'model' ? 'rotate-180' : ''}`}
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 9l-7 7-7-7"
                                  />
                                </svg>
                              </>
                            )
                          })()}
                        </button>

                        {expandedLabel === 'model' && handleModelSelect && (
                          <ModelSelector
                            selectedModel={selectedModel}
                            onSelect={handleModelSelect}
                            isDarkMode={isDarkMode}
                            models={models}
                            preferredPosition="below"
                          />
                        )}
                      </div>
                    ) : undefined
                  }
                  reasoningSelectorButton={(() => {
                    if (
                      !reasoningEffort ||
                      !setReasoningEffort ||
                      !handleLabelClick ||
                      thinkingEnabled === undefined ||
                      !setThinkingEnabled
                    )
                      return undefined
                    const m = models?.find(
                      (mm) => mm.modelName === selectedModel,
                    )
                    if (!isReasoningModel(m)) return undefined
                    return (
                      <ReasoningEffortSelector
                        supportsEffort={supportsReasoningEffort(m)}
                        supportsToggle={supportsThinkingToggle(m)}
                        reasoningEffort={reasoningEffort}
                        onEffortChange={setReasoningEffort}
                        thinkingEnabled={thinkingEnabled}
                        onThinkingEnabledChange={setThinkingEnabled}
                        isOpen={expandedLabel === 'reasoning'}
                        onToggle={() => handleLabelClick('reasoning', () => {})}
                        onClose={() => handleLabelClick('reasoning', () => {})}
                        preferredPosition="below"
                      />
                    )
                  })()}
                  webSearchEnabled={webSearchEnabled}
                  onWebSearchToggle={onWebSearchToggle}
                />
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
})
