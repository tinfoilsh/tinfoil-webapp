import {
  ClerkProvider,
  SignIn,
  UserButton,
  useAuth,
  useClerk,
} from '@clerk/chrome-extension'
import type { Message } from '@tinfoil/chat-client/types'
import { Button } from '@tinfoil/chat-ui/button'
import {
  isImeComposition,
  isSubmitShortcut,
} from '@tinfoil/chat-ui/keyboard-utils'
import {
  StreamingMarkdown,
  type MarkdownComponents,
} from '@tinfoil/chat-ui/StreamingMarkdown'
import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createRoot } from 'react-dom/client'
import remarkGfm from 'remark-gfm'
import '../../../../../src/styles/tailwind.css'
import { webURL } from '../../browser/schema'
import {
  CLERK_PUBLISHABLE_KEY,
  DEFAULT_MODEL,
  HARNESS_URL,
  MAX_TABS,
} from '../../config'
import type { Command } from '../../messages'
import { PanelConnection } from '../../panel-connection'
import './style.css'

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
}
const SUGGESTIONS = [
  'Summarize the page I selected',
  'Compare these tabs and make a table',
  'Help me fill out this form',
]

function MessageView({
  message,
  streaming,
}: {
  message: Message
  streaming: boolean
}) {
  const tools = (message.timeline || []).filter(
    (block) => block.type === 'tool_call',
  )
  return (
    <article
      className={`message ${message.role === 'user' ? 'user-message' : ''}`}
    >
      <div className="message-label">
        {message.role === 'user' ? 'You' : 'Tinfoil'}
      </div>
      {!!tools.length && (
        <details className="steps">
          <summary>
            {tools.length} browser {tools.length === 1 ? 'step' : 'steps'}
          </summary>
          {tools.map((tool) => (
            <div key={tool.id} className="step">
              <strong>
                {tool.name === 'browser_action' ? 'Browser action' : tool.name}
              </strong>
              <pre>{tool.arguments}</pre>
              {tool.result !== undefined && (
                <pre>
                  {typeof tool.result === 'string'
                    ? tool.result
                    : JSON.stringify(tool.result, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </details>
      )}
      {message.role === 'user' ? (
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      ) : (
        <div className="markdown">
          <StreamingMarkdown
            text={message.content || ''}
            streaming={streaming}
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          />
        </div>
      )}
    </article>
  )
}

function ChatPanel({
  owner,
  getToken,
}: {
  owner: string
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>
}) {
  const connection = useMemo(
    () => new PanelConnection(owner, getToken),
    [owner, getToken],
  )
  const view = useSyncExternalStore(connection.subscribe, connection.snapshot)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [modelChoice, setModel] = useState<string>()
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  const [confirmActions, setConfirmActions] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(true)
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const task = view.task
  const busy = !!task && ['running', 'review', 'paused'].includes(task.phase)
  const models = view.session?.models.filter((model) => !model.deprecated) || []
  const model =
    modelChoice ||
    task?.model ||
    models.find((m) => m.id === DEFAULT_MODEL)?.id ||
    models[0]?.id ||
    DEFAULT_MODEL
  const selectedModel = models.find((m) => m.id === model)

  useEffect(() => connection.connect(), [connection])
  useEffect(() => {
    let active = true
    const refresh = () => {
      void chrome.tabs
        .query({ currentWindow: true })
        .then((all) => {
          if (active)
            setTabs(
              all.filter((tab) => {
                try {
                  webURL(tab.url || '')
                  return !!tab.id
                } catch {
                  return false
                }
              }),
            )
        })
        .catch(() => {
          if (active) setError('Could not read the tabs in this window.')
        })
    }
    refresh()
    chrome.tabs.onUpdated.addListener(refresh)
    chrome.tabs.onRemoved.addListener(refresh)
    chrome.tabs.onActivated.addListener(refresh)
    return () => {
      active = false
      chrome.tabs.onUpdated.removeListener(refresh)
      chrome.tabs.onRemoved.removeListener(refresh)
      chrome.tabs.onActivated.removeListener(refresh)
    }
  }, [])
  useEffect(() => {
    const element = scroll.current
    if (following.current && element) element.scrollTop = element.scrollHeight
  }, [task?.state.messages, task?.phase, view.pending])

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
        tabs: selected,
        model,
        effort,
        confirmActions,
      })
      setInput('')
      setScopeOpen(false)
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
    <div className="app">
      <header className="header">
        <div>
          <strong className="brand">tinfoil</strong>
          <span className="beta">BROWSER BETA</span>
        </div>
        <div className="header-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHistoryOpen(!historyOpen)}
            aria-expanded={historyOpen}
          >
            History
          </Button>
          <Button
            variant="solid"
            size="sm"
            onClick={() => void command({ kind: 'new' })}
          >
            New
          </Button>
          <UserButton />
        </div>
      </header>
      <div className="privacy-strip">
        <span className={view.verified ? 'verified-dot' : 'pending-dot'} />
        {view.verified ? 'Attested connection' : 'Connecting privately…'}
        <span>History stays here</span>
      </div>
      {historyOpen && (
        <section className="history">
          <h2>Local chats</h2>
          {view.tasks.length ? (
            view.tasks.map((item) => (
              <div key={item.id} className="history-row">
                <button
                  onClick={() => {
                    void command({ kind: 'select', id: item.id })
                    setHistoryOpen(false)
                  }}
                >
                  {item.title}
                </button>
                <button
                  aria-label={`Delete ${item.title}`}
                  onClick={() => void command({ kind: 'delete', id: item.id })}
                >
                  Delete
                </button>
              </div>
            ))
          ) : (
            <p>No saved chats yet.</p>
          )}
        </section>
      )}
      <div
        className="conversation"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current
          if (el)
            following.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {!task?.state.messages.length && (
          <div className="welcome">
            <div className="welcome-symbol" aria-hidden>
              tf
            </div>
            <h1>
              Your browser.
              <br />
              Privately.
            </h1>
            <p>
              Ask about a page or let Tinfoil help you get something done.
              Choose the tabs it can use below.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((text) => (
                <button key={text} onClick={() => setInput(text)}>
                  {text}
                  <span aria-hidden>↗</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {task?.state.messages.map((message, index, all) => (
          <MessageView
            key={message.id}
            message={message}
            streaming={busy && index === all.length - 1}
          />
        ))}
        {busy && (
          <div role="status" className="task-status">
            {task.phase === 'review'
              ? 'Waiting for your review'
              : task.phase === 'paused'
                ? 'Paused'
                : 'Working…'}
          </div>
        )}
        {view.pending && (
          <section className="review-card">
            <h2>Review browser action</h2>
            <p>{view.pending.preview}</p>
            <pre>{JSON.stringify(view.pending.operation, null, 2)}</pre>
            <div className="controls">
              <Button
                variant="solid"
                onClick={() =>
                  void command({
                    kind: 'review',
                    executionId: view.pending!.executionId,
                    allow: true,
                  })
                }
              >
                Allow action
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void command({
                    kind: 'review',
                    executionId: view.pending!.executionId,
                    allow: false,
                  })
                }
              >
                Decline
              </Button>
            </div>
          </section>
        )}
        {(error || view.error || task?.error) && (
          <div className="notice" role="alert">
            {error || view.error || task?.error}
          </div>
        )}
        {task?.phase === 'interrupted' && (
          <Button
            variant="outline"
            onClick={() => void command({ kind: 'resume', tabs: selected })}
          >
            Resume with selected tabs
          </Button>
        )}
      </div>
      <footer className="composer-area">
        {busy && (
          <div className="controls">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void command(
                  task.phase === 'paused'
                    ? { kind: 'resume', tabs: selected }
                    : { kind: 'pause' },
                )
              }
            >
              {task.phase === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void command({ kind: 'stop' })}
            >
              Stop / take over
            </Button>
            <span className="shortcut">Alt+Shift+S</span>
          </div>
        )}
        <button
          className="scope-toggle"
          aria-expanded={scopeOpen}
          onClick={() => setScopeOpen(!scopeOpen)}
        >
          {selected.length
            ? `${selected.length} selected ${selected.length === 1 ? 'tab' : 'tabs'}`
            : 'Select browser tabs'}
          <span>{scopeOpen ? '−' : '+'}</span>
        </button>
        {scopeOpen && (
          <div className="scope">
            <p>
              Only selected tabs and tabs opened by this task are available to
              the agent.
            </p>
            {tabs.map((tab) => (
              <label key={tab.id} className="tab-choice">
                <input
                  type="checkbox"
                  checked={selected.includes(tab.id!)}
                  disabled={
                    busy ||
                    (!selected.includes(tab.id!) && selected.length >= MAX_TABS)
                  }
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, tab.id!]
                        : selected.filter((id) => id !== tab.id),
                    )
                  }
                />
                <span>
                  <strong>{tab.title}</strong>
                  <small>{new URL(tab.url!).hostname}</small>
                </span>
              </label>
            ))}
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={confirmActions}
                disabled={busy}
                onChange={(e) => setConfirmActions(e.target.checked)}
              />
              Review actions before execution
            </label>
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="composer"
        >
          <textarea
            disabled={sending}
            aria-label="Message Tinfoil"
            placeholder={
              busy ? 'Give another instruction…' : 'What would you like to do?'
            }
            value={input}
            rows={3}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(event) => {
              if (!isImeComposition(event) && isSubmitShortcut(event, false)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <div className="composer-toolbar">
            <select
              aria-label="Model"
              value={model}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.shortLabel || m.label}
                </option>
              ))}
            </select>
            {selectedModel?.reasoning?.effort && (
              <select
                aria-label="Reasoning effort"
                value={effort}
                disabled={busy}
                onChange={(e) => setEffort(e.target.value as typeof effort)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            )}
            <Button
              variant="solid"
              type="submit"
              size="sm"
              disabled={sending || !input.trim() || !view.session}
            >
              {sending ? 'Starting…' : busy ? 'Update task' : 'Send'}
            </Button>
          </div>
        </form>
        <div className="footer-note">
          {new URL(HARNESS_URL).host} · Chats are saved in this extension.
        </div>
      </footer>
    </div>
  )
}

function SignedInApp() {
  const { isLoaded, userId } = useAuth()
  const clerk = useClerk()
  const getToken = useCallback(
    async (options?: { skipCache?: boolean }) => {
      const session = clerk.session
      if (!session || session.user.id !== userId)
        throw new Error('The signed-in account changed.')
      const token = await session.getToken(options)
      if (clerk.session !== session || clerk.user?.id !== userId)
        throw new Error('The signed-in account changed.')
      return token
    },
    [clerk, userId],
  )
  if (!isLoaded)
    return (
      <div className="setup" role="status">
        Opening Tinfoil…
      </div>
    )
  if (!userId)
    return (
      <div className="setup">
        <h1>Tinfoil Browser</h1>
        <p>Sign in to use private models with your browser.</p>
        <SignIn routing="hash" />
      </div>
    )
  return <ChatPanel key={userId} owner={userId} getToken={getToken} />
}

function App() {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () =>
      document.documentElement.classList.toggle('dark', media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  if (!CLERK_PUBLISHABLE_KEY)
    return (
      <div className="setup">
        <h1>Tinfoil Browser</h1>
        <p>
          Set <code>WXT_CLERK_PUBLISHABLE_KEY</code> and{' '}
          <code>WXT_CLERK_FRONTEND_API</code> in{' '}
          <code>apps/extension/.env</code>, then reload the extension.
        </p>
        <p>The development commands are in DEVELOPMENT.md.</p>
      </div>
    )
  const url = chrome.runtime.getURL('sidepanel.html')
  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      telemetry={{ disabled: true }}
      afterSignOutUrl={url}
      signInFallbackRedirectUrl={url}
      signUpFallbackRedirectUrl={url}
    >
      <SignedInApp />
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
