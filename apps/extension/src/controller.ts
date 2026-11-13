import { HarnessClient } from '@tinfoil/chat-client/client'
import { logError } from '@tinfoil/chat-client/logging'
import { ROUTES } from '@tinfoil/chat-client/protocol'
import {
  initialChat,
  isTerminal,
  reduceEvent,
} from '@tinfoil/chat-client/reducer'
import { HarnessError } from '@tinfoil/chat-client/sse'
import type {
  BrowserResult,
  BrowserToolRequest,
  Frame,
  Session,
  Turn,
} from '@tinfoil/chat-client/types'
import { BrowserDriver } from './browser/driver'
import {
  BrowserError,
  browserFailure,
  OUTCOME_UNKNOWN,
  outcomeUnknown,
} from './browser/errors'
import { changesPage } from './browser/schema'
import {
  DEFAULT_MODEL,
  randomSecret,
  RECONNECT_DELAYS_MS,
  TASK_TIMEOUT_MS,
} from './config'
import type { Command, View } from './messages'
import { TaskStore, type Task, type TaskPhase } from './storage'

const TITLE_CHARS = 80
const CANCEL_TIMEOUT_MS = 15_000
const MAX_ACTION_WAIT_MS = 5 * 60_000
// The phases a task rests in. A task stored in any other, as one this build
// no longer has, was cut off when the extension last stopped.
const SETTLED_PHASES: ReadonlySet<string> = new Set<TaskPhase>([
  'idle',
  'completed',
  'interrupted',
])
const RESUME_PROMPT =
  'Continue my previous task. First observe the current browser state. Reconcile any action that may already have completed before taking another action.'

type BrowserExecutor = Pick<BrowserDriver, 'execute' | 'describe' | 'dispose'>
type CreateBrowser = (
  signal: AbortSignal,
  interrupted: (message: string) => void,
) => BrowserExecutor

export class TaskController {
  private session?: Session
  private task?: Task
  private verified = false
  private error?: string
  private active?: { abort: AbortController; done: Promise<void> }
  private review?: {
    request: BrowserToolRequest
    preview: string
    resolve: (allow: boolean) => void
  }
  private disposed = false
  private reconnecting = false
  private generation = 0
  private transitions: Promise<void> = Promise.resolve()
  private readonly summaries = new Map<string, View['tasks'][number]>()

  constructor(
    private readonly client: HarnessClient,
    private readonly owner: string,
    private readonly store: TaskStore,
    private readonly publish: (view: View) => void,
    // Whether an action that changes a page waits for the user's approval.
    private readonly reviewActions: () => Promise<boolean>,
    private readonly createBrowser: CreateBrowser = (signal, interrupted) =>
      new BrowserDriver(signal, interrupted),
  ) {}

  // Opens on a new chat, or on the chat a panel that lost its connection was
  // showing, for it to go on in.
  initialize(
    after: Promise<void> = Promise.resolve(),
    shown?: string,
  ): Promise<void> {
    const pending = this.transitions
      .then(() => after)
      .then(() => this.load(shown))
    this.transitions = pending.catch(() => undefined)
    return pending
  }

  private async load(shown?: string) {
    const tasks = await this.store.list(this.owner)
    for (const summary of tasks) {
      this.summaries.set(summary.id, {
        id: summary.id,
        title: summary.title,
        updatedAt: summary.updatedAt,
      })
      if (!SETTLED_PHASES.has(summary.phase)) {
        const task = await this.store.get(this.owner, summary.id)
        if (!task) continue
        task.phase = 'interrupted'
        task.error =
          'This task was interrupted. Resume to reconnect, or send a new instruction after checking the page.'
        await this.store.put(task)
      }
    }
    this.task = shown ? await this.store.get(this.owner, shown) : undefined
    await this.emit()
    try {
      this.session = await this.client.post<Session>(ROUTES.session, {})
      if (this.session.user.id !== this.owner || this.session.user.anonymous)
        throw new Error('Sign in again to open your chats.')
      await this.client.verify()
      this.verified = true
    } catch (cause) {
      this.session = undefined
      this.error = errorText(cause)
    }
    await this.emit()
  }

  private async emit() {
    if (this.disposed) return
    const task = this.task
    this.publish({
      session: this.session,
      verified: this.verified,
      error: this.error,
      tasks: [...this.summaries.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
      task: task && {
        id: task.id,
        title: task.title,
        state: task.state,
        phase: task.phase,
        model: task.model,
        effort: task.effort,
        autoIntelligence: task.autoIntelligence,
        captures: task.captures ?? [],
        error:
          task.error ||
          (this.reconnecting
            ? 'Connection interrupted. Reconnecting to the same run…'
            : undefined),
      },
      pending: this.review && {
        ...this.review.request,
        preview: this.review.preview,
      },
    })
  }

  private async save(task: Task) {
    task.updatedAt = Date.now()
    await this.store.put(task)
    this.summaries.set(task.id, {
      id: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    })
    await this.emit()
  }

  command(command: Command): Promise<void> {
    if (command.kind === 'stop') return this.stop()
    const generation = this.generation
    if (command.kind === 'review') return this.handle(command, generation)
    const pending = this.transitions.then(() =>
      this.handle(command, generation),
    )
    this.transitions = pending.catch(() => undefined)
    return pending
  }

  private checkGeneration(generation: number) {
    if (this.disposed) throw new Error('The panel was closed.')
    if (generation !== this.generation)
      throw new DOMException('The task was stopped.', 'AbortError')
  }

  private async handle(command: Command, generation: number): Promise<void> {
    this.checkGeneration(generation)
    switch (command.kind) {
      case 'send':
        await this.stopActive()
        await this.begin(command, generation, command.content)
        return
      case 'resume':
        if (this.active) {
          if (
            !this.task ||
            !['interrupted', 'completed'].includes(this.task.phase)
          )
            throw new Error('The task is already running.')
          await this.active.done
          this.checkGeneration(generation)
        }
        if (!this.task) return
        if (this.task.receipt) this.launch(this.task)
        else
          await this.begin(
            {
              kind: 'send',
              content: `${RESUME_PROMPT}\n\nOriginal request: ${this.task.lastPrompt}`,
              model: this.task.model,
              effort: this.task.effort,
              autoIntelligence: this.task.autoIntelligence,
            },
            generation,
            this.task.lastPrompt,
          )
        return
      case 'stop':
        await this.stopActive()
        return
      case 'review':
        if (this.review?.request.executionId !== command.executionId)
          throw new Error('That action is no longer awaiting review.')
        this.review.resolve(command.allow)
        this.review = undefined
        if (this.task) this.task.phase = 'running'
        await this.emit()
        return
      case 'new':
      case 'select':
      case 'delete':
        await this.stopActive()
        this.checkGeneration(generation)
        if (command.kind === 'delete') {
          await this.store.delete(this.owner, command.id)
          this.summaries.delete(command.id)
        }
        this.task =
          command.kind === 'select'
            ? await this.store.get(this.owner, command.id)
            : undefined
        await this.emit()
    }
  }

  private async begin(
    input: Extract<Command, { kind: 'send' }>,
    generation: number,
    lastPrompt: string,
  ) {
    this.checkGeneration(generation)
    if (!this.session || !this.verified) {
      this.session = await this.client.post<Session>(ROUTES.session, {})
      if (this.session.user.id !== this.owner || this.session.user.anonymous)
        throw new Error('Sign in again to continue.')
      await this.client.verify()
      this.verified = true
    }
    this.checkGeneration(generation)
    this.error = undefined
    if (!this.session.features.browserTools)
      throw new Error(
        'This harness does not support browser tools yet. Configure a harness release with browserTools.',
      )
    const model = this.session.models.find(
      (entry) => entry.id === input.model && !entry.deprecated,
    )
    if (!model) throw new Error('Select an available model.')
    // Auto always works at a level the session offers, its default when the
    // turn names none.
    const autoIntelligence = model.auto
      ? (input.autoIntelligence ?? this.session.auto.default)
      : undefined
    if (
      autoIntelligence !== undefined &&
      !this.session.auto.levels.some((level) => level.id === autoIntelligence)
    )
      throw new Error('Select an available intelligence level.')
    const task =
      this.task ??
      ({
        id: `${Date.now()}_${crypto.randomUUID()}`,
        owner: this.owner,
        title: input.content.slice(0, TITLE_CHARS),
        updatedAt: Date.now(),
        state: initialChat(),
        phase: 'idle',
        lastPrompt: '',
        model: DEFAULT_MODEL,
        effort: 'medium',
      } satisfies Task)
    task.lastPrompt = lastPrompt
    task.model = input.model
    task.effort = input.effort
    task.autoIntelligence = autoIntelligence
    task.error = undefined
    task.receipt = undefined
    const turn: Turn = {
      clientRequestId: crypto.randomUUID(),
      threadId: task.id,
      local: true,
      kind: 'send',
      content: input.content,
      ...(task.thread ? { thread: task.thread } : {}),
      profile: {},
      widgets: [],
      options: {
        model: input.model,
        reasoningEffort: input.effort,
        ...(autoIntelligence ? { autoIntelligence } : {}),
        webSearch: false,
        genUI: false,
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        cacheSecret: randomSecret(),
      },
      browser: { executorId: crypto.randomUUID(), token: randomSecret() },
    }
    // The message shows at once, until the run's first window of the chat
    // replaces its messages.
    task.state = {
      ...task.state,
      messages: [
        ...task.state.messages,
        {
          id: turn.clientRequestId,
          role: 'user',
          content: input.content,
          createdAt: new Date().toISOString(),
        },
      ],
    }
    this.task = task
    await this.save(task)
    this.checkGeneration(generation)
    this.launch(task, turn)
  }

  private launch(task: Task, turn?: Turn) {
    if (this.active) throw new Error('Another task is running.')
    const abort = new AbortController()
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(TASK_TIMEOUT_MS),
    ])
    task.phase = 'running'
    task.error = undefined
    const active = { abort, done: Promise.resolve() }
    this.active = active
    active.done = this.run(task, signal, turn).finally(async () => {
      this.review = undefined
      if (this.active === active) this.active = undefined
      await this.save(task)
    })
    void active.done.catch((cause) => {
      this.error = errorText(cause)
      void this.emit()
    })
  }

  private async run(task: Task, signal: AbortSignal, turn?: Turn) {
    const driver = this.createBrowser(signal, (message) => {
      if (signal.aborted) return
      task.error = message
      this.active?.abort.abort()
    })
    try {
      await this.save(task)
      const access = turn?.browser ?? task.receipt?.browser
      if (task.receipt) this.client.locate(task.id, task.receipt.instance)
      let next = turn
      for (let attempt = 0; ; attempt++) {
        try {
          const receipt = task.receipt
          const stream = next
            ? this.client.events(ROUTES.turn, next, signal)
            : this.client.events(
                ROUTES.follow,
                {
                  threadId: task.id,
                  runId: receipt!.runId,
                  lastEventId: receipt!.cursor,
                },
                signal,
              )
          for await (const frame of stream) {
            signal.throwIfAborted()
            this.reconnecting = false
            const event = frame.event
            if (event.type === 'RUN_STARTED')
              task.receipt = {
                runId: event.runId,
                instance: event.instance,
                browser: access,
              }
            if (event.type === 'BROWSER_TOOL_REQUEST')
              await this.browserAction(task, event, driver, signal)
            this.apply(task, frame)
            if (task.receipt && frame.id !== undefined)
              task.receipt.cursor = frame.id
            await this.save(task)
          }
          await this.store.clearActions(this.owner, task.id)
          break
        } catch (cause) {
          signal.throwIfAborted()
          if (
            cause instanceof BrowserError ||
            (cause instanceof HarnessError && cause.detail.action !== 'retry')
          )
            throw cause
          if (attempt >= RECONNECT_DELAYS_MS.length) throw cause
          this.reconnecting = true
          await this.save(task)
          await wait(RECONNECT_DELAYS_MS[attempt], signal)
          if (task.receipt) next = undefined
        }
      }
    } catch (cause) {
      this.reconnecting = false
      task.phase = 'interrupted'
      task.error =
        task.error ||
        (signal.aborted
          ? signal.reason instanceof BrowserError
            ? signal.reason.message
            : 'Task stopped. Check the page before continuing.'
          : errorText(cause))
      await driver.dispose()
      if (task.receipt) await this.cancelAndCollect(task)
    } finally {
      await driver.dispose()
      if (!task.receipt) await this.store.clearActions(this.owner, task.id)
    }
  }

  private apply(task: Task, frame: Frame) {
    task.state = reduceEvent(task.state, frame)
    const event = frame.event
    if (task.state.snapshot.thread?.title)
      task.title = task.state.snapshot.thread.title
    if (isTerminal(event)) {
      if (event.metadata?.thread) task.thread = event.metadata.thread
      task.phase =
        event.type === 'RUN_ERROR' || event.metadata?.cancelled
          ? 'interrupted'
          : 'completed'
      if (event.type === 'RUN_ERROR') task.error = event.message
      else if (!event.metadata?.cancelled) task.error = undefined
      task.receipt = undefined
    }
  }

  private async browserAction(
    task: Task,
    request: BrowserToolRequest,
    driver: BrowserExecutor,
    signal: AbortSignal,
  ) {
    const expires = Date.parse(request.expiresAt)
    const remaining = Math.min(expires - Date.now(), MAX_ACTION_WAIT_MS)
    const expired = new BrowserError(
      'ACTION_EXPIRED',
      'This browser action expired. Check the page and send a new instruction.',
    )
    if (!Number.isFinite(remaining) || remaining <= 0) throw expired
    const deadline = new AbortController()
    const active = this.active
    deadline.signal.addEventListener(
      'abort',
      () => active?.abort.abort(expired),
      { once: true },
    )
    const timer = setTimeout(() => deadline.abort(expired), remaining)
    try {
      await this.executeBrowserAction(
        task,
        request,
        driver,
        AbortSignal.any([signal, deadline.signal]),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async executeBrowserAction(
    task: Task,
    request: BrowserToolRequest,
    driver: BrowserExecutor,
    signal: AbortSignal,
  ) {
    const receipt = task.receipt
    const access = receipt?.browser
    if (!receipt || !access || request.executorId !== access.executorId)
      throw new BrowserError(
        'WRONG_EXECUTOR',
        'The browser action belongs to a different executor.',
      )
    signal.throwIfAborted()
    const previous = await this.store.action(
      this.owner,
      receipt.runId,
      request.executionId,
    )
    if (
      !previous &&
      changesPage(request.operation) &&
      (await this.reviewRequired())
    ) {
      const preview = await driver.describe(request.operation)
      signal.throwIfAborted()
      const allow = await new Promise<boolean>((resolve, reject) => {
        const aborted = () => {
          this.review = undefined
          reject(signal.reason)
        }
        signal.addEventListener('abort', aborted, { once: true })
        this.review = {
          request,
          preview,
          resolve: (value) => {
            signal.removeEventListener('abort', aborted)
            resolve(value)
          },
        }
        task.phase = 'review'
        void this.emit()
      })
      if (!allow)
        throw new BrowserError(
          'USER_REFUSED',
          'You declined the action. The task was stopped.',
        )
    }
    const result = await this.store.executeOnce(
      this.owner,
      task.id,
      receipt.runId,
      request.executionId,
      async (): Promise<BrowserResult> => {
        signal.throwIfAborted()
        try {
          return await driver.execute(request.operation)
        } catch (cause) {
          signal.throwIfAborted()
          // The browser says when an action's input may have reached the
          // page. Any other failure it names came before that, and the model
          // can act on it.
          if (
            changesPage(request.operation) &&
            (!(cause instanceof BrowserError) || cause.code === OUTCOME_UNKNOWN)
          )
            throw outcomeUnknown(cause)
          return { text: JSON.stringify(browserFailure(cause)) }
        }
      },
    )
    signal.throwIfAborted()
    if (result.image) {
      await this.keepCapture(task, request.toolCallId, result.image)
      signal.throwIfAborted()
    }
    await this.client.post(
      ROUTES.browserResult,
      {
        threadId: task.id,
        runId: receipt.runId,
        ...access,
        executionId: request.executionId,
        result,
      },
      signal,
    )
  }

  // Keeps the picture an action took of the page with its chat, for the user
  // to see what the task saw. The task goes on without a picture that could
  // not be kept.
  private async keepCapture(task: Task, toolCallId: string, image: string) {
    if (task.captures?.includes(toolCallId)) return
    try {
      await this.store.putCapture(this.owner, task.id, toolCallId, image)
      task.captures = [...(task.captures ?? []), toolCallId]
      await this.save(task)
    } catch (cause) {
      logError('Unable to keep a capture', cause)
    }
  }

  // Whether the user asked to approve actions. An action does not run
  // unreviewed because the answer could not be read.
  private async reviewRequired(): Promise<boolean> {
    try {
      return await this.reviewActions()
    } catch (cause) {
      throw new BrowserError(
        'SETTINGS_UNAVAILABLE',
        'The review setting could not be read, so the task was stopped before acting.',
        { cause },
      )
    }
  }

  private async cancelAndCollect(task: Task) {
    const receipt = task.receipt
    if (!receipt) return
    const signal = AbortSignal.timeout(CANCEL_TIMEOUT_MS)
    try {
      try {
        await this.client.post(
          ROUTES.cancel,
          { threadId: task.id, runId: receipt.runId },
          signal,
        )
      } catch (cause) {
        if (!(cause instanceof HarnessError) || cause.code !== 'RUN_NOT_FOUND')
          throw cause
      }
      for await (const frame of this.client.events(
        ROUTES.follow,
        {
          threadId: task.id,
          runId: receipt.runId,
          lastEventId: receipt.cursor,
        },
        signal,
      ))
        this.apply(task, frame)
    } catch (cause) {
      if (cause instanceof HarnessError && cause.code === 'RUN_NOT_FOUND')
        task.receipt = undefined
      task.error =
        'Browser control stopped. The final chat could not be recovered; an in-flight action may have completed. Check the page before continuing.'
    }
  }

  // Turns a recording into its text, which belongs to no task.
  async transcribe(audio: File, signal?: AbortSignal): Promise<string> {
    const { text } = await this.client.upload<{ text: string }>(
      ROUTES.transcriptions,
      audio,
      {},
      signal,
    )
    return text
  }

  async stop() {
    this.generation++
    await this.stopActive()
  }

  private async stopActive() {
    const active = this.active
    if (!active) return
    if (
      this.task?.receipt ||
      !this.task ||
      !['interrupted', 'completed'].includes(this.task.phase)
    )
      active.abort.abort()
    await active.done
  }
  async dispose() {
    this.disposed = true
    await this.stop()
    this.client.dispose()
  }
}

export function errorText(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'The task could not finish. Please try again.'
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
