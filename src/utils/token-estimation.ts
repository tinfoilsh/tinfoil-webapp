import type { Message } from '@/components/chat/types'
import {
  REASONING_HISTORY_POLICIES,
  shouldIncludeReasoning,
  type ReasoningHistoryPolicy,
} from '@/utils/reasoning-history'
import { webSearchHistoryMessages } from '@/utils/web-search-history'

// Fraction of the model's context window reserved for conversation history;
// the remainder is headroom for the system prompt and the model's response.
export const CONTEXT_WINDOW_USAGE_RATIO = 0.8

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000

/** The slice of a model the context budget is derived from. */
export type ContextWindowSource = {
  chatConfig?: { contextWindowTokens?: number }
}

// Roughly estimate token count based on character length (≈4 chars per token)
export function estimateTokenCount(text: string | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function resolveContextWindowTokens(
  model: ContextWindowSource | undefined,
): number {
  return model?.chatConfig?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
}

export function getSmallestContextWindowTokens(
  models: ContextWindowSource[],
): number | undefined {
  if (models.length === 0) return undefined
  return Math.min(...models.map(resolveContextWindowTokens))
}

export type TokenEstimationOptions = {
  reasoningHistoryPolicy?: ReasoningHistoryPolicy
  keepMostRecent?: boolean
}

// Estimate the tokens a message contributes to the prompt, including quoted
// text, attachment contents, assistant tool calls, and reasoning when the
// selected model requires it to be returned in subsequent requests.
export function estimateMessageTokens(
  msg: Message,
  options: TokenEstimationOptions = {},
): number {
  let tokens = estimateTokenCount(msg.content)
  const evidence = webSearchHistoryMessages(msg, 0)
  if (evidence.length) tokens += estimateTokenCount(JSON.stringify(evidence))
  if (
    msg.role === 'assistant' &&
    shouldIncludeReasoning(
      options.reasoningHistoryPolicy ?? REASONING_HISTORY_POLICIES.none,
      Boolean(msg.toolCalls?.length),
    )
  ) {
    tokens += estimateTokenCount(msg.thoughts)
  }
  if (msg.searchReasoning) {
    tokens += estimateTokenCount(msg.searchReasoning)
  }
  if (msg.toolCalls) {
    for (const toolCall of msg.toolCalls) {
      tokens += estimateTokenCount(toolCall.name)
      tokens += estimateTokenCount(toolCall.arguments)
    }
  }
  if (msg.quote) {
    tokens += estimateTokenCount(msg.quote)
  }
  if (msg.attachments) {
    for (const attachment of msg.attachments) {
      tokens += estimateTokenCount(attachment.textContent)
      tokens += estimateTokenCount(attachment.description)
    }
  }
  if (msg.documentContent) {
    tokens += estimateTokenCount(msg.documentContent)
  }
  return tokens
}

export function getContextTokenBudget(contextWindowTokens?: number): number {
  return Math.floor(
    (contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS) *
      CONTEXT_WINDOW_USAGE_RATIO,
  )
}

export function getHistoryTokenBudget(
  contextWindowTokens?: number,
  pendingTokens = 0,
): number {
  return Math.max(0, getContextTokenBudget(contextWindowTokens) - pendingTokens)
}

/**
 * Returns the index of the first message (from the end) that fits within the
 * token budget. Messages before this index are "archived" and excluded from
 * the prompt. The most recent message is always included, even if it alone
 * exceeds the budget.
 */
export function findContextStartIndex(
  messages: Message[],
  budgetTokens: number,
  options: TokenEstimationOptions = {},
): number {
  let usedTokens = 0
  const keepMostRecent = options.keepMostRecent ?? true
  for (let i = messages.length - 1; i >= 0; i--) {
    usedTokens += estimateMessageTokens(messages[i], options)
    if (
      usedTokens > budgetTokens &&
      (!keepMostRecent || i < messages.length - 1)
    ) {
      return i + 1
    }
  }
  return 0
}

/**
 * Selects the most recent messages that fit within the model's context
 * token budget.
 */
export function selectMessagesWithinBudget(
  messages: Message[],
  contextWindowTokens?: number,
  options: TokenEstimationOptions = {},
): Message[] {
  const budget = getContextTokenBudget(contextWindowTokens)
  return messages.slice(findContextStartIndex(messages, budget, options))
}
