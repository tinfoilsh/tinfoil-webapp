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
import { ERROR_ACTIONS, ERROR_CODES, ROUTES } from './protocol'
import type { AnswerSaves } from './question-answers'
import {
  isRunning,
  isStopping,
  unstopped,
  withoutSending,
  withSending,
} from './reducer'
import type { RunController } from './run-controller'
import { getView, type HarnessAPI, type Profile } from './runtime'
import { HarnessError } from './sse'
import type { Store } from './store'
import type { ThreadStore, TurnSettings } from './thread-store'
import type {
  HarnessErrorBody,
  Message,
  QueueItem,
  Session,
  ThreadMessage,
  Turn,
} from './types'
import { shownMessages } from './view-model'

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
  // The answers picked in questions widgets that are not saved yet.
  answers: AnswerSaves
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

// The turns a research may answer: those that answer a question anew.
const RESEARCH_KINDS: readonly Turn['kind'][] = [
  'send',
  'edit',
  'regenerate',
  'retry',
]

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
  answers,
  openStore,
  patch,
  report,
  presetChoice,
  claim,
  reopen,
}: TurnContext) {
  // The fields every turn of the open chat has.
  const turnDefaults = (threadId: string): Turn => ({
    clientRequestId: crypto.randomUUID(),
    threadId,
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
  // A turn the open chat researches says so, while the session offers it.
  const researched = (
    options: Turn['options'],
    research: boolean,
  ): Turn['options'] => (research ? { ...options, research: true } : options)
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
  // A message sent while a reply runs, as the queue shows it until the
  // harness lists it there.
  function queuedMessage(input: Turn): QueueItem | null {
    const { status } = controller.view.get()
    if (
      input.kind !== 'send' ||
      (status !== 'streaming' && status !== 'queued')
    )
      return null
    return {
      queueId: input.clientRequestId,
      kind: input.kind,
      content: input.content ?? null,
      quote: input.quote ?? null,
      attachments: uploaded(input.attachments).map(
        ({ id, kind, fileName, mimeType, size, thumbnail }) => ({
          id,
          kind,
          fileName,
          mimeType,
          size,
          thumbnail,
        }),
      ),
      createdAt: now(),
    }
  }
  // A message as the view shows it, without its uploads' contents.
  const shownMessage = ({
    attachments: sent,
    ...message
  }: ThreadMessage): Message =>
    sent
      ? {
          ...message,
          attachments: sent.map(
            ({ base64: _base64, pages: _pages, ...shown }) => shown,
          ),
        }
      : message
  // A message the user sends shows at once, until the run's first window
  // replaces the messages.
  function showSent(message: ThreadMessage) {
    controller.view.update((state) => ({
      ...state,
      messages: [...state.messages, shownMessage(message)],
    }))
  }
  // The messages a turn that regenerates, edits or continues leaves, as the
  // harness applies it: the messages after the one it names go, and an
  // edited message is sent again under the turn's id. A turn queued behind
  // a running reply changes nothing yet.
  function appliedTurn(input: Turn): Message[] | null {
    const { messages, status } = controller.view.get()
    if (status === 'streaming' || status === 'queued') return null
    const index = messages.findIndex(({ id }) => id === input.messageId)
    const target = messages[index]
    if (!target) return null
    if (input.kind === 'regenerate' || input.kind === 'continue')
      return target.role === 'assistant'
        ? messages.slice(0, input.kind === 'continue' ? index + 1 : index)
        : null
    if (input.kind !== 'edit' || target.role !== 'user') return null
    const quote = input.quote ?? target.quote
    const sent = input.attachments
      ? uploaded(input.attachments)
      : (target.attachments ?? [])
    return [
      ...messages.slice(0, index),
      shownMessage({
        id: input.clientRequestId,
        role: 'user',
        createdAt: now(),
        content: input.content ?? target.content ?? '',
        ...(quote ? { quote } : {}),
        ...(sent.length ? { attachments: sent } : {}),
      }),
    ]
  }
  function send(fields: Partial<Turn> = {}): Promise<boolean> | undefined {
    // A turn sent while the reply stops goes once it stopped, since the
    // harness ends the turns queued behind a reply it stops. Another turn
    // is refused until then, as one sent while a turn is submitted is.
    if (isStopping(controller.view.get())) {
      if (controller.holding) return
      controller.holding = true
      const shown = controller.track()
      return controller.stopped().then(() => {
        controller.holding = false
        return (shown() && send(fields)) || false
      })
    }
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
    const research =
      current.research &&
      !!session?.features.research &&
      RESEARCH_KINDS.includes(fields.kind ?? 'send')
    const threadId = startChat(choice)
    const defaults = turnDefaults(threadId)
    const shown = controller.track()
    const before = controller.view.get().messages
    const message = sentMessage({ ...defaults, ...fields })
    if (message) showSent(message)
    const queued = queuedMessage({ ...defaults, ...fields })
    if (queued) controller.view.update((state) => withSending(state, queued))
    const applied = appliedTurn({ ...defaults, ...fields })
    if (applied)
      controller.view.update((state) => ({ ...state, messages: applied }))
    // A turn that did not start leaves the chat as the harness stores it.
    const unapply = () => {
      if (applied && shown() && controller.view.get().messages === applied)
        controller.view.update((state) => ({ ...state, messages: before }))
    }
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
          stopping: undefined,
          compactTurn: fields.kind === 'compact' || undefined,
          compacted: undefined,
        }))
      }
      return (async () => {
        // A question sends the answers the user picked, so it waits for the
        // chat to save them. The picks of a widget the chat no longer offers
        // are left out.
        for (
          let saving = answers.flush(threadId);
          saving;
          saving = answers.flush(threadId)
        ) {
          try {
            await saving
          } catch (cause) {
            if (
              !(cause instanceof HarnessError) ||
              cause.detail.action !== ERROR_ACTIONS.reload ||
              !answers.forgetFailed(threadId)
            )
              throw cause
          }
        }
        const turn = await threads.prepareTurn(
          threadId,
          {
            defaults: {
              ...defaults,
              options: researched(
                leaveToPreset(defaults.options, choice),
                research,
              ),
            },
            fields: {
              ...fields,
              ...(fields.options
                ? {
                    options: researched(
                      leaveToPreset(fields.options, choice),
                      research,
                    ),
                  }
                : {}),
            },
            key,
          },
          settings,
        )
        if (!turn || !shown()) {
          unapply()
          return false
        }
        const pending = { input: turn.resend, run: turn.run }
        controller.pending = pending
        if (message) {
          await turn.keep?.(message)
        }
        if (!shown() || submission?.cancelled) {
          if (turn.run) controller.settle(turn.run)
          if (shown()) controller.pending = null
          // The message a device chat kept shows the reply it never asked
          // for as stopped.
          if (shown() && message && turn.keep)
            controller.markCanceled([message.id])
          unapply()
          return false
        }
        const ran = await controller.run(ROUTES.turn, turn.input, {
          device: turn.run,
          submission,
        })
        if (controller.pending === pending) unapply()
        // A research's report ends the open chat's research. A reply that
        // only asked what it needs to know leaves it on for the answers, and
        // one that failed for a retry.
        if (
          ran &&
          research &&
          shown() &&
          controller.view.get().messages.at(-1)?.research
        )
          patch({ research: false })
        return ran
      })()
        .catch((cause) => {
          if (shown()) {
            if (submission) controller.retryPreparation = submit
            report(cause)
          }
          unapply()
          return false
        })
        .finally(() => {
          if (queued && shown())
            controller.view.update((state) =>
              withoutSending(state, queued.queueId),
            )
          if (submission && controller.submission === submission) {
            controller.submission = null
            controller.view.update((state) =>
              state.status === 'submitting'
                ? { ...state, status: 'idle', stopping: undefined }
                : state,
            )
          }
        })
    }
    return submit()
  }
  // A refused content key rejects these actions instead of throwing, as
  // their callers report a rejection.
  // The chat shows its reply stopping at once, and a stop asked again while
  // it does sends nothing.
  async function cancel() {
    const state = controller.view.get()
    if (isStopping(state)) return
    const input = {
      ...openStore().runKey(),
      threadId: open.get().id,
      runId: state.snapshot.thread?.activeRun?.runId ?? state.runId,
    }
    if (!isRunning(state)) return controller.cancel(input)
    const shown = controller.track()
    controller.view.update((current) => ({
      ...current,
      stopping: true,
      held: undefined,
    }))
    // A reply already streaming is the one stopped, which keeps saying so
    // even if the chat is left before its run ends. A compaction streams no
    // reply.
    const last = shownMessages(state.messages).at(-1)
    if (last?.role === 'assistant' && !state.compactTurn)
      controller.markCanceled([last.id])
    try {
      await controller.cancel(input)
    } catch (cause) {
      if (shown()) controller.view.update(unstopped)
      throw cause
    }
  }
  // The harness regenerates the reply it is named. The message actions name
  // a message by its index: a reply, or the user message it answers. A user
  // message left without a reply is sent again with its own text. A run in
  // progress is stopped first.
  async function regenerate(index: number, fields: Partial<Turn> = {}) {
    const { messages, status } = controller.view.get()
    const shown = shownMessages(messages)
    const target = shown[index]
    if (!target) return false
    const reply =
      target.role === 'assistant'
        ? target
        : shown[index + 1]?.role === 'assistant'
          ? shown[index + 1]
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
    const reply = shownMessages(controller.view.get().messages)[index]
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
  // compaction compacts again, as the chat shows it does. A refused request
  // or a dropped stream reconnects.
  async function retry(fields: Partial<Turn> = {}) {
    const { failedRun, status, compactTurn } = controller.view.get()
    if (!failedRun || status !== 'error') return reconnect()
    return send({ ...fields, kind: compactTurn ? 'compact' : 'retry' })
  }
  // Compacts the open chat on request: the harness summarizes its earlier
  // messages without asking the model. It does so only while no reply runs.
  function compact(fields: Partial<Turn> = {}) {
    if (!open.get().id || isRunning(controller.view.get())) return
    return send({ ...fields, kind: 'compact' })
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
          defaults: turnDefaults(current.id),
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
    compact,
    retryToolCall,
    sendQueued: async (queueId: string) =>
      controller.sendQueued(queueInput(queueId)),
    removeQueued: async (queueId: string) =>
      controller.removeQueued(queueInput(queueId)),
  }
}
