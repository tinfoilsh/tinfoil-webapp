import type { ImagesById, LocalThreadStore, Originals } from './local-threads'
import { ERROR_CODES, ROUTES, type RunRoute } from './protocol'
import {
  initialChat,
  isTerminal,
  reduceEvent,
  runOf,
  type ChatState,
} from './reducer'
import type { HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import { createStore } from './store'
import type {
  FollowInput,
  HarnessErrorBody,
  HarnessEvent,
  TerminalEvent,
  Turn,
} from './types'

// A stream that broke without a reason from the harness, as when the
// connection dropped. Its run may go on.
const CONNECTION_LOST: HarnessErrorBody = {
  code: ERROR_CODES.streamInterrupted,
  message: 'The connection closed. Reconnect to continue.',
}
const interrupted = (cause: unknown) =>
  !(cause instanceof HarnessError) || cause.code === CONNECTION_LOST.code
// A turn sent again after the harness applied it changed the chat already,
// and a run the harness no longer has ended, finished or not.
const gone = (cause: unknown) =>
  cause instanceof HarnessError &&
  (cause.code === ERROR_CODES.alreadyApplied ||
    cause.code === ERROR_CODES.runNotFound)

// A run of a chat the browser stores. Its final event returns the whole
// thread, without the image bytes the browser holds for it.
export interface DeviceRun {
  saved?: boolean
  threadId: string
  store: LocalThreadStore
  images: ImagesById
  // The originals of the images the turn sent, stored with the thread.
  originals?: Originals
  runId?: string
  // When the run's turn read the chat, on the controller's clock.
  since: number
}

export interface RunOptions {
  submission?: { cancelled: boolean }
  // A device chat's run keeps reading when the view moves to another chat,
  // or the page to another route, so its reply is still saved. An account
  // change ends it with the API's lifetime.
  device?: DeviceRun
  // Rejoining a run left behind: losing it shows no error.
  quiet?: boolean
  rejoined?: boolean
}

// What the chat around a run does as the run goes.
export interface RunHooks {
  // The run the view shows started, under the thread the harness names.
  started?(run: { threadId?: string; runId: string }): void
  // The harness accepted a stored chat's turn, which stored a new chat.
  accepted?(threadId: string): void
  // A device run's final event returns the thread to store.
  saved?(run: DeviceRun, event: TerminalEvent, attached: boolean): Promise<void>
  // A run ended, which may have changed the chat list.
  ended?(): void
  // The open chat's run is over though its stream did not say so.
  gone?(threadId: string): Promise<void>
}

// A hint that rejoins a device chat's run after a reload, kept for the tab.
interface Receipt {
  threadId: string
  runId: string
}

// Streams the runs of the chat a view shows: a turn's run, or a live run it
// follows again, which replays from its first frame while the view skips
// the frames it applied. A run whose stream drops is rejoined once.
export class RunController {
  readonly view = createStore<ChatState>(initialChat())
  // The device chats whose runs this page reads, by chat.
  readonly deviceRuns = createStore<ReadonlyMap<string, DeviceRun>>(new Map())
  // When the open chat's error happened, so a wait the harness asks for
  // counts from then.
  errorAt = 0
  // The turn sent whose run has not started. It is sent again, with its
  // nonce, to reconnect.
  pending: { input: Turn; run?: DeviceRun } | null = null
  submission: { cancelled: boolean } | null = null
  retryPreparation: (() => Promise<boolean>) | null = null
  // Changes each time the view moves to another chat. A run started for
  // the previous one no longer updates the view.
  private generation = 0
  private readonly followers = new Set<AbortController>()
  // The device turn sent and not started yet. Its chat takes no other
  // device turn until the turn starts or its stream ends, as when it was
  // queued and then removed.
  private starting: DeviceRun | null = null
  // When each setting of a device chat last changed through the harness,
  // on a clock that also dates the turns read from the chat.
  private clock = 0
  private readonly settingChanges = new Map<string, Map<string, number>>()

  constructor(
    private readonly api: HarnessAPI,
    // Set by the chat around the runs, which may change them as it renders.
    public hooks: RunHooks = {},
    private readonly receiptKey?: string,
  ) {}

  // The view moves to another chat: runs it followed stop, other than
  // device runs, which go on to save their replies.
  reset(next: ChatState = initialChat()) {
    this.generation++
    for (const controller of this.followers) controller.abort()
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

  // The user changed settings of a device chat through the harness.
  settingsChanged(threadId: string, settings: readonly string[]) {
    const at = this.tick()
    const changes = this.settingChanges.get(threadId) ?? new Map()
    for (const setting of settings) changes.set(setting, at)
    this.settingChanges.set(threadId, changes)
  }

  // The settings of a device chat changed after a run's turn read it.
  settingsChangedSince({ threadId, since }: DeviceRun): string[] {
    return [...(this.settingChanges.get(threadId) ?? [])]
      .filter(([, at]) => at > since)
      .map(([setting]) => setting)
  }

  settle(run: DeviceRun) {
    if (this.starting === run) this.starting = null
  }

  async run(
    route: RunRoute,
    input: Turn | FollowInput,
    options: RunOptions = {},
  ): Promise<boolean> {
    const { device, quiet = false } = options
    const controller = new AbortController()
    if (!device) this.followers.add(controller)
    const version = this.generation
    const attached = () => version === this.generation
    let runId = 'runId' in input ? input.runId : undefined
    let threadId = input.threadId
    let succeeded = false
    let view = this.view.get()
    try {
      for await (const frame of this.api.client.events(
        route,
        input,
        this.api.signal({ signal: controller.signal, keyless: !input.key }),
      )) {
        const shown = attached()
        if (!shown && !device) break
        const { event } = frame
        if ('threadId' in event && event.threadId) threadId = event.threadId
        runId = runOf(event) ?? runId
        const base = shown ? this.view.get() : view
        const next = reduceEvent(base, frame, runId)
        if (next === base && (!isTerminal(event) || !device || device.saved)) {
          if (event.type === 'RUN_FINISHED')
            succeeded = event.metadata?.cancelled !== true
          continue
        }
        // A replayed frame leaves the view as it was.
        if (next !== base) {
          this.reportQuota(event)
          if (event.type === 'RUN_ERROR' && shown) this.errorAt = Date.now()
        }
        view = next
        if (shown) this.view.set(next)
        if (event.type === 'RUN_FINISHED')
          succeeded = event.metadata?.cancelled !== true
        if (event.type === 'RUN_STARTED') {
          this.started(event.runId, threadId!, device, shown)
          if (shown)
            this.hooks.started?.({
              threadId: event.threadId,
              runId: event.runId,
            })
        }
        if (options.submission?.cancelled && runId) {
          options.submission.cancelled = false
          await this.api.post(
            ROUTES.cancel,
            {
              ...(input.key ? { key: this.api.key() } : {}),
              threadId,
              runId,
            },
            { keyless: true },
          )
        }
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
      }
    } catch (cause) {
      if (controller.signal.aborted) return false
      // A stream cut off after its run started rejoins the run once, which
      // replays it; a device run does so after the view moved on.
      if (
        runId &&
        !options.rejoined &&
        interrupted(cause) &&
        (device || attached())
      ) {
        let follow: FollowInput
        try {
          follow = {
            ...(input.key ? { key: this.api.key() } : {}),
            threadId: threadId!,
            runId,
          }
        } catch (refusal) {
          if (attached()) this.fail(refusal)
          return false
        }
        return await this.run(ROUTES.follow, follow, {
          ...options,
          rejoined: true,
        })
      }
      if (attached()) {
        if (gone(cause)) {
          this.pending = null
          this.forgetReceipt(runId)
          await this.hooks.gone?.(input.threadId!)
        }
        // A run the harness refused to follow is gone. One that could not
        // be reached keeps its receipt, so it can still be rejoined.
        else if (!quiet) this.fail(cause)
        else if (cause instanceof HarnessError && cause.status !== undefined)
          this.forgetReceipt(runId)
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

  private started(
    runId: string,
    threadId: string,
    device: DeviceRun | undefined,
    shown: boolean,
  ) {
    if (device) {
      this.settle(device)
      device.runId = runId
      this.deviceRuns.update((runs) =>
        new Map(runs).set(device.threadId, device),
      )
    }
    if (!shown) return
    this.pending = null
    // A stored chat names its run itself; a chat on this device is
    // rejoined after a reload through this receipt.
    if (device) this.writeReceipt({ threadId, runId })
    else this.hooks.accepted?.(threadId)
  }

  // The open chat's run ended with its stream, refused or cut off.
  fail(cause: unknown) {
    const detail =
      cause instanceof HarnessError ? cause.detail : CONNECTION_LOST
    this.errorAt = Date.now()
    this.view.update((state) => ({
      ...state,
      error: detail,
      status: 'error',
      ...(detail.code === ERROR_CODES.chatFlagged ? { flagged: true } : {}),
    }))
    this.api.reportRateLimit(detail.rateLimit)
  }

  // The quota a run reports as it starts and as it ends.
  private reportQuota(event: HarnessEvent) {
    if (event.type === 'STATE_SNAPSHOT')
      this.api.reportRateLimit(event.snapshot.rateLimit)
    else if (isTerminal(event))
      this.api.reportRateLimit(event.metadata?.rateLimit)
  }

  cancel(input: { key?: string; threadId: string | null; runId?: string }) {
    if (this.view.get().status === 'submitting' && this.submission) {
      this.submission.cancelled = true
      return Promise.resolve()
    }
    return this.api.post(ROUTES.cancel, input, { keyless: true })
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
      return typeof receipt?.threadId === 'string' &&
        typeof receipt?.runId === 'string'
        ? receipt
        : null
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
