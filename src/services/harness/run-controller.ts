import type { FollowRequest } from './client'
import type { ImagesById, LocalThreadStore, Originals } from './local-threads'
import { scopedTurn } from './prompt-cache-secret'
import { ERROR_ACTIONS, ERROR_CODES, ROUTES, type RunRoute } from './protocol'
import {
  canceledBy,
  initialChat,
  isStopping,
  isTerminal,
  reduceEvent,
  runErrorOf,
  runOf,
  unstopped,
  withoutSending,
  type ChatState,
} from './reducer'
import { showsRateLimit, type HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import { createFrameStore, createStore } from './store'
import type {
  HarnessErrorBody,
  HarnessEvent,
  TerminalEvent,
  ThreadSummary,
  Turn,
} from './types'

// A stream that broke without a reason from the harness, as when the
// connection dropped. Its run may go on.
const CONNECTION_LOST: HarnessErrorBody = {
  code: ERROR_CODES.streamInterrupted,
  action: ERROR_ACTIONS.retry,
  message: 'The connection closed. Reconnect to continue.',
}
// A stream that broke, or a request the harness gave no answer to, as while a
// new instance of it starts: the run may go on, and following it again
// changes nothing.
const interrupted = (cause: unknown) =>
  !(cause instanceof HarnessError) ||
  cause.code === CONNECTION_LOST.code ||
  cause.code === ERROR_CODES.connection
// The waits before each attempt to rejoin a run whose stream dropped, the
// first at once. Together they outlast a restart of the harness, whose new
// instance takes about a minute to answer.
export const REJOIN_DELAYS_MS = [
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000,
]

// Resolves after ms, or as soon as signal aborts.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
// The chat changed from the copy this client shows, as when the harness
// had applied a turn sent again, or no longer has the run, finished or not.
const gone = (cause: unknown) =>
  cause instanceof HarnessError && cause.detail.action === ERROR_ACTIONS.reload

// How long applying a run's frames back to back may hold the page before
// the browser gets a turn to draw and answer input.
export const YIELD_AFTER_MS = 8

// Resolves in a task of its own, once the tasks queued before it ran.
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      resolve()
    }
    port2.postMessage(null)
  })
}

// Paces work done back to back: once it held the page for YIELD_AFTER_MS
// without the browser getting a turn, it waits for one.
function pacer() {
  let since: number | undefined
  return (): Promise<void> | undefined => {
    const now = performance.now()
    if (since === undefined) {
      since = now
      void nextTask().then(() => {
        since = undefined
      })
      return
    }
    if (now - since < YIELD_AFTER_MS) return
    since = undefined
    const { scheduler } = globalThis as {
      scheduler?: { yield?(): Promise<void> }
    }
    return scheduler?.yield?.() ?? nextTask()
  }
}

// Following a run resumes after the last frame of it this client applied,
// when it applied one.
const resumed = (input: FollowRequest, after?: number): FollowRequest =>
  input.lastEventId === undefined && after !== undefined
    ? { ...input, lastEventId: after }
    : input

// A run of a chat the browser stores. Its final event returns the whole
// thread, without the image bytes the browser holds for it.
export interface DeviceRun {
  saved?: boolean
  // The chat stored the thread the run's final event returned. A final event
  // without the thread leaves the chat without anything the run streamed.
  threadStored?: boolean
  threadId: string
  store: LocalThreadStore
  images: ImagesById
  // The originals of the images the turn sent, stored with the thread.
  originals?: Originals
  // The run, once it started.
  run?: Receipt
  // When the run's turn read the chat, on the controller's clock.
  since: number
  // When this page saw the run start, on the same clock.
  startedAt?: number
}

interface Submission {
  threadId: string
  cancelled: boolean
}

export interface RunOptions {
  submission?: Submission
  // A device chat's run keeps reading when the view moves to another chat,
  // or the page to another route, so its reply is still saved. An account
  // change ends it with the API's lifetime.
  device?: DeviceRun
  // Rejoining a run left behind: losing it shows no error.
  quiet?: boolean
  // The attempts made in a row to rejoin the run since its stream last
  // delivered a frame.
  rejoins?: number
  // The run started before this stream: one followed by its id is, unless a
  // stream that only queued it is rejoined.
  started?: boolean
  // A widget's retry leaves the chat's status and error as they were, and
  // keeps why it failed here instead.
  widgetRetry?: { failure?: HarnessErrorBody }
  // A rejoined run stays the run of the chat it started from: it shows only
  // while the view shows that chat, and otherwise goes on from the chat as
  // the run left it.
  generation?: number
  state?: ChatState
}

// What the chat around a run does as the run goes.
export interface RunHooks {
  // The run the view shows started, under the thread the harness names.
  started?(run: { threadId?: string; runId: string }): void
  // The harness accepted a stored chat's turn, which stored a new chat.
  accepted?(threadId: string): void
  // The run the view shows changed the chat's summary, as when it started,
  // titled the chat or ended.
  summary?(thread: ThreadSummary): void
  // A device run's final event returns the thread to store.
  saved?(run: DeviceRun, event: TerminalEvent, attached: boolean): Promise<void>
  // A run ended, which may have changed the chat list.
  ended?(): void
  // The open chat's run is over though its stream did not say so. A device
  // run's chat holds nothing it streamed unless its final event was saved.
  gone?(threadId: string, device?: DeviceRun): Promise<void>
  // A device run the view moved away from is gone before its final event
  // returned the thread: its chat stores what the run streamed.
  cutOff?(run: DeviceRun, state: ChatState): Promise<void>
}

// A hint that rejoins a device chat's run after a reload, kept for the tab.
export interface Receipt {
  threadId: string
  runId: string
  instance: string
  // The settings of the chat the user changed while the run was in flight,
  // which the thread it returns does not hold.
  changed?: string[]
}

// Streams the runs of the chat a view shows: a turn's run, or a live run it
// follows again, which replays from its first frame while the view skips
// the frames it applied. A run whose stream drops is rejoined, backing off
// while the harness cannot be reached.
export class RunController {
  readonly view = createFrameStore<ChatState>(initialChat())
  // The device chats whose runs this page reads, by chat.
  readonly deviceRuns = createStore<ReadonlyMap<string, DeviceRun>>(new Map())
  // The messages whose reply the user stopped on this page, which keep
  // saying so as the chat is read again.
  readonly canceled = createStore<ReadonlySet<string>>(new Set())
  // The replies on this page the model ran out of room for, which keep
  // saying so as the chat is read again.
  readonly truncated = createStore<ReadonlySet<string>>(new Set())
  // When the open chat's error happened, so a wait the harness asks for
  // counts from then.
  errorAt = 0
  // The turn sent whose run has not started. It is sent again, with its
  // nonce, to reconnect.
  pending: { input: Turn; run?: DeviceRun } | null = null
  submission: Submission | null = null
  // A turn sent while the open chat's reply stops waits for it to stop.
  holding = false
  retryPreparation: (() => Promise<boolean>) | null = null
  // Changes each time the view moves to another chat. A run started for
  // the previous one no longer updates the view.
  private generation = 0
  // The streams of stored chats' runs the view reads, with the turn each
  // sent.
  private readonly followers = new Map<
    AbortController,
    Submission | undefined
  >()
  // The device turn sent and not started yet. Its chat takes no other
  // device turn until the turn starts or its stream ends, as when it was
  // queued and then removed.
  private starting: DeviceRun | null = null
  // When each setting of a device chat last changed through the harness,
  // on a clock that also dates the turns read from the chat.
  private clock = 0
  private readonly settingChanges = new Map<string, Map<string, number>>()
  // When the device run whose thread each chat stored last started.
  private readonly storedRuns = new Map<string, number>()
  // How many changes the user made to each chat that its store has not
  // answered, by chat. A copy of the chat read meanwhile lacks them.
  readonly changes = createStore<ReadonlyMap<string, number>>(new Map())

  constructor(
    private readonly api: HarnessAPI,
    // Set by the chat around the runs, which may change them as it renders.
    public hooks: RunHooks = {},
    private readonly receiptKey?: string,
  ) {
    const receipt = this.receipt()
    if (receipt?.changed?.length)
      this.settingsChanged(receipt.threadId, receipt.changed)
  }

  // The view moves to another chat: runs it followed stop, other than
  // device runs, which go on to save their replies, and turns the user
  // stopped before their runs started, which read on until the stop is sent.
  reset(next: ChatState = initialChat()) {
    this.generation++
    for (const [controller, submission] of this.followers)
      if (!submission?.cancelled) controller.abort()
    this.followers.clear()
    this.starting = null
    this.pending = null
    this.submission = null
    this.retryPreparation = null
    this.view.set(next)
  }

  startingThread() {
    return this.starting?.threadId
  }

  // Whether the view still shows the chat it showed when this was called.
  track() {
    const version = this.generation
    return () => version === this.generation
  }

  // A device turn about to be sent.
  begin(run: DeviceRun) {
    this.starting = run
  }

  tick() {
    return ++this.clock
  }

  // The user changed settings of a device chat.
  settingsChanged(threadId: string, settings: readonly string[]) {
    const at = this.tick()
    const changes = this.settingChanges.get(threadId) ?? new Map()
    for (const setting of settings) changes.set(setting, at)
    this.settingChanges.set(threadId, changes)
    const receipt = this.receipt()
    if (receipt?.threadId === threadId)
      this.writeReceipt({
        ...receipt,
        changed: [...new Set([...(receipt.changed ?? []), ...settings])],
      })
  }

  // The settings of a device chat changed after a run's turn read it.
  settingsChangedSince({ threadId, since }: DeviceRun): string[] {
    return [...(this.settingChanges.get(threadId) ?? [])]
      .filter(([, at]) => at > since)
      .map(([setting]) => setting)
  }

  // Whether a device chat stores the thread its run's final event returned,
  // and if so counts the run as the latest it stored. The harness runs a
  // chat's turns one at a time, each from the thread the one before left,
  // so the thread of a run that started later holds this run's and is kept.
  // A run this page did not see start counts from when the page took it up.
  storesThread(run: DeviceRun): boolean {
    const started = run.startedAt ?? run.since
    const latest = this.storedRuns.get(run.threadId)
    if (latest !== undefined && latest > started) return false
    this.storedRuns.set(run.threadId, started)
    return true
  }

  settle(run: DeviceRun) {
    if (this.starting === run) this.starting = null
  }

  // Counts a change the user made to a chat until its store answers it.
  async changing<T>(threadId: string, change: () => Promise<T>): Promise<T> {
    this.countChanges(threadId, 1)
    try {
      return await change()
    } finally {
      this.countChanges(threadId, -1)
    }
  }

  private countChanges(threadId: string, by: number) {
    this.changes.update((counts) => {
      const next = new Map(counts)
      const left = (counts.get(threadId) ?? 0) + by
      if (left > 0) next.set(threadId, left)
      else next.delete(threadId)
      return next
    })
  }

  async run(
    route: RunRoute,
    input: Turn | FollowRequest,
    options: RunOptions = {},
  ): Promise<boolean> {
    const { device, quiet = false, widgetRetry } = options
    let started = options.started ?? 'runId' in input
    const controller = new AbortController()
    if (!device) this.followers.set(controller, options.submission)
    const version = options.generation ?? this.generation
    const attached = () => version === this.generation
    let runId = 'runId' in input ? input.runId : undefined
    let threadId = input.threadId
    let succeeded = false
    let view = attached() || !options.state ? this.view.get() : options.state
    const sent =
      'clientRequestId' in input
        ? scopedTurn(input, this.api.userId)
        : resumed(input, view.cursors[input.runId])
    // A turn the user stopped before its run started is stopped once the run
    // names itself.
    const stopSubmitted = async () => {
      if (!options.submission?.cancelled || !runId) return
      await this.stop({
        ...(input.key ? { key: this.api.key() } : {}),
        threadId,
        runId,
      })
      options.submission.cancelled = false
    }
    const signal = this.api.signal({
      signal: controller.signal,
      keyless: !input.key,
    })
    // The stream applied a frame the view did not hold yet.
    let progressed = false
    // A long backlog of frames, as a slow device falls behind its stream,
    // lets the browser draw and answer input as it applies them.
    const pace = pacer()
    try {
      for await (const frame of this.api.client.events(route, sent, signal)) {
        const browserTurn = pace()
        if (browserTurn) await browserTurn
        const shown = attached()
        const { event } = frame
        if ('threadId' in event && event.threadId) threadId = event.threadId
        runId = runOf(event) ?? runId
        if (!shown && !device) {
          if (!options.submission?.cancelled) break
          if (!runId) continue
          await stopSubmitted()
          break
        }
        if (event.type === 'RUN_STARTED') started = true
        const base = shown ? this.view.get() : view
        const reduced = reduceEvent(base, frame, runId, !!widgetRetry)
        // A message sent while a reply ran waits in the queue until its own
        // stream names its run, which the harness listed or started.
        const next =
          runId && 'clientRequestId' in input
            ? withoutSending(reduced, input.clientRequestId)
            : reduced
        const replayed =
          next === base && (!isTerminal(event) || !device || device.saved)
        // A replayed frame leaves the view as it was.
        if (!replayed) {
          if (next !== base) {
            this.reportQuota(event)
            if (event.type === 'RUN_ERROR' && widgetRetry)
              widgetRetry.failure = runErrorOf(event)
            else if (event.type === 'RUN_ERROR' && shown)
              this.errorAt = Date.now()
          }
          if (isTerminal(event)) {
            this.markCanceled(canceledBy(base, event))
            this.noteTruncation(event)
          }
          progressed = true
          view = next
          // A change of the run's status shows at once, and what it streams
          // with the next animation frame.
          if (shown) {
            if (
              event.type === 'RUN_STARTED' ||
              isTerminal(event) ||
              next.status !== base.status
            )
              this.view.set(next)
            else this.view.stage(next)
          }
          if (event.type === 'RUN_STARTED') {
            this.started(
              {
                threadId: threadId!,
                runId: event.runId,
                instance: event.instance,
              },
              device,
              shown && !widgetRetry,
            )
            if (shown)
              this.hooks.started?.({
                threadId: event.threadId,
                runId: event.runId,
              })
          }
          if (
            shown &&
            next.snapshot.thread &&
            next.snapshot.thread !== base.snapshot.thread
          )
            this.hooks.summary?.(next.snapshot.thread)
        }
        await stopSubmitted()
        if (event.type === 'RUN_FINISHED')
          succeeded = event.metadata?.cancelled !== true
        if (replayed) continue
        if (
          device &&
          event.type === 'STATE_DELTA' &&
          event.runId &&
          event.delta.some(
            (patch) =>
              patch.op === 'add' &&
              patch.path === '/queue/-' &&
              patch.value.queueId === event.runId,
          )
        ) {
          this.settle(device)
        }
        if (!isTerminal(event)) continue
        if (device) {
          await this.hooks.saved?.(device, event, attached())
          device.saved = true
        }
        this.forgetReceipt(runId)
        this.hooks.ended?.()
        if (
          event.type === 'RUN_ERROR' &&
          runErrorOf(event).action === ERROR_ACTIONS.reload &&
          attached()
        ) {
          this.pending = null
          await this.hooks.gone?.(threadId!, device)
        }
      }
    } catch (cause) {
      if (controller.signal.aborted) return false
      // A stream cut off after its run started rejoins the run, which
      // replays it; a device run does so after the view moved on. Attempts
      // that deliver nothing wait longer each time, so a harness that
      // restarts is reached once its new instance answers.
      const rejoins = progressed ? 0 : (options.rejoins ?? 0)
      if (
        runId &&
        rejoins < REJOIN_DELAYS_MS.length &&
        interrupted(cause) &&
        (device || attached())
      ) {
        await pause(REJOIN_DELAYS_MS[rejoins], signal)
        if (signal.aborted || !(device || attached())) return false
        let follow: FollowRequest
        try {
          follow = resumed(
            {
              ...(input.key ? { key: this.api.key() } : {}),
              threadId: threadId!,
              runId,
            },
            view.cursors[runId],
          )
        } catch (refusal) {
          if (attached()) this.fail(refusal)
          return false
        }
        return await this.run(ROUTES.follow, follow, {
          ...options,
          rejoins: rejoins + 1,
          started,
          generation: version,
          state: view,
        })
      }
      if (attached()) {
        if (gone(cause)) {
          this.pending = null
          this.forgetReceipt(runId)
          await this.hooks.gone?.(input.threadId!, device)
        } else if (widgetRetry) {
          widgetRetry.failure =
            cause instanceof HarnessError ? cause.detail : CONNECTION_LOST
          this.api.reportRateLimit(widgetRetry.failure.rateLimit)
        }
        // A run the harness refused to follow is gone. One that could not
        // be reached keeps its receipt, so it can still be rejoined.
        else if (!quiet) this.fail(cause, started)
        else if (cause instanceof HarnessError && cause.status !== undefined)
          this.forgetReceipt(runId)
      } else if (device && gone(cause)) {
        this.forgetReceipt(runId)
        await this.hooks.cutOff?.(device, view)
      }
    } finally {
      this.followers.delete(controller)
      // A device run this page no longer reads is not shown as running, and
      // another turn may follow one that never started.
      if (device) {
        this.settle(device)
        if (this.deviceRuns.get().get(device.threadId) === device)
          this.deviceRuns.update((runs) => {
            const next = new Map(runs)
            next.delete(device.threadId)
            return next
          })
      }
    }
    return succeeded && attached()
  }

  private started(run: Receipt, device: DeviceRun | undefined, shown: boolean) {
    const { threadId } = run
    if (device) {
      this.settle(device)
      device.run = run
      device.startedAt ??= this.tick()
      this.deviceRuns.update((runs) =>
        new Map(runs).set(device.threadId, device),
      )
    }
    if (!shown) return
    this.pending = null
    // A stored chat names its run itself; a chat on this device is
    // rejoined after a reload through this receipt.
    if (device) {
      const kept = this.receipt()
      this.writeReceipt(
        kept?.runId === run.runId ? { ...run, changed: kept.changed } : run,
      )
    } else this.hooks.accepted?.(threadId)
  }

  // The open chat's run ended with its stream, refused or cut off. A turn
  // refused before it started, as one queued behind a reply, leaves the
  // reply streaming.
  fail(cause: unknown, started = true) {
    const detail =
      cause instanceof HarnessError ? cause.detail : CONNECTION_LOST
    this.errorAt = Date.now()
    // A run whose stream ended while it stopped may go on, so the chat shows
    // all it streamed, which rejoining it continues from.
    this.view.update((state) => ({
      ...(!started &&
      (state.status === 'streaming' || state.status === 'queued')
        ? state
        : { ...unstopped(state), status: 'error' as const }),
      error: detail,
      ...(detail.code === ERROR_CODES.chatFlagged ? { flagged: true } : {}),
    }))
    this.api.reportRateLimit(detail.rateLimit)
  }

  // The quota a run reports as it starts and as it ends.
  private reportQuota(event: HarnessEvent) {
    if (event.type === 'STATE_SNAPSHOT')
      this.api.reportRateLimit(event.snapshot.rateLimit)
    else if (isTerminal(event)) {
      this.api.reportRateLimit(event.metadata?.rateLimit)
      if (!showsRateLimit(event.metadata?.rateLimit))
        this.api.reportUsage(event.metadata?.usage)
    }
  }

  async cancel(input: {
    key?: string
    threadId: string | null
    runId?: string
  }) {
    const submission =
      this.view.get().status === 'submitting' &&
      this.submission?.threadId === input.threadId
        ? this.submission
        : null
    if (submission && !input.runId) {
      submission.cancelled = true
      return
    }
    // The run a chat names while its turn is sent may be one that is over,
    // as one a restart ended, so the turn's own run is stopped once it
    // starts.
    if (!(await this.stop(input)) && submission) submission.cancelled = true
  }

  // Stops a run, and says whether it was live. One that ended, or is
  // ending, as the stop arrived needs no stop.
  private async stop(input: {
    key?: string
    threadId: string | null
    runId?: string
  }): Promise<boolean> {
    try {
      await this.api.post(ROUTES.cancel, input, { keyless: true })
      return true
    } catch (cause) {
      if (
        cause instanceof HarnessError &&
        (cause.code === ERROR_CODES.runNotFound ||
          cause.code === ERROR_CODES.runInFlight)
      )
        return false
      throw cause
    }
  }

  markCanceled(messageIds: string[]) {
    if (messageIds.length)
      this.canceled.update((canceled) => new Set([...canceled, ...messageIds]))
  }

  // Records whether the model ran out of room for each reply a run committed
  // as it ended, so a reply continued since says so only if it ran out again.
  noteTruncation(event: TerminalEvent) {
    const replies = event.metadata?.messages?.map(({ id }) => id) ?? []
    if (!replies.length) return
    const truncated =
      event.type === 'RUN_FINISHED' && !!event.metadata?.truncated
    this.truncated.update((current) => {
      const next = new Set(current)
      for (const id of replies) {
        if (truncated) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  // Resolves once the run the open chat stops has ended, or the view moved
  // to another chat.
  stopped(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (isStopping(this.view.get())) return
        unsubscribe()
        resolve()
      }
      const unsubscribe = this.view.subscribe(check)
      check()
    })
  }

  sendQueued(input: {
    key?: string
    threadId: string | null
    queueId: string
  }) {
    return this.api.post(ROUTES.queueSend, input, { keyless: true })
  }

  removeQueued(input: {
    key?: string
    threadId: string | null
    queueId: string
  }) {
    return this.api.post(ROUTES.queueRemove, input, { keyless: true })
  }

  receipt(): Receipt | null {
    if (!this.receiptKey) return null
    try {
      const receipt = JSON.parse(sessionStorage.getItem(this.receiptKey) ?? '')
      if (
        typeof receipt?.threadId !== 'string' ||
        typeof receipt?.runId !== 'string' ||
        typeof receipt?.instance !== 'string'
      )
        return null
      const { threadId, runId, instance, changed } = receipt
      return Array.isArray(changed) &&
        changed.every((setting) => typeof setting === 'string')
        ? { threadId, runId, instance, changed }
        : { threadId, runId, instance }
    } catch {
      // Receipts are optional routing hints; an invalid one is discarded.
      return null
    }
  }

  private writeReceipt(receipt: Receipt) {
    if (!this.receiptKey) return
    try {
      sessionStorage.setItem(this.receiptKey, JSON.stringify(receipt))
    } catch {
      // Receipts are optional routing hints.
    }
  }

  // A run that ended is not followed again after a reload.
  private forgetReceipt(runId?: string) {
    if (runId && this.receipt()?.runId === runId) this.clearReceipt()
  }

  clearReceipt() {
    if (!this.receiptKey) return
    try {
      sessionStorage.removeItem(this.receiptKey)
    } catch {
      // Receipts are optional routing hints.
    }
  }
}
