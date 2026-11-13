import { HarnessError } from '@tinfoil/chat-client/sse'
import {
  PANEL_HEARTBEAT_MS,
  PANEL_PORT,
  PANEL_RECONNECT_DELAYS_MS,
  PANEL_SETTLED_MS,
} from './config'
import type { Command, ToPanel, View } from './messages'

const CONNECTION_CLOSED =
  'The extension connection closed. Reopen the panel to reconnect.'
const OPEN_ELSEWHERE =
  'Tinfoil is open in another window. Reopen this panel to use it here.'
// What a request is answered with when the worker stopped before it could
// answer: the panel connects again, and the request can be made again.
const WORKER_STOPPED = 'The extension restarted before it answered. Try again.'

// A recording as the text it crosses to the worker in.
function base64(audio: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(audio)
  })
}

export class PanelConnection {
  private port?: chrome.runtime.Port
  private view: View = { tasks: [], verified: false }
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (cause: unknown) => void }
  >()
  private readonly transcripts = new Map<
    string,
    { resolve: (text: string) => void; reject: (cause: unknown) => void }
  >()
  constructor(
    private readonly owner: string,
    private readonly token: (options?: {
      skipCache?: boolean
    }) => Promise<string | null>,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.view
  private update(view: View) {
    this.view = view
    for (const listener of this.listeners) listener()
  }
  // Connects the panel to the worker until the function returned is called.
  // The browser stops a worker that has nothing to do, and one it has
  // stopped is started by connecting to it, so a connection the worker
  // closed is made again.
  connect() {
    let closed = false
    // How many connections in a row closed soon after they were made, as
    // those to a worker that cannot run do.
    let unsettled = 0
    let waiting: ReturnType<typeof setTimeout> | undefined
    let leave = () => {}
    const lost = (error: string) => this.update({ ...this.view, error })
    const open = () => {
      document.removeEventListener('visibilitychange', open)
      if (closed) return
      let port: chrome.runtime.Port
      try {
        port = chrome.runtime.connect({ name: PANEL_PORT })
      } catch {
        // The extension this panel belongs to is gone, as once it has been
        // reloaded.
        lost(CONNECTION_CLOSED)
        return
      }
      const opened = Date.now()
      let replaced = false
      const heartbeat = setInterval(
        () => port.postMessage({ type: 'ping' }),
        PANEL_HEARTBEAT_MS,
      )
      this.port = port
      leave = () => {
        clearInterval(heartbeat)
        port.disconnect()
      }
      port.onMessage.addListener((message: ToPanel) => {
        if (message.type === 'state') this.update(message.view)
        if (message.type === 'replaced') replaced = true
        if (message.type === 'result') {
          const pending = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) pending?.reject(new Error(message.error))
          else pending?.resolve()
        }
        if (message.type === 'transcript') {
          const pending = this.transcripts.get(message.id)
          this.transcripts.delete(message.id)
          if ('text' in message) pending?.resolve(message.text)
          // What the chat service refused is refused here in its own terms,
          // which say whether trying again can help.
          else if (message.refusal)
            pending?.reject(
              new HarnessError(message.refusal.detail, message.refusal.status),
            )
          else pending?.reject(new Error(message.error))
        }
        if (message.type === 'token') {
          // A sign-in that has ended answers with no token. One that could
          // not be asked about says so, as it may answer the next time.
          void this.token({ skipCache: message.skipCache }).then(
            (token) => {
              if (this.port === port)
                port.postMessage({ type: 'token', id: message.id, token })
            },
            () => {
              if (this.port === port)
                port.postMessage({
                  type: 'token',
                  id: message.id,
                  token: null,
                  failed: true,
                })
            },
          )
        }
      })
      port.onDisconnect.addListener(() => {
        clearInterval(heartbeat)
        // Chrome expects the reason it gives for a closed connection to be
        // read.
        void chrome.runtime.lastError
        if (this.port !== port) return
        this.port = undefined
        // The panel that took this one's place keeps it, until this one is
        // opened again.
        if (replaced) {
          this.abandon(new Error(OPEN_ELSEWHERE))
          if (!closed) lost(OPEN_ELSEWHERE)
          return
        }
        this.abandon(new Error(WORKER_STOPPED))
        if (closed) return
        unsettled = Date.now() - opened < PANEL_SETTLED_MS ? unsettled + 1 : 0
        if (unsettled > PANEL_RECONNECT_DELAYS_MS.length) {
          lost(CONNECTION_CLOSED)
          return
        }
        // A panel out of sight waits to be looked at, as it would only wake
        // a worker that is stopped again before anyone sees it.
        if (document.visibilityState === 'hidden')
          document.addEventListener('visibilitychange', open)
        else
          waiting = setTimeout(
            open,
            unsettled ? PANEL_RECONNECT_DELAYS_MS[unsettled - 1] : 0,
          )
      })
      // A panel that lost its connection goes on in the chat it shows.
      const shown = this.view.task?.id
      port.postMessage({
        type: 'hello',
        owner: this.owner,
        ...(shown ? { shown } : {}),
      })
    }
    open()
    return () => {
      closed = true
      clearTimeout(waiting)
      document.removeEventListener('visibilitychange', open)
      this.port = undefined
      this.abandon(new Error('The panel was closed.'))
      leave()
    }
  }
  // Answers everything the panel still waits on with why no answer comes.
  private abandon(cause: Error) {
    for (const pending of [
      ...this.pending.values(),
      ...this.transcripts.values(),
    ])
      pending.reject(cause)
    this.pending.clear()
    this.transcripts.clear()
  }
  // Has the worker turn a recording into its text.
  async transcribe(audio: File, signal?: AbortSignal): Promise<string> {
    const encoded = await base64(audio)
    signal?.throwIfAborted()
    const port = this.port
    if (!port) throw new Error('Reopen the panel to reconnect.')
    const id = crypto.randomUUID()
    return new Promise<string>((resolve, reject) => {
      const aborted = () => {
        this.transcripts.delete(id)
        // The worker gives the recording up too.
        if (this.port === port) port.postMessage({ type: 'cancel', id })
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', aborted, { once: true })
      this.transcripts.set(id, {
        resolve: (text) => {
          signal?.removeEventListener('abort', aborted)
          resolve(text)
        },
        reject: (cause) => {
          signal?.removeEventListener('abort', aborted)
          reject(cause)
        },
      })
      port.postMessage({
        type: 'transcribe',
        id,
        audio: encoded,
        mimeType: audio.type,
      })
    })
  }
  async command(command: Command) {
    const port = this.port
    if (!port) throw new Error('Reopen the panel to reconnect.')
    const id = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      port.postMessage({ type: 'command', id, command })
    })
  }
}
