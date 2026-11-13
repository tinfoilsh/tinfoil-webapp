import type { Message, TimelineBlock } from '@tinfoil/chat-client/types'
import {
  MESSAGE_PROSE_CLASS_NAME,
  MessageMetadata,
  USER_MESSAGE_BUBBLE_CLASS_NAME,
} from '@tinfoil/chat-ui/message'
import {
  StreamingMarkdown,
  type MarkdownComponents,
} from '@tinfoil/chat-ui/StreamingMarkdown'
import { StreamingTracerDot } from '@tinfoil/chat-ui/StreamingTracerDot'
import { ThoughtProcess } from '@tinfoil/chat-ui/ThoughtProcess'
import remarkGfm from 'remark-gfm'
import {
  BROWSER_TOOL,
  BrowserStep,
  connectingStep,
  WorkSteps,
  type WorkBlock,
} from './browser-steps'
import { webURL } from './browser/schema'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS: [] = []
const MARKDOWN_COMPONENTS: MarkdownComponents = {
  a: ({ href, children }) => {
    let safe: string | undefined
    try {
      safe = webURL(href || '')
    } catch {
      safe = undefined
    }
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
  },
  img: ({ alt }) => <span>[Image: {alt || 'image'}]</span>,
  pre: ({ children }) => (
    <pre className="my-3 rounded-lg border border-border-subtle !bg-surface-chat !p-3 font-mono text-sm text-content-primary">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

type Segment =
  | { kind: 'work'; key: string; blocks: WorkBlock[] }
  | { kind: 'content'; block: TimelineBlock }

const isWork = (block: TimelineBlock) =>
  block.type === 'thinking' ||
  (block.type === 'tool_call' && block.name === BROWSER_TOOL)

// A block that shows nothing: text of only whitespace between steps, or a
// thought that ended without one. It neither shows nor splits a run of steps.
const isInvisible = (block: TimelineBlock, running: boolean) =>
  block.type === 'tool_call' ? false : !block.content?.trim() && !running

// A reply's timeline as it shows: its text, and each run of thinking and
// browser steps between that text.
function segments(timeline: TimelineBlock[], streaming: boolean): Segment[] {
  const shown: Segment[] = []
  const connecting = connectingStep(timeline)
  timeline.forEach((block, index) => {
    const last = streaming && index === timeline.length - 1
    // A reply thinks only in its last block, and a browser step runs until
    // the extension answers it.
    const running =
      block.type === 'thinking'
        ? last && !block.complete
        : block.type === 'tool_call' && streaming && block.result === undefined
    if (isInvisible(block, running)) return
    if (block.type === 'content') {
      shown.push({ kind: 'content', block })
      return
    }
    // A block of a type or a tool this client does not know has no view.
    if (!isWork(block)) return
    const work = { block, running, connects: block.id === connecting }
    const previous = shown[shown.length - 1]
    if (previous?.kind === 'work') previous.blocks.push(work)
    else shown.push({ kind: 'work', key: `work-${block.id}`, blocks: [work] })
  })
  return shown
}

function AssistantText({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}) {
  return (
    <div className="w-full px-4 py-2">
      <div className={MESSAGE_PROSE_CLASS_NAME} translate="no">
        <StreamingMarkdown
          text={text}
          streaming={streaming}
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={MARKDOWN_COMPONENTS}
        />
      </div>
    </div>
  )
}

export function MessageView({
  message,
  streaming,
  isDarkMode,
}: {
  message: Message
  // The reply is the one its chat's run is still writing.
  streaming: boolean
  isDarkMode: boolean
}) {
  if (message.role === 'user')
    return (
      <div className="group relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-end">
        <div className="flex w-full justify-end px-4 pt-2">
          <div className="flex max-w-[95%] flex-col">
            <div className={USER_MESSAGE_BUBBLE_CLASS_NAME}>
              <div className={MESSAGE_PROSE_CLASS_NAME}>
                <div className="whitespace-pre-wrap break-words">
                  {message.content}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )

  const timeline = message.timeline ?? []
  const shown = segments(timeline, streaming)
  const lastSegment = shown.at(-1)
  // A group of steps working, or a step running, shows the reply's progress
  // in its own header.
  const showsProgress =
    lastSegment?.kind === 'work' &&
    (lastSegment.blocks.length > 1 || lastSegment.blocks[0].running)
  const hasText = timeline.some((block) => block.type === 'content')
  const hasContent = !!message.content || shown.length > 0
  return (
    <div className="group relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      {shown.map((segment, index) => {
        if (segment.kind === 'content')
          return (
            <AssistantText
              key={segment.block.id}
              text={segment.block.content ?? ''}
              streaming={streaming && index === shown.length - 1}
            />
          )
        const isActive = streaming && index === shown.length - 1
        const [only] = segment.blocks
        return (
          <div key={segment.key} className="no-scroll-anchoring w-full px-4">
            {segment.blocks.length > 1 ? (
              <WorkSteps
                blocks={segment.blocks}
                isActive={isActive}
                isDarkMode={isDarkMode}
              />
            ) : only.block.type === 'thinking' ? (
              <ThoughtProcess
                thoughts={only.block.content ?? ''}
                isDarkMode={isDarkMode}
                isThinking={only.running}
                thinkingDuration={only.block.duration}
                startedAt={only.block.startedAt}
              />
            ) : (
              <BrowserStep
                block={only.block}
                running={only.running}
                connects={only.connects}
              />
            )}
          </div>
        )
      })}

      {/* A reply saved before timelines has only its text. */}
      {!hasText && message.content && (
        <AssistantText text={message.content} streaming={streaming} />
      )}

      {streaming && !showsProgress && (
        <div className="w-full px-4 pb-2 pt-2">
          <span className="flex h-3.5 w-3.5 items-center justify-center">
            <StreamingTracerDot
              tone={lastSegment?.kind === 'content' ? 'primary' : 'secondary'}
            />
          </span>
        </div>
      )}

      {!streaming && message.isInterrupted && (
        <div className="flex w-full items-center gap-2 px-4 pt-2">
          <p className="text-left text-xs text-content-muted">
            Response stopped
          </p>
        </div>
      )}

      {!streaming && hasContent && (
        <div className="mt-4 flex w-full items-center px-4">
          <MessageMetadata
            modelDisplayName={message.modelDisplayName?.trim()}
          />
        </div>
      )}
    </div>
  )
}

// A chat's messages, and a sign that its reply is on the way for as long as
// none of it has arrived.
export function Conversation({
  messages,
  busy,
  isDarkMode,
}: {
  messages: Message[]
  // The chat's run is still working on its reply.
  busy: boolean
  isDarkMode: boolean
}) {
  return (
    <div className="mx-auto w-full min-w-0 pb-6 pt-6 font-chat">
      {messages.map((message, index) => (
        <MessageView
          key={message.id}
          message={message}
          streaming={busy && index === messages.length - 1}
          isDarkMode={isDarkMode}
        />
      ))}
      {busy && messages.at(-1)?.role === 'user' && (
        <div className="no-scroll-anchoring group mx-auto mb-6 flex w-full max-w-3xl flex-col items-start px-4 pt-6">
          <StreamingTracerDot tone="secondary" label="Waiting for response" />
        </div>
      )}
    </div>
  )
}
