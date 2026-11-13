import { HarnessClient } from '@tinfoil/chat-client/client'
import { logError } from '@tinfoil/chat-client/logging'
import { defineBackground } from 'wxt/utils/define-background'
import {
  CONTROLPLANE_URL,
  HARNESS_URL,
  PANEL_PORT,
  TOKEN_TIMEOUT_MS,
} from '../config'
import { TaskController, errorText } from '../controller'
import {
  commandEnvelopeSchema,
  toWorkerSchema,
  type ToPanel,
} from '../messages'
import { reviewActions } from '../settings'
import { TaskStore } from '../storage'

export default defineBackground(() => {
  const store = new TaskStore()
  let current:
    { controller: TaskController; port: chrome.runtime.Port } | undefined
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((cause) => logError('Unable to enable side panel', cause))
    void chrome.storage.local
      .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      .catch((cause) => logError('Unable to restrict extension storage', cause))
  })
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'stop-task')
      void current?.controller
        .stop()
        .catch((cause) => logError('Unable to stop task', cause))
  })
  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender
    const url = new URL(sender?.url || 'about:blank')
    if (
      port.name !== PANEL_PORT ||
      sender?.id !== chrome.runtime.id ||
      url.protocol !== 'chrome-extension:' ||
      url.hostname !== chrome.runtime.id ||
      url.pathname !== '/sidepanel.html'
    ) {
      port.disconnect()
      return
    }
    let disconnected = false
    let lastToken: string | null = null
    let controller: TaskController | undefined
    const tokens = new Map<
      string,
      {
        resolve: (token: string | null) => void
        reject: (cause: unknown) => void
      }
    >()
    const send = (message: ToPanel) => {
      if (!disconnected) port.postMessage(message)
    }
    const getToken = async (options?: {
      skipCache?: boolean
    }): Promise<string | null> => {
      if (disconnected) {
        if (!lastToken || options?.skipCache)
          throw new Error('Sign in again to continue.')
        return lastToken
      }
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          tokens.delete(id)
          reject(new Error('Sign-in did not respond. Reopen the panel.'))
        }, TOKEN_TIMEOUT_MS)
        tokens.set(id, {
          resolve: (token) => {
            clearTimeout(timer)
            lastToken = token
            if (token) resolve(token)
            else reject(new Error('Sign in again to continue.'))
          },
          reject: (cause) => {
            clearTimeout(timer)
            reject(cause)
          },
        })
        send({ type: 'token', id, skipCache: options?.skipCache })
      })
    }
    port.onMessage.addListener((raw: unknown) => {
      const parsed = toWorkerSchema.safeParse(raw)
      if (!parsed.success) {
        // A command the panel waits on is answered even when it is refused.
        const refused = commandEnvelopeSchema.safeParse(raw)
        if (refused.success)
          send({
            type: 'result',
            id: refused.data.id,
            error: 'That request could not be understood.',
          })
        return
      }
      const message = parsed.data
      if (message.type === 'token') {
        tokens.get(message.id)?.resolve(message.token)
        tokens.delete(message.id)
        return
      }
      if (message.type === 'hello') {
        if (controller) return
        const previous = current
        controller = new TaskController(
          new HarnessClient(HARNESS_URL, getToken, undefined, CONTROLPLANE_URL),
          message.owner,
          store,
          (view) => send({ type: 'state', view }),
          () => reviewActions.getValue(),
        )
        current = { controller, port }
        const ready = previous
          ? previous.controller
              .dispose()
              .finally(() => previous.port.disconnect())
          : Promise.resolve()
        void controller.initialize(ready).catch((cause) =>
          send({
            type: 'state',
            view: { tasks: [], verified: false, error: errorText(cause) },
          }),
        )
      } else if (message.type === 'command') {
        void (
          controller
            ? controller.command(message.command)
            : Promise.reject(new Error('Sign in first.'))
        ).then(
          () => send({ type: 'result', id: message.id }),
          (cause) =>
            send({ type: 'result', id: message.id, error: errorText(cause) }),
        )
      }
    })
    port.onDisconnect.addListener(() => {
      disconnected = true
      for (const token of tokens.values()) token.resolve(lastToken)
      tokens.clear()
      if (current?.port === port) current = undefined
      void controller
        ?.dispose()
        .catch((cause) => logError('Unable to close task', cause))
        .finally(() => {
          lastToken = null
        })
    })
  })
})
