import type { ReasoningEffort } from '@/components/chat/hooks/use-reasoning-effort'
import type { Chat, Message } from '@/components/chat/types'
import type { AutoIntelligenceLevelId, BaseModel } from '@/config/models'
import {
  StructuredCompletionError,
  sendStructuredCompletion,
} from '@/services/inference/inference-client'
import { logError } from '@/utils/error-handling'
import {
  estimateTokenCount,
  findContextStartIndex,
  getHistoryTokenBudget,
  getSmallestContextWindowTokens,
} from '@/utils/token-estimation'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { GENUI_WIDGETS_BY_NAME, isGenUIToolName } from './registry'

export type ArtifactRetryErrorCode =
  | 'request_failed'
  | 'schema_conversion_failed'
  | 'incomplete_replacement'
  | 'schema_invalid_replacement'
  | 'stale_target'
  | 'unavailable_target'

export class ArtifactRetryError extends Error {
  readonly code: ArtifactRetryErrorCode

  constructor(code: ArtifactRetryErrorCode, options: { cause?: unknown } = {}) {
    super(code, { cause: options.cause })
    this.name = 'ArtifactRetryError'
    this.code = code
  }
}

export interface ToolCallPatchTarget {
  messageTurnId?: string
  messageTimestamp: number
  timelineBlockId: string
  toolCallId: string
  toolName: string
  originalArguments: string
}

export type ToolCallPatchResult =
  { ok: true; chat: Chat } | { ok: false; error: ArtifactRetryError }

function toPlainText(message: Message): string {
  if (message.content) return message.content
  if (message.timeline) {
    return message.timeline
      .filter((block) => block.type === 'content')
      .map((block) => block.content)
      .join('\n')
  }
  return ''
}

export function selectArtifactRetryContext(
  contextMessages: Message[],
  contextWindowTokens: number | undefined,
  mandatoryPrompt: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = contextMessages
    .map((message) => ({
      source: message,
      role: message.role,
      content: toPlainText(message),
    }))
    .filter((message) => message.content.trim().length > 0)
  const projected = messages.map(({ source, content }) => ({
    ...source,
    content,
    timeline: undefined,
    toolCalls: undefined,
    attachments: undefined,
    documentContent: undefined,
    imageData: undefined,
    quote: undefined,
    searchReasoning: undefined,
  }))
  const budget = getHistoryTokenBudget(
    contextWindowTokens,
    estimateTokenCount(mandatoryPrompt),
  )
  const startIndex = findContextStartIndex(projected, budget, {
    keepMostRecent: false,
  })
  return messages
    .slice(startIndex)
    .map(({ role, content }) => ({ role, content }))
}

function mapStructuredError(error: unknown): ArtifactRetryError {
  if (
    error instanceof StructuredCompletionError &&
    error.code !== 'request_failed'
  ) {
    return new ArtifactRetryError('incomplete_replacement', { cause: error })
  }
  return new ArtifactRetryError('request_failed', { cause: error })
}

export async function regenerateToolCallArguments({
  toolName,
  originalArguments = '',
  contextMessages,
  model,
  autoCandidates,
  reasoningEffort,
  thinkingEnabled,
  autoIntelligence,
}: {
  toolName: string
  originalArguments?: string
  contextMessages: Message[]
  model: BaseModel
  autoCandidates?: BaseModel[]
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  autoIntelligence?: AutoIntelligenceLevelId
}): Promise<string> {
  if (!isGenUIToolName(toolName)) {
    throw new ArtifactRetryError('unavailable_target')
  }
  const widget = GENUI_WIDGETS_BY_NAME[toolName]
  let jsonSchema: Record<string, unknown>
  try {
    jsonSchema = zodToJsonSchema(widget.schema, {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Record<string, unknown>
  } catch (error) {
    const retryError = new ArtifactRetryError('schema_conversion_failed', {
      cause: error,
    })
    logError('Artifact schema conversion failed', retryError, {
      component: 'genui-retry',
      action: 'regenerateToolCallArguments',
      metadata: { toolName, code: retryError.code },
    })
    throw retryError
  }
  const instruction =
    `Repair only the JSON arguments for the "${toolName}" component. ` +
    'Preserve the artifact intent and all valid data. Follow the supplied schema exactly, ' +
    'including the matching fields for the selected variant. Do not generate or revise prose.'
  const malformedArtifact = `Malformed arguments to repair:\n${originalArguments}`
  const mandatoryPrompt = `${instruction}\n${JSON.stringify(jsonSchema)}\n${malformedArtifact}`
  const contextWindowTokens = getSmallestContextWindowTokens(
    autoCandidates ?? [model],
  )
  const conversation = selectArtifactRetryContext(
    contextMessages,
    contextWindowTokens,
    mandatoryPrompt,
  )

  let regenerated: unknown
  try {
    regenerated = await sendStructuredCompletion<unknown>({
      model,
      autoCandidates,
      messages: [
        { role: 'system', content: instruction },
        ...conversation,
        { role: 'user', content: malformedArtifact },
      ],
      jsonSchema,
      reasoningEffort,
      thinkingEnabled,
      autoIntelligence,
    })
  } catch (error) {
    const retryError = mapStructuredError(error)
    const structuredError =
      error instanceof StructuredCompletionError ? error : undefined
    logError('Artifact argument regeneration failed', retryError, {
      component: 'genui-retry',
      action: 'regenerateToolCallArguments',
      metadata: {
        toolName,
        code: retryError.code,
        status: structuredError?.status,
        requestCode: structuredError?.requestCode,
        finishReason: structuredError?.finishReason,
      },
    })
    throw retryError
  }

  const parsed = widget.schema.safeParse(regenerated)
  if (!parsed.success) {
    const retryError = new ArtifactRetryError('schema_invalid_replacement')
    logError(
      'Regenerated artifact arguments failed schema validation',
      retryError,
      {
        component: 'genui-retry',
        action: 'regenerateToolCallArguments',
        metadata: {
          toolName,
          issues: parsed.error.issues.map(
            (issue: { code: string; path: Array<string | number> }) => ({
              code: issue.code,
              path: issue.path,
            }),
          ),
        },
      },
    )
    throw retryError
  }

  return JSON.stringify(parsed.data)
}

export function patchToolCallArguments(
  chat: Chat,
  target: ToolCallPatchTarget,
  newArguments: string,
): ToolCallPatchResult {
  const matchingMessageIndexes = chat.messages.flatMap((message, index) => {
    const matchesIdentity = target.messageTurnId
      ? message.turnId === target.messageTurnId
      : message.timestamp.getTime() === target.messageTimestamp
    const hasBlock = message.timeline?.some(
      (block) =>
        block.type === 'tool_call' &&
        block.id === target.timelineBlockId &&
        block.toolCallId === target.toolCallId,
    )
    return matchesIdentity && hasBlock ? [index] : []
  })
  if (matchingMessageIndexes.length !== 1) {
    return {
      ok: false,
      error: new ArtifactRetryError('unavailable_target'),
    }
  }

  const messageIndex = matchingMessageIndexes[0]
  const message = chat.messages[messageIndex]
  const blocks =
    message.timeline?.filter(
      (candidate) =>
        candidate.type === 'tool_call' &&
        candidate.id === target.timelineBlockId &&
        candidate.toolCallId === target.toolCallId,
    ) ?? []
  const block = blocks[0]
  const mirrors =
    message.toolCalls?.filter(
      (candidate) => candidate.id === target.toolCallId,
    ) ?? []
  if (
    blocks.length !== 1 ||
    !block ||
    block.type !== 'tool_call' ||
    block.name !== target.toolName ||
    block.arguments !== target.originalArguments ||
    (message.toolCalls !== undefined && mirrors.length !== 1) ||
    (mirrors.length === 1 &&
      (mirrors[0].name !== target.toolName ||
        mirrors[0].arguments !== target.originalArguments))
  ) {
    return { ok: false, error: new ArtifactRetryError('stale_target') }
  }

  const patchedMessage: Message = {
    ...message,
    timeline: message.timeline?.map((candidate) =>
      candidate.type === 'tool_call' &&
      candidate.id === target.timelineBlockId &&
      candidate.toolCallId === target.toolCallId
        ? { ...candidate, arguments: newArguments }
        : candidate,
    ),
    toolCalls: message.toolCalls?.map((candidate) =>
      candidate.id === target.toolCallId
        ? { ...candidate, arguments: newArguments }
        : candidate,
    ),
  }
  const messages = [...chat.messages]
  messages[messageIndex] = patchedMessage
  return { ok: true, chat: { ...chat, messages } }
}
