import { cn } from '@/components/ui/utils'
import { findSelectableModel, type BaseModel } from '@/config/models'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { memo, useRef } from 'react'
import { PiChatCircleText } from 'react-icons/pi'
import { LoadingDots } from '../loading-dots'
import { CONSTANTS } from './constants'
import type { SidebarChatState } from './hooks/use-sidebar-chat'
import { QuoteSelectionPopover } from './quote-selection-popover'
import { getRendererRegistry } from './renderers/client'
import type { AIModel, Message } from './types'

type AskSidebarProps = {
  isOpen: boolean
  onClose: () => void
  // Fired when the user highlights text inside the sidebar and chooses
  // "Quote". The quote is piped back into the main chat's input (the sidebar
  // itself has no input of its own).
  onQuote?: (text: string) => void
  state: SidebarChatState
  models: BaseModel[]
  selectedModel: AIModel
  isDarkMode: boolean
}

const SidebarMessage = memo(function SidebarMessage({
  message,
  messageIndex,
  model,
  isDarkMode,
  isLastMessage,
  isStreaming,
}: {
  message: Message
  messageIndex: number
  model: BaseModel
  isDarkMode: boolean
  isLastMessage: boolean
  isStreaming: boolean
}) {
  const renderer = getRendererRegistry().getMessageRenderer(message, model)
  const Component = renderer.render
  return (
    <Component
      message={message}
      messageIndex={messageIndex}
      model={model}
      isDarkMode={isDarkMode}
      isLastMessage={isLastMessage}
      isStreaming={isStreaming}
    />
  )
})

export function AskSidebar({
  isOpen,
  onClose,
  onQuote,
  state,
  models,
  selectedModel,
  isDarkMode,
}: AskSidebarProps) {
  const { messages, isWaitingForResponse, isStreaming } = state
  const hasMessages = messages.length > 0
  const currentModel = findSelectableModel(selectedModel, models) || models[0]
  const sidebarScrollRef = useRef<HTMLDivElement>(null)

  const lastMessage = messages[messages.length - 1]
  const showLoadingDots =
    isWaitingForResponse &&
    !(
      lastMessage &&
      lastMessage.role === 'assistant' &&
      (lastMessage.isThinking || (lastMessage.thoughts && !lastMessage.content))
    )

  return (
    <>
      <div
        className={cn(
          'fixed right-0 top-0 z-40 flex h-full w-[85vw] flex-col border-l border-border-subtle bg-surface-chat-background font-aeonik transition-transform duration-200 ease-in-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
        style={{ maxWidth: `${CONSTANTS.ASK_SIDEBAR_WIDTH_PX}px` }}
        inert={!isOpen}
        aria-hidden={!isOpen}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-2 text-content-primary">
            <PiChatCircleText className="h-5 w-5" />
            <span className="text-sm font-medium">Ask</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-surface-chat text-content-secondary transition-colors hover:bg-surface-chat-background"
            aria-label="Close ask sidebar"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Messages area */}
        {isOpen && onQuote && (
          <QuoteSelectionPopover
            containerRef={sidebarScrollRef}
            onQuote={onQuote}
          />
        )}
        <div ref={sidebarScrollRef} className="flex flex-1 overflow-y-auto">
          {hasMessages && currentModel ? (
            <div className="flex-1 [container-type:inline-size]">
              <div className="flex flex-col gap-2 px-2 py-4">
                {messages.map((message, i) => (
                  <SidebarMessage
                    key={`${message.role}-${i}`}
                    message={message}
                    messageIndex={i}
                    model={currentModel}
                    isDarkMode={isDarkMode}
                    isLastMessage={i === messages.length - 1}
                    isStreaming={i === messages.length - 1 && isStreaming}
                  />
                ))}
                {showLoadingDots && (
                  <div className="mx-auto flex w-full max-w-3xl px-4">
                    <LoadingDots />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <p className="text-sm text-content-secondary">
                Highlight text in the chat and choose <strong>Ask</strong> to
                start a side-conversation about it.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}
    </>
  )
}
