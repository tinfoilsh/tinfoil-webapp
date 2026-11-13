import { useUser } from '@clerk/chrome-extension'
import {
  DEFAULT_EFFORT,
  findSelectableModel,
  type ReasoningEffort,
} from '@tinfoil/chat-client/models'
import { Button } from '@tinfoil/chat-ui/button'
import { Composer } from '@tinfoil/chat-ui/composer'
import { timeOfDayGreeting } from '@tinfoil/chat-ui/greeting'
import { LoadingDots } from '@tinfoil/chat-ui/LoadingDots'
import { StepDetails, StepHeader } from '@tinfoil/chat-ui/WorkStep'
import {
  TfChat2Animated,
  TfLockLockedAnimated,
  TfRefreshTwoArrowsAnimated,
  TfWriting2Animated,
} from '@tinfoilsh/tinfoil-icons/animated'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { DEFAULT_MODEL } from '../config'
import { MessageView } from '../message-view'
import type { Command, View } from '../messages'
import { PanelConnection } from '../panel-connection'
import { Logo } from '../ui/logo'
import { AccountMenu } from './account-menu'
import { ChatsModal } from './chats-modal'
import { ModelPicker } from './model-picker'

const SUGGESTIONS = [
  'Summarize the current page',
  'Compare these tabs and make a table',
  'Help me fill out this form',
]
const INPUT_MIN_HEIGHT = '28px'
const WELCOME_INPUT_MIN_HEIGHT = '36px'
// How close to its end the conversation is scrolled for it to follow a reply
// as it grows.
const FOLLOW_THRESHOLD_PX = 80
const STOP_SHORTCUT = 'Alt+Shift+S'
const HEADER_BUTTON_CLASS_NAME =
  'flex items-center justify-center rounded-lg border border-transparent bg-surface-chat-background p-2.5 text-content-secondary transition-all duration-200 hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary'
const NOTICE_BUTTON_CLASS_NAME =
  'flex h-9 shrink-0 items-center gap-1 self-start whitespace-nowrap rounded-site-control border border-red-300 px-3 text-xs font-medium transition-colors hover:bg-red-500/10 dark:border-red-500/40 dark:hover:bg-red-500/20'

// What stopped the chat, above the composer, and how to go on from it.
function ProblemNotice({
  message,
  action,
}: {
  message: string
  action?: ReactNode
}) {
  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-red-300 bg-red-50 text-red-700 shadow-sm transition-colors dark:border-red-500/40 dark:bg-red-950/60 dark:text-red-200">
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p role="alert" className="min-w-0 flex-1 text-sm">
          {message}
        </p>
        {action}
      </div>
    </div>
  )
}

// A browser action waiting for the user to allow it.
function ReviewCard({
  pending,
  onReview,
}: {
  pending: NonNullable<View['pending']>
  onReview: (allow: boolean) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  return (
    <section
      aria-label="Review browser action"
      className="mb-2 rounded-2xl border border-border-subtle bg-surface-chat px-3 py-2.5 shadow-sm"
    >
      <p className="text-sm font-medium text-content-primary">
        {pending.preview}
      </p>
      <StepHeader
        label={<span className="font-medium">Details</span>}
        isRunning={false}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((value) => !value)}
        detailsId={detailsId}
      />
      <StepDetails id={detailsId} isExpanded={isExpanded}>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-content-primary/70">
          {JSON.stringify(pending.operation, null, 2)}
        </pre>
      </StepDetails>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="solid" size="sm" onClick={() => onReview(true)}>
          Allow
        </Button>
        <Button variant="outline" size="sm" onClick={() => onReview(false)}>
          Decline
        </Button>
      </div>
    </section>
  )
}

// What the task under way is doing, and where, with pausing and stopping it.
function TaskStatus({
  phase,
  workingTab,
  onPause,
  onResume,
  onStop,
}: {
  phase: NonNullable<View['task']>['phase']
  workingTab: View['workingTab']
  onPause: () => void
  onResume: () => void
  onStop: () => void
}) {
  const paused = phase === 'paused'
  const title = paused
    ? 'Paused'
    : phase === 'review'
      ? 'Waiting for your review'
      : workingTab
        ? `Working in ${workingTab.title || new URL(workingTab.url).hostname}`
        : 'Working'
  return (
    <div
      role="status"
      className="mb-2 flex items-center gap-2 rounded-2xl border border-border-subtle bg-surface-chat px-3 py-2 shadow-sm"
    >
      {phase === 'running' && (
        <span className="flex h-6 shrink-0 items-center" aria-hidden="true">
          <LoadingDots size="small" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <p
          className="truncate text-sm font-medium text-content-primary"
          title={workingTab?.url}
        >
          {title}
        </p>
        {workingTab && !paused && (
          <p className="truncate text-xs text-content-secondary">
            {new URL(workingTab.url).hostname}
          </p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={paused ? onResume : onPause}>
        {paused ? 'Resume' : 'Pause'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onStop}
        title={`Stop the task (${STOP_SHORTCUT})`}
      >
        Stop
      </Button>
    </div>
  )
}

export function ChatPanel({
  owner,
  getToken,
  isDarkMode,
}: {
  owner: string
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>
  isDarkMode: boolean
}) {
  const connection = useMemo(
    () => new PanelConnection(owner, getToken),
    [owner, getToken],
  )
  const view = useSyncExternalStore(connection.subscribe, connection.snapshot)
  const { user } = useUser()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [modelChoice, setModel] = useState<string>()
  const [effortChoice, setEffort] = useState<ReasoningEffort>()
  const [autoChoice, setAutoIntelligence] = useState<string>()
  const [chatsOpen, setChatsOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const task = view.task
  const messages = task?.state.messages ?? []
  const hasMessages = messages.length > 0
  const busy = !!task && ['running', 'review', 'paused'].includes(task.phase)
  const models = view.session?.models ?? []
  const autoLevels = view.session?.auto.levels ?? []
  const offered = (id: string | undefined) =>
    models.find((entry) => entry.id === id && !entry.deprecated)?.id
  const model =
    modelChoice ||
    task?.model ||
    offered(DEFAULT_MODEL) ||
    offered(view.session?.defaultModel) ||
    DEFAULT_MODEL
  const effort = effortChoice ?? task?.effort ?? DEFAULT_EFFORT
  const autoIntelligence =
    autoChoice ?? task?.autoIntelligence ?? view.session?.auto.default ?? ''
  const problem = error || view.error || task?.error

  useEffect(() => connection.connect(), [connection])
  useEffect(() => {
    const element = scroll.current
    if (following.current && element) element.scrollTop = element.scrollHeight
  }, [task?.state.messages, task?.phase, view.pending, problem])

  const command = async (value: Command) => {
    setError('')
    try {
      await connection.command(value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The command failed.')
    }
  }
  const submit = async () => {
    const content = input.trim()
    if (!content || sending) return
    setSending(true)
    setError('')
    try {
      await connection.command({
        kind: 'send',
        content,
        model,
        effort,
        ...(findSelectableModel(model, models)?.auto
          ? { autoIntelligence }
          : {}),
      })
      setInput('')
      following.current = true
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not send the message.',
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-surface-chat-background text-content-primary">
      <header className="flex flex-none items-center justify-between gap-2 border-b border-border-subtle bg-surface-chat-background px-4 py-2.5">
        <Logo className="h-6 w-auto" dark={isDarkMode} />
        <div className="flex flex-none items-center gap-2">
          {view.verified ? (
            <span
              role="img"
              aria-label="Privacy verified"
              title="Privacy verified"
              className="flex items-center px-1 text-content-muted"
            >
              <TfLockLockedAnimated className="h-4 w-4" aria-hidden="true" />
            </span>
          ) : (
            !view.error && (
              <span
                role="status"
                aria-label="Verifying privacy"
                title="Verifying privacy"
                className="flex items-center px-1"
              >
                <LoadingDots size="small" />
              </span>
            )
          )}
          <button
            type="button"
            className={HEADER_BUTTON_CLASS_NAME}
            aria-label="New chat"
            title="New chat"
            onClick={() => void command({ kind: 'new' })}
          >
            <TfWriting2Animated className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={HEADER_BUTTON_CLASS_NAME}
            aria-label="Chats"
            title="Chats"
            aria-haspopup="dialog"
            onClick={() => setChatsOpen(true)}
          >
            <TfChat2Animated className="h-4 w-4" aria-hidden="true" />
          </button>
          <AccountMenu />
        </div>
      </header>

      <ChatsModal
        isOpen={chatsOpen}
        onClose={() => setChatsOpen(false)}
        chats={view.tasks}
        currentId={task?.id}
        onSelect={(id) => {
          void command({ kind: 'select', id })
          setChatsOpen(false)
        }}
        onDelete={(id) => void command({ kind: 'delete', id })}
      />

      <div
        ref={scroll}
        data-scroll-container="main"
        role="main"
        aria-label="Conversation"
        className="relative z-0 min-h-0 flex-1 overflow-y-auto bg-surface-chat-background"
        onScroll={() => {
          const element = scroll.current
          if (element)
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              FOLLOW_THRESHOLD_PX
        }}
      >
        {hasMessages ? (
          <div className="mx-auto w-full min-w-0 pb-6 pt-6 font-chat">
            {messages.map((message, index) => (
              <MessageView
                key={message.id}
                message={message}
                streaming={busy && index === messages.length - 1}
                isDarkMode={isDarkMode}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-full w-full flex-col items-center justify-center px-8 py-10">
            <h1 className="text-center text-2xl font-medium tracking-tight text-content-primary">
              {user?.firstName
                ? timeOfDayGreeting(user.firstName)
                : 'Tinfoil Browser'}
            </h1>
            <p className="mt-3 text-balance text-center text-sm leading-relaxed text-content-secondary">
              Ask about a page, or let Tinfoil get something done in your open
              tabs.
            </p>
            <div className="mt-8 flex w-full max-w-sm flex-col gap-2">
              {SUGGESTIONS.map((text) => (
                <button
                  type="button"
                  key={text}
                  onClick={() => {
                    setInput(text)
                    inputRef.current?.focus()
                  }}
                  className="inline-flex w-full items-center justify-center rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2.5 text-sm text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div
        data-chat-input-area
        className="relative z-10 min-w-0 flex-none px-4 pb-4"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="mx-auto max-w-3xl px-1"
        >
          {problem && (
            <ProblemNotice
              message={problem}
              action={
                task?.phase === 'interrupted' && (
                  <button
                    type="button"
                    className={NOTICE_BUTTON_CLASS_NAME}
                    onClick={() => void command({ kind: 'resume' })}
                  >
                    <TfRefreshTwoArrowsAnimated
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                    Resume task
                  </button>
                )
              }
            />
          )}
          {view.pending && (
            <ReviewCard
              pending={view.pending}
              onReview={(allow) =>
                void command({
                  kind: 'review',
                  executionId: view.pending!.executionId,
                  allow,
                })
              }
            />
          )}
          {busy && (
            <TaskStatus
              phase={task.phase}
              workingTab={view.workingTab}
              onPause={() => void command({ kind: 'pause' })}
              onResume={() => void command({ kind: 'resume' })}
              onStop={() => void command({ kind: 'stop' })}
            />
          )}
          <Composer
            input={input}
            setInput={setInput}
            onSubmit={() => void submit()}
            busy={busy}
            onCancel={() => void command({ kind: 'stop' })}
            cancelOnEscape={busy}
            inputRef={inputRef}
            inputMinHeight={
              hasMessages ? INPUT_MIN_HEIGHT : WELCOME_INPUT_MIN_HEIGHT
            }
            hasMessages={hasMessages}
            locked={sending}
            modelSelectorButton={
              models.length > 0 && (
                <ModelPicker
                  models={models}
                  autoLevels={autoLevels}
                  selectedModel={model}
                  onSelect={setModel}
                  reasoningEffort={effort}
                  onEffortChange={setEffort}
                  autoIntelligence={autoIntelligence}
                  onAutoIntelligenceChange={setAutoIntelligence}
                  isDarkMode={isDarkMode}
                />
              )
            }
          />
        </form>
      </div>
    </div>
  )
}
