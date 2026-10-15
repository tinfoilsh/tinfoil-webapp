import { HarnessError } from './sse'
import type {
  Frame,
  HarnessErrorBody,
  Json,
  Message,
  Patch,
  Snapshot,
  Thread,
  TimelineBlock,
} from './types'

export interface ChatState {
  snapshot: Snapshot
  messages: Message[]
  hasOlder: boolean
  runId?: string
  status: 'idle' | 'queued' | 'streaming' | 'error'
  error?: HarnessErrorBody
  cursors: Record<string, number>
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

function invalidPatch(): never {
  throw new HarnessError({
    code: 'INVALID_STREAM',
    message: 'The chat stream contained an invalid state patch.',
  })
}
function pointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) invalidPatch()
  return path
    .slice(1)
    .split('/')
    .map((part) => {
      if (/~[^01]|~$/.test(part)) invalidPatch()
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        invalidPatch()
      return key
    })
}
function indexOf(part: string, length: number, append = false): number {
  if (append && part === '-') return length
  if (!/^(0|[1-9]\d*)$/.test(part)) invalidPatch()
  const index = Number(part)
  if (!Number.isSafeInteger(index) || index >= length + (append ? 1 : 0))
    invalidPatch()
  return index
}
function read(root: Json, parts: string[]): Json {
  for (const part of parts) {
    if (!root || typeof root !== 'object') invalidPatch()
    if (Array.isArray(root)) root = root[indexOf(part, root.length)]
    else {
      if (!Object.hasOwn(root, part)) invalidPatch()
      root = root[part]
    }
  }
  return root
}
function same(a: Json, b: Json): boolean {
  if (a === b) return true
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false
  const left = Object.keys(a),
    right = Object.keys(b)
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same(
          (a as Record<string, Json>)[key],
          (b as Record<string, Json>)[key],
        ),
    )
  )
}

// Patches operate on a copy. A failed test or an invalid path leaves the
// caller's state intact, including when earlier operations succeeded.
export function applyPatch(value: Json, patches: Patch[]): Json {
  let result = structuredClone(value)
  for (const patch of patches) {
    const parts = pointer(patch.path)
    let replacement = patch.value
    if (patch.op === 'test') {
      if (replacement === undefined || !same(read(result, parts), replacement))
        invalidPatch()
      continue
    }
    if (patch.op === 'copy' || patch.op === 'move') {
      if (patch.from === undefined) invalidPatch()
      const source = pointer(patch.from)
      if (
        patch.op === 'move' &&
        parts.length > source.length &&
        source.every((key, i) => parts[i] === key)
      )
        invalidPatch()
      replacement = structuredClone(read(result, source))
      if (patch.op === 'move')
        result = applyPatch(result, [{ op: 'remove', path: patch.from }])
    } else if (!['add', 'remove', 'replace'].includes(patch.op)) invalidPatch()
    const add = patch.op === 'add' || patch.op === 'copy' || patch.op === 'move'
    if (patch.op !== 'remove' && replacement === undefined) invalidPatch()
    if (!parts.length) {
      result = patch.op === 'remove' ? null : structuredClone(replacement!)
      continue
    }
    const parent = read(result, parts.slice(0, -1))
    const key = parts[parts.length - 1]
    if (!parent || typeof parent !== 'object') invalidPatch()
    if (Array.isArray(parent)) {
      const index = indexOf(key, parent.length, add)
      if (patch.op === 'remove') parent.splice(index, 1)
      else if (add) parent.splice(index, 0, structuredClone(replacement!))
      else parent[index] = structuredClone(replacement!)
    } else {
      if (!add && !Object.hasOwn(parent, key)) invalidPatch()
      if (patch.op === 'remove') delete parent[key]
      else parent[key] = structuredClone(replacement!)
    }
  }
  return result
}

export function reduceEvent(
  state: ChatState,
  frame: Frame,
  runHint?: string,
): ChatState {
  const event = frame.event
  const runId = event.runId ?? runHint ?? state.runId
  if (
    frame.id !== undefined &&
    runId &&
    Object.hasOwn(state.cursors, runId) &&
    frame.id <= state.cursors[runId]
  )
    return state
  const next = structuredClone(state)
  if (frame.id !== undefined && runId) next.cursors[runId] = frame.id
  // A queued run has its own stream. Its cancellation cannot stop the active
  // run, and late frames from the previous run cannot modify a newer snapshot.
  if (
    runId &&
    next.runId &&
    runId !== next.runId &&
    !['RUN_STARTED', 'STATE_DELTA'].includes(event.type)
  ) {
    if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR')
      next.snapshot.queue = next.snapshot.queue.filter(
        (item) => item.queueId !== runId,
      )
    return next
  }
  const message = (id: string): Message => {
    let value = next.messages.find((m) => m.id === id)
    if (!value) {
      value = {
        id,
        role: 'assistant',
        createdAt: event.timestamp ?? '',
        timeline: [],
      }
      next.messages.push(value)
    }
    value.timeline ??= []
    return value
  }
  const call = (id: string | undefined): TimelineBlock | undefined =>
    next.messages
      .flatMap((m) => m.timeline ?? [])
      .find((b) => b.type === 'tool_call' && (b.toolCallId ?? b.id) === id)
  switch (event.type) {
    case 'RUN_STARTED':
      next.runId = event.runId
      next.status = 'streaming'
      delete next.error
      break
    case 'STATE_SNAPSHOT':
      if (event.snapshot) next.snapshot = event.snapshot
      break
    case 'STATE_DELTA':
      if (Array.isArray(event.delta))
        next.snapshot = applyPatch(
          next.snapshot as unknown as Json,
          event.delta,
        ) as unknown as Snapshot
      if (event.runId && next.status !== 'streaming') {
        next.status = 'queued'
        next.runId = event.runId
      }
      break
    case 'MESSAGES_SNAPSHOT':
      next.messages = event.messages ?? []
      next.hasOlder = event.hasOlder ?? false
      break
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CHUNK': {
      if (!event.messageId || typeof event.delta !== 'string') break
      const thinking = event.type === 'REASONING_MESSAGE_CHUNK'
      const id = thinking
        ? event.messageId.replace(/-reasoning$/, '')
        : event.messageId
      const m = message(id),
        blocks = m.timeline!
      const type = thinking ? 'thinking' : 'content'
      let block = blocks.at(-1)
      if (block?.type !== type) {
        block = { id: `${id}_${type}_${blocks.length}`, type, content: '' }
        blocks.push(block)
      }
      block.content = (block.content ?? '') + event.delta
      break
    }
    case 'TOOL_CALL_START': {
      if (!event.toolCallId) break
      const existing = call(event.toolCallId)
      if (existing) {
        existing.arguments = ''
        existing.name = event.toolCallName
        existing.complete = false
      } else
        message(
          event.parentMessageId ?? `msg_${event.toolCallId}`,
        ).timeline!.push({
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          type: 'tool_call',
          name: event.toolCallName,
          arguments: '',
          complete: false,
          progress: [],
          resolvedAt: null,
          resolution: null,
        })
      break
    }
    case 'TOOL_CALL_ARGS': {
      const block = call(event.toolCallId)
      if (block && typeof event.delta === 'string')
        block.arguments = (block.arguments ?? '') + event.delta
      break
    }
    case 'TOOL_CALL_END': {
      const block = call(event.toolCallId)
      if (block) block.complete = true
      break
    }
    case 'TOOL_CALL_RESULT': {
      const block = call(event.toolCallId)
      if (block) {
        block.result = event.content
        block.metadata = event.metadata
      }
      break
    }
    case 'ACTIVITY_SNAPSHOT':
    case 'ACTIVITY_DELTA': {
      const block = call(event.messageId?.replace(/^act_/, ''))
      if (block) {
        block.activity =
          event.type === 'ACTIVITY_SNAPSHOT'
            ? event.content
            : applyPatch(block.activity ?? { output: [] }, event.patch ?? [])
        if (
          block.activity &&
          typeof block.activity === 'object' &&
          !Array.isArray(block.activity) &&
          Array.isArray(block.activity.output)
        )
          block.progress = block.activity.output
      }
      break
    }
    case 'RUN_FINISHED':
    case 'RUN_ERROR': {
      next.snapshot.queue = next.snapshot.queue.filter(
        (item) => item.queueId !== runId,
      )
      next.status = event.type === 'RUN_ERROR' ? 'error' : 'idle'
      if (event.type === 'RUN_ERROR')
        next.error = {
          code: event.code ?? 'UPSTREAM_REFUSED',
          message: event.message ?? 'The run could not finish.',
          retryAfter: event.retryAfter,
        }
      if (event.metadata?.rateLimit)
        next.snapshot.rateLimit = event.metadata
          .rateLimit as unknown as Snapshot['rateLimit']
      const last = next.messages.findLast((m) => m.role === 'assistant')
      if (last) {
        last.isError = event.type === 'RUN_ERROR'
        last.isInterrupted = event.metadata?.cancelled === true
      }
      break
    }
  }
  return next
}
