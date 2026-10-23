import { GENUI_WIDGETS } from '@/components/chat/genui/registry'
import {
  ArtifactRetryError,
  type ArtifactRetryErrorCode,
} from '@/components/chat/genui/retry'
import { generateReverseId } from '@/utils/reverse-id'
import { now } from './local-threads'
import type { OpenAttachments } from './open-attachments'
import { uploaded } from './open-attachments'
import {
  presetIdOf,
  type OpenChat,
  type OpenChatResult,
  type PresetChoice,
} from './open-chat'
import { ERROR_CODES, ROUTES } from './protocol'
import type { RunController } from './run-controller'
import { getView, type HarnessAPI, type Profile } from './runtime'
import { HarnessError } from './sse'
import type { Store } from './store'
import type { ThreadStore, TurnSettings } from './thread-store'
import type { HarnessErrorBody, Session, ThreadMessage, Turn } from './types'

// What a widget's card says of a retry the harness refused or could not
// finish.
function widgetRetryFailure(
  detail: HarnessErrorBody | undefined,
): ArtifactRetryErrorCode {
  switch (detail?.code) {
    case ERROR_CODES.threadNotFound:
    case ERROR_CODES.toolUnavailable:
      return 'unavailable_target'
    case ERROR_CODES.revisionConflict:
      return 'stale_target'
    default:
      return 'request_failed'
  }
}

export interface TurnContext {
  api: HarnessAPI
  controller: RunController
  open: Store<OpenChat>
  attachments: OpenAttachments
  session?: Session
  // The profile with the session's defaults, which decides the default prompt.
  profile: Profile
  projectId?: string | null
  // Chats moving between the cloud and this device take no turns.
  moving: Map<string, Promise<unknown>>
  openStore(): ThreadStore
  patch(fields: Partial<OpenChat>): void
  report(cause: unknown): void
  // What a new chat's saved prompt chooses, which the harness applies.
  presetChoice(): PresetChoice
  // A new chat names the route it will open under.
  claim(threadId: string): void
  // Opens the chat the route names again, when nothing else reconnects.
  reopen(): Promise<OpenChatResult> | undefined
}

// The turns of the open chat: sending, regenerating, continuing, and what
// retries them, through the open chat's store and the run controller.
export function chatTurns({
  api,
  controller,
  open,
  attachments,
  session,
  profile,
  projectId,
  moving,
  openStore,
  patch,
  report,
  presetChoice,
  claim,
  reopen,
}: TurnContext) {
  // The fields every turn of the open chat has.
  const turnDefaults = (): Turn => ({
    clientRequestId: crypto.randomUUID(),
    threadId: open.get().id,
    kind: 'send',
    widgets: GENUI_WIDGETS.map((widget) => widget.name).filter((name) =>
      session?.widgets.includes(name),
    ),
    options: {
      model: open.get().model,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  })
  const turnSettings = (current: OpenChat): TurnSettings => ({
    first: !current.id || current.unsaved === current.id,
    presetId: presetIdOf(current, profile),
    presetChosen: current.presetChosen,
    projectId,
    profile: getView().profile,
  })
  // A new chat takes its id with its first turn, and keeps showing the
  // prompt it started with and the settings the prompt chose.
  function startChat(choice: PresetChoice): string {
    const current = open.get()
    if (current.id) return current.id
    const threadId = generateReverseId().id
    claim(threadId)
    patch({
      ...(current.presetChosen
        ? {}
        : {
            presetChosen: true,
            chosenPresetId: presetIdOf(current, profile),
          }),
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.webSearchEnabled !== undefined
        ? { webSearch: choice.webSearchEnabled }
        : {}),
      id: threadId,
      unsaved: threadId,
    })
    return threadId
  }
  // A new chat's first turn leaves the settings its prompt chooses to the
  // harness, which applies the prompt. Web search turned off in Settings
  // stays off whatever the prompt chooses.
  const leaveToPreset = (
    options: Turn['options'],
    choice: PresetChoice,
  ): Turn['options'] => {
    if (!options) return options
    const left = { ...options }
    if (choice.model) delete left.model
    if (choice.webSearchEnabled !== undefined && left.webSearch !== false)
      delete left.webSearch
    return left
  }
  // The message a turn adds, under the id the harness stores it with. A
  // message queued behind a running reply shows in the queue instead.
  function sentMessage(input: Turn): ThreadMessage | null {
    const { status } = controller.view.get()
    if (input.kind !== 'send' || status === 'streaming' || status === 'queued')
      return null
    const sent = uploaded(input.attachments)
    return {
      id: input.clientRequestId,
      role: 'user',
      createdAt: now(),
      content: input.content ?? '',
      ...(input.quote ? { quote: input.quote } : {}),
      ...(sent.length ? { attachments: sent } : {}),
    }
  }
  // A message the user sends shows at once, until the run's first window
  // replaces the messages.
  function showSent({ attachments: sent, ...message }: ThreadMessage) {
    controller.view.update((state) => ({
      ...state,
      messages: [
        ...state.messages,
        sent
          ? {
              ...message,
              attachments: sent.map(
                ({ base64: _base64, pages: _pages, ...shown }) => shown,
              ),
            }
          : message,
      ],
    }))
  }
  function send(fields: Partial<Turn> = {}): Promise<boolean> | undefined {
    const threads = openStore()
    if (controller.view.get().status === 'submitting') return
    if (threads.local && controller.startingThread() !== undefined) return
    const current = open.get()
    if (current.loadingId || (current.id && moving.has(current.id))) return
    patch({ failure: null })
    attachments.rememberSent(fields.attachments)
    let key: { key?: string }
    try {
      key = threads.runKey()
    } catch (cause) {
      report(cause)
      return
    }
    const settings = turnSettings(current)
    const choice = presetChoice()
    const threadId = startChat(choice)
    const defaults = turnDefaults()
    const shown = controller.track()
    const message = sentMessage({ ...defaults, ...fields })
    if (message) showSent(message)
    const status = controller.view.get().status
    const submit = (): Promise<boolean> => {
      controller.retryPreparation = null
      const submission =
        status === 'streaming' || status === 'queued'
          ? undefined
          : { threadId, cancelled: false }
      if (submission) {
        controller.submission = submission
        controller.view.update((state) => ({
          ...state,
          status: 'submitting',
          runId: undefined,
          error: undefined,
        }))
      }
      return (async () => {
        const turn = await threads.prepareTurn(
          threadId,
          {
            defaults: {
              ...defaults,
              options: leaveToPreset(defaults.options, choice),
            },
            fields: {
              ...fields,
              ...(fields.options
                ? { options: leaveToPreset(fields.options, choice) }
                : {}),
            },
            key,
          },
          settings,
        )
        if (!turn || !shown()) return false
        controller.pending = { input: turn.resend, run: turn.run }
        if (message) {
          await turn.keep?.(message)
        }
        if (!shown() || submission?.cancelled) {
          if (turn.run) controller.settle(turn.run)
          if (shown()) controller.pending = null
          return false
        }
        return controller.run(ROUTES.turn, turn.input, {
          device: turn.run,
          submission,
        })
      })()
        .catch((cause) => {
          if (shown()) {
            if (submission) controller.retryPreparation = submit
            report(cause)
          }
          return false
        })
        .finally(() => {
          if (submission && controller.submission === submission) {
            controller.submission = null
            controller.view.update((state) =>
              state.status === 'submitting'
                ? { ...state, status: 'idle' }
                : state,
            )
          }
        })
    }
    return submit()
  }
  // A refused content key rejects these actions instead of throwing, as
  // their callers report a rejection.
  async function cancel() {
    const state = controller.view.get()
    return controller.cancel({
      ...openStore().runKey(),
      threadId: open.get().id,
      runId: state.snapshot.thread?.activeRun?.runId ?? state.runId,
    })
  }
  // The harness regenerates the reply it is named. The message actions name
  // a message by its index: a reply, or the user message it answers. A user
  // message left without a reply is sent again with its own text. A run in
  // progress is stopped first.
  async function regenerate(index: number, fields: Partial<Turn> = {}) {
    const { messages, status } = controller.view.get()
    const target = messages[index]
    if (!target) return false
    const reply =
      target.role === 'assistant'
        ? target
        : messages[index + 1]?.role === 'assistant'
          ? messages[index + 1]
          : undefined
    const turn: Partial<Turn> = reply
      ? { kind: 'regenerate', messageId: reply.id, content: '' }
      : { kind: 'edit', messageId: target.id, content: target.content ?? '' }
    if (status === 'streaming' || status === 'queued')
      await cancel().catch(report)
    return send({ ...fields, ...turn })
  }
  // Asks the model to resume a reply where it stopped. The harness drops the
  // messages after it, so the continued reply ends the chat.
  function continueReply(index: number, fields: Partial<Turn> = {}) {
    const reply = controller.view.get().messages[index]
    if (reply?.role !== 'assistant') return
    return send({
      ...fields,
      kind: 'continue',
      messageId: reply.id,
      content: '',
    })
  }
  async function reconnect() {
    patch({ failure: null })
    if (controller.retryPreparation) return controller.retryPreparation()
    const threads = openStore()
    const threadId = open.get().id
    // A turn whose acceptance never arrived is sent again with its nonce,
    // which the harness answers with the run it may already have started.
    if (controller.pending) {
      const { input, run } = controller.pending
      if (run) controller.begin(run)
      return controller.run(
        ROUTES.turn,
        { ...input, ...threads.runKey() },
        { device: run },
      )
    }
    const state = controller.view.get()
    const runId = state.runId ?? state.snapshot.thread?.activeRun?.runId
    if (threadId && runId) {
      const { input, device: run } = await threads.follow(threadId, runId)
      return controller.run(ROUTES.follow, input, { device: run })
    }
    return reopen()
  }
  // Retries what failed. A run that ended with an error runs again, as the
  // harness decides from the chat: a continuation continues again, a reply
  // is regenerated, and a message left without a reply is answered. A
  // refused request or a dropped stream reconnects.
  async function retry(fields: Partial<Turn> = {}) {
    const { failedRun, status } = controller.view.get()
    if (!failedRun || status !== 'error') return reconnect()
    return send({ ...fields, kind: 'retry' })
  }
  // Asks the harness for new arguments for a widget call, while the chat
  // shows no run or error of its own. A retry that does not repair the
  // widget rejects with why.
  async function retryToolCall(fields: Partial<Turn>) {
    const threads = openStore()
    const current = open.get()
    const { status } = controller.view.get()
    if (
      !current.id ||
      current.loadingId ||
      moving.has(current.id) ||
      status === 'submitting' ||
      status === 'streaming' ||
      status === 'queued' ||
      (threads.local && controller.startingThread() !== undefined)
    )
      throw new ArtifactRetryError('unavailable_target')
    const shown = controller.track()
    const widgetRetry: { failure?: HarnessErrorBody } = {}
    let repaired: boolean
    try {
      const turn = await threads.prepareTurn(
        current.id,
        {
          defaults: turnDefaults(),
          fields: { ...fields, kind: 'retryToolCall', content: '' },
          key: threads.runKey(),
        },
        turnSettings(current),
      )
      if (!turn || !shown()) throw new ArtifactRetryError('unavailable_target')
      repaired = await controller.run(ROUTES.turn, turn.input, {
        device: turn.run,
        widgetRetry,
      })
    } catch (cause) {
      if (cause instanceof ArtifactRetryError) throw cause
      throw new ArtifactRetryError(
        widgetRetryFailure(
          cause instanceof HarnessError ? cause.detail : undefined,
        ),
        { cause },
      )
    }
    if (repaired) return true
    throw new ArtifactRetryError(widgetRetryFailure(widgetRetry.failure))
  }
  const queueInput = (queueId: string) => ({
    ...openStore().runKey(),
    threadId: open.get().id,
    queueId,
  })
  return {
    send,
    cancel,
    regenerate,
    continueReply,
    reconnect,
    retry,
    retryToolCall,
    sendQueued: async (queueId: string) =>
      controller.sendQueued(queueInput(queueId)),
    removeQueued: async (queueId: string) =>
      controller.removeQueued(queueInput(queueId)),
  }
}
