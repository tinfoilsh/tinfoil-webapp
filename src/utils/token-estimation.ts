import type { Message } from '@/components/chat/types'

// Fraction of the model's context window reserved for conversation history;
// the remainder is headroom for the system prompt and the model's response.
export const CONTEXT_WINDOW_USAGE_RATIO = 0.9

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 64000

// Roughly estimate token count based on character length (≈4 chars per token)
export function estimateTokenCount(text: string | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// Parse values like "64k tokens" → 64000
export function parseContextWindowTokens(contextWindow?: string): number {
  if (!contextWindow) return DEFAULT_CONTEXT_WINDOW_TOKENS
  const match = contextWindow.match(/(\d+)(k)?/i)
  if (!match) return DEFAULT_CONTEXT_WINDOW_TOKENS
  let tokens = parseInt(match[1], 10)
  if (match[2]) {
    tokens *= 1000
  }
  return tokens
}

// Estimate the tokens a message contributes to the prompt, including
// quoted text, attachment contents that get inlined into user content,
// and assistant tool calls. Thoughts are excluded: they are never sent
// back in chat prompt payloads.
export function estimateMessageTokens(msg: Message): number {
  let tokens = estimateTokenCount(msg.content)
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

export function getContextTokenBudget(contextWindow?: string): number {
  return Math.floor(
    parseContextWindowTokens(contextWindow) * CONTEXT_WINDOW_USAGE_RATIO,
  )
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
): number {
  let usedTokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    usedTokens += estimateMessageTokens(messages[i])
    if (usedTokens > budgetTokens && i < messages.length - 1) {
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
  contextWindow?: string,
): Message[] {
  const budget = getContextTokenBudget(contextWindow)
  return messages.slice(findContextStartIndex(messages, budget))
}
