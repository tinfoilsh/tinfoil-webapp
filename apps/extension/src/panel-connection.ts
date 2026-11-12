import { PANEL_HEARTBEAT_MS, PANEL_PORT, TOKEN_TIMEOUT_MS } from './config'
import type { Command, ToPanel, View } from './messages'

export class PanelConnection {
  private port?: chrome.runtime.Port
  private view: View = { tasks: [], verified: false }
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (cause: unknown) => void }
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
  connect() {
    const port = chrome.runtime.connect({ name: PANEL_PORT })
    const heartbeat = setInterval(
      () => port.postMessage({ type: 'ping' }),
      PANEL_HEARTBEAT_MS,
    )
    this.port = port
    port.onMessage.addListener((message: ToPanel) => {
      if (message.type === 'state') this.update(message.view)
      if (message.type === 'result') {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending?.reject(new Error(message.error))
        else pending?.resolve()
      }
      if (message.type === 'token') {
        void this.token({ skipCache: message.skipCache }).then(
          (token) => {
            if (this.port === port)
              port.postMessage({ type: 'token', id: message.id, token })
          },
          () => {
            if (this.port === port)
              port.postMessage({ type: 'token', id: message.id, token: null })
          },
        )
      }
    })
    port.onDisconnect.addListener(() => {
      clearInterval(heartbeat)
      if (this.port !== port) return
      this.port = undefined
      this.update({
        ...this.view,
        error:
          'The extension connection closed. Reopen the panel to reconnect.',
      })
      for (const pending of this.pending.values())
        pending.reject(new Error('The extension disconnected.'))
      this.pending.clear()
    })
    port.postMessage({ type: 'hello', owner: this.owner })
    return () => {
      clearInterval(heartbeat)
      this.port = undefined
      for (const pending of this.pending.values())
        pending.reject(new Error('The panel was closed.'))
      this.pending.clear()
      port.disconnect()
    }
  }
  async command(command: Command) {
    const port = this.port
    if (!port) throw new Error('Reopen the panel to reconnect.')
    const id = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The extension did not respond.'))
      }, TOKEN_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timeout)
          resolve()
        },
        reject: (cause) => {
          clearTimeout(timeout)
          reject(cause)
        },
      })
      port.postMessage({ type: 'command', id, command })
    })
  }
}
