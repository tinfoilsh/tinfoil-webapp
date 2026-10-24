import {
  actionOf,
  ERROR_ACTIONS,
  ERROR_CODES,
  invalidResponse,
  WIDGET_PREFIX,
} from './protocol'
import { HarnessError } from './sse'
import type {
  ActivityPatch,
  Frame,
  HarnessErrorBody,
  HarnessEvent,
  Message,
  Snapshot,
  StatePatch,
  TerminalEvent,
  Thread,
  TimelineBlock,
  ToolActivity,
} from './types'

export interface ChatState {
  snapshot: Snapshot
  messages: Message[]
  hasOlder: boolean
  runId?: string
  status: 'idle' | 'submitting' | 'queued' | 'streaming' | 'error'
  error?: HarnessErrorBody
  // The run that ended with RUN_ERROR. It is run again rather than rejoined.
  failedRun?: string
  // A run continuing a reply streams into it, as RUN_STARTED names it.
  continued?: string
  // The leading blocks of a continued reply that new text starts after: as
  // in the harness, only a trailing text block takes the continuation.
  sealed?: Record<string, number>
  // The last frame applied of each run, so a replayed run skips the frames
  // it applied already.
  cursors: Record<string, number>
  // The latest summary of each thinking block of the run, by block id.
  summaries?: Record<string, string>
  // The harness refused a turn because the safeguards flagged the chat.
  flagged?: boolean
}

export function initialChat(thread?: Thread): ChatState {
  return {
    snapshot: { thread: thread ?? null, queue: [] },
    messages: thread?.messages ?? [],
    hasOlder: thread?.hasOlder ?? false,
    status: 'idle',
    cursors: {},
  }
}

export const isTerminal = (event: HarnessEvent): event is TerminalEvent =>
  event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'

export const runOf = (event: HarnessEvent): string | undefined =>
  'runId' in event ? event.runId : undefined

// A reply's reasoning streams under the reply's id with this suffix.
const REASONING_SUFFIX = /-reasoning$/
// A tool's activity streams under the tool call's id with this prefix.
const ACTIVITY_PREFIX = /^act_/
// The status of a widget call's result when the harness refused its
// arguments and asked the model to call the widget again.
const REFUSED_WIDGET_STATUS = 'error'

function invalidPatch(): never {
  throw new HarnessError({
    code: ERROR_CODES.invalidStream,
    action: ERROR_ACTIONS.stop,
    message: 'The chat stream contained an invalid state patch.',
  })
}

const replaceAt = <T>(items: readonly T[], index: number, item: T): T[] =>
  items.map((current, at) => (at === index ? item : current))

// Whether a widget call's result refuses the arguments it was drawn from.
function refusesWidget(block: TimelineBlock, result: unknown) {
  return (
    !!block.name?.startsWith(WIDGET_PREFIX) &&
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === REFUSED_WIDGET_STATUS
  )
}

// When an event happened, in epoch milliseconds, if it says.
function millisOf(timestamp: string | undefined): number | undefined {
  const at = timestamp ? Date.parse(timestamp) : NaN
  return Number.isNaN(at) ? undefined : at
}

// How long a reasoning block has thought by a chunk at `at`, as the harness
// stores it.
function thoughtUntil(
  block: TimelineBlock,
  at: number | undefined,
): Partial<TimelineBlock> {
  if (block.startedAt === undefined || at === undefined || at < block.startedAt)
    return {}
  const duration = (at - block.startedAt) / 1000
  return { endedAt: at, ...(duration > 0 ? { duration } : {}) }
}

// The queue and title changes a run sends. Each change copies only what it
// changes.
function applyStateDelta(
  snapshot: Snapshot,
  patches: readonly StatePatch[],
): Snapshot {
  let next = snapshot
  for (const patch of patches) {
    if (patch.op === 'add' && patch.path === '/queue/-')
      next = { ...next, queue: [...next.queue, patch.value] }
    else if (patch.op === 'replace' && patch.path === '/queue')
      next = { ...next, queue: patch.value }
    else if (
      patch.op === 'replace' &&
      patch.path === '/thread/title' &&
      next.thread
    )
      next = { ...next, thread: { ...next.thread, title: patch.value } }
    else if (
      patch.op === 'replace' &&
      patch.path === '/thread/titleState' &&
      next.thread
    )
      next = { ...next, thread: { ...next.thread, titleState: patch.value } }
    else invalidPatch()
  }
  return next
}

// A tool's progress and the output lines it adds.
// The output a block gathered from its earlier activity events, if any.
function gathered(activity: unknown): ToolActivity {
  return typeof activity === 'object' &&
    activity !== null &&
    'output' in activity &&
    Array.isArray(activity.output)
    ? (activity as ToolActivity)
    : { output: [] }
}

function applyActivityDelta(
  activity: ToolActivity,
  patches: readonly ActivityPatch[],
): ToolActivity {
  let next = activity
  for (const patch of patches) {
    if (patch.op === 'replace' && patch.path === '/progress')
      next = { ...next, progress: patch.value }
    else if (patch.op === 'add' && patch.path === '/output/-')
      next = { ...next, output: [...next.output, patch.value] }
    else invalidPatch()
  }
  return next
}

// Changes the timeline of a reply, which the first chunk naming it starts.
function withReply(
  messages: Message[],
  id: string,
  createdAt: string | undefined,
  change: (timeline: TimelineBlock[]) => TimelineBlock[],
): Message[] {
  const index = messages.findIndex((message) => message.id === id)
  if (index < 0)
    return [
      ...messages,
      {
        id,
        role: 'assistant',
        createdAt: createdAt ?? '',
        timeline: change([]),
      },
    ]
  const message = messages[index]
  return replaceAt(messages, index, {
    ...message,
    timeline: change(message.timeline ?? []),
  })
}

// Changes a tool call's block, wherever it is; null when no block has it.
function withToolCall(
  messages: Message[],
  toolCallId: string,
  change: (block: TimelineBlock) => TimelineBlock,
): Message[] | null {
  for (const [index, message] of messages.entries()) {
    const timeline = message.timeline ?? []
    const at = timeline.findIndex(
      (block) =>
        block.type === 'tool_call' &&
        (block.toolCallId ?? block.id) === toolCallId,
    )
    if (at >= 0)
      return replaceAt(messages, index, {
        ...message,
        timeline: replaceAt(timeline, at, change(timeline[at])),
      })
  }
  return null
}

// The leading blocks of a continued reply that new text does not extend.
function sealOf(messages: Message[], id: string): Record<string, number> {
  const blocks = messages.find((message) => message.id === id)?.timeline ?? []
  return {
    [id]: blocks.length - (blocks.at(-1)?.type === 'content' ? 1 : 0),
  }
}

// A window of the chat's latest messages, after the earlier messages the
// view loaded before the window's first.
export function afterLoaded(
  view: Pick<ChatState, 'messages' | 'hasOlder'>,
  messages: Message[],
  hasOlder: boolean,
): Pick<ChatState, 'messages' | 'hasOlder'> {
  const start = view.messages.findIndex(
    (message) => message.id === messages[0]?.id,
  )
  if (start <= 0) return { messages, hasOlder }
  return {
    messages: [...view.messages.slice(0, start), ...messages],
    hasOlder: view.hasOlder,
  }
}

const withoutQueued = (snapshot: Snapshot, runId?: string): Snapshot => ({
  ...snapshot,
  queue: snapshot.queue.filter((item) => item.queueId !== runId),
})

// Why a run ended with RUN_ERROR. One without the code, message and action
// the protocol requires of it is not one the client can read.
export function runErrorOf(
  event: Extract<HarnessEvent, { type: 'RUN_ERROR' }>,
): HarnessErrorBody {
  if (
    typeof event.code !== 'string' ||
    typeof event.message !== 'string' ||
    typeof event.action !== 'string'
  )
    return invalidResponse()
  return {
    code: event.code,
    message: event.message,
    action: actionOf(event.action),
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
    ...(event.retryAfter ? { retryAfter: event.retryAfter } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.keyId ? { keyId: event.keyId } : {}),
    ...(event.upstreamCode ? { upstreamCode: event.upstreamCode } : {}),
    ...(event.rateLimit ? { rateLimit: event.rateLimit } : {}),
  }
}

// The events of a widget's retry that the chat applies: the call redrawn
// from its new arguments, and what the call read for them, as a link
// preview's page. The run reports the reply it redrew as its own, under the
// model the chat has now.
const WIDGET_RETRY_EVENTS: ReadonlySet<HarnessEvent['type']> = new Set([
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
])

// Applies one frame of a run. A frame the state applied already, as when a
// run is replayed from its first frame, returns the state itself. A widget's
// retry redraws the widget and leaves the chat's run, status and error as
// they were.
export function reduceEvent(
  state: ChatState,
  frame: Frame,
  runHint?: string,
  widgetRetry = false,
): ChatState {
  const { event } = frame
  const runId = runOf(event) ?? runHint ?? state.runId
  if (
    frame.id !== undefined &&
    runId &&
    Object.hasOwn(state.cursors, runId) &&
    frame.id <= state.cursors[runId]
  )
    return state
  const cursors =
    frame.id !== undefined && runId
      ? { ...state.cursors, [runId]: frame.id }
      : state.cursors
  const next: ChatState = { ...state, cursors }
  if (widgetRetry && !WIDGET_RETRY_EVENTS.has(event.type)) return next
  // A queued run has its own stream. Its cancellation cannot stop the active
  // run, and late frames from the previous run cannot modify a newer snapshot.
  if (
    !widgetRetry &&
    runId &&
    state.runId &&
    runId !== state.runId &&
    event.type !== 'RUN_STARTED' &&
    event.type !== 'STATE_DELTA'
  )
    return isTerminal(event)
      ? { ...next, snapshot: withoutQueued(next.snapshot, runId) }
      : next
  switch (event.type) {
    case 'RUN_STARTED': {
      const {
        error: _error,
        failedRun: _failedRun,
        sealed: _sealed,
        continued: _continued,
        summaries: _summaries,
        ...rest
      } = next
      return {
        ...rest,
        runId: event.runId,
        status: 'streaming',
        ...(event.messageId
          ? {
              continued: event.messageId,
              sealed: sealOf(rest.messages, event.messageId),
            }
          : {}),
      }
    }
    case 'STATE_SNAPSHOT':
      return { ...next, snapshot: event.snapshot }
    case 'STATE_DELTA': {
      const snapshot = applyStateDelta(next.snapshot, event.delta)
      return event.runId && next.status !== 'streaming'
        ? { ...next, snapshot, status: 'queued', runId: event.runId }
        : { ...next, snapshot }
    }
    case 'MESSAGES_SNAPSHOT': {
      const shown = afterLoaded(next, event.messages, event.hasOlder ?? false)
      return {
        ...next,
        ...shown,
        // The window holds the continued reply as the harness stored it.
        ...(next.continued
          ? { sealed: sealOf(shown.messages, next.continued) }
          : {}),
      }
    }
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CHUNK': {
      const thinking = event.type === 'REASONING_MESSAGE_CHUNK'
      const id = thinking
        ? event.messageId.replace(REASONING_SUFFIX, '')
        : event.messageId
      const type = thinking ? 'thinking' : 'content'
      const sealed = next.sealed?.[id] ?? 0
      const at = millisOf(event.timestamp)
      return {
        ...next,
        messages: withReply(next.messages, id, event.timestamp, (blocks) => {
          const last = blocks.at(-1)
          const before = blocks.at(-2)
          // Reasoning that arrives after the reply's text began is the tail
          // of the reasoning before that text, as the harness keeps it.
          if (
            thinking &&
            blocks.length - 2 >= sealed &&
            last?.type === 'content' &&
            before?.type === 'thinking'
          )
            return replaceAt(blocks, blocks.length - 2, {
              ...before,
              content: (before.content ?? '') + event.delta,
            })
          if (last?.type === type && blocks.length > sealed)
            return replaceAt(blocks, blocks.length - 1, {
              ...last,
              content: (last.content ?? '') + event.delta,
              ...(thinking ? thoughtUntil(last, at) : {}),
            })
          return [
            ...blocks,
            {
              id: `${id}_${type}_${blocks.length}`,
              type,
              content: event.delta,
              ...(thinking && at !== undefined
                ? { startedAt: at, endedAt: at }
                : {}),
            },
          ]
        }),
      }
    }
    case 'REASONING_SUMMARY':
      return {
        ...next,
        summaries: { ...next.summaries, [event.blockId]: event.content },
      }
    case 'TOOL_CALL_START': {
      const { toolCallId, toolCallName: name } = event
      const at = millisOf(event.timestamp)
      const restarted = withToolCall(
        next.messages,
        toolCallId,
        ({ invalidArguments: _invalid, ...block }) => ({
          ...block,
          arguments: '',
          name,
          complete: false,
        }),
      )
      return {
        ...next,
        messages:
          restarted ??
          withReply(
            next.messages,
            event.parentMessageId ?? `msg_${toolCallId}`,
            event.timestamp,
            (blocks) => [
              ...blocks,
              {
                id: toolCallId,
                toolCallId,
                type: 'tool_call',
                name,
                arguments: '',
                complete: false,
                progress: [],
                ...(at !== undefined ? { startedAt: at } : {}),
              },
            ],
          ),
      }
    }
    case 'TOOL_CALL_ARGS':
      return {
        ...next,
        messages:
          withToolCall(next.messages, event.toolCallId, (block) => ({
            ...block,
            arguments: (block.arguments ?? '') + event.delta,
          })) ?? next.messages,
      }
    case 'TOOL_CALL_END':
      return {
        ...next,
        messages:
          withToolCall(next.messages, event.toolCallId, (block) => ({
            ...block,
            complete: true,
          })) ?? next.messages,
      }
    case 'TOOL_CALL_RESULT': {
      const at = millisOf(event.timestamp)
      return {
        ...next,
        messages:
          withToolCall(next.messages, event.toolCallId, (block) => ({
            ...block,
            result: event.content,
            metadata: event.metadata,
            ...(event.display ? { display: event.display } : {}),
            ...(refusesWidget(block, event.content)
              ? { invalidArguments: true }
              : {}),
            ...(at !== undefined &&
            (block.startedAt === undefined || at >= block.startedAt)
              ? { endedAt: at }
              : {}),
          })) ?? next.messages,
      }
    }
    case 'ACTIVITY_SNAPSHOT':
    case 'ACTIVITY_DELTA': {
      const toolCallId = event.messageId.replace(ACTIVITY_PREFIX, '')
      return {
        ...next,
        messages:
          withToolCall(next.messages, toolCallId, (block) => {
            const activity =
              event.type === 'ACTIVITY_SNAPSHOT'
                ? event.content
                : applyActivityDelta(gathered(block.activity), event.patch)
            return {
              ...block,
              activity,
              ...(Array.isArray(activity.output)
                ? { progress: activity.output }
                : {}),
              ...(event.display ? { display: event.display } : {}),
            }
          }) ?? next.messages,
      }
    }
    case 'RUN_FINISHED':
    case 'RUN_ERROR': {
      const failed = event.type === 'RUN_ERROR'
      const committed = new Map(
        event.metadata?.messages?.map((message) => [message.id, message]),
      )
      return {
        ...next,
        snapshot: withoutQueued(next.snapshot, runId),
        status: failed ? 'error' : 'idle',
        ...(failed
          ? {
              error: runErrorOf(event),
              ...(runId ? { failedRun: runId } : {}),
              ...(event.code === ERROR_CODES.chatFlagged
                ? { flagged: true }
                : {}),
            }
          : {}),
        messages: next.messages.map((message) => {
          const metadata = committed.get(message.id)
          return metadata ? { ...message, ...metadata } : message
        }),
      }
    }
  }
  return next
}
