import { ERROR_CODES } from './protocol'
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
const DEFAULT_RUN_ERROR = 'The run could not finish.'

function invalidPatch(): never {
  throw new HarnessError({
    code: ERROR_CODES.invalidStream,
    message: 'The chat stream contained an invalid state patch.',
  })
}

const replaceAt = <T>(items: readonly T[], index: number, item: T): T[] =>
  items.map((current, at) => (at === index ? item : current))

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

const withoutQueued = (snapshot: Snapshot, runId?: string): Snapshot => ({
  ...snapshot,
  queue: snapshot.queue.filter((item) => item.queueId !== runId),
})

// Applies one frame of a run. A frame the state applied already, as when a
// run is replayed from its first frame, returns the state itself.
export function reduceEvent(
  state: ChatState,
  frame: Frame,
  runHint?: string,
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
  // A queued run has its own stream. Its cancellation cannot stop the active
  // run, and late frames from the previous run cannot modify a newer snapshot.
  if (
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
      const messages = event.messages
      return {
        ...next,
        messages,
        hasOlder: event.hasOlder ?? false,
        // The window holds the continued reply as the harness stored it.
        ...(next.continued ? { sealed: sealOf(messages, next.continued) } : {}),
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
      return {
        ...next,
        messages: withReply(next.messages, id, event.timestamp, (blocks) => {
          const last = blocks.at(-1)
          if (last?.type === type && blocks.length > sealed)
            return replaceAt(blocks, blocks.length - 1, {
              ...last,
              content: (last.content ?? '') + event.delta,
            })
          return [
            ...blocks,
            {
              id: `${id}_${type}_${blocks.length}`,
              type,
              content: event.delta,
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
    case 'TOOL_CALL_RESULT':
      return {
        ...next,
        messages:
          withToolCall(next.messages, event.toolCallId, (block) => ({
            ...block,
            result: event.content,
            metadata: event.metadata,
            ...(event.display ? { display: event.display } : {}),
          })) ?? next.messages,
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
                : applyActivityDelta(
                    block.activity ?? { output: [] },
                    event.patch,
                  )
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
              error: {
                code: event.code ?? ERROR_CODES.upstreamRefused,
                message: event.message ?? DEFAULT_RUN_ERROR,
                ...(event.kind ? { kind: event.kind } : {}),
                ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
                ...(event.retryAfter ? { retryAfter: event.retryAfter } : {}),
              },
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
