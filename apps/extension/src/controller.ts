import { HarnessClient } from '@tinfoil/chat-client/client'
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
import { BrowserError, browserFailure } from './browser/errors'
import { changesPage } from './browser/schema'
import {
  DEFAULT_MODEL,
  randomSecret,
  RECONNECT_DELAYS_MS,
  TASK_TIMEOUT_MS,
} from './config'
import type { Command, View } from './messages'
import { TaskStore, type Task } from './storage'

const TITLE_CHARS = 80
const CANCEL_TIMEOUT_MS = 15_000
const MAX_ACTION_WAIT_MS = 5 * 60_000
const RESUME_PROMPT =
  'Continue my previous task. First observe the current browser state. Reconcile any action that may already have completed before taking another action.'

type BrowserExecutor = Pick<
  BrowserDriver,
  'attach' | 'execute' | 'describe' | 'dispose'
>
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
  private gate?: { resume: () => void; reject: (error: unknown) => void }
  private review?: {
    request: BrowserToolRequest
    preview: string
    resolve: (allow: boolean) => void
  }
  private disposed = false
  private generation = 0
  private transitions: Promise<void> = Promise.resolve()
  private readonly summaries = new Map<string, View['tasks'][number]>()

  constructor(
    private readonly client: HarnessClient,
    private readonly owner: string,
    private readonly store: TaskStore,
    private readonly publish: (view: View) => void,
    private readonly createBrowser: CreateBrowser = (signal, interrupted) =>
      new BrowserDriver(signal, interrupted),
  ) {}

  async initialize() {
    const tasks = await this.store.list(this.owner)
    for (const task of tasks) {
      this.summaries.set(task.id, {
        id: task.id,
        title: task.title,
        updatedAt: task.updatedAt,
      })
      if (['running', 'review', 'paused'].includes(task.phase)) {
        task.phase = 'interrupted'
        task.error =
          'This task was interrupted. Resume to reconnect, or send a new instruction after checking the page.'
        await this.store.put(task)
      }
    }
    this.task = tasks[0]
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
        tabs: task.tabs,
        confirmActions: task.confirmActions,
        error: task.error,
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
    if (command.kind === 'pause' || command.kind === 'review')
      return this.handle(command, generation)
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
        await this.begin(command, generation)
        return
      case 'resume':
        if (this.active && this.task?.phase === 'paused') {
          this.task.phase = 'running'
          this.gate?.resume()
          this.gate = undefined
          await this.save(this.task)
          return
        }
        if (!this.task) return
        if (this.task.receipt) this.launch(this.task, command.tabs)
        else
          await this.begin(
            {
              kind: 'send',
              content: `${RESUME_PROMPT}\n\nOriginal request: ${this.task.lastPrompt}`,
              tabs: command.tabs,
              model: this.task.model,
              effort: this.task.effort,
              confirmActions: this.task.confirmActions,
            },
            generation,
          )
        return
      case 'pause':
        if (this.active && this.task) {
          this.task.phase = 'paused'
          await this.save(this.task)
        }
        return
      case 'stop':
        await this.stopActive()
        return
      case 'review':
        if (this.review?.request.executionId !== command.executionId)
          throw new Error('That action is no longer awaiting review.')
        this.review.resolve(command.allow)
        this.review = undefined
        if (this.task && this.task.phase !== 'paused')
          this.task.phase = 'running'
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
    if (input.tabs.length && !this.session.features.browserTools)
      throw new Error(
        'This harness does not support browser tools yet. Configure a harness release with browserTools, or deselect tabs to chat.',
      )
    if (
      !this.session.models.some(
        (model) => model.id === input.model && !model.deprecated,
      )
    )
      throw new Error('Select an available model.')
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
        tabs: [],
        confirmActions: true,
      } satisfies Task)
    task.lastPrompt = input.content
    task.model = input.model
    task.effort = input.effort
    task.confirmActions = input.confirmActions
    task.error = undefined
    task.receipt = undefined
    this.task = task
    await this.save(task)
    this.checkGeneration(generation)
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
        webSearch: false,
        genUI: false,
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        cacheSecret: randomSecret(),
      },
      ...(input.tabs.length
        ? {
            browser: { executorId: crypto.randomUUID(), token: randomSecret() },
          }
        : {}),
    }
    this.launch(task, input.tabs, turn)
  }

  private launch(task: Task, tabs: number[], turn?: Turn) {
    if (this.active) throw new Error('Another task is running.')
    const abort = new AbortController()
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(TASK_TIMEOUT_MS),
    ])
    task.tabs = tabs
    task.phase = 'running'
    task.error = undefined
    const active = { abort, done: Promise.resolve() }
    this.active = active
    active.done = this.run(task, signal, turn).finally(async () => {
      this.review = undefined
      this.gate = undefined
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
      if (access) {
        if (!task.tabs.length)
          throw new Error('Select the tabs this task may control.')
        for (const tab of task.tabs) await driver.attach(tab)
      }
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
          task.error = 'Connection interrupted. Reconnecting to the same run…'
          await this.save(task)
          await wait(RECONNECT_DELAYS_MS[attempt], signal)
          if (task.receipt) next = undefined
        }
      }
    } catch (cause) {
      task.phase = 'interrupted'
      task.error =
        task.error ||
        (signal.aborted
          ? 'Task stopped. Check the page before continuing.'
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
    await this.waitForResume(task, signal)
    const previous = await this.store.action(
      this.owner,
      receipt.runId,
      request.executionId,
    )
    if (!previous && task.confirmActions && changesPage(request.operation)) {
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
    await this.waitForResume(task, signal)
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
          return { text: JSON.stringify(browserFailure(cause)) }
        }
      },
    )
    signal.throwIfAborted()
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

  private async waitForResume(task: Task, signal: AbortSignal) {
    signal.throwIfAborted()
    if (task.phase !== 'paused') return
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      this.gate = {
        resume: () => {
          signal.removeEventListener('abort', aborted)
          resolve()
        },
        reject,
      }
    })
    signal.throwIfAborted()
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

  async stop() {
    this.generation++
    await this.stopActive()
  }

  private async stopActive() {
    const active = this.active
    if (!active) return
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
