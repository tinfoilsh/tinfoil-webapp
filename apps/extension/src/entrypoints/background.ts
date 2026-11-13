import { HarnessClient } from '@tinfoil/chat-client/client'
import { DICTATION } from '@tinfoil/chat-client/dictation-constants'
import { logError } from '@tinfoil/chat-client/logging'
import { ERROR_ACTIONS, ERROR_CODES } from '@tinfoil/chat-client/protocol'
import { HarnessError } from '@tinfoil/chat-client/sse'
import { defineBackground } from 'wxt/utils/define-background'
import {
  CONTROLPLANE_URL,
  HARNESS_URL,
  PANEL_PORT,
  TOKEN_TIMEOUT_MS,
} from '../config'
import { TaskController, errorText } from '../controller'
import {
  requestEnvelopeSchema,
  toWorkerSchema,
  type ToPanel,
  type View,
} from '../messages'
import { catalog, privacyVerified, reviewActions } from '../settings'
import { TaskStore } from '../storage'

// Why a request fails when the panel has no sign-in to make it with, which
// no number of attempts changes.
const signedOut = () =>
  new HarnessError(
    {
      code: ERROR_CODES.unauthenticated,
      action: ERROR_ACTIONS.reauthenticate,
      message: 'Sign in again to continue.',
    },
    401,
  )

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
  // No panel has verified the service for a worker that is starting.
  void privacyVerified
    .setValue(false)
    .catch((cause) => logError('Unable to share the session', cause))
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
    // What the settings page shows of this panel's session: the models it
    // offers and whether the service was verified, written as they change.
    // The first is always written, over what a panel before this one left.
    let shared: Pick<View, 'session' | 'verified'> | undefined
    const share = (view: View) => {
      if (
        shared &&
        view.session === shared.session &&
        view.verified === shared.verified
      )
        return
      shared = { session: view.session, verified: view.verified }
      void Promise.all([
        privacyVerified.setValue(view.verified),
        ...(view.session
          ? [
              catalog.setValue({
                models: view.session.models,
                auto: view.session.auto,
                defaultModel: view.session.defaultModel,
              }),
            ]
          : []),
      ]).catch((cause) => logError('Unable to share the session', cause))
    }
    let controller: TaskController | undefined
    // The recordings being transcribed for this panel, to give up when it
    // does.
    const transcribing = new Map<string, AbortController>()
    const tokens = new Map<
      string,
      {
        resolve: (token: string | null, failed?: boolean) => void
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
        if (!lastToken || options?.skipCache) throw signedOut()
        return lastToken
      }
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          tokens.delete(id)
          reject(new Error('Sign-in did not respond. Reopen the panel.'))
        }, TOKEN_TIMEOUT_MS)
        tokens.set(id, {
          resolve: (token, failed) => {
            clearTimeout(timer)
            // A sign-in the panel could not ask about may answer the next
            // time, where one that has ended will not.
            if (failed) {
              reject(
                new Error(
                  'Your sign-in could not be confirmed. Check your connection and try again.',
                ),
              )
              return
            }
            lastToken = token
            if (token) resolve(token)
            else reject(signedOut())
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
        // A request the panel waits on is answered even when it is refused.
        const refused = requestEnvelopeSchema.safeParse(raw)
        if (refused.success) {
          const { id, type } = refused.data
          const error = 'That request could not be understood.'
          send(
            type === 'command'
              ? { type: 'result', id, error }
              : { type: 'transcript', id, error },
          )
        }
        return
      }
      const message = parsed.data
      if (message.type === 'token') {
        tokens.get(message.id)?.resolve(message.token, message.failed)
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
          (view) => {
            send({ type: 'state', view })
            if (!disconnected) share(view)
          },
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
      } else if (message.type === 'transcribe') {
        const { id, audio, mimeType } = message
        const given = new AbortController()
        transcribing.set(id, given)
        // A recording that cannot be read is answered like any other
        // failure.
        void Promise.resolve()
          .then(() => {
            if (!controller) throw signedOut()
            return controller.transcribe(
              new File(
                [Uint8Array.from(atob(audio), (byte) => byte.charCodeAt(0))],
                DICTATION.FILE_NAME,
                { type: mimeType },
              ),
              given.signal,
            )
          })
          .then(
            (text) => send({ type: 'transcript', id, text }),
            (cause) =>
              send({
                type: 'transcript',
                id,
                error: errorText(cause),
                ...(cause instanceof HarnessError
                  ? { refusal: { detail: cause.detail, status: cause.status } }
                  : {}),
              }),
          )
          .finally(() => {
            if (transcribing.get(id) === given) transcribing.delete(id)
          })
      } else if (message.type === 'cancel') {
        transcribing.get(message.id)?.abort()
      }
    })
    port.onDisconnect.addListener(() => {
      disconnected = true
      if (current?.port === port)
        void privacyVerified
          .setValue(false)
          .catch((cause) => logError('Unable to share the session', cause))
      for (const token of tokens.values()) token.resolve(lastToken)
      tokens.clear()
      for (const given of transcribing.values()) given.abort()
      transcribing.clear()
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
